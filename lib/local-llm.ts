/*
 * 本地大模型推理层 —— 参考 YUH Studio 的做法：主进程 `spawn` 一个 llama.cpp 的
 * `llama-server`，它对外就是一个 OpenAI 兼容端点，我们只跟 `/v1/chat/completions` 说话。
 *
 * 四条前提，改这个文件之前先看：
 *
 * 1. **不内置运行时。** YUH 把整套 llama.cpp（含 ggml-cuda 538MB + cublasLt 660MB，共 1.34GB）
 *    塞进 `resources/`，安装包直接胖 1.3GB。Holy Light画布不这么干：运行时路径由用户指定一次、
 *    之后存进设置；找不到时给出「去哪下、选哪个文件」的提示，而不是静默失败。
 * 2. **引擎是长驻子进程，不是每次请求起一次。** 4B 模型加载要几十秒，请求级别起进程等于
 *    每次都等半分钟。所以状态机是 stopped / starting / ready / error，
 *    换模型或换关键参数才重启（靠 `signature()` 比对）。
 * 3. **模型路径含中文时 llama.cpp 读不了。** 表现是它报一段看不懂的加载失败。
 *    处理方式与 YUH 相同：cwd 切到模型目录、参数改成文件名（相对路径）。
 *    连文件名都含中文就没救了，只能让用户改名 —— 这时给明确的报错。
 * 4. **显存是硬约束。** 本机 RTX 5060 Laptop 只有 4GB：4B 的 Q4（2.77GB）加上
 *    4096 上下文的 KV cache 才装得下，32768 那种默认值一上来就爆。所以默认上下文
 *    给 4096 而不是照抄 YUH 的 32768，缓存默认 q8_0。
 * 5. **优化提示词走的是「按需装载」。** 设置页「文本」段选中本地之后，
 *    每次优化都是 装载 → 优化 → 按保活卸载（默认立刻卸），用完就把显存还回去 ——
 *    这台机器只有 4GB 显存，还要留给 ComfyUI 出图。见文件末尾那一节。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimePaths } from './runtime-paths';

export type LlmState = 'stopped' | 'starting' | 'ready' | 'error';

export type LlmSettings = {
  /** `llama-server.exe` 的完整路径。留空 = 自动找（见 `detectServerExe`）。 */
  serverPath: string;
  /** 主模型 GGUF。 */
  modelPath: string;
  modelDirs: string[];
  port: number;
  contextSize: number;
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  repeatPenalty: number;
  seed: number;
  /** -1 = 全部层放 GPU。 */
  gpuLayers: number;
  threads: number;
  batchSize: number;
  microBatchSize: number;
  flashAttention: boolean;
  cacheTypeK: string;
  cacheTypeV: string;
  /** `CUDA_VISIBLE_DEVICES` 的值；null = 不限制。多显卡时用来锁卡。 */
  gpuDevice: number | null;
  /**
   * 「优化提示词走本地」跑完之后保活多少秒。**0 = 立刻卸载**（默认）。
   *
   * 为什么默认是 0 而不是保活几分钟：显存是硬约束。这台机器 4GB 显存还要跑
   * ComfyUI 出图，本地模型多占一秒就可能让下一次出图 OOM。装 0.8B 只要 3 秒，
   * 每次重新装回来的代价可以接受；想省掉这几秒的人自己把它调到 120 就行。
   */
  keepAliveSeconds: number;
};

export type LlmStatus = {
  state: LlmState;
  message: string;
  port: number;
  /** 引擎最近的一段输出。启动失败时这段是唯一的线索，所以状态里必须带上。 */
  log: string;
  running: boolean;
  modelPath: string;
  serverPath: string;
  resolvedServerPath: string;
};

export type LlmModelFile = { name: string; path: string; size: number };

/** 默认端口。与 YUH 一致用 8191，方便两边不同时占着同一个端口排查。 */
const DEFAULT_PORT = 8191;
const HEALTH_TIMEOUT_MS = 2500;
/** 4B Q4 从磁盘读进显存要几十秒，冷盘时更久；给足 3 分钟，短了会误判成失败。 */
const START_TIMEOUT_MS = 180000;
const MAX_SCAN_FILES = 300;

/**
 * 设置文件。
 *
 * 落在**数据根**而不是 `config/` 子目录：老版本就存在 `userData/local-llm.json`，
 * 默认布局下 `dataDir === userData`，写在这里等于原地不动，用户的设置不会丢。
 */
function settingsFile(): string {
  return path.join(runtimePaths().dataDir, 'local-llm.json');
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function defaultThreads(): number {
  return Math.min(16, Math.max(4, (os.cpus()?.length ?? 8) - 2));
}

const DEFAULT_SETTINGS: LlmSettings = {
  serverPath: '',
  modelPath: '',
  modelDirs: [],
  port: DEFAULT_PORT,
  /*
   * 4096 而不是 32768：见文件头第 4 条。4B Q4 的模型本身就 2.77GB，
   * 32768 上下文的 KV cache（q8_0）还要再加约 4.7GB —— 4GB 显存的机器必然 OOM。
   */
  contextSize: 4096,
  maxTokens: 2048,
  /** 剧本创作要一点发散，0.2 那种「反推标签」的确定性取值会写出一堆一样的句子。 */
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.05,
  seed: -1,
  gpuLayers: -1,
  threads: defaultThreads(),
  batchSize: 1024,
  microBatchSize: 512,
  flashAttention: true,
  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',
  gpuDevice: null,
  keepAliveSeconds: 0,
};

function normalizeSettings(input: Partial<LlmSettings> | null | undefined): LlmSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(input ?? {}) };
  const cache = (v: unknown) => (['f16', 'q8_0', 'q4_0'].includes(String(v)) ? String(v) : 'q8_0');
  const dirs = Array.isArray(merged.modelDirs) ? merged.modelDirs : [];
  return {
    serverPath: String(merged.serverPath || ''),
    modelPath: String(merged.modelPath || ''),
    modelDirs: [...new Set(dirs.map((d) => String(d || '')).filter(Boolean))],
    port: Math.round(clamp(merged.port, DEFAULT_PORT, 1024, 65535)),
    contextSize: Math.round(clamp(merged.contextSize, 4096, 512, 65536)),
    maxTokens: Math.round(clamp(merged.maxTokens, 2048, 64, 16384)),
    temperature: clamp(merged.temperature, 0.7, 0, 2),
    topP: clamp(merged.topP, 0.9, 0.01, 1),
    topK: Math.round(clamp(merged.topK, 40, 0, 200)),
    minP: clamp(merged.minP, 0.05, 0, 1),
    repeatPenalty: clamp(merged.repeatPenalty, 1.05, 0.5, 2),
    seed: Math.round(clamp(merged.seed, -1, -1, 2147483647)),
    gpuLayers: Math.round(clamp(merged.gpuLayers, -1, -1, 999)),
    threads: Math.round(clamp(merged.threads, defaultThreads(), 1, 64)),
    batchSize: Math.round(clamp(merged.batchSize, 1024, 32, 4096)),
    microBatchSize: Math.round(clamp(merged.microBatchSize, 512, 32, 2048)),
    flashAttention: Boolean(merged.flashAttention),
    cacheTypeK: cache(merged.cacheTypeK),
    cacheTypeV: cache(merged.cacheTypeV),
    gpuDevice: merged.gpuDevice === null || merged.gpuDevice === undefined ? null : Math.round(clamp(merged.gpuDevice, 0, 0, 15)),
    /* 上限 1 小时：再长就成「忘了关的常驻进程」，那正好是这一层要避免的事。 */
    keepAliveSeconds: Math.round(clamp(merged.keepAliveSeconds, 0, 0, 3600)),
  };
}

