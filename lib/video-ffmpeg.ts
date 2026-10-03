import 'server-only';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { db } from '@/lib/db';
import { storageRoot } from '@/lib/storage-root';
import { mediaRoot, outputRoot, resolveStoredPath } from '@/lib/output-dir';
import { runtimePaths } from '@/lib/runtime-paths';

/**
 * 视频拼接工具的后半段 —— FFmpeg 那一层。
 *
 * 这块的原型是 `D:\ai\www\video_cutter_joiner.py`（徐先自己的 Tkinter 小工具），
 * 搬进来时只保留了**算法**，壳子换成了 Holy Light画布自己的：
 *
 *  - 素材一律是**资产库里的 Asset**（只认 `assetId`，绝不从渲染进程收文件路径 ——
 *    否则一个改过的包就能让 ffmpeg 去读盘上任意位置）；
 *  - 逐片段 trim + scale/pad/fps 归一 → `concat -c copy`，与原型逐字一致；
 *  - 多出来的只有**图片当素材**这一档（原型只会拼视频）：`-loop 1 -t 帧数/帧率`。
 *
 * ⚠️ 后端进程里 `writeResponse()` 会把响应**整块 buffer 完才写**（见
 * `electron/backend/index.ts`），所以进度**不能**用 SSE —— 只能起任务 + 轮询。
 * 这里就按这个约束设计：`startExport()` 立刻回一个 jobId，进度靠 `job()` 查。
 */

/* ------------------------------------------------------------------ *
 * FFmpeg 在哪
 * ------------------------------------------------------------------ */

const CONFIG_NAME = 'video-ffmpeg.json';
const IS_WIN = process.platform === 'win32';

type Binaries = { ffmpeg: string; ffprobe: string; source: 'bundled' | 'custom' | 'detected' | 'none' };
type Stored = { ffmpeg?: string; ffprobe?: string };

let cache: Binaries | undefined;

function configFile(): string {
  return path.join(storageRoot(), CONFIG_NAME);
}

function exe(base: string): string {
  return IS_WIN ? `${base}.exe` : base;
}

async function isFile(target: string): Promise<boolean> {
  try {
    const info = await stat(/*turbopackIgnore: true*/ target);
    return info.isFile();
  } catch {
    return false;
  }
}

/** `where` / `which` 这两个命令在 Windows 上叫 where —— 认不出就当 PATH 里没有。 */
function whichLike(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(IS_WIN ? 'where' : 'which', [name], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout?.on('data', (chunk) => {
        out += String(chunk);
      });
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      child.on('error', () => finish(null));
      child.on('close', () => finish(out.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null));
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 卡住的 where 杀掉就行 */
        }
        finish(null);
      }, 5000);
      timer.unref?.();
    } catch {
      resolve(null);
    }
  });
}

/** 徐先这台机器上 ffmpeg 就在 `D:\ai\ffmpeg-...\bin`，先照这个形状找一遍。 */
const FIXED_DIRS = [
  'D:\\ai\\ffmpeg-2026-07-27-git-a757b708ae-essentials_build\\bin',
  'C:\\ffmpeg\\bin',
  'C:\\Program Files\\ffmpeg\\bin',
  'D:\\ffmpeg\\bin',
];

/** 这几个根目录**只扫一层**：找名字以 ffmpeg 开头的子目录，再看它底下有没有 bin。 */
const SCAN_ROOTS = ['D:\\ai', 'C:\\ai', 'C:\\tools', 'D:\\tools'];

async function scanDirs(): Promise<string[]> {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    try {
      const entries = await readdir(/*turbopackIgnore: true*/ root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^ffmpeg/i.test(entry.name)) continue;
        out.push(path.join(root, entry.name, 'bin'), path.join(root, entry.name));
      }
    } catch {
      /* 目录不存在 / 没权限：这台机器上就没有，跳过 */
    }
  }
  return out;
}

/**
 * 随包分发的那一份 —— 安装目录下 `resources/ffmpeg/`（见 package.json 的 `extraResources`）。
 *
 * 这一档是「新装的机器开箱能用」的唯一保证：以前要用户自己下 FFmpeg、自己在带 git hash
 * 的目录里找到 `bin`、再填进来 —— 对不写代码的人等于「这个功能坏了」。
 */
function bundledDir(): string {
  return path.join(runtimePaths().resourcesDir, 'ffmpeg');
}

async function bundledBinaries(): Promise<Binaries | null> {
  const dir = bundledDir();
  const ffmpeg = path.join(dir, exe('ffmpeg'));
  if (!(await isFile(ffmpeg))) return null;
  const ffprobe = path.join(dir, exe('ffprobe'));
  return { ffmpeg, ffprobe: (await isFile(ffprobe)) ? ffprobe : '', source: 'bundled' };
}

