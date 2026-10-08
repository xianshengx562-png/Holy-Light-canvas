import 'server-only';
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { storageRoot } from './storage-root';

/**
 * **产出落盘的根目录**——桌面版可以由用户自己挑一个文件夹。
 *
 * 为什么要有这一层：桌面版是「我自己的电脑、我自己的盘」，把几百兆的视频塞进
 * `userData/storage`（在 `%APPDATA%` 底下、通常在系统盘）既不好找也不好搬。
 * 用户挑了目录之后，之后所有产出都落进去。
 *
 * 三条不能破的规矩：
 *
 * 1. **换了根目录不影响老资产。** 资产记录里 `metadata.path` 存的是**绝对路径**，
 *    `openMediaAsset` 拿它直接开流。所以改这个配置只是「之后的文件往哪写」，
 *    不需要搬文件、也不会让已有资产变成坏图。
 * 2. **子目录的相对结构不变**：`<根目录>/media/<projectId>/<uuid>.<ext>`、
 *    `<根目录>/latents/<projectId>/...`。孤儿扫描（`lib/assets.ts`）就是照这个结构扫的，
 *    结构一变它就得重写，而扫错目录的后果是**把用户的文件当孤儿删掉**。
 * 3. **没配置时行为与今天完全一致**：根目录就是 `storageRoot()`，也就是
 *    `<userData>/storage`，media 与 latents 两个子目录照旧。
 */

const CONFIG_NAME = 'output-dir.json';

/** 落盘根目录下的两个子目录名。改名等于改落盘结构，见上面第 2 条。 */
export const MEDIA_DIR = 'media';
export const LATENT_DIR = 'latents';
/**
 * 第三个子目录：**画布上手动放进去的素材**（拖进来 / 粘进来 / 在节点上选的文件）。
 *
 * 它**刻意不叫 media、也不放在 media 底下**（2026-10-08 徐先：「从外面添加的图片
 * 拉入画布会自动进入资产库，这个 bug 也修复（不要进入资产库）」）：
 * 孤儿扫描只认 `media/` 与 `latents/` 两个目录、且按「有没有 Asset 记录」判生死，
 * 一个没有记录的文件落在 `media/` 里，用户点一次「清理孤儿」就真没了。
 * 单独一个目录既满足「不进资产库」，也不会被那把清扫扫到。
 */
export const CANVAS_MEDIA_DIR = 'canvas-media';

type Stored = { dir?: string };

/**
 * `undefined` = 还没读过磁盘；`string` = 用户自己挑的目录；`null` = 读过了，没配置。
 *
 * 缓存的理由：落盘是「一张图一次 `mkdir` + 一次 `writeFile`」，没必要每张图都再读一次配置。
 * 而写入路径只有 `saveOutputRoot()` 一条，它顺手把缓存刷掉，不会出现「改了但还在用旧的」。
 */
let cache: string | null | undefined;

/** `resolveStoredPath()` 的记忆：同一个过期路径只找一次。 */
const resolvedCache = new Map<string, string>();

function configFile(): string {
  return path.join(storageRoot(), CONFIG_NAME);
}

/** 没配置时的默认根目录。界面上要把它显示出来，让用户知道「不选会落在哪」。 */
export function defaultOutputRoot(): string {
  return storageRoot();
}

async function readStored(): Promise<string | null> {
  if (cache !== undefined) return cache;
  try {
    const raw = await readFile(/*turbopackIgnore: true*/ configFile(), 'utf8');
    const parsed = JSON.parse(raw) as Stored;
    const dir = typeof parsed?.dir === 'string' ? parsed.dir.trim() : '';
    cache = dir || null;
  } catch {
    /** 文件不存在 / 内容坏了都当「没配置」——配置丢了不值得让整个应用起不来。 */
    cache = null;
  }
  return cache;
}

/** 生效中的产出根目录。没配置就是默认目录。 */
export async function outputRoot(): Promise<string> {
  return (await readStored()) || defaultOutputRoot();
}

/** 媒体（图 / 视频）的落盘目录。 */
export async function mediaRoot(): Promise<string> {
  return path.join(await outputRoot(), MEDIA_DIR);
}

/** latent 的落盘目录。 */
export async function latentRoot(): Promise<string> {
  return path.join(await outputRoot(), LATENT_DIR);
}

/**
 * 画布素材的落盘目录：`<根目录>/canvas-media/<projectId>/<uuid>.<ext>`。
 *
 * 与 `mediaRoot()` 的唯一区别就是它**不建 Asset 记录**，所以资产库里看不到、
 * 容量统计里也算不到 —— 生成、取流、重传照旧（见 `lib/canvas-media.ts`）。
 */
export async function canvasMediaRoot(): Promise<string> {
  return path.join(await outputRoot(), CANVAS_MEDIA_DIR);
}

/* ------------------------------------------------------------------ *
 * 保存：先验证，再落配置
 * ------------------------------------------------------------------ */

export type OutputDirView = {
  /** 实际生效的根目录。 */
  dir: string;
  /** 用户自己挑的目录；没挑就是 null。 */
  custom: string | null;
  source: 'custom' | 'default';
  /** 默认值，界面上给「恢复默认」做对照。 */
  defaultDir: string;
  /** 目录现在在不在盘上。 */
  exists: boolean;
  /** 最近一次写入探测的结果（只有在保存 / 检查那一刻才测，不是实时）。 */
  writable: boolean;
};