export function getLlmSettings(): LlmSettings {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveLlmSettings(patch: Partial<LlmSettings> = {}): LlmSettings {
  const next = normalizeSettings({ ...getLlmSettings(), ...patch });
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/* ------------------------------------------------------------------ 运行时查找 */

/**
 * 内置运行时的位置（打包后 `resources/llama.cpp/`）。存在就用它，不硬塞进安装包。
 *
 * 这里不能碰 `electron`：`app.isPackaged` / `app.getAppPath()` 只有主进程有，
 * 而这一层也跑在后端进程里。改成看环境变量与目录是否存在 —— 语义一样，
 * 而且后端进程是由主进程 fork 出来的，主进程会把程序目录喂进来。
 */
function bundledRuntimeDir(): string {
  const appDir = runtimePaths().appDir;
  const candidates = [
    process.env.HOLYLIGHT_RESOURCES_DIR ? path.join(process.env.HOLYLIGHT_RESOURCES_DIR, 'llama.cpp') : null,
    path.join(appDir, 'llama.cpp'),
    path.join(appDir, '..', 'llama.cpp'),
    path.join(appDir, 'resources', 'llama.cpp'),
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'llama-server.exe'))) return dir;
  }
  return candidates[0] ?? path.join(appDir, 'resources', 'llama.cpp');
}

/**
 * LM Studio 自带的 llama.cpp 后端。
 *
 * 装在 `~/.lmstudio/extensions/backends/llama.cpp-*` 下，一套一个目录（CPU / CUDA / Vulkan
 * 各有各的），每个目录自带全部 dll —— 它是一个**可直接独立运行**的 llama-server。
 * 排序上 CUDA 优先、版本号大的优先：CPU 版本跑 4B 模型只有个位数 tok/s，能上显卡就上显卡。
 */
function lmStudioBackends(): string[] {
  const root = path.join(os.homedir(), '.lmstudio', 'extensions', 'backends');
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const full = (name: string) => path.join(root, name);
  /*
   * 排序：**自带 CUDA 运行时库**的最优先，其次才是光有 ggml-cuda.dll 的。
   *
   * 这不是洁癖 —— 本机实测：只带 ggml-cuda.dll 的后端（LM Studio 的 cuda12 那套）
   * 启动就崩，退出码 0xC0000135（缺 DLL），因为它指望系统里另有 cublas / cudart，
   * 而没装 CUDA Toolkit 的机器上根本没有。顺序错了就是「一点启动就失败」。
   */
  const score = (name: string): number => {
    let score = /cuda/i.test(name) ? 100 : /vulkan/i.test(name) ? 50 : 0;
    try {
      const files = fs.readdirSync(full(name)).map((f) => f.toLowerCase());
      if (files.some((f) => f.startsWith('ggml-cuda'))) score += 200;
      if (files.some((f) => f.startsWith('cublas') || f.startsWith('cudart'))) score += 400;
    } catch {
      /* 读不了就按名字算 */
    }
    return score + (Number(/([\d.]+)$/.exec(name)?.[1]?.split('.')[0]) || 0);
  };
  return dirs.sort((a, b) => score(b) - score(a)).map((d) => path.join(full(d), 'llama-server.exe'));
}

function candidateServerPaths(): string[] {
  const out: string[] = [];
  out.push(path.join(bundledRuntimeDir(), 'llama-server.exe'));
  out.push(...lmStudioBackends());
  // 常见构建产物位置（llama.cpp 官方 CMake 默认输出到 build/bin/Release）
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    const root = `${drive}:\\`;
    if (!fs.existsSync(root)) continue;
    out.push(
      path.join(root, 'llama.cpp', 'build', 'bin', 'Release', 'llama-server.exe'),
      path.join(root, 'llama.cpp', 'llama-server.exe'),
      path.join(root, 'llama.cpp', 'build', 'bin', 'llama-server.exe'),
    );
  }
  const home = os.homedir();
  out.push(
    path.join(home, '.lmstudio', 'runtime', 'llama-server.exe'),
    path.join(home, 'llama.cpp', 'build', 'bin', 'Release', 'llama-server.exe'),
  );
  return out;
}

/** 自动找 `llama-server.exe`：设置里的 → 内置的 → 一批常见位置。找不到返回空串。 */
export function detectServerExe(): string {
  const saved = getLlmSettings().serverPath;
  if (saved && fs.existsSync(saved)) return saved;
  for (const p of candidateServerPaths()) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

export function listServerCandidates(): string[] {
  return candidateServerPaths().filter((p) => fs.existsSync(p));
}

/**
 * 随包自带的那一套（2026-09-26：内置 Vulkan 版）。
 *
 * 打包后落在 `<resources>/llama.cpp/llama-server.exe`（`extraResources` 拷过去，
 * 不在 asar 里 —— asar 里的 exe 是 spawn 不起来的）。没带就是空串。
 */
export function bundledServerPath(): string {
  const p = path.join(bundledRuntimeDir(), 'llama-server.exe');
  return fs.existsSync(p) ? p : '';
}

/* -------------------------------------------------------------------- 模型扫描 */

function scanGgufs(root: string, maxDepth = 3): string[] {
  if (!root || !fs.existsSync(root)) return [];
  const results: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth || results.length >= MAX_SCAN_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(p, depth + 1);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.gguf') results.push(p);
    }
  };
  visit(root, 0);
  return results;
}