async function detect(): Promise<Binaries | null> {
  for (const dir of [...FIXED_DIRS, ...(await scanDirs())]) {
    const ffmpeg = path.join(dir, exe('ffmpeg'));
    if (!(await isFile(ffmpeg))) continue;
    const ffprobe = path.join(dir, exe('ffprobe'));
    return { ffmpeg, ffprobe: (await isFile(ffprobe)) ? ffprobe : '', source: 'detected' };
  }
  const fromPath = await whichLike(exe('ffmpeg'));
  if (fromPath && (await isFile(fromPath))) {
    const ffprobe = path.join(path.dirname(fromPath), exe('ffprobe'));
    return { ffmpeg: fromPath, ffprobe: (await isFile(ffprobe)) ? ffprobe : '', source: 'detected' };
  }
  return null;
}

async function readStored(): Promise<Stored | null> {
  try {
    const raw = await readFile(/*turbopackIgnore: true*/ configFile(), 'utf8');
    return JSON.parse(raw) as Stored;
  } catch {
    return null;
  }
}

/**
 * 生效中的 ffmpeg / ffprobe。
 *
 * 顺序：**用户自选 → 随包自带 → 自动探测**。配过但文件又没了（换机器、删了目录）就退回后两档，
 * 而不是报「找不到」—— 那种时候自动探测往往能救回来。
 */
export async function binaries(): Promise<Binaries> {
  if (cache) return cache;
  /*
   * 顺序：**用户自选 → 随包自带 → 自动探测**。
   *
   * 自带的排在探测前面，是因为探测那条路只在徐先这台机器上刚好命中
   * （`D:\ai\ffmpeg-2026-…`），换台机器就什么都没有。
   *
   * 但**用户显式指定过就还听他的** —— 他可能就是想用自己那份更新的版本；
   * 把显式配置压在自带后面，症状会是「我明明设了却没生效」，比不内置还难查。
   */
  const stored = await readStored();
  const configured = String(stored?.ffmpeg || '').trim();
  if (configured && (await isFile(configured))) {
    const ffprobe = String(stored?.ffprobe || '').trim();
    cache = { ffmpeg: configured, ffprobe: ffprobe && (await isFile(ffprobe)) ? ffprobe : '', source: 'custom' };
    return cache;
  }
  const bundled = await bundledBinaries();
  if (bundled) {
    cache = bundled;
    return cache;
  }
  cache = (await detect()) ?? { ffmpeg: '', ffprobe: '', source: 'none' };
  return cache;
}

/** 给界面看的状态：能不能用、用的是哪个。 */
export async function ffmpegStatus(): Promise<Binaries & { ok: boolean; message: string; version: string }> {
  const bin = await binaries();
  if (!bin.ffmpeg) {
    return { ...bin, ok: false, message: 'FFmpeg 没找到 —— 随包自带的那份似乎不在了（安装包可能被裁过），在下面选一个 ffmpeg.exe（同目录有 ffprobe.exe 最好）。', version: '' };
  }
  const probe = await runCapture([bin.ffmpeg, '-version'], 15000);
  const version = probe.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? '';
  if (probe.code) {
    return { ...bin, ok: false, message: `FFmpeg 跑不起来：${probe.stderr.trim() || '未知原因'}`, version: '' };
  }
  const message = !bin.ffprobe
    ? '找到了 FFmpeg，但同目录没有 ffprobe —— 换一个带 ffprobe 的目录。'
    : bin.source === 'bundled'
      ? 'FFmpeg 与 FFprobe 都就绪（软件自带，不用自己下载）。'
      : bin.source === 'custom'
        ? 'FFmpeg 与 FFprobe 都就绪（用的是你指定的那一份）。'
        : 'FFmpeg 与 FFprobe 都就绪。';
  return { ...bin, ok: Boolean(bin.ffprobe), message, version };
}

/**
 * 记下用户选的 ffmpeg。收**文件或目录都行**：
 * 给文件时拿它的同目录找 ffprobe，给目录时按 `bin/` 那层找。
 */
