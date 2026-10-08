/*
 * 自定义标签分类（2026-10-08，徐先：「标签也可以自己加分类」）。
 *
 * D站标签面板里那五档（角色 / 服装 / 姿势 / 环境 / 画师）是**烤进包里**的只读清单，
 * 改一次要重新打包；用户自己建的分类是**用户数据**，存在这儿：
 *
 *     <dataDir>/danbooru-categories.json
 *
 * 跟 `<dataDir>/creative-presets/` 一个待遇 —— 不在 asar 里、不进安装包、随时能改能删。
 *
 * 🔴 为什么走主进程：渲染进程没有 `node:fs`，既写不了数据目录，也读不了用户选的文件。
 *    不要再往回引 `/api/*` 那条路 —— 后端 utilityProcess 被监督器重启打断，
 *    半份清单写进去读出来就是 `JSON.parse` 直接抛（那三档兜底见 `writeManifest()` 那段）。
 *
 * 🔴 存的形状 **只存用户自己定的东西**（分类名 / 模式 / 条目），不存抽签结果：
 *    抽签是每一轮的事，存下来「换一批」就失效了（同 `TagSelection` 那条规矩）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runtimePaths } from '@/lib/runtime-paths';

/** 一条自定义标签。`tags` 才是真正接进提示词的那串，`label` 只是列表里显示的名字。 */
export type CustomTagEntry = {
  id: string;
  /** 显示名（列表标题 / chip）。没填就是 `tags` 本身。 */
  label: string;
  /** 真正接进提示词的串。 */
  tags: string;
  /** 副标题：导入时的原文 / 出处，给「这两条看着一样」时分辨用。 */
  sub?: string;
  /** 缩略图（只有「从已有档收藏」那条路会带，是远程地址）。 */
  preview?: string;
};

/** 用户建的分类。 */
export type CustomTagCategory = {
  id: string;
  name: string;
  /**
   * `pick` — 每次运行从选中的条目里**抽 1 条**（跟服装 / 姿势一样）。
   * `all`  — 选中的条目**按顺序整串接上**（跟画师一样）。
   * 建分类时定一次，之后可以随时改。
   */
  mode: 'pick' | 'all';
  entries: CustomTagEntry[];
};

export type CustomTagFile = {
  version: 1;
  categories: CustomTagCategory[];
};

/** 单次导入最多收多少条 —— 有人拿整份 danbooru 标签表当清单，那会把这个面板拖死。 */
const MAX_IMPORT = 5000;

export function customCategoriesPath(): string {
  return path.join(runtimePaths().dataDir, 'danbooru-categories.json');
}

function emptyFile(): CustomTagFile {
  return { version: 1, categories: [] };
}

/** 把一条读进来的东西修成合法形状。缺字段的条目丢掉，不让它把整份清单带下水。 */
function normalizeEntry(raw: unknown, seq: number): CustomTagEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const tags = str(src.tags);
  if (!tags) return null;
  const label = str(src.label) || tags;
  const preview = str(src.preview);
  return {
    id: str(src.id) || `e${seq}`,
    label,
    tags,
    sub: str(src.sub) || undefined,
    preview: preview || undefined,
  };
}

function normalizeCategory(raw: unknown, seq: number): CustomTagCategory | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const name = typeof src.name === 'string' ? src.name.trim() : '';
  if (!name) return null;
  const list = Array.isArray(src.entries) ? src.entries : [];
  const entries: CustomTagEntry[] = [];
  for (const item of list) {
    /* 早先版本可能存的是纯字符串（一行一个标签），这里顺手兜住。 */
    const entry = typeof item === 'string'
      ? normalizeEntry({ tags: item }, entries.length)
      : normalizeEntry(item, entries.length);
    if (entry) entries.push(entry);
  }
  return {
    id: typeof src.id === 'string' && src.id.trim() ? src.id.trim() : `c${seq}`,
    name,
    mode: src.mode === 'all' ? 'all' : 'pick',
    entries,
  };
}

/**
 * 读。**读不出来一律当「还没有」** —— 文件被手删 / 写坏 / 第一次用，都是同一个结果，
 * 而这份清单丢了不致命（用户的条目还在自己手上，重新导一遍就有）。
 */