/**
 * 猜模型目录。
 *
 * 只放**通用**位置（用户目录下那几个约定俗成的地方、可执行文件旁边、各盘根下的
 * `llm`/`models`），不写死任何一台机器的具体路径 —— 那是别人的隐私也是维护负担。
 */
export function detectModelDirs(): string[] {
  const out: string[] = [];
  const home = os.homedir();
  out.push(
    path.join(home, '.lmstudio', 'models'),
    path.join(home, '.cache', 'lm-studio', 'models'),
    path.join(runtimePaths().dataDir, 'models'),
  );
  const exe = detectServerExe();
  if (exe) {
    out.push(path.join(path.dirname(exe), 'models'));
    out.push(path.join(path.dirname(exe), '..', 'models'));
  }
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    const root = `${drive}:\\`;
    if (!fs.existsSync(root)) continue;
    out.push(path.join(root, 'llm', 'model'), path.join(root, 'llm', 'models'), path.join(root, 'models'), path.join(root, 'llm'));
  }
  return [...new Set(out)];
}

export function listLlmModels(dirs?: string[]): LlmModelFile[] {
  const roots = dirs && dirs.length ? dirs : [...getLlmSettings().modelDirs, ...detectModelDirs()];
  const files = new Set<string>();
  for (const root of roots) for (const f of scanGgufs(root)) files.add(f);
  return [...files]
    .filter((p) => !/(?:mmproj|vision[-_ ]?projector)/i.test(path.basename(p)))
    .map((p) => ({ name: path.basename(p), path: p, size: fs.statSync(p).size }))
    .sort((a, b) => b.size - a.size);
}

/**
 * 深度扫盘找 .gguf（2026-09-26，徐先：「直接扫一遍电脑」）。
 *
 * 只在用户**明确点了「深度扫描」**时才跑 —— 全盘递归是分钟级的活，
 * 默认那条路（`detectModelDirs`）只去约定俗成的那几个位置。
 * 三条硬约束，缺一条就会把界面卡死或者扫进不该去的地方：
 *   ① 系统目录与开发垃圾目录直接跳过（Windows / Program Files / AppData / node_modules …）；
 *   ② 计数 + 计时双上限（先到先停），超了就把 `truncated` 报上去，界面照实说「没扫完」；
 *   ③ 结果去重、按体积降序。
 *
 * ⚠️ 走 `fs.promises`（异步）：同步版实测会把后端单线程整个堵住，
 *    扫盘那几十秒里画布和优化提示词全都收不到响应。上限仍卡着（45 秒 / 20 万目录）。
 */
export type DeepScanResult = {
  models: LlmModelFile[];
  /** 扫过的目录数（给用户看「扫了多少」，也是截断判据之一）。 */
  dirs: number;
  /** 看过的文件数。 */
  files: number;
  elapsedMs: number;
  /** 撞到上限提前停了 —— 界面要照实说「没扫完」，别让人以为全盘就这些。 */
  truncated: boolean;
};

/** 这些目录进去只有浪费时间：`Windows` 里不可能有模型，`node_modules` 里全是别人的包。 */
const DEEP_SKIP_DIRS = new Set([
  'windows', 'winnt', 'program files', 'program files (x86)', 'programdata', 'appdata',
  '$recycle.bin', 'system volume information', 'recovery', 'perflogs', 'wpsystem', 'wudownloadcache',
  'node_modules', '.git', '.svn', '.cache', '__pycache__', 'dist', 'build', 'vendor',
  'onedrivetemp', 'temp', 'tmp', 'logs',
]);

const DEEP_MAX_DIRS = 200_000;
const DEEP_MAX_MS = 45_000;
const DEEP_MAX_HITS = 500;

export async function deepScanGgufs(roots: string[]): Promise<DeepScanResult> {
  const started = Date.now();
  const seenDir = new Set<string>();
  const hits = new Map<string, number>();
  let dirs = 0;
  let files = 0;
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > 12) return;
    if (dirs > DEEP_MAX_DIRS || Date.now() - started > DEEP_MAX_MS) { truncated = true; return; }
    let entries: fs.Dirent[] = [];
    try {
      /*
       * ⚠️ 必须用**异步** readdir（2026-09-26 实测改过来的）。
       * 同步版扫 E 盘要 45 秒，这 45 秒里后端进程整个被堵住 —— 画布、优化提示词、
       * 状态查询全都收不到响应，用户以为软件卡死了。异步之后等待磁盘的时间能回去处理别的请求。
       */
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 没权限 / 被删了 —— 扫盘时这是常态，不值得报错。
    }
    dirs += 1;
    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;
      if (name.startsWith('.') && name !== '.lmstudio') continue;
      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        if (DEEP_SKIP_DIRS.has(name.toLowerCase())) continue;
        /* 同一层里可能有 junction（比如 `E:\本地` 链到别处）→ 用 realpath 去重，不然会兜圈子。 */
        let key = full;
        try { key = await fs.promises.realpath(full); } catch { /* 读不到就按原样 */ }
        if (seenDir.has(key)) continue;
        seenDir.add(key);
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      if (path.extname(name).toLowerCase() !== '.gguf') continue;
      try {
        hits.set(full, (await fs.promises.stat(full)).size);
      } catch {
        /* 打不开就跳过 */
      }
      if (hits.size >= DEEP_MAX_HITS) { truncated = true; return; }
    }
  };

  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    await walk(root, 0);
  }

  const models: LlmModelFile[] = [...hits.entries()]
    .map(([p, size]) => ({ name: path.basename(p), path: p, size }))
    .sort((a, b) => b.size - a.size);
  return { models, dirs, files, elapsedMs: Date.now() - started, truncated };
}

/** 本机上还活着的盘符（深度扫描的下拉用）。 */
export function listDrives(): string[] {
  const out: string[] = [];
  for (const letter of 'CDEFGHIJK') {
    const root = letter + ':\\';
    if (fs.existsSync(root)) out.push(root);
  }
  return out;
}

/** 扫到的模型**所在目录**（父目录）—— 记进 `modelDirs`，下次不用再扫一遍。 */
export function dirsOfModels(models: LlmModelFile[]): string[] {
  return [...new Set(models.map((m) => path.dirname(m.path)))];
}

/**
 * 挑一个默认模型。
 *
 * 规则：**先排除 4GB 显存装不下的档位**（F16 / Q8 / Q6），再在剩下的里面挑
 * 「不超过 1.6GB 的最大那个」—— 都超了就挑最小的。
 *
 * 为什么不是直接挑最大的：默认运行时不一定有显卡（本机自动找到的是 LM Studio 的
 * CPU 后端），4B 在纯 CPU 上只有个位数 tok/s，一段剧本要等好几分钟，
 * 体验上等于「点了没反应」。小模型跑得动、能立刻看到结果，大模型在下拉里点一下就换。
 */