export async function saveFfmpeg(input: string): Promise<Binaries & { ok: boolean; message: string; version: string }> {
  const raw = String(input || '').trim();
  if (!raw) {
    cache = undefined;
    await writeConfig(null);
    return ffmpegStatus();
  }
  let dir = raw;
  let file = raw;
  try {
    const info = await stat(/*turbopackIgnore: true*/ raw);
    if (info.isDirectory()) {
      const candidate = path.join(raw, exe('ffmpeg'));
      const nested = path.join(raw, 'bin', exe('ffmpeg'));
      file = (await isFile(candidate)) ? candidate : nested;
      dir = path.dirname(file);
    } else {
      dir = path.dirname(raw);
    }
  } catch {
    throw new Error('这个路径打不开 —— 选一个真实存在的 ffmpeg.exe 或它的 bin 目录。');
  }
  if (!(await isFile(file))) throw new Error('那个地方没有 ffmpeg.exe —— 选到 bin 目录，或者直接选 ffmpeg.exe。');

  const ffprobe = path.join(dir, exe('ffprobe'));
  cache = undefined;
  await writeConfig({ ffmpeg: file, ffprobe: (await isFile(ffprobe)) ? ffprobe : '' });
  return ffmpegStatus();
}

async function writeConfig(value: Stored | null): Promise<void> {
  const root = storageRoot();
  await mkdir(/*turbopackIgnore: true*/ root, { recursive: true });
  await writeFile(/*turbopackIgnore: true*/ configFile(), JSON.stringify(value, null, 2), 'utf8');
}

/** 干活前的一道闸：ffmpeg / ffprobe 缺一个就把话说清楚，不要让它变成一句「导出失败」。 */
async function requireBinaries(): Promise<{ ffmpeg: string; ffprobe: string }> {
  const bin = await binaries();
  if (!bin.ffmpeg) throw new Error('没找到 FFmpeg —— 先在「FFmpeg 设置」里选一下 ffmpeg.exe。');
  if (!bin.ffprobe) throw new Error('没找到 FFprobe —— 它和 ffmpeg.exe 在同一个 bin 目录里，一起选上。');
  return { ffmpeg: bin.ffmpeg, ffprobe: bin.ffprobe };
}

/* ------------------------------------------------------------------ *
 * 跑一条命令
 * ------------------------------------------------------------------ */

type Captured = { code: number; stdout: string; stderr: string };

const MAX_OUT = 200_000;
const MAX_ERR = 40_000;

function runCapture(args: string[], timeout = 30_000): Promise<Captured> {
  return new Promise((resolve) => {
    try {
      const child = spawn(args[0], args.slice(1), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.length > MAX_OUT) stdout = stdout.slice(-MAX_OUT / 2);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > MAX_ERR) stderr = stderr.slice(-MAX_ERR / 2);
      });
      let done = false;
      const finish = (value: Captured) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 杀不掉也只能算了 */
        }
        finish({ code: -1, stdout, stderr: `超时（${Math.round(timeout / 1000)} 秒）` });
      }, timeout);
      child.on('error', () => finish({ code: -1, stdout, stderr: '启动不了 FFmpeg，检查路径有没有选错。' }));
      child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : '启动失败。' });
    }
  });
}

/* ------------------------------------------------------------------ *
 * 探测素材
 * ------------------------------------------------------------------ */

export type Probe = {
  kind: 'video' | 'image';
  width: number;
  height: number;
  fps: number;
  /** 视频＝总帧数；图片＝1。 */
  frames: number;
  duration: number;
  hasAudio: boolean;
};

/** ffprobe 给的是 `30000/1001` 这种分数，`Number('30000/1001')` 是 NaN。 */
function parseRate(value: string): number {
  const text = String(value || '').trim();
  const match = /^(\d+)\/(\d+)$/.exec(text);
  if (match) {
    const den = Number(match[2]);
    const num = Number(match[1]);
    return den ? num / den : 0;
  }
  const direct = Number(text);
  return Number.isFinite(direct) ? direct : 0;
}

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'jpeg', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'apng']);

/**
 * 读一个素材的宽高 / 帧率 / 帧数 / 有没有音轨。
 *
 * 图片也走 ffprobe：它同样能报 `codec_type=video`，只是 `nb_frames` 是 1。
 * 认出是图片时 `fps` 给 0 —— 图片自己没有帧率，它的时长由「占几帧」决定（在界面上填）。
 */