export function readCustomCategories(): CustomTagFile {
  try {
    const raw = fs.readFileSync(customCategoriesPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CustomTagFile>;
    if (!parsed || !Array.isArray(parsed.categories)) return emptyFile();
    const categories: CustomTagCategory[] = [];
    for (const item of parsed.categories) {
      const category = normalizeCategory(item, categories.length);
      if (category) categories.push(category);
    }
    return { version: 1, categories };
  } catch {
    return emptyFile();
  }
}

/**
 * 写。三档兜底跟 `preset-import.ts` 的 `writeManifest()` 一模一样，理由也一样：
 * 改名会被杀软 / 索引器拦一下，而走到那一步时用户的编辑已经在内存里了 ——
 * 为了一次 rename 把整趟作废，用户看到的是「保存失败」却不知道数据其实还在。
 */
export function writeCustomCategories(next: CustomTagFile): { ok: boolean; message: string } {
  const target = customCategoriesPath();
  const body = JSON.stringify({ version: 1, categories: next.categories }, null, 2);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch {
    /* 目录已经在了 —— 建不出来下面写盘会报，那时再回话。 */
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
    return { ok: false, message: '标签分类存不进去：' + String((e as Error)?.message || e) };
  }
}

/*
 * ---------------------------------------------------------------------------
 * 从文件导入一份自己的标签清单
 * ---------------------------------------------------------------------------
 */

/** 一个条目在 JSON 里的样子（宽松认几种常见写法）。 */
type RawImportEntry = {
  name?: string;
  label?: string;
  name_zh?: string;
  title?: string;
  tags?: string;
  prompt?: string;
  value?: string;
  preview?: string;
  thumbnail?: string;
};

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * JSON → 条目。认三种形状：字符串数组、对象数组、`{ tags: [...] }` 包一层。
 *
 * 🔴 「名字」与「标签」是**两个字段**：中文名给人看，标签串给模型看。
 * 只给一个时两边都用它（用户就想让这行原样接上去）。
 */
function entriesFromJson(text: string): { entries: CustomTagEntry[]; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { entries: [], error: String((e as Error)?.message || e).slice(0, 100) };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.tags)
      ? ((parsed as Record<string, unknown>).tags as unknown[])
      : Array.isArray((parsed as Record<string, unknown>)?.entries)
        ? ((parsed as Record<string, unknown>).entries as unknown[])
        : null;
  if (!list) return { entries: [], error: '不是数组（要一个标签数组）' };

  const entries: CustomTagEntry[] = [];
  for (const item of list) {
    if (entries.length >= MAX_IMPORT) break;
    if (typeof item === 'string') {
      const tags = item.trim();
      if (tags) entries.push(entryOf(tags, tags, ''));
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const src = item as RawImportEntry;
    const tags = str(src.tags) || str(src.prompt) || str(src.value);
    if (!tags) continue;
    const label = str(src.name_zh) || str(src.label) || str(src.name) || str(src.title) || tags;
    const sub = str(src.name) && str(src.name) !== label ? str(src.name) : '';
    entries.push(entryOf(label, tags, sub, str(src.preview) || str(src.thumbnail) || undefined));
  }
  return { entries, error: '' };
}

/**
 * 文本 → 条目。**一行一条**，两种写法：
 *
 *   `masterpiece`                    → 标签就是这一行
 *   `质量词 | masterpiece, best quality`  → 竖线左边是显示名，右边才是标签串
 *
 * 🔴 分隔符**只认竖线和 Tab**，不认逗号：标签串本身全是逗号
 *    （`evening gown, halterneck, side slit`），用逗号当分隔符会把一条标签劈成两半 ——
 *    而且劈出来看着还挺像回事，这种错最难发现。
 */
function entriesFromText(text: string): CustomTagEntry[] {
  const entries: CustomTagEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (entries.length >= MAX_IMPORT) break;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cut = line.includes('|') ? line.indexOf('|') : line.indexOf('\t');
    if (cut > 0) {
      const label = line.slice(0, cut).trim();
      const tags = line.slice(cut + 1).trim();
      if (tags) entries.push(entryOf(label || tags, tags, ''));
      continue;
    }
    entries.push(entryOf(line, line, ''));
  }
  return entries;
}

/** 条目 id：取「标签串」的哈希 —— 同一条导两次会得到同一个 id，重复导入不会翻倍。 */
function entryOf(label: string, tags: string, sub: string, preview?: string): CustomTagEntry {
  const digest = crypto.createHash('md5').update(tags).digest('hex').slice(0, 10);
  return {
    id: `e-${digest}`,
    label,
    tags,
    sub: sub || undefined,
    preview: preview || undefined,
  };
}

export type TagImportResult = {
  ok: boolean;
  message: string;
  entries: CustomTagEntry[];
  /** 读了几个文件 / 跳过了哪些（给界面显示前几条）。 */
  files: number;
  skipped: string[];
};

/** 读用户选的那几个文件，变成条目。**只读，不写任何东西** —— 收不收由用户决定。 */
export function importTagFiles(files: string[]): TagImportResult {
  const list = (files || []).map(item => String(item || '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, message: '没选文件。', entries: [], files: 0, skipped: [] };

  const entries: CustomTagEntry[] = [];
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
    message: entries.length
      ? `从 ${read} 个文件读到 ${entries.length} 条标签。`
      : '没读到可用的标签。',
    entries,
    files: read,
    skipped: skipped.slice(0, 5),
  };
}