/**
 * 真的往目标目录写一个文件再删掉。
 *
 * 为什么不能只看 `access(dir, W_OK)`：Windows 上「目录可写」这个标记经常说谎
 * （UAC 虚拟化、只读的 U 盘、权限被继承），而这里一旦判断错，代价是**每一次生成
 * 都静默失败**——`lib/media.ts` 的归档把写失败吞掉、回退到原始 URL，用户看到的是
 * 「生成成功了但图是空的」。宁可在点保存这一刻报错。
 */
async function probeWrite(dir: string): Promise<void> {
  await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  const probe = path.join(dir, `.frame-write-test-${process.pid}-${Date.now()}`);
  await writeFile(/*turbopackIgnore: true*/ probe, 'ok');
  try { await unlink(/*turbopackIgnore: true*/ probe); } catch { /* 探完删不掉也无所谓，留一个字节的文件而已 */ }
}

async function checkDir(dir: string): Promise<{ exists: boolean; writable: boolean }> {
  try {
    const info = await stat(/*turbopackIgnore: true*/ dir);
    if (!info.isDirectory()) return { exists: false, writable: false };
  } catch {
    return { exists: false, writable: false };
  }
  try { await access(/*turbopackIgnore: true*/ dir); } catch { return { exists: true, writable: false }; }
  return { exists: true, writable: true };
}

export async function describeOutputDir(): Promise<OutputDirView> {
  const custom = await readStored();
  const dir = custom || defaultOutputRoot();
  const state = await checkDir(dir);
  return {
    dir,
    custom,
    source: custom ? 'custom' : 'default',
    defaultDir: defaultOutputRoot(),
    exists: state.exists,
    writable: state.writable,
  };
}

/**
 * 保存用户挑的目录。**先建目录 + 真写一个文件，通过了才落配置**——
 * 否则「选了一个没权限的盘」会在之后每一次生成时才暴露，而那时候报错的地方
 * 和出错的原因隔着十万八千里。
 *
 * 传空串 / null = 恢复默认。
 */
export async function saveOutputRoot(value: string | null): Promise<OutputDirView> {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    cache = null;
    resolvedCache.clear();
    await writeConfig(null);
    return describeOutputDir();
  }

  /** 相对路径一律按 `storageRoot()` 的 sibling 处理会很难猜，直接拒绝：界面上传进来的应当是绝对路径。 */
  if (!path.isAbsolute(trimmed)) {
    throw new Error('请填一个完整路径（比如 E:\\我的产出 或 /Users/me/output）。');
  }

  try {
    await probeWrite(trimmed);
  } catch (error) {
    const reason = (error as { code?: string }).code || '';
    if (reason === 'EACCES' || reason === 'EPERM') {
      throw new Error(`没有往「${trimmed}」写入的权限 —— 换一个目录，或者用管理员身份重新打开。`);
    }
    throw new Error(`「${trimmed}」写不进去${reason ? `（${reason}）` : ''} —— 换一个目录再试。`);
  }

  cache = trimmed;
  /** 换了根目录，之前「找回」的结论就不再成立。 */
  resolvedCache.clear();
  await writeConfig(trimmed);
  return describeOutputDir();
}

async function writeConfig(dir: string | null): Promise<void> {
  const root = storageRoot();
  await mkdir(/*turbopackIgnore: true*/ root, { recursive: true });
  const payload = JSON.stringify({ dir }, null, 2);
  await writeFile(/*turbopackIgnore: true*/ configFile(), payload, 'utf8');
}

/* ------------------------------------------------------------------ *
 * 找回：路径过期 ≠ 文件没了
 * ------------------------------------------------------------------ */

/**
 * 落盘结构里的锚点目录名 —— 找回时从路径最后一段往前找这些名字。
 * 前两个就是本文件的 `MEDIA_DIR` / `LATENT_DIR`，后两个是工具产出的目录。
 */
const PATH_ANCHORS = [MEDIA_DIR, LATENT_DIR, 'joined', 'exports'];

async function existsAt(target: string): Promise<boolean> {
  try {
    await stat(/*turbopackIgnore: true*/ target);
    return true;
  } catch {
    return false;
  }
}

/**
 * `metadata.path` 存的是**绝对路径**，落盘根目录却可能已经换过：数据目录改过名
 * （FRAME → frame-studio → holy-light-canvas）、用户改过「产出目录」、或者自己搬过 storage。
 * 这时候文件一个都没丢，路径却全部指向旧根目录。
 *
 * 后果有两个，第二个**不可逆**：
 *  1. 资产页一片坏图、落盘占用 `0 B`、「N 条记录的文件已不在磁盘上」；
 *  2. `scanOrphans()` 拿这些过期路径去对账 → 磁盘上的真文件被算成「没有对应记录」，
 *     用户随手点一下「清理」就真删了。
 *
 * 能救回来的前提是**相对结构没变**（`<锚点>/<projectId>/<file>`）——
 * 这正是本文件从一开始就守着「换根目录不改子结构」的原因。
 * 找不到就原样返回，让上层照旧报错 —— 绝不猜。
 */
export async function resolveStoredPath(stored: string): Promise<string> {
  const raw = String(stored || '');
  if (!raw) return raw;
  const cached = resolvedCache.get(raw);
  if (cached) return cached;
  if (await existsAt(raw)) {
    resolvedCache.set(raw, raw);
    return raw;
  }
  const parts = raw.split(/[\\/]+/);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (!PATH_ANCHORS.includes(parts[i].toLowerCase())) continue;
    const candidate = path.join(await outputRoot(), ...parts.slice(i));
    if (await existsAt(candidate)) {
      resolvedCache.set(raw, candidate);
      return candidate;
    }
  }
  /** 「没找到」也要记下来：否则每张坏图都会重扫一遍这一串候选。 */
  resolvedCache.set(raw, raw);
  return raw;
}