export function pickDefaultModel(models: LlmModelFile[]): LlmModelFile | null {
  const heavy = /(?:f16|bf16|q8_0|q6_k|q5_k_m)/i;
  const usable = models.filter((m) => !heavy.test(m.name));
  const pool = usable.length ? usable : models;
  const light = pool.filter((m) => m.size <= 1.6 * 1024 * 1024 * 1024);
  if (light.length) return light.sort((a, b) => b.size - a.size)[0];
  return pool.sort((a, b) => a.size - b.size)[0] ?? null;
}

/* -------------------------------------------------------------------- 进程状态 */

let child: ChildProcess | null = null;
let state: LlmState = 'stopped';
let message = '本地模型未启动';
let logTail = '';
let activeSignature = '';
let activeModelPath = '';
let activeServerPath = '';
const activeRequests = new Map<string, AbortController>();

function note(line: string): void {
  const text = line.trim();
  if (!text) return;
  logTail = `${logTail}${text}\n`.slice(-4000);
}

function host(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${host(port)}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/** `/health` 通了不代表能用：端口可能被别的服务占着。必须再验一次对话接口在不在。 */
async function chatApiReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${host(port)}/v1/models`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return false;
    const payload = (await res.json()) as { data?: unknown };
    return Array.isArray(payload?.data);
  } catch {
    return false;
  }
}

export function getLlmStatus(): LlmStatus {
  const settings = getLlmSettings();
  return {
    state,
    message,
    port: settings.port,
    log: logTail,
    running: Boolean(child) && state !== 'stopped',
    modelPath: activeModelPath || settings.modelPath,
    serverPath: settings.serverPath,
    resolvedServerPath: activeServerPath || detectServerExe(),
  };
}

/** 参数签名：这几个值变了才需要重启引擎，其余（温度、top_p…）每次请求单独传。 */
function signature(settings: LlmSettings): string {
  return JSON.stringify([
    settings.modelPath,
    settings.port,
    settings.contextSize,
    settings.gpuLayers,
    settings.flashAttention,
    settings.cacheTypeK,
    settings.cacheTypeV,
    settings.batchSize,
    settings.microBatchSize,
    settings.threads,
    settings.gpuDevice,
  ]);
}

export async function stopLlm(): Promise<LlmStatus> {
  /* 手动卸载时把「待卸载」一起取消，不然那个定时器还会再卸一次。 */
  cancelPendingUnload();
  for (const controller of activeRequests.values()) controller.abort();
  activeRequests.clear();
  const proc = child;
  child = null;
  if (proc && !proc.killed) {
    proc.kill();
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!proc.killed) proc.kill('SIGKILL');
  }
  state = 'stopped';
  message = '本地模型未启动';
  activeSignature = '';
  activeModelPath = '';
  activeServerPath = '';
  return getLlmStatus();
}

function buildArgs(settings: LlmSettings, modelArg: string, extra: boolean): string[] {
  const base = [
    '-m',
    modelArg,
    '--host',
    '127.0.0.1',
    '--port',
    String(settings.port),
    '-c',
    String(settings.contextSize),
    '-ngl',
    settings.gpuLayers < 0 ? 'all' : String(settings.gpuLayers),
    '-fa',
    settings.flashAttention ? 'on' : 'off',
    '-ctk',
    settings.cacheTypeK,
    '-ctv',
    settings.cacheTypeV,
    '-b',
    String(settings.batchSize),
    '-ub',
    String(settings.microBatchSize),
    '-t',
    String(settings.threads),
  ];
  /*
   * 第二批是“锦上添花”的参数：老版本 llama.cpp 不认 `--jinja`，传了它直接退出。
   * 所以它们单独一档，启动失败且日志里出现「不认识的参数」时，去掉它们重试一次。
   */
  if (!extra) return base;
  return [...base, '--parallel', '1', '--cont-batching', '--jinja'];
}

function spawnServer(exe: string, args: string[], cwd: string, gpuDevice: number | null): ChildProcess {
  return spawn(exe, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(gpuDevice === null ? {} : { env: { ...process.env, CUDA_VISIBLE_DEVICES: String(gpuDevice) } }),
  });
}

/** 最近一次子进程退出码。只看它才能区分「缺 DLL」和「参数不对」这两种启动失败。 */
let lastExitCode: number | null = null;

/** 读 `state` 的入口。异步回调会改它，直接读会被 TS 的收窄判成常量 —— 详见 `launch()` 里那处。 */
function currentState(): LlmState {
  return state;
}

function attach(p: ChildProcess, onUnsupported: () => void): void {
  const capture = (chunk: unknown): void => {
    note(String(chunk));
    if (/unrecognized|unknown option|invalid option|error: unknown argument/i.test(String(chunk))) {
      onUnsupported();
    }
  };
  p.stdout?.on('data', capture);
  p.stderr?.on('data', capture);
  p.once('close', (code) => {
    lastExitCode = typeof code === 'number' ? code : null;
    /* ⚠️ 必须先看是不是当前进程：换模型时旧进程晚一步 close，会把新进程的状态覆盖掉。 */
    if (child !== p) return;
    child = null;
    state = code === 0 ? 'stopped' : 'error';
    message =
      code === 0
        ? '本地模型已停止'
        : `llama.cpp 异常退出 (${code ?? '未知'})：${logTail.trim().slice(-400) || '请看上面的引擎日志。'}`;
  });
  p.once('error', (error) => {
    if (child !== p) return;
    state = 'error';
    message = error.message;
    note(error.message);
  });
}

export async function startLlm(patch: Partial<LlmSettings> = {}): Promise<LlmStatus> {
  const settings = saveLlmSettings(patch);

  let modelPath = settings.modelPath;
  if (!modelPath || !fs.existsSync(modelPath)) {
    const found = pickDefaultModel(listLlmModels());
    if (!found) {
      throw new Error('没有找到 GGUF 模型。请在「本地模型」里选择模型文件，或添加一个模型目录后重新扫描。');
    }
    modelPath = found.path;
  }
  if (fs.statSync(modelPath).size < 1024 * 1024) {
    throw new Error(`模型文件异常或不完整：${path.basename(modelPath)}`);
  }

  const exes = [
    ...new Set([
      ...(settings.serverPath && fs.existsSync(settings.serverPath) ? [settings.serverPath] : []),
      ...listServerCandidates(),
    ]),
  ];
  if (!exes.length) {
    throw new Error(
      '没有找到 llama.cpp 的 llama-server.exe。请下载 llama.cpp 的 Windows 发行包（b 号越大越新，要 CUDA 版），解压后在「本地模型」里选中 llama-server.exe。',
    );
  }

  /*
   * 逐个候选试，不是只试第一个。
   *
   * 原因很实在：本机上排在最前的是 LM Studio 的 CUDA 后端，它**起不来**
   * （退出码 0xC0000135，缺 cublas/cudart，而机器没装 CUDA Toolkit）。
   * 只认第一个的话用户看到的就是「启动失败」四个字，而明明换一个就能用。
   */
  let lastFailure = '';
  for (const exe of exes) {
    const outcome = await launch(exe, modelPath);
    if (outcome === 'ok') return getLlmStatus();
    lastFailure = outcome;
  }
  throw new Error(lastFailure || '所有候选运行时都启动失败，请看上面的引擎日志。');
}

/** 缺 DLL 的退出码：0xC0000135（找不到）与 0xC0000142（初始化失败）。 */
const DLL_MISSING = new Set([3221225781, 3221225794]);

async function launch(exe: string, modelPath: string): Promise<'ok' | string> {
  const next = saveLlmSettings({ modelPath, serverPath: exe });
  const nextSignature = signature(next);

  if (child && activeSignature === nextSignature && (await healthy(next.port))) {
    if (await chatApiReady(next.port)) {
      state = 'ready';
      message = `已加载 ${path.basename(next.modelPath)}`;
      return 'ok';
    }
    await stopLlm();
    throw new Error(
      `本地推理端口 ${next.port} 已被别的服务占用，而且它不提供 /v1/chat/completions。请关掉占用该端口的程序，或换一个端口后重试。`,
    );
  }
  await stopLlm();

  /*
   * 中文路径：llama.cpp 用的是窄字符 API，路径里有非 ASCII 就读不到文件。
   * 与 YUH 的处理一致 —— cwd 切到模型目录、参数只留文件名，让它按相对路径解析。
   */
  let cwd = path.dirname(exe);
  let modelArg = modelPath;
  if (/[^\x00-\x7f]/.test(modelPath)) {
    if (/[^\x00-\x7f]/.test(path.basename(modelPath))) {
      throw new Error('模型文件名包含中文，llama.cpp 无法读取。请把模型改名成纯英文（目录有中文没关系）。');
    }
    cwd = path.dirname(modelPath);
    modelArg = path.basename(modelPath);
    note('>>> 模型目录包含中文，已改用相对路径加载');
  }

  state = 'starting';
  message = `正在加载 ${path.basename(next.modelPath)}`;
  logTail = '';
  lastExitCode = null;
  note(`>>> ${exe}`);

  /* 「去掉 --jinja 重试」只在这一次启动里允许一次，否则失败时会一直重启下去。 */
  let unsupportedFlag = false;
  let retriedWithoutExtra = false;
  const flag = (): void => {
    unsupportedFlag = true;
  };
  let proc = spawnServer(exe, buildArgs(next, modelArg, true), cwd, next.gpuDevice);
  child = proc;
  activeModelPath = next.modelPath;
  activeServerPath = exe;
  activeSignature = nextSignature;
  attach(proc, flag);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await healthy(next.port)) {
      if (!(await chatApiReady(next.port))) {
        await stopLlm();
        throw new Error(`端口 ${next.port} 上有服务，但它不是 llama.cpp 的对话服务。请换一个端口。`);
      }
      state = 'ready';
      message = `已加载 ${path.basename(next.modelPath)}`;
      return 'ok';
    }
    /*
     * ⚠️ 这里必须走 `currentState()` 而不是直接读 `state`。
     *
     * `state` 是模块级的 `let`，TS 的控制流分析在 `state = 'starting'` 之后就把它
     * 收窄成了 `'starting'`，再 `state === 'error'` 会被判成「永远不成立」而编译失败。
     * 而实际上 `close` 回调会在两次 `await` 之间把它改成 `'error'` —— 编译器看不到
     * 这一层异步改动。套一层函数调用，收窄就断了。
     */
    if (currentState() === 'error' || !child) {
      /* 老版本不认 `--jinja` 这一档参数时，去掉它们再起一次。 */
      if (unsupportedFlag && !retriedWithoutExtra) {
        retriedWithoutExtra = true;
        unsupportedFlag = false;
        note('>>> 检测到旧版 llama.cpp，已去掉 --jinja 等参数重试');
        proc = spawnServer(exe, buildArgs(next, modelArg, false), cwd, next.gpuDevice);
        child = proc;
        state = 'starting';
        attach(proc, flag);
        continue;
      }
      /*
       * 缺 DLL 不是这台机器的错，是这个运行时的错 —— 换下一个候选，别在这里判死刑。
       *
       * 判据放宽到「退出码是缺库」**或**「一行输出都没有就退了」：后者覆盖
       * `close` 事件拿不到退出码的情况（Node 偶尔给 null），
       * 而一个正常的 llama-server 就算启动失败也一定会先打出几行 banner。
       */
      const silent = !logTail
        .split('\n')
        .some((line) => line.trim() && !line.trim().startsWith('>>>'));
      /* ⚠️ 先接成一个 const 再用：`lastExitCode` 是回调里反复写的 `let`，
         控制流收不住它的类型（模板串里那个 `>>>` 会报「可能为 null」）。 */
      const code = lastExitCode;
      const missing = code !== null && DLL_MISSING.has(code);
      if (missing || silent) {
        return `${path.basename(path.dirname(exe))} 没能启动${missing ? `（退出码 0x${(code >>> 0).toString(16)}）` : ''}：通常缺运行库（比如这份 llama.cpp 依赖系统里的 CUDA 运行库，而机器上没装）。`;
      }
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  await stopLlm();
  throw new Error(`模型加载超时（${Math.round(START_TIMEOUT_MS / 1000)} 秒）。请检查显存是否够用，以及上面的引擎日志。`);
}

/* ---------------------------------------------------------------------- 推理 */

export type CompleteInput = {
  requestId?: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** 让模型停下来不继续往下编的字符串（剧本里用它截断多余的场景）。 */
  stop?: string[];
};

export type CompleteResult = {
  content: string;
  elapsedMs: number;
  tokensPerSecond?: number;
  completionTokens?: number;
  promptTokens?: number;
};

export async function completeLlm(input: CompleteInput): Promise<CompleteResult> {
  if (!input.prompt.trim()) throw new Error('请输入要处理的文字');
  const settings = getLlmSettings();
  if (state !== 'ready' || !child) throw new Error('本地模型还没启动，请先点「启动引擎」。');

  const controller = new AbortController();
  const requestId = input.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeRequests.set(requestId, controller);

  const messages: { role: 'system' | 'user'; content: string }[] = [];
  if (input.system && input.system.trim()) messages.push({ role: 'system', content: input.system.trim() });
  messages.push({ role: 'user', content: input.prompt });

  const started = Date.now();
  try {
    const res = await fetch(`${host(settings.port)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: path.basename(settings.modelPath || 'local'),
        messages,
        max_tokens: Math.round(clamp(input.maxTokens, settings.maxTokens, 64, 16384)),
        temperature: clamp(input.temperature, settings.temperature, 0, 2),
        top_p: settings.topP,
        top_k: settings.topK,
        min_p: settings.minP,
        repeat_penalty: settings.repeatPenalty,
        seed: settings.seed,
        stream: false,
        /*
         * ⚠️ 必须显式关掉思考。
         *
         * Qwen3.5 默认走 thinking：模型会先写一大段思考过程，再写正文。
         * 实测同一条请求，不开这个开关时 64 个 token 全被思考吃掉，`content` 是**空字符串**
         * —— 界面上表现成「模型没说话」，而 usage 显示一切正常，极难联想到是思考吃掉了预算。
         * 剧本生成不需要思考链：它既拖慢速度又把 token 花在看不见的地方。
         */
        chat_template_kwargs: { enable_thinking: false },
        ...(input.stop && input.stop.length ? { stop: input.stop } : {}),
      }),
    });
    const payload = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { completion_tokens?: number; prompt_tokens?: number };
      timings?: { predicted_per_second?: number; tokens_per_second?: number };
      error?: { message?: string };
      message?: string;
    };
    if (!res.ok) {
      throw new Error(payload?.error?.message || payload?.message || `llama.cpp 请求失败 (${res.status})`);
    }
    const completionTokens = Number(payload?.usage?.completion_tokens) || undefined;
    const elapsedMs = Date.now() - started;
    const reported = Number(payload?.timings?.predicted_per_second || payload?.timings?.tokens_per_second) || undefined;
    return {
      content: String(payload?.choices?.[0]?.message?.content || '').trim(),
      elapsedMs,
      completionTokens,
      promptTokens: Number(payload?.usage?.prompt_tokens) || undefined,
      tokensPerSecond: reported || (completionTokens ? completionTokens / Math.max(1e-3, elapsedMs / 1000) : undefined),
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('这次生成已取消');
    throw error;
  } finally {
    activeRequests.delete(requestId);
  }
}

