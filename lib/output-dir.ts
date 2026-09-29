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

type Stored = { dir?: string };

/**
 * `undefined` = 还没读过磁盘；`string` = 用户自己挑的目录；`null` = 读过了，没配置。
 *
 * 缓存的理由：落盘是「一张图一次 `mkdir` + 一次 `writeFile`」，没必要每张图都再读一次配置。
 * 而写入路径只有 `saveOutputRoot()` 一条，它顺手把缓存刷掉，不会出现「改了但还在用旧的」。
 */
let cache: string | null | undefined;

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
  await writeConfig(trimmed);
  return describeOutputDir();
}

async function writeConfig(dir: string | null): Promise<void> {
  const root = storageRoot();
  await mkdir(/*turbopackIgnore: true*/ root, { recursive: true });
  const payload = JSON.stringify({ dir }, null, 2);
  await writeFile(/*turbopackIgnore: true*/ configFile(), payload, 'utf8');
}
