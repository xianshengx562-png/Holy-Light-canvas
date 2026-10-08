/*
 * 自建的创作预设（2026-10-08）—— 用户自己加的**档**、档下自己加的**分类**、分类里的条目。
 *
 * 落在 `<dataDir>/creative-presets/mine.json`，与 `<dataDir>/danbooru-categories.json`
 * 是一对（那一份是标签分类，这一份是预设）。
 *
 * 🔴 为什么**单独一份**，不并进 `imported.json`：那一份的规矩是
 *    「**同名再导 = 覆盖**」—— 用户把分类名填成一样再导一次，意图是刷新那批
 *    （不覆盖的话界面里会有 7892 条同名预设）。而这里点「导入」的意图是**往自建分类里加**，
 *    清空再写等于「我攒的那批没了」。两个语义塞进一份文件，总有一次会清掉不该清的。
 *
 * 🔴 走主进程的理由同 `danbooru-cats.ts`：渲染进程没有 `node:fs`，
 *    写不了数据目录、也读不了用户选的文件。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runtimePaths } from '@/lib/runtime-paths';

export type MineKind = {
  id: string;
  name: string;
  /** 这一档只能选一条（运镜那种）。 */
  single: boolean;
};

export type MineCategory = { id: string; kind: string; name: string };

export type MinePreset = {
  id: string;
  kind: string;
  category: string;
  name: string;
  description: string;
  prompt: string;
  preview: string;
  poster?: string;
  prefix?: string;
};

export type MineFile = {
  version: 1;
  kinds: MineKind[];
  categories: MineCategory[];
  presets: MinePreset[];
};

/** 单次导入最多收多少条。 */
const MAX_IMPORT = 5000;

export function presetMinePath(): string {
  return path.join(runtimePaths().dataDir, 'creative-presets', 'mine.json');
}

function emptyFile(): MineFile {
  return { version: 1, kinds: [], categories: [], presets: [] };
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 自建档的 id 一律 `k-` 开头 —— 与内置三档一眼分得开，也挡住「用户起了个叫 style 的档」。 */
function isMineKindId(value: unknown): boolean {
  return /^k-[a-z0-9\-_]{3,}$/i.test(str(value));
}

export function readMine(): MineFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(presetMinePath(), 'utf8')) as Partial<MineFile>;
    if (!parsed || typeof parsed !== 'object') return emptyFile();
    const kinds: MineKind[] = [];
    for (const item of Array.isArray(parsed.kinds) ? parsed.kinds : []) {
      if (!item || typeof item !== 'object') continue;
      const id = str(item.id);
      const name = str(item.name);
      if (!isMineKindId(id) || !name) continue;
      kinds.push({ id, name, single: item.single === true });
    }
    const categories: MineCategory[] = [];
    for (const item of Array.isArray(parsed.categories) ? parsed.categories : []) {
      if (!item || typeof item !== 'object') continue;
      const id = str(item.id);
      const name = str(item.name);
      if (!id || !name) continue;
      categories.push({ id, kind: str(item.kind), name });
    }
    const presets: MinePreset[] = [];
    for (const item of Array.isArray(parsed.presets) ? parsed.presets : []) {
      const one = normalizeEntry(item);
      if (one && !presets.some(exist => exist.id === one.id)) presets.push(one);
    }
    return { version: 1, kinds, categories, presets };
  } catch {
    /* 第一次用 / 被手删 / 写坏了 —— 都当「还没有」。 */
    return emptyFile();
  }
}

function normalizeEntry(raw: unknown): MinePreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const prompt = str(src.prompt);
  if (!prompt) return null;
  const name = str(src.name) || prompt.slice(0, 20);
  const poster = str(src.poster);
  const prefix = str(src.prefix);
  return {
    id: str(src.id) || entryId(name, prompt),
    kind: str(src.kind),
    category: str(src.category),
    name,
    description: str(src.description),
    prompt,
    preview: str(src.preview),
    ...(poster ? { poster } : {}),
    ...(prefix ? { prefix } : {}),
  };
}

/** 条目 id 取「名字 + 提示词」的哈希（渲染层那边的 `presetIdOf` 是同一个语义，算法不同不影响）。 */
function entryId(name: string, prompt: string): string {
  const digest = crypto.createHash('md5').update(`${name}\u0000${prompt}`).digest('hex').slice(0, 10);
  return `mine-${digest}`;
}

/**
 * 写。三档兜底与 `preset-import.ts` 的 `writeManifest()` 一模一样，理由也一样：
 * 改名会被杀软 / 索引器拦一下，而走到那一步时用户的编辑已经在内存里了。
 */