export async function probeFile(file: string): Promise<Probe> {
  const { ffprobe } = await requireBinaries();
  const result = await runCapture(
    [ffprobe, '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    30_000,
  );
  if (result.code) throw new Error(result.stderr.trim() || '读不出这个文件的画面信息。');

  let parsed: { streams?: Record<string, unknown>[]; format?: Record<string, unknown> } = {};
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    throw new Error('FFprobe 返回的内容读不懂 —— 这个文件可能已经损坏。');
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((item) => item?.codec_type === 'video') as Record<string, unknown> | undefined;
  if (!video) throw new Error('这个文件里没有画面 —— 换一个视频或图片。');

  const codec = String(video.codec_name || '').toLowerCase();
  const isImage = IMAGE_CODECS.has(codec);
  const fps = parseRate(String(video.avg_frame_rate || video.r_frame_rate || '0'));
  const duration = Number(video.duration ?? parsed.format?.duration ?? 0) || 0;
  let frames = Number(video.nb_frames || 0) || 0;
  if (!frames && fps && duration) frames = Math.max(1, Math.round(fps * duration));
  if (isImage) frames = 1;

  return {
    kind: isImage ? 'image' : 'video',
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    fps: isImage ? 0 : fps,
    frames,
    duration: isImage ? 0 : duration,
    hasAudio: !isImage && streams.some((item) => item?.codec_type === 'audio'),
  };
}

/* ------------------------------------------------------------------ *
 * 素材 = 资产库里的一条 Asset
 * ------------------------------------------------------------------ */

export type MaterialInfo = {
  assetId: string;
  name: string;
  type: string;
  path: string;
  /** 图片可以直接用取流地址当预览，视频要抽帧。 */
  url: string;
  width: number;
  height: number;
};

/**
 * 资产 id → 本机绝对路径。
 *
 * ⚠️ 这是**唯一**把素材变成路径的地方：渲染进程从头到尾只交 assetId，
 * 库里 `metadata.path` 是我们自己落盘时写的，不是用户能填的东西。
 */
export async function resolveMaterial(assetId: string, userId: string): Promise<MaterialInfo> {
  const asset = await db.asset.findFirst({ where: { id: assetId, userId, type: { in: ['video', 'image'] } } });
  if (!asset) throw new Error('这个素材不在资产库里，或者不属于当前账号。');
  const meta = (asset.metadata || {}) as { path?: string };
  if (!meta.path) throw new Error('这个素材没落盘 —— 重新上传一次再试。');
  const file = await resolveStoredPath(meta.path);
  if (!(await isFile(file))) throw new Error('这个素材的文件已经不在盘上了 —— 重新上传一次再试。');
  return { assetId: asset.id, name: asset.name, type: asset.type, path: file, url: asset.url, width: 0, height: 0 };
}

/* ------------------------------------------------------------------ *
 * 取一帧当预览
 * ------------------------------------------------------------------ */

const PREVIEW_DIR = path.join(os.tmpdir(), 'frame-video-preview');

/**
 * 抽第 `frame` 帧存成 PNG。
 *
 * 为什么不让浏览器用 `<video>` 自己 seek：ffmpeg 的 `trim=start_frame=N` 与浏览器的
 * `currentTime` 是两套编号，差一帧就会「界面上看着是这一帧，切出来是下一帧」。
 * 预览与导出必须同一个 ffmpeg，编号才对得上。
 *
 * 结果按 `cacheKey` 落在临时目录里复用 —— 拖帧滑块时同一个来回不会反复抽同一帧。
 */
export async function framePng(input: { file: string; kind: 'video' | 'image'; fps: number; frame: number; cacheKey: string }): Promise<Buffer> {
  const { ffmpeg } = await requireBinaries();
  await mkdir(/*turbopackIgnore: true*/ PREVIEW_DIR, { recursive: true });
  const target = path.join(PREVIEW_DIR, `${input.cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`);
  if (await isFile(target)) return readFile(/*turbopackIgnore: true*/ target);

  const args = [ffmpeg, '-y'];
  if (input.kind === 'video') {
    const seconds = input.fps ? Math.max(0, input.frame / input.fps) : 0;
    args.push('-ss', seconds.toFixed(6));
  }
  args.push('-i', input.file, '-frames:v', '1', '-vf', "scale='min(960,iw)':-2", target);
  const result = await runCapture(args, 60_000);
  if (result.code) throw new Error(result.stderr.trim() || '抽帧失败。');
  return readFile(/*turbopackIgnore: true*/ target);
}

/**
 * 从一段视频里**均匀抽 N 帧**（2026-10-03：视频反推提示词）。
 *
 * 与 `framePng` 的差别：那边是「界面上拖到第几帧就抽第几帧」（要跟导出的帧号对得上），
 * 这边是「把整段视频摊开看一遍」—— 反推要的是**画面怎么变化**，不是某一帧长什么样。
 * 只发一帧等于把这段视频废掉：镜头运动和前后变化全都丢了，模型写出来的提示词跟看图一样。
 *
 * 抽多少帧：`PROMPT_VIDEO_FRAMES = 4`。再往上加，模型拿到的是一堆几乎一样的帧，
 * 而每帧都要几百 KB 的 base64 —— 收益不涨、超时风险涨。
 *
 * 做法用 `fps=N/duration`（而不是 `select`）：不管这段多长，出来的**正好**是 N 张，
 * 间隔也一定是均匀的。
 */
export const PROMPT_VIDEO_FRAMES = 4;

export async function sampleFramesPng(input: { file: string; count?: number; cacheKey: string }): Promise<Buffer[]> {
  const count = Math.max(1, Math.min(8, Math.floor(input.count || PROMPT_VIDEO_FRAMES)));
  const { ffmpeg } = await requireBinaries();
  const dir = path.join(PREVIEW_DIR, `sample-${input.cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
  await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  const probe = await probeFile(input.file);
  /** 图片素材（fps / duration 都是 0）就只有一帧可抽，别按视频那套算。 */
  const seconds = probe.duration > 0 ? probe.duration : 1;
  const args = [
    ffmpeg, '-y', '-i', input.file,
    '-vf', `fps=${(count / seconds).toFixed(6)},scale='min(960,iw)':-2`,
    '-frames:v', String(count),
    path.join(dir, '%03d.png'),
  ];
  const result = await runCapture(args, 60_000);
  if (result.code) throw new Error(result.stderr.trim() || '抽帧失败。');
  const names = (await readdir(/*turbopackIgnore: true*/ dir)).filter(item => item.endsWith('.png')).sort();
  if (!names.length) throw new Error('这段视频一帧都没抽出来 —— 它可能已经损坏，或者格式 FFmpeg 解不开。');
  return Promise.all(names.map(name => readFile(/*turbopackIgnore: true*/ path.join(dir, name))));
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

export type JoinClip = {
  assetId: string;
  /** 起始帧（含）。图片不看这个。 */
  start: number;
  /** 结束帧（含）。图片不看这个。 */
  end: number;
  /** 图片专用：这张图在成品里占多少帧。 */
  imageFrames: number;
};

export type JobState = 'running' | 'done' | 'error' | 'cancelled';

export type Job = {
  id: string;
  state: JobState;
  pct: number;
  message: string;
  /** 成品的绝对路径。只在 state === 'done' 时有值。 */
  output: string | null;
  /** 成品所在的目录 —— 「打开文件夹」要用，前端自己拼不出这个路径。 */
  outputDir: string | null;
  error: string | null;
};

const jobs = new Map<string, Job & { child?: ReturnType<typeof spawn>; temp?: string }>();
/** 任务表不清理的话，跑一晚上就攒几百条没人看的记录。 */
const MAX_JOBS = 20;

function setJob(id: string, patch: Partial<Job & { child?: ReturnType<typeof spawn>; temp?: string }>) {
  const current = jobs.get(id);
  if (!current) return;
  jobs.set(id, { ...current, ...patch });
}

export function job(id: string): Job | null {
  const found = jobs.get(id);
  if (!found) return null;
  const { child: _child, temp: _temp, ...rest } = found;
  return rest;
}

/** libx264 不接受奇数宽高 —— 素材是 1279×719 时直接报错，这里往下取偶。 */
function even(value: number): number {
  const n = Math.max(2, Math.round(value));
  return n % 2 === 0 ? n : n - 1;
}

type Prepared = {
  name: string;
  path: string;
  kind: 'video' | 'image';
  start: number;
  end: number;
  frames: number;
  fps: number;
  hasAudio: boolean;
  width: number;
  height: number;
  /** 只有图片用得上：这张图在成品里占几帧。 */
  imageFrames: number;
};

/**
 * 起一个导出任务，**立刻**返回 jobId（真正的活儿在后面跑，进度靠 `job()` 查）。
 *
 * 算法与原型逐字一致：先按「第一个片段的尺寸与帧率」把每段归一成同一个
 * 编码参数的小 mp4，再用 `concat -c copy` 拼起来 —— 直接 concat 原始文件会因为
 * 尺寸 / 帧率 / 编码不同而失败或音画不同步。
 */
export function startExport(input: { userId: string; clips: JoinClip[]; outputName: string }): string {
  const id = randomUUID();
  jobs.set(id, { id, state: 'running', pct: 0, message: '正在准备…', output: null, outputDir: null, error: null });
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value;
    if (oldest === undefined) break;
    jobs.delete(oldest);
  }
  void runExport(id, input);
  return id;
}

/** 取消：杀掉正在跑的 ffmpeg，临时目录一并收掉。 */
export function cancelExport(id: string): boolean {
  const found = jobs.get(id);
  if (!found || found.state !== 'running') return false;
  killChild(found.child);
  setJob(id, { state: 'cancelled', message: '已取消', pct: 0 });
  if (found.temp) void rm(/*turbopackIgnore: true*/ found.temp, { recursive: true, force: true });
  return true;
}

function killChild(child: ReturnType<typeof spawn> | undefined): void {
  if (!child || child.killed) return;
  try {
    child.kill();
  } catch {
    /* 已经退了 */
  }
  if (process.platform === 'win32' && child.pid) {
    /* ffmpeg 在 Windows 上偶尔会留下孙子进程，`taskkill /T` 才收得干净。 */
    const reaper = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    reaper.on('error', () => {
      /* 没有 taskkill 就算了 */
    });
  }
}

/** 跑一条 ffmpeg，边跑边把 `-progress` 里的 `out_time_ms` 翻成百分比。 */
function runWithProgress(
  args: string[],
  onProgress: (fraction: number) => void,
  expectedMs: number,
  onChild: (child: ReturnType<typeof spawn>) => void,
): Promise<Captured> {
  return new Promise((resolve) => {
    try {
      const child = spawn(args[0], args.slice(1), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      /* 交出去才能让「取消」真的杀到这个进程 —— 存下来才有得可杀。 */
      onChild(child);
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.length > MAX_OUT) stdout = stdout.slice(-MAX_OUT / 2);
        /* `-progress` 是一组 `key=value`，攒到一段完整的一帧再解析。 */
        const tail = stdout.slice(-4000);
        const match = /out_time_ms=(\d+)/g;
        let hit: RegExpExecArray | null;
        let last = 0;
        while ((hit = match.exec(tail))) last = Number(hit[1]);
        if (last > 0 && expectedMs > 0) onProgress(Math.min(1, last / 1000 / expectedMs));
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > MAX_ERR) stderr = stderr.slice(-MAX_ERR / 2);
      });
      let done = false;
      const finish = (value: Captured) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      child.on('error', () => finish({ code: -1, stdout, stderr: '启动不了 FFmpeg。' }));
      child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : '启动失败。' });
    }
  });
}

async function runExport(id: string, input: { userId: string; clips: JoinClip[]; outputName: string }): Promise<void> {
  let temp: string | null = null;
  try {
    const { ffmpeg } = await requireBinaries();
    if (!input.clips.length) throw new Error('还没有素材 —— 先从资产库或本地加几个。');

    /* 逐个解析 + 探测：顺序保持用户排的顺序，它决定成品里谁在前。 */
    const prepared: Prepared[] = [];
    for (const clip of input.clips) {
      const material = await resolveMaterial(clip.assetId, input.userId);
      const probe = await probeFile(material.path);
      if (probe.kind === 'video') {
        const total = Math.max(1, probe.frames);
        const start = Math.max(0, Math.min(Math.floor(clip.start || 0), total - 1));
        const end = Math.max(start, Math.min(Math.floor(clip.end ?? total - 1), total - 1));
        prepared.push({
          name: material.name,
          path: material.path,
          kind: 'video',
          start,
          end,
          frames: total,
          fps: probe.fps,
          hasAudio: probe.hasAudio,
          width: probe.width,
          height: probe.height,
          imageFrames: 1,
        });
      } else {
        prepared.push({
          name: material.name,
          path: material.path,
          kind: 'image',
          start: 0,
          end: 0,
          frames: 1,
          fps: 0,
          hasAudio: false,
          width: probe.width,
          height: probe.height,
          imageFrames: Math.max(1, Math.round(clip.imageFrames || 0) || 5),
        });
      }
    }

    /* 目标尺寸与帧率跟着**第一个**片段走 —— 与原型一致，也是最不容易让人意外的口径。 */
    const targetW = even(prepared[0].width || 1280);
    const targetH = even(prepared[0].height || 720);
    const targetFps = prepared.find((item) => item.fps > 0)?.fps || 30;

    temp = path.join(os.tmpdir(), `frame-video-join-${id}`);
    setJob(id, { temp });
    await mkdir(/*turbopackIgnore: true*/ temp, { recursive: true });

    const parts: string[] = [];
    for (let index = 0; index < prepared.length; index += 1) {
      if (jobs.get(id)?.state !== 'running') return;
      const clip = prepared[index];
      const out = path.join(temp, `part_${String(index).padStart(3, '0')}.mp4`);
      const shape = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${targetFps.toFixed(6)}`;
      const encode = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p'];
      const audio = ['-f', 'lavfi', '-t', 'DURATION', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];

      let args: string[];
      let expectedMs: number;
      if (clip.kind === 'video') {
        const fps = clip.fps || targetFps;
        const startT = clip.start / fps;
        const endT = (clip.end + 1) / fps;
        const vf = `trim=start_frame=${clip.start}:end_frame=${clip.end + 1},setpts=PTS-STARTPTS,${shape}`;
        expectedMs = Math.max(1, (endT - startT) * 1000);
        args = [ffmpeg, '-y', '-progress', 'pipe:1', '-nostats', '-i', clip.path];
        if (clip.hasAudio) {
          args.push('-vf', vf, '-af', `atrim=start=${startT.toFixed(6)}:end=${endT.toFixed(6)},asetpts=PTS-STARTPTS`);
          args.push(...encode, '-c:a', 'aac', '-ar', '48000', '-ac', '2');
        } else {
          args.push(...audio.map((item) => (item === 'DURATION' ? (endT - startT).toFixed(6) : item)));
          args.push('-map', '0:v:0', '-map', '1:a:0', '-vf', vf, ...encode, '-c:a', 'aac', '-shortest');
        }
      } else {
        const count = clip.imageFrames;
        const seconds = count / targetFps;
        expectedMs = Math.max(1, seconds * 1000);
        args = [ffmpeg, '-y', '-progress', 'pipe:1', '-nostats', '-loop', '1', '-t', seconds.toFixed(6), '-i', clip.path];
        args.push(...audio.map((item) => (item === 'DURATION' ? seconds.toFixed(6) : item)));
        args.push('-map', '0:v:0', '-map', '1:a:0', '-vf', shape, ...encode, '-c:a', 'aac', '-shortest');
      }
      args.push(out);

      const result = await runWithProgress(
        args,
        (fraction) => {
          const base = index / (prepared.length + 1);
          const step = 1 / (prepared.length + 1);
          setJob(id, {
            pct: Math.min(99, Math.round((base + step * fraction) * 100)),
            message: `正在处理第 ${index + 1}/${prepared.length} 段：${clip.name}`,
          });
        },
        expectedMs,
        (child) => setJob(id, { child }),
      );
      if (jobs.get(id)?.state !== 'running') return;
      if (result.code) {
        throw new Error(`第 ${index + 1} 段（${clip.name}）处理失败：${result.stderr.slice(-500).trim() || `退出码 ${result.code}`}`);
      }
      parts.push(out);
      setJob(id, { pct: Math.round(((index + 1) / (prepared.length + 1)) * 100), message: `已处理 ${index + 1}/${prepared.length} 段` });
    }

    if (jobs.get(id)?.state !== 'running') return;
    setJob(id, { pct: 99, message: '正在拼接…' });

    const list = path.join(temp, 'concat.txt');
    await writeFile(
      /*turbopackIgnore: true*/ list,
      parts.map((item) => `file '${item.split(path.sep).join('/').replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8',
    );

    const name = sanitizeName(input.outputName) || `joined-${Date.now()}.mp4`;
    const outputDir = path.join(await outputRoot(), 'joined');
    await mkdir(/*turbopackIgnore: true*/ outputDir, { recursive: true });
    const output = path.join(outputDir, name);

    const merged = await runCapture([ffmpeg, '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', output], 600_000);
    if (jobs.get(id)?.state !== 'running') return;
    if (merged.code) throw new Error(merged.stderr.slice(-800).trim() || '拼接失败。');

    setJob(id, { state: 'done', pct: 100, message: '导出完成', output, outputDir: outputDir });
  } catch (error) {
    if (jobs.get(id)?.state === 'running') {
      setJob(id, { state: 'error', error: error instanceof Error ? error.message : '导出失败。', message: '导出失败' });
    }
  } finally {
    handleCleanup(id, temp);
  }
}

function handleCleanup(id: string, temp: string | null): void {
  setJob(id, { child: undefined });
  /* 临时目录不管成功失败都收掉：里面是几十到几百 MB 的中间 mp4。 */
  if (temp) void rm(/*turbopackIgnore: true*/ temp, { recursive: true, force: true });
}

function sanitizeName(value: string): string {
  const raw = String(value || '').trim();
  const base = raw.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  if (!base) return '';
  return /\.mp4$/i.test(base) ? base : `${base}.mp4`;
}

/* ------------------------------------------------------------------ *
 * 上传 / 成品入库
 * ------------------------------------------------------------------ */

const UPLOAD_TYPES: Record<string, { mime: string; type: 'video' | 'image' }> = {
  mp4: { mime: 'video/mp4', type: 'video' },
  mov: { mime: 'video/quicktime', type: 'video' },
  mkv: { mime: 'video/x-matroska', type: 'video' },
  avi: { mime: 'video/x-msvideo', type: 'video' },
  webm: { mime: 'video/webm', type: 'video' },
  m4v: { mime: 'video/x-m4v', type: 'video' },
  png: { mime: 'image/png', type: 'image' },
  jpg: { mime: 'image/jpeg', type: 'image' },
  jpeg: { mime: 'image/jpeg', type: 'image' },
  webp: { mime: 'image/webp', type: 'image' },
  gif: { mime: 'image/gif', type: 'image' },
  bmp: { mime: 'image/bmp', type: 'image' },
};

const UPLOAD_MAX = 512 * 1024 * 1024;

/**
 * 用户上传的素材落盘 + 建一条 Asset。
 *
 * 走资产库而不是「工具私有的临时目录」：徐先选的就是「上传的东西也进资产库」，
 * 这样同一段素材下次在别的拼接里还能再挑到，不用再传一遍。
 *
 * 扩展名**先认文件名、认不出再认魔数**：`archiveToolMedia()` 只认魔数，
 * 而它认不出 mov / mkv / avi（那三种都不是 ftyp/EBML 开头），
 * 用它会「明明选了一个 .mov，却说格式不支持」。
 */
export async function archiveUpload(input: {
  userId: string;
  projectId: string;
  file: File;
}): Promise<{ id: string; url: string; name: string; size: number; type: 'video' | 'image' } | null> {
  const bytes = Buffer.from(await input.file.arrayBuffer());
  if (!bytes.length || bytes.length > UPLOAD_MAX) return null;

  const raw = String(input.file.name || '');
  const fromName = /\.([a-z0-9]+)$/i.exec(raw)?.[1]?.toLowerCase() ?? '';
  const kind = UPLOAD_TYPES[fromName] ?? guessByMagic(bytes);
  if (!kind) return null;
  const ext = fromName && UPLOAD_TYPES[fromName] ? fromName : extOfKind(kind.type, bytes);

  const dir = path.join(await mediaRoot(), input.projectId);
  await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  const id = randomUUID();
  const target = path.join(dir, `${id}.${ext}`);
  await writeFile(/*turbopackIgnore: true*/ target, bytes);
  const url = `/api/assets/${id}/media.${ext}`;
  const name = raw.split(/[\\/]/).pop() || `${kind.type}.${ext}`;
  await db.asset.create({
    data: {
      id,
      userId: input.userId,
      projectId: input.projectId,
      name,
      type: kind.type,
      url,
      metadata: { size: bytes.length, originalUrl: null, mime: kind.mime, path: target, ext, source: 'video-tool-upload' },
    },
  });
  return { id, url, name, size: bytes.length, type: kind.type };
}

function guessByMagic(bytes: Buffer): { mime: string; type: 'video' | 'image' } | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return UPLOAD_TYPES.png;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return UPLOAD_TYPES.jpg;
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return UPLOAD_TYPES.webm;
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return UPLOAD_TYPES.mp4;
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return UPLOAD_TYPES.webp;
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'AVI ') return UPLOAD_TYPES.avi;
  return null;
}

function extOfKind(type: 'video' | 'image', bytes: Buffer): string {
  if (type === 'image') return bytes.subarray(0, 4).toString('hex') === '89504e47' ? 'png' : 'jpg';
  return 'mp4';
}

/**
 * 成品入库。
 *
 * 跟上传那条路只差「字节从哪来」—— 成品是刚刚 ffmpeg 写出来的文件，
 * 直接 `copyFile` 进媒体目录，不读进内存（几百 MB 的视频读进 Buffer 太蠢）。
 */
export async function archiveLocalFile(input: {
  userId: string;
  projectId: string;
  filePath: string;
  name: string;
}): Promise<{ id: string; url: string; name: string }> {
  if (!(await isFile(input.filePath))) throw new Error('成品文件已经不在了 —— 重新导出一次。');
  const dir = path.join(await mediaRoot(), input.projectId);
  await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  const id = randomUUID();
  const target = path.join(dir, `${id}.mp4`);
  await copyFile(/*turbopackIgnore: true*/ input.filePath, /*turbopackIgnore: true*/ target);
  const url = `/api/assets/${id}/media.mp4`;
  const info = await stat(/*turbopackIgnore: true*/ target);
  await db.asset.create({
    data: {
      id,
      userId: input.userId,
      projectId: input.projectId,
      name: input.name || `joined-${Date.now()}.mp4`,
      type: 'video',
      url,
      metadata: { size: info.size, originalUrl: null, mime: 'video/mp4', path: target, ext: 'mp4', source: 'video-tool-output' },
    },
  });
  return { id, url, name: input.name };
}
