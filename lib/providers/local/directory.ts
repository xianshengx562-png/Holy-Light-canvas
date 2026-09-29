import 'server-only';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * **只读**扫一遍 ComfyUI 的安装目录。
 *
 * 为什么需要这一层：用户说过「我只连我自己开的 ComfyUI」—— 那台服务经常是**关着的**，
 * 而「这份图缺不缺节点 / 缺不缺模型」这件事，绝大多数时候并不需要它开着：
 * 节点装在 `custom_nodes/<包>/` 里（`NODE_CLASS_MAPPINGS` 里写了它注册哪些类型），
 * 模型就是 `models/<种类>/` 下面那几个文件。读目录就能答，读完就把答案说出来。
 *
 * 三条硬规矩：
 *  1. **只读**：不写、不下载、不安装、不拉起进程。整个模块只有 `stat / readdir / readFile`。
 *  2. **有预算，而且节点和模型各算各的**：自定义节点包动辄上百个（本机 109 个），
 *     每个包里 `.py` 又可能很大。早先两者共用一份预算，结果节点扫描把 4 秒全吃掉、
 *     模型那一步一个文件都没扫到（`modelCount: 0`）—— 于是每个模型都被报成「缺」。
 *     所以现在 `nodeBudget` / `modelBudget` 分账，谁慢都不影响另一方。
 *  3. **结论要说得清是「按目录扫的」**：目录扫描认不全节点（有些包在运行时才注册），
 *     所以服务开着时一律以 `/object_info` 为准，只有在**服务连不上**时才退回这一层。
 */

/** 模型文件的后缀。只认这些 —— 目录里还混着预览图、json、txt，全收进来只会污染比对。 */
const MODEL_EXTS = new Set([
  '.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx',
]);

/** 同一个目录的扫描结果缓存多久。目录内容不会每分钟变，而扫一次要读几千个文件。 */
const SCAN_TTL_MS = 5 * 60 * 1000;
/** 节点 / 模型各自的时间预算（各算各的，加起来是最坏耗时）。超了就停手，用已扫到的部分作答。 */
const NODE_DEADLINE_MS = 3000;
const MODEL_DEADLINE_MS = 3000;
const NODE_MAX_FILES = 2500;
const MODEL_MAX_FILES = 8000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type ComfyuiDirView = {
  dir: string;
  exists: boolean;
  /** 目录里有没有 ComfyUI 该有的东西（`custom_nodes` / `models` / `nodes.py` / `main.py`）。 */
  looksLikeComfyui: boolean;
  /** 从各处的 `NODE_CLASS_MAPPINGS` 里认出来的节点类型数。 */
  nodeTypeCount: number;
  /** `custom_nodes` 里带 `__init__.py` 的包数（ComfyUI 只加载这些）。 */
  customNodePackages: number;
  modelCount: number;
  modelKinds: { kind: string; count: number }[];
  /** `extra_model_paths.yaml` 里挂进来的外部目录。 */
  extraPaths: string[];
  scannedAt: string;
  /** 一句话说明，直接给设置页显示。 */
  message: string;
};

export type ComfyuiDirScan = {
  view: ComfyuiDirView;
  /** 认出来的节点类型（`NODE_CLASS_MAPPINGS` 的键）。 */
  nodeTypes: Set<string>;
  /** 模型文件的相对路径（相对 `models/<种类>`，分隔符统一成 `/`，小写）。 */
  modelPaths: Set<string>;
  /** 模型文件名（小写）。跨种类查「这个文件在不在」用它。 */
  modelNames: Set<string>;
};

type Budget = { files: number; deadline: number };

const cache = new Map<string, { at: number; scan: ComfyuiDirScan }>();

/** 测试 / 换目录后想立刻重扫时清一下。 */
export function clearComfyuiDirCache(): void {
  cache.clear();
}