export function cancelLlm(requestId: string): boolean {
  const controller = activeRequests.get(requestId);
  if (!controller) return false;
  controller.abort();
  activeRequests.delete(requestId);
  return true;
}

/** 退出前必须调：不然 llama-server 会变成孤儿进程一直占着显存。 */
export function shutdownLlm(): void {
  cancelPendingUnload();
  if (child && !child.killed) child.kill();
  child = null;
}

/* ------------------------------------------------------------------ 按需装载 */

/**
 * 「用一次就卸」那一套的编排入口（2026-09-27）。
 *
 * 设置页「文本」段选中「本地」之后，优化提示词走的就是这里：
 * **装载 → 跑 → 按保活决定卸不卸**。默认 `keepAliveSeconds = 0` = 跑完立刻卸，
 * 显存一次都不多占。
 *
 * 三件事必须一起做对：
 * 1. **同一时刻只装载一次**：两个优化请求同时在飞，第二次要等第一次装载完，
 *    而不是各自 spawn 一个 llama-server（两个进程会抢同一块显存，双双失败）。
 * 2. **保活期又来了请求要先取消待卸载**：否则那个定时器会在优化跑到一半时
 *    把进程 kill 掉，用户看到的是「优化失败」而根因在卸载那侧。
 * 3. **卸载只发生在请求结束后**（`finally`）：`stopLlm()` 会 abort 在飞的请求，
 *    提前卸就等于把正在生成的那次掐死。
 */