export function writeMine(next: MineFile): { ok: boolean; message: string } {
  const target = presetMinePath();
  const body = JSON.stringify({
    version: 1,
    kinds: next.kinds || [],
    categories: next.categories || [],
    presets: next.presets || [],
  }, null, 2);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch {
    /* 目录已经在了。 */
  }
  const tmp = target + '.tmp';
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, message: '' };
  } catch {
    /* 落到下面：直接写。 */
  }
  try {
    fs.writeFileSync(target, body, 'utf8');
    return { ok: true, message: '' };
  } catch {
    /* 再落一档：先删掉旧的再建一个新的。 */
  }
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.writeFileSync(target, body, 'utf8');
    return { ok: true, message: '' };
  } catch (e) {
    return { ok: false, message: '自建预设存不进去：' + String((e as Error)?.message || e) };
  }
}

/*
 * ---------------------------------------------------------------------------
 * 从文件读一批预设进来
 * ---------------------------------------------------------------------------
 */

type RawEntry = {
  name?: string;
  name_cn?: string;
  label?: string;
  title?: string;
  prompt?: string;
  description?: string;
  preview?: string;
  thumbnail?: string;
  poster?: string;
  category?: string;
};

/**
 * JSON → 条目。认三种形状：字符串数组、对象数组、`{ presets: [...] }` 包一层。
 *
 * 🔴「名字」与「提示词」是两个字段（中文名给人看，提示词给模型看），
 * 只给一个时两边都用它 —— 用户就想让这一条原样拼上去。
 */
function entriesFromJson(text: string): { entries: MinePreset[]; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { entries: [], error: String((e as Error)?.message || e).slice(0, 100) };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.presets)
      ? ((parsed as Record<string, unknown>).presets as unknown[])
      : Array.isArray((parsed as Record<string, unknown>)?.styles)
        ? ((parsed as Record<string, unknown>).styles as unknown[])
        : null;
  if (!list) return { entries: [], error: '不是数组（要一个预设数组）' };

  const entries: MinePreset[] = [];
  for (const item of list) {
    if (entries.length >= MAX_IMPORT) break;
    if (typeof item === 'string') {
      const prompt = item.trim();
      if (prompt) entries.push(plainEntry(prompt));
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const src = item as RawEntry;
    const prompt = str(src.prompt) || str(src.description);
    if (!prompt) continue;
    const name = str(src.name_cn) || str(src.name) || str(src.label) || str(src.title) || prompt.slice(0, 20);
    entries.push(normalizeEntry({
      name,
      prompt,
      description: str(src.name) && str(src.name) !== name ? str(src.name) : '',
      preview: str(src.preview) || str(src.thumbnail) || '',
      poster: str(src.poster),
      category: str(src.category),
    }) as MinePreset);
  }
  return { entries, error: '' };
}

function plainEntry(prompt: string): MinePreset {
  return normalizeEntry({ name: prompt.slice(0, 20), prompt }) as MinePreset;
}

/**
 * 文本 → 条目。**一行一条**，两种写法：
 *
 *   `暖阳赛璐璐CG | 视觉风格：暖阳赛璐璐CG。高饱和…`  → 竖线左边是名字，右边是提示词
 *   `视觉风格：暖阳赛璐璐CG。高饱和…`                → 整行就是提示词，名字取前 20 字
 *
 * 🔴 分隔符**只认竖线和 Tab，不认逗号**（与标签分类那边同一条规矩）：
 *    提示词里全是逗号，用逗号当分隔符会把一条劈成「名字 + 半个提示词」，而且看着还挺像回事。
 */
function entriesFromText(text: string): MinePreset[] {
  const entries: MinePreset[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (entries.length >= MAX_IMPORT) break;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cut = line.includes('|') ? line.indexOf('|') : line.indexOf('\t');
    if (cut > 0) {
      const name = line.slice(0, cut).trim();
      const prompt = line.slice(cut + 1).trim();
      if (prompt) entries.push(normalizeEntry({ name: name || prompt.slice(0, 20), prompt }) as MinePreset);
      continue;
    }
    entries.push(plainEntry(line));
  }
  return entries;
}

export type MineImportResult = {
  ok: boolean;
  message: string;
  entries: MinePreset[];
  files: number;
  skipped: string[];
};

/** 读用户选的那几个文件。**只读，不写任何东西** —— 收不收由调用方决定。 */
export function importMinePresets(files: string[]): MineImportResult {
  const list = (files || []).map(item => String(item || '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, message: '没选文件。', entries: [], files: 0, skipped: [] };

  const entries: MinePreset[] = [];
  const seen = new Set<string>();
  const skipped: string[] = [];
  let read = 0;

  for (const file of list) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      skipped.push(`${path.basename(file)}：${String((e as Error)?.message || e).slice(0, 80)}`);
      continue;
    }
    read++;
    const isJson = file.toLowerCase().endsWith('.json');
    const parsed = isJson ? entriesFromJson(text) : { entries: entriesFromText(text), error: '' };
    if (parsed.error) {
      skipped.push(`${path.basename(file)}：${parsed.error}`);
      continue;
    }
    for (const entry of parsed.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
  }

  return {
    ok: entries.length > 0,
    message: entries.length ? `从 ${read} 个文件读到 ${entries.length} 条预设。` : '没读到可用的预设。',
    entries,
    files: read,
    skipped: skipped.slice(0, 5),
  };
}