async function isDir(p: string): Promise<boolean> {
  try {
    const info = await stat(/*turbopackIgnore: true*/ p);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function listEntries(p: string): Promise<{ name: string; dir: boolean }[]> {
  try {
    const items = await readdir(/*turbopackIgnore: true*/ p, { withFileTypes: true });
    return items.map(item => ({ name: item.name, dir: item.isDirectory() }));
  } catch {
    return [];
  }
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed[0] === '"' && trimmed.endsWith('"')) || (trimmed[0] === "'" && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 从一个 `NODE_CLASS_MAPPINGS` 出现的位置往后取它那个字典。
 *
 * 取到**匹配的花括号**为止，而不是固定取几千字符 —— 后者会把后面无关的代码也吞进来，
 * 于是「某个包里提了一句 NODE_CLASS_MAPPINGS」就会被当成「它注册了后面所有字符串」，
 * 假阴性（缺节点却报成装了）就是这么来的。
 */
function dictWindow(src: string, from: number): string {
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/** `NODE_CLASS_MAPPINGS` 字典里的键 —— 也就是这个包对外提供的节点类型名。 */
const MAPPING_KEY = /["']([A-Za-z0-9_.\-]{2,80})["']\s*:/g;

function nodeTypesFromSource(src: string): string[] {
  const out = new Set<string>();
  let at = src.indexOf('NODE_CLASS_MAPPINGS');
  while (at >= 0) {
    const window = dictWindow(src, at);
    if (window) {
      MAPPING_KEY.lastIndex = 0;
      let hit: RegExpExecArray | null;
      while ((hit = MAPPING_KEY.exec(window))) out.add(hit[1]);
    }
    at = src.indexOf('NODE_CLASS_MAPPINGS', at + 1);
  }
  return [...out];
}

async function collectNodeTypes(file: string, out: Set<string>, budget: Budget): Promise<void> {
  if (budget.files >= NODE_MAX_FILES || Date.now() > budget.deadline) return;
  budget.files += 1;
  try {
    const info = await stat(/*turbopackIgnore: true*/ file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return;
    const src = await readFile(/*turbopackIgnore: true*/ file, 'utf8');
    for (const type of nodeTypesFromSource(src)) out.add(type);
  } catch {
    /* 单个文件读不动（编码、权限、正在被写）不影响整次扫描。 */
  }
}

/** 一个自定义节点包里值得看的 `.py`：顶层、`py/`、`nodes/`。再深就不看了，代价换不来几个节点。 */
async function packagePyFiles(pkgDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await listEntries(pkgDir)) {
    if (!entry.dir && entry.name.endsWith('.py')) out.push(path.join(pkgDir, entry.name));
  }
  for (const sub of ['py', 'nodes']) {
    for (const entry of await listEntries(path.join(pkgDir, sub))) {
      if (!entry.dir && entry.name.endsWith('.py')) out.push(path.join(pkgDir, sub, entry.name));
    }
  }
  return out;
}

/** ComfyUI 只加载带 `__init__.py` 的包 —— 没有的就是被禁用 / 只是个资源目录。 */
function isPackage(files: string[]): boolean {
  return files.some(file => path.basename(file) === '__init__.py');
}

async function walkModels(
  abs: string, rel: string, depth: number, out: Set<string>, budget: Budget,
): Promise<void> {
  if (depth > 4 || budget.files >= MODEL_MAX_FILES || Date.now() > budget.deadline) return;
  for (const entry of await listEntries(abs)) {
    if (budget.files >= MODEL_MAX_FILES || Date.now() > budget.deadline) return;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.dir) {
      await walkModels(path.join(abs, entry.name), childRel, depth + 1, out, budget);
      continue;
    }
    budget.files += 1;
    if (!MODEL_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
    out.add(childRel.toLowerCase());
  }
}

type YamlSection = { base: string; entries: Record<string, string[]> };

/**
 * 一个够用的 `extra_model_paths.yaml` 解析。**不引 yaml 库**（为了这一份文件不值得），
 * 只认它真实在用的那几种写法：普通键值、`|` 多行列表、`[a, b]` 内联列表。
 *
 * 这个文件的作用是把**别的**安装（比如秋叶的 sd-webui-aki）的模型目录挂进来 ——
 * 不认它的话，用户明明有几百个模型，我们却报「缺模型」。
 */
function parseExtraModelPaths(raw: string): YamlSection[] {
  const sections: YamlSection[] = [];
  let current: YamlSection | null = null;
  let pending: { section: YamlSection; key: string; indent: number } | null = null;

  for (const line of raw.split(/\r?\n/)) {
    /** 注释只在行尾（前面有空格）才算 —— 路径里带 `#` 的情况虽然少见，但代价是整条配置失效。 */
    const body0 = line.replace(/\s+#.*$/, '');
    if (!body0.trim()) continue;
    const indent = body0.length - body0.trimStart().length;
    const body = body0.trim();

    if (pending) {
      if (indent > pending.indent && body.startsWith('- ')) {
        const value = stripQuotes(body.slice(2));
        if (value) pending.section.entries[pending.key].push(value);
        continue;
      }
      pending = null;
    }

    const colon = body.indexOf(':');
    if (colon <= 0) continue;
    const key = body.slice(0, colon).trim();
    const value = body.slice(colon + 1).trim();

    /** 顶层只有 section 名（`comfyui:` / `a1111:`）。 */
    if (indent === 0) {
      current = { base: '', entries: {} };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    if (key === 'base_path') { current.base = stripQuotes(value); continue; }
    /** `is_default: true` 是给界面用的标记，不是目录。 */
    if (key === 'is_default') continue;

    const list = current.entries[key] || (current.entries[key] = []);
    if (!value || value === '|' || value === '>') {
      pending = { section: current, key, indent };
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      for (const item of value.slice(1, -1).split(',')) {
        const one = stripQuotes(item);
        if (one) list.push(one);
      }
      continue;
    }
    list.push(stripQuotes(value));
  }
  return sections;
}

function emptyScan(dir: string, message: string): ComfyuiDirScan {
  return {
    view: {
      dir, exists: false, looksLikeComfyui: false,
      nodeTypeCount: 0, customNodePackages: 0, modelCount: 0, modelKinds: [], extraPaths: [],
      scannedAt: new Date().toISOString(), message,
    },
    nodeTypes: new Set(), modelPaths: new Set(), modelNames: new Set(),
  };
}

/** 把一个种类下扫到的相对路径并进全局索引（`modelPaths` 比整条路径，`modelNames` 只比文件名）。 */
function indexModels(set: Set<string>, modelPaths: Set<string>, modelNames: Set<string>): void {
  for (const rel of set) {
    modelPaths.add(rel);
    modelNames.add(rel.split('/').pop() || rel);
  }
}

async function doScan(dir: string): Promise<ComfyuiDirScan> {
  const nodeTypes = new Set<string>();
  const modelPaths = new Set<string>();
  const modelNames = new Set<string>();
  const models = new Map<string, Set<string>>();
  const extraPaths: string[] = [];
  const start = Date.now();
  /** 两条预算分账：节点扫慢了不许把模型的份额吃掉（共用一份时就是这么漏掉全部模型的）。 */
  const nodeBudget: Budget = { files: 0, deadline: start + NODE_DEADLINE_MS };
  const modelBudget: Budget = { files: 0, deadline: start + NODE_DEADLINE_MS + MODEL_DEADLINE_MS };
  let packages = 0;

  const top = await listEntries(dir);
  if (!top.length && !(await isDir(dir))) {
    return emptyScan(dir, '这个目录不在盘上（或打不开）—— 检查一下路径，或者重新选一次。');
  }
  const names = new Set(top.map(entry => entry.name));
  const looksLikeComfyui = names.has('custom_nodes') || names.has('models') || names.has('nodes.py') || names.has('main.py');

  /** 1. 内置节点：根目录的 `nodes.py` 和 `comfy_extras/*.py`。 */
  await collectNodeTypes(path.join(dir, 'nodes.py'), nodeTypes, nodeBudget);
  for (const entry of await listEntries(path.join(dir, 'comfy_extras'))) {
    if (!entry.dir && entry.name.endsWith('.py')) {
      await collectNodeTypes(path.join(dir, 'comfy_extras', entry.name), nodeTypes, nodeBudget);
    }
  }

  /** 2. 自定义节点：`custom_nodes` 下带 `__init__.py` 的子目录。 */
  const customRoot = path.join(dir, 'custom_nodes');
  for (const entry of await listEntries(customRoot)) {
    if (!entry.dir) continue;
    const pkgDir = path.join(customRoot, entry.name);
    const pkgFiles = await packagePyFiles(pkgDir);
    if (!isPackage(pkgFiles)) continue;
    packages += 1;
    for (const file of pkgFiles) await collectNodeTypes(file, nodeTypes, nodeBudget);
  }

  /** 3. 模型：`models/<种类>/**`。 */
  const modelsRoot = path.join(dir, 'models');
  for (const entry of await listEntries(modelsRoot)) {
    if (!entry.dir) continue;
    const set = new Set<string>();
    await walkModels(path.join(modelsRoot, entry.name), '', 0, set, modelBudget);
    models.set(entry.name, set);
    indexModels(set, modelPaths, modelNames);
  }

  /** 4. `extra_model_paths.yaml`：别的安装挂载进来的目录。 */
  let rawYaml = '';
  try {
    rawYaml = await readFile(/*turbopackIgnore: true*/ path.join(dir, 'extra_model_paths.yaml'), 'utf8');
  } catch {
    /* 没有这个文件是常态 —— 只有整合包 / 多安装共存时才会有。 */
  }
  if (rawYaml) {
    for (const section of parseExtraModelPaths(rawYaml)) {
      const base = section.base || dir;
      for (const [kind, values] of Object.entries(section.entries)) {
        for (const value of values) {
          const resolved = path.isAbsolute(value) ? value : path.resolve(base, value);
          if (!(await isDir(resolved))) continue;
          extraPaths.push(resolved);
          if (kind === 'custom_nodes') {
            for (const entry of await listEntries(resolved)) {
              if (!entry.dir) continue;
              const pkgFiles = await packagePyFiles(path.join(resolved, entry.name));
              if (!isPackage(pkgFiles)) continue;
              packages += 1;
              for (const file of pkgFiles) await collectNodeTypes(file, nodeTypes, nodeBudget);
            }
            continue;
          }
          const set = models.get(kind) || new Set<string>();
          models.set(kind, set);
          await walkModels(resolved, '', 0, set, modelBudget);
          indexModels(set, modelPaths, modelNames);
        }
      }
    }
  }

  const modelCount = [...models.values()].reduce((sum, set) => sum + set.size, 0);
  const modelKinds = [...models.entries()]
    .map(([kind, set]) => ({ kind, count: set.size }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const message = !looksLikeComfyui
    ? '这个目录里没有 custom_nodes / models / nodes.py —— 不像是 ComfyUI 的根目录（要选的是里面带 custom_nodes 的那一层）。'
    : `扫到 ${nodeTypes.size} 个节点类型（${packages} 个自定义节点包）、${modelCount} 个模型文件`
      + (extraPaths.length ? `，另有 ${extraPaths.length} 个 extra_model_paths 挂进来的目录` : '')
      + '。';

  return {
    view: {
      dir, exists: true, looksLikeComfyui,
      nodeTypeCount: nodeTypes.size,
      customNodePackages: packages,
      modelCount, modelKinds, extraPaths: [...new Set(extraPaths)],
      scannedAt: new Date().toISOString(), message,
    },
    nodeTypes,
    modelPaths,
    modelNames,
  };
}

/** 扫一个目录。**结果按目录缓存 5 分钟**；没配目录（空串）返回 null。 */
export async function scanComfyuiDir(dir: string): Promise<ComfyuiDirScan | null> {
  const trimmed = String(dir || '').trim();
  if (!trimmed) return null;
  const cached = cache.get(trimmed);
  if (cached && Date.now() - cached.at < SCAN_TTL_MS) return cached.scan;
  const scan = await doScan(trimmed);
  cache.set(trimmed, { at: Date.now(), scan });
  return scan;
}

/**
 * 给界面读的那一份（不含几百上千个节点名的集合）。**只取缓存，不扫。**
 *
 * 为什么这里不能真扫：读连接配置的接口**每次打开设置页都会被调用**，而真扫一遍
 * 在装满节点包的机器上要好几秒（本机 109 个包实测 3 秒）—— 为一个概览把页面卡住不值。
 * 真正该扫的时机只有两处：**保存目录那一刻**（要验证）和**诊断那一刻**（要用）。
 * 那两处都会走 `scanComfyuiDir` 把缓存填上，于是下一次开页面就有数了。
 */
export async function describeComfyuiDir(dir: string): Promise<ComfyuiDirView | null> {
  const trimmed = String(dir || '').trim();
  if (!trimmed) return null;
  const cached = cache.get(trimmed);
  if (!cached || Date.now() - cached.at >= SCAN_TTL_MS) return null;
  return cached.scan.view;
}

/**
 * 保存前的校验：**目录得存在、得是目录、得像 ComfyUI**。
 *
 * 为什么在这里拦：填错目录的后果是「每次检查都按空清单比对」，也就是**每个节点都被报成缺**。
 * 那种报错看着像「你的 ComfyUI 什么都没装」，而真正的原因只是路径填错了一层 ——
 * 与其让它留着等人撞，不如保存这一刻就说清楚。
 */
export async function validateComfyuiDir(dir: string): Promise<ComfyuiDirView | null> {
  const trimmed = String(dir || '').trim();
  if (!trimmed) return null;
  if (!path.isAbsolute(trimmed)) {
    throw new Error('请填一个完整路径（比如 D:\\ComfyUI 或 /home/me/ComfyUI）。');
  }
  const scan = await scanComfyuiDir(trimmed);
  if (!scan) throw new Error('ComfyUI 目录为空。');
  if (!scan.view.exists) {
    throw new Error(`「${trimmed}」这个目录不在盘上 —— 确认 ComfyUI 装在哪，或者点「浏览」重新选一次。`);
  }
  if (!scan.view.looksLikeComfyui) {
    throw new Error(`「${trimmed}」里没有 custom_nodes / models / nodes.py —— 要选的是 ComfyUI 的根目录（里面带 custom_nodes 的那一层）。`);
  }
  return scan.view;
}

/**
 * 「这个模型文件本机有没有」。
 *
 * ComfyUI 给的选项有时候是**相对路径**（`MiniMax-H3/xxx.safetensors`，Windows 上分隔符是 `\`），
 * 有时候就是个文件名；目录这边的模型也可能藏在子目录里。所以三条都试：
 * 整条相对路径、只比文件名、以及分隔符换成 `/` 再比一次。
 */
export function hasModelFile(scan: ComfyuiDirScan, value: string): boolean {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const normalized = raw.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
  if (scan.modelPaths.has(normalized)) return true;
  const base = normalized.split('/').pop() || normalized;
  if (base && scan.modelNames.has(base)) return true;
  return false;
}