let pendingUnload: NodeJS.Timeout | null = null;
let loading: Promise<void> | null = null;

function cancelPendingUnload(): void {
  if (!pendingUnload) return;
  clearTimeout(pendingUnload);
  pendingUnload = null;
}

/** 装载。已经在跑就直接返回；正在装载就等那一次（不重复 spawn）。 */
export async function ensureLlmLoaded(): Promise<void> {
  cancelPendingUnload();
  if (state === 'ready' && child) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      await startLlm();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * 按保活设置决定「现在卸」还是「过一会儿卸」。
 *
 * `unref()` 是必须的：定时器要是把后端进程钉住，退出时会少那么一段时间 ——
 * 而后端退出本来就是靠 `shutdownLlm()` 收尾的，两件事不该互相牵扯。
 */
export function releaseLlm(keepAliveSeconds?: number): void {
  const settings = getLlmSettings();
  const raw = Math.round(keepAliveSeconds ?? settings.keepAliveSeconds);
  cancelPendingUnload();
  /*
   * 负数 = 「一直装载」（2026-09-26 徐先要的模式一）：**不排任何卸载**，
   * 模型留在显存里，等用户手动卸载（或退出应用时 `shutdownLlm()` 收尾）。
   *
   * 这里不能偷懒给一个很大的秒数：那到点了照样卸，而用户点这一档时的预期是
   * 「我说了算」—— 他要的是连着改十次提示词都不用再等装载（大模型首次装载实测几十秒）。
   */
  if (raw < 0) return;
  const seconds = Math.round(clamp(raw, settings.keepAliveSeconds, 0, 3600));
  if (seconds <= 0) {
    void stopLlm().catch(() => undefined);
    return;
  }
  pendingUnload = setTimeout(() => {
    pendingUnload = null;
    void stopLlm().catch(() => undefined);
  }, seconds * 1000);
  pendingUnload.unref?.();
}

/**
 * 一次「装载 → 跑 → 按保活卸」。
 *
 * ⚠️ `finally` 里卸：装载成功、模型跑挂了、上游报错 —— 任何一种都得卸。
 * 少卸一次就是几 GB 显存一直挂着，而且用户完全看不出是谁占的。
 */
export async function withLocalModel<T>(run: () => Promise<T>, keepAliveSeconds?: number): Promise<T> {
  await ensureLlmLoaded();
  try {
    return await run();
  } finally {
    releaseLlm(keepAliveSeconds);
  }
}

/**
 * 「优化提示词走本地」要的那个 OpenAI 兼容端点。
 *
 * `baseUrl` 末尾带 `/v1`，跟 `lib/providers/text.ts` 里 `chatEndpointCandidates()`
 * 的期望一致（它会自己拼 `/chat/completions`）。模型名只用于显示与请求体，
 * llama-server 不校验它。
 */
export function localTextTarget(): { baseUrl: string; model: string; label: string; port: number } {
  const settings = getLlmSettings();
  const modelPath = activeModelPath || settings.modelPath || pickDefaultModel(listLlmModels())?.path || '';
  const name = modelPath ? path.basename(modelPath).replace(/\.gguf$/i, '') : '';
  return {
    baseUrl: `${host(settings.port)}/v1`,
    model: name || 'local',
    label: name ? `本地 · ${name}` : '本地模型',
    port: settings.port,
  };
}

/* ------------------------------------------------------------------ 显存估算 */

/**
 * GGUF 文件头里那几个「算显存必须知道」的数（2026-09-27）。
 *
 * 为什么非得去读文件头：显存占用 = 权重 + **KV 缓存**，而
 * KV 缓存 = 层数 × KV 头数 × 每头维度 × 2（K 与 V）× 每值字节数 × 上下文长度。
 * 这几个数只写在模型文件里，从文件名（甚至文件大小）都推不出来 ——
 * 猜的结果就是「算出来 1.8 GB，一装还是爆」，而这个功能的全部意义就是别让用户试出来。
 *
 * 只读文件头（最多 1 MB）：词表那种几万条的大数组排在元数据区后面，
 * 读不到就当「没读出来」，由调用方给出「粗估」的说明，不能假装算准了。
 */
export type GgufMeta = {
  architecture: string;
  name: string;
  sizeLabel: string;
  /** Transformer 层数。 */
  blockCount: number;
  embeddingLength: number;
  headCount: number;
  headCountKv: number;
  /** 每个 K / V 头的维度：新模型直接给 `attention.key_length`，老的用 embedding / headCount 推。 */
  headDim: number;
  contextLength: number;
  parameters: number;
};

/** GGUF v3 的 value 类型。 */
const GGUF_TYPE = {
  U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STR: 8, ARR: 9, U64: 10, I64: 11, F64: 12,
};

function readGgufValue(buf: Buffer, off: number, vtype: number): { value: unknown; next: number } {
  switch (vtype) {
    case GGUF_TYPE.U8: return { value: buf.readUInt8(off), next: off + 1 };
    case GGUF_TYPE.I8: return { value: buf.readInt8(off), next: off + 1 };
    case GGUF_TYPE.U16: return { value: buf.readUInt16LE(off), next: off + 2 };
    case GGUF_TYPE.I16: return { value: buf.readInt16LE(off), next: off + 2 };
    case GGUF_TYPE.U32: return { value: buf.readUInt32LE(off), next: off + 4 };
    case GGUF_TYPE.I32: return { value: buf.readInt32LE(off), next: off + 4 };
    case GGUF_TYPE.F32: return { value: buf.readFloatLE(off), next: off + 4 };
    case GGUF_TYPE.BOOL: return { value: buf.readUInt8(off) !== 0, next: off + 1 };
    case GGUF_TYPE.STR: {
      const len = Number(buf.readBigUInt64LE(off));
      const start = off + 8;
      return { value: buf.toString('utf8', start, start + len), next: start + len };
    }
    case GGUF_TYPE.ARR: {
      /* 数组元素一个都不需要（rope / tokenizer 那些），只管跳过。 */
      const etype = buf.readUInt32LE(off);
      const count = Number(buf.readBigUInt64LE(off + 4));
      let p = off + 12;
      for (let i = 0; i < count; i++) {
        const r = readGgufValue(buf, p, etype);
        p = r.next;
        if (p >= buf.length) break;
      }
      return { value: null, next: p };
    }
    case GGUF_TYPE.U64: return { value: Number(buf.readBigUInt64LE(off)), next: off + 8 };
    case GGUF_TYPE.I64: return { value: Number(buf.readBigInt64LE(off)), next: off + 8 };
    case GGUF_TYPE.F64: return { value: buf.readDoubleLE(off), next: off + 8 };
    default: throw new Error('未知的 GGUF 值类型：' + vtype);
  }
}

/** 读文件头。读不出来（不是 GGUF / 版本不认 / 文件太小）就返回 null，让调用方照实说。 */
export function readGgufMeta(file: string): GgufMeta | null {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const size = fs.statSync(file).size;
    if (size < 64) return null;
    const take = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(take);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, take, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (buf.toString('latin1', 0, 4) !== 'GGUF') return null;
    let off = 4;
    const version = buf.readUInt32LE(off);
    off += 4;
    if (version !== 3) return null;
    /* 头部剩下的两段：tensor_count(8) + kv_count(8)。 */
    const kvCount = Number(buf.readBigUInt64LE(off + 8));
    off += 16;
    const kv: Record<string, unknown> = {};
    for (let i = 0; i < kvCount; i++) {
      if (off + 12 > buf.length) break;
      const keyLen = Number(buf.readBigUInt64LE(off));
      off += 8;
      if (keyLen > buf.length - off) break;
      const key = buf.toString('utf8', off, off + keyLen);
      off += keyLen;
      const vtype = buf.readUInt32LE(off);
      off += 4;
      const r = readGgufValue(buf, off, vtype);
      off = r.next;
      kv[key] = r.value;
    }
    const architecture = String(kv['general.architecture'] ?? '');
    if (!architecture) return null;
    const num = (k: string) => {
      const v = Number(kv[k] ?? 0);
      return Number.isFinite(v) ? v : 0;
    };
    const headCount = num(`${architecture}.attention.head_count`);
    const embedding = num(`${architecture}.embedding_length`);
    return {
      architecture,
      name: String(kv['general.name'] ?? ''),
      sizeLabel: String(kv['general.size_label'] ?? ''),
      blockCount: num(`${architecture}.block_count`),
      embeddingLength: embedding,
      headCount,
      headCountKv: num(`${architecture}.attention.head_count_kv`) || headCount,
      headDim: num(`${architecture}.attention.key_length`) || (headCount ? Math.round(embedding / headCount) : 0),
      contextLength: num(`${architecture}.context_length`),
      parameters: num('general.parameter_count'),
    };
  } catch {
    return null;
  }
}

