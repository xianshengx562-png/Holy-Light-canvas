/*
 * 自定义标签分类（2026-10-08，徐先：「标签也可以自己加分类」）—— 渲染层这一侧的模型与读写。
 *
 * 三件事放这儿：
 *   ① **形状**（`CustomCategory` / `CustomEntry`）—— 纯类型，主进程、面板、纯函数层共用；
 *   ② **缓存**：模块级一份 + 订阅，面板与画布读的是同一份，不会各拿各的；
 *   ③ **读写**：全部走 preload 的 `window.api.danbooruCats*`（主进程才碰得到 `node:fs`）。
 *
 * 🔴 为什么缓存要放在模块层而不是面板 state 里：抽签发生在 `CanvasEditor`（「启动」时重抽），
 *    那时面板**可能根本没开**。它得能同步拿到这份清单 —— 所以写盘之后缓存立刻更新，
 *    再把 IPC 发出去（乐观写）。失败只影响「下次开机还在不在」，不影响这一轮抽签。
 *
 * 🔴 `mode` 是**每个分类自己**的（`pick` 抽 1 条 / `all` 整串接上）—— 徐先 2026-10-08 选的那档。
 *    做成全局开关的话，「质量词」这种要整串接的会和「衣服」这种要抽一个的互相打架。
 */

/** 一条自定义标签：`label` 给人看，`tags` 才是接进提示词的那串。 */
export type CustomEntry = {
  id: string;
  label: string;
  tags: string;
  /** 副标题（导入时的原文 / 出处），列表里那行小字。 */
  sub?: string;
  /** 缩略图（只有「从已有档收藏」会带，是远程地址）。 */
  preview?: string;
};

export type CustomCategory = {
  id: string;
  name: string;
  /** `pick` — 每次运行从选中项里抽 1 条；`all` — 选中项按顺序整串接上。 */
  mode: 'pick' | 'all';
  entries: CustomEntry[];
};

/** 一次导入读到的条目（`message` / `skipped` 直接显示给用户）。 */
export type TagImportOutcome = {
  ok: boolean;
  message: string;
  entries: CustomEntry[];
  files: number;
  skipped: string[];
};

/**
 * 条目 id：`tags` 的哈希。
 *
 * 🔴 取哈希而不是序号：同一条标签导两次、或者在手输里又打了一遍，会得到同一个 id ——
 *    否则列表里会出现两条一模一样的，而用户「明明只加了一次」。
 *    （主进程导入那边用 md5，这里是渲染层，用同一套 djb2 保证两边算法一致即可。）
 */
export function entryIdOf(tags: string): string {
  const text = String(tags || '');
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return `e-${hash.toString(36)}`;
}