/** KV 缓存每种数据类型的每值字节数。认不出来按 q8_0（1 字节）算 —— 那是我们的默认值。 */
const CACHE_BYTES: Record<string, number> = {
  f32: 4, f16: 2, bf16: 2, q8_0: 1, q6_k: 0.75, q5_0: 0.625, q5_1: 0.625,
  q4_0: 0.5, q4_1: 0.5, q4_k: 0.55, iq4: 0.55, q3_k: 0.4, q2_k: 0.3,
};

function cacheBytesPerValue(type: string): number {
  const key = String(type || '').trim().toLowerCase();
  return CACHE_BYTES[key] ?? 1;
}

export type VramEstimate = {
  /** 元数据读出来了才算得准；false 时下面那几个数只能当大致量级看。 */
  ok: boolean;
  note: string;
  modelPath: string;
  contextSize: number;
  /** 权重上显卡的部分（GB）。 */
  weightsGb: number;
  /** KV 缓存（GB）—— 随上下文长度线性增长，调大上下文主要就涨这一项。 */
  kvGb: number;
  /** 运行开销：compute buffer / 计算图 / 后端自身（GB）。 */
  overheadGb: number;
  totalGb: number;
  /** true = 全在 CPU 跑（gpuLayers 设为 0），不吃显存。 */
  cpuOnly: boolean;
  meta: GgufMeta | null;
};

/**
 * 估算「这个模型 + 这个上下文」要占多少显存。
 *
 * 三块相加：
 * - **权重**：量化后的 .gguf 基本就是权重本身，直接取文件大小；
 *   再乘 4% 给张量对齐 / 元数据那些零头。`gpuLayers` 是 0 就一块都不上显卡，
 *   在 0 和层数之间时按层数比例粗算（llama.cpp 是按层切的，比例近似成立）。
 * - **KV 缓存**：见上面 `readGgufMeta` 的说明。**这一项随上下文线性增长** ——
 *   4096 → 32768 就是八倍，本机 4GB 显存上这是能不能装下的分水岭。
 * - **运行开销**：不随模型和上下文变的常数，实测 Vulkan 后端 0.3~0.8 GB，取 0.45。
 */
export function estimateLlmVram(input: {
  modelPath?: string;
  contextSize?: number;
  cacheTypeK?: string;
  cacheTypeV?: string;
  gpuLayers?: number;
} = {}): VramEstimate {
  const settings = getLlmSettings();
  const modelPath = String(input.modelPath ?? '').trim()
    || settings.modelPath
    || pickDefaultModel(listLlmModels())?.path
    || '';
  const contextSize = Math.round(clamp(input.contextSize ?? settings.contextSize, settings.contextSize, 512, 65536));
  const gpuLayers = Math.round(clamp(input.gpuLayers ?? settings.gpuLayers, settings.gpuLayers, -1, 9999));
  const cacheBytes = (cacheBytesPerValue(input.cacheTypeK ?? settings.cacheTypeK)
    + cacheBytesPerValue(input.cacheTypeV ?? settings.cacheTypeV)) / 2;

  let sizeBytes = 0;
  try {
    if (modelPath && fs.existsSync(modelPath)) sizeBytes = fs.statSync(modelPath).size;
  } catch {
    sizeBytes = 0;
  }

  const meta = readGgufMeta(modelPath);
  const cpuOnly = gpuLayers === 0;
  /* -1 = 全部上显卡；0 = 全在 CPU；0 < n < 层数 = 只上 n 层。 */
  const onGpu = cpuOnly ? 0
    : gpuLayers < 0 ? 1
      : meta?.blockCount ? Math.min(1, gpuLayers / meta.blockCount)
        : 1;

  const weightsGb = (sizeBytes * onGpu * 1.04) / 1024 ** 3;
  const perToken = meta && meta.blockCount > 0 && meta.headDim > 0 && meta.headCountKv > 0
    ? meta.blockCount * meta.headCountKv * meta.headDim * 2 * cacheBytes
    : 0;
  /*
   * ⚠️ KV 缓存也要乘 `onGpu`：不上显卡的层，它的 KV 就在内存里，不算显存。
   * 少了这一个因子，「纯 CPU 推理」会算出 0.09 GB 的显存 —— 看着不大，
   * 但这功能就是要让人信得过，一个假的数字比没有更糟。
   */
  const kvGb = perToken ? (perToken * contextSize * onGpu) / 1024 ** 3 : 0;
  /* 同理：模型文件都不在，就没有「引擎跑起来」这回事，开销也是 0。 */
  const overheadGb = sizeBytes > 0 && onGpu > 0 ? 0.45 : 0;
  const totalGb = weightsGb + kvGb + overheadGb;

  let note = '';
  if (!modelPath) note = '还没选模型文件，没法算。';
  else if (!sizeBytes) note = '这个模型文件现在读不到了（被挪走或删了？）—— 换一个再算。';
  else if (!meta) note = '这个文件的头信息没读出来，KV 缓存那一项算不出来 —— 下面是权重部分，实际会更高。';
  else if (contextSize > meta.contextLength && meta.contextLength > 0) {
    note = `这个模型训练时的上下文是 ${meta.contextLength}，调到 ${contextSize} 超出它的设计长度，长文质量会掉。`;
  }
  if (cpuOnly) note = (note ? note + ' ' : '') + '现在是 0 层上显卡（纯 CPU 推理），不吃显存，但会慢很多。';

  return {
    ok: Boolean(meta) && sizeBytes > 0,
    note,
    modelPath,
    contextSize,
    weightsGb: Math.round(weightsGb * 100) / 100,
    kvGb: Math.round(kvGb * 100) / 100,
    overheadGb: Math.round(overheadGb * 100) / 100,
    totalGb: Math.round(totalGb * 100) / 100,
    cpuOnly,
    meta,
  };
}

/**
 * 本机显卡显存总量（GB）。
 *
 * 只做一次尽力探测：没 N 卡 / 没装驱动 / 命令超时 → 返回 null，界面上就不显示这一项。
 * ⚠️ 必须带超时：这条命令在某些机器上会卡住，而后端是单线程的。
 */
export async function probeDeviceVramGb(): Promise<number | null> {
  const out = await new Promise<string>((resolve) => {
    let done = false;
    const finish = (text: string) => {
      if (done) return;
      done = true;
      resolve(text);
    };
    try {
      const p = spawn('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], {
        windowsHide: true,
      });
      let text = '';
      p.stdout?.on('data', chunk => { text += String(chunk); });
      const timer = setTimeout(() => {
        try { p.kill(); } catch { /* noop */ }
        finish(text);
      }, 3000);
      p.on('error', () => { clearTimeout(timer); finish(text); });
      p.on('close', () => { clearTimeout(timer); finish(text); });
    } catch {
      finish('');
    }
  });
  const mb = Number(String(out).trim().split(/\s+/)[0]);
  return Number.isFinite(mb) && mb > 0 ? Math.round((mb / 1024) * 10) / 10 : null;
}