/** 分类 id：时间戳 + 随机尾巴。分类名可以重复、可以改，id 不能。 */
export function newCategoryId(): string {
  return `c-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 手输一条标签：变成条目。 */
export function entryFromInput(text: string): CustomEntry | null {
  const tags = String(text || '').trim();
  if (!tags) return null;
  return { id: entryIdOf(tags), label: tags, tags };
}

/**
 * 把从磁盘 / 画布读回来的东西修成合法形状。
 *
 * 老数据只存了纯字符串（一行一个标签）也认 —— 这个功能第一版就可能那样存过。
 */
export function normalizeCustomCategories(raw: unknown): CustomCategory[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomCategory[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const src = item as Partial<CustomCategory> & { entries?: unknown };
    const name = String(src.name || '').trim();
    if (!name) continue;
    const list = Array.isArray(src.entries) ? src.entries : [];
    const entries: CustomEntry[] = [];
    for (const entry of list) {
      const one = typeof entry === 'string'
        ? entryFromInput(entry)
        : normalizeEntry(entry as Partial<CustomEntry>);
      if (one && !entries.some(exist => exist.id === one.id)) entries.push(one);
    }
    out.push({
      id: String(src.id || '').trim() || newCategoryId(),
      name,
      mode: src.mode === 'all' ? 'all' : 'pick',
      entries,
    });
  }
  return out;
}

function normalizeEntry(raw: Partial<CustomEntry> | null | undefined): CustomEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const tags = String(raw.tags || '').trim();
  if (!tags) return null;
  const label = String(raw.label || '').trim() || tags;
  const sub = String(raw.sub || '').trim();
  const preview = String(raw.preview || '').trim();
  return {
    id: String(raw.id || '').trim() || entryIdOf(tags),
    label,
    tags,
    sub: sub || undefined,
    preview: preview || undefined,
  };
}

/* ------------------------------------------------------------------ *
 * preload 上那三个方法（只有桌面版有）
 * ------------------------------------------------------------------ */

type CatsApi = {
  danbooruCatsLoad?: () => Promise<{ version: number; categories: unknown }>;
  danbooruCatsSave?: (payload: { categories: CustomCategory[] }) => Promise<{ ok: boolean; message: string }>;
  danbooruCatsImport?: (payload: { files: string[] }) => Promise<{
    ok: boolean; message: string; entries: CustomEntry[]; files: number; skipped: string[];
  }>;
};

function catsApi(): CatsApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { api?: CatsApi }).api ?? null;
}

/* ------------------------------------------------------------------ *
 * 模块级缓存 + 订阅
 * ------------------------------------------------------------------ */

let cache: CustomCategory[] = [];
let loaded = false;
let inflight: Promise<CustomCategory[]> | null = null;
const listeners = new Set<() => void>();

/** 同步读当前这份（没加载过就是空的）。抽签那条路用它 —— 等不了异步。 */
export function customCategoriesNow(): CustomCategory[] {
  return cache;
}

export function subscribeCustomCategories(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      /* 某个订阅者炸了不该拖垮其余的（面板 / 画布都订着）。 */
    }
  }
}

/**
 * 读一次（模块级缓存，重复调用不重复 IPC）。
 *
 * 🔴 读失败**当「还没有」**，不抛：这是面板打开时顺带做的一次查询，
 *    它炸了就是「整个标签面板打不开」—— 而自定义分类本来就是可选项。
 */
export function loadCustomCategories(): Promise<CustomCategory[]> {
  if (loaded) return Promise.resolve(cache);
  if (inflight) return inflight;
  const api = catsApi();
  if (!api?.danbooruCatsLoad) {
    loaded = true;
    return Promise.resolve(cache);
  }
  inflight = api.danbooruCatsLoad()
    .then(file => {
      cache = normalizeCustomCategories(file?.categories);
      loaded = true;
      notify();
      return cache;
    })
    .catch(() => {
      cache = [];
      loaded = true;
      return cache;
    })
    .then(result => {
      inflight = null;
      return result;
    });
  return inflight;
}

/**
 * 换一份（面板每次改动都调它）。
 *
 * **先更新缓存再发 IPC**：画布那边下一帧就要读这份来抽签，等写盘回来才更新的话，
 * 「刚加完分类、紧接着点启动」会漏掉这一次。写盘失败只回一句话，缓存不动。
 */
export function replaceCustomCategories(next: CustomCategory[]): Promise<{ ok: boolean; message: string }> {
  cache = next;
  loaded = true;
  notify();
  const api = catsApi();
  if (!api?.danbooruCatsSave) {
    return Promise.resolve({ ok: false, message: '只有桌面版能把分类存到本机。' });
  }
  return api.danbooruCatsSave({ categories: next })
    .then(result => ({ ok: Boolean(result?.ok), message: String(result?.message || '') }))
    .catch(error => ({
      ok: false,
      message: error instanceof Error ? error.message : '保存失败。',
    }));
}

/** 读用户选的那几个文件（一行一个标签，或「名字 | 标签串」）。**只读，收不收由调用方定**。 */
export async function importTagFiles(files: string[]): Promise<TagImportOutcome> {
  const api = catsApi();
  if (!api?.danbooruCatsImport) {
    return { ok: false, message: '只有桌面版能导入本机的标签清单。', entries: [], files: 0, skipped: [] };
  }
  try {
    const result = await api.danbooruCatsImport({ files });
    const entries: CustomEntry[] = [];
    for (const raw of result?.entries || []) {
      const one = normalizeEntry(raw);
      if (one && !entries.some(exist => exist.id === one.id)) entries.push(one);
    }
    return {
      ok: Boolean(result?.ok) && entries.length > 0,
      message: String(result?.message || ''),
      entries,
      files: Number(result?.files || 0),
      skipped: Array.isArray(result?.skipped) ? result.skipped : [],
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '导入失败。',
      entries: [], files: 0, skipped: [],
    };
  }
}
