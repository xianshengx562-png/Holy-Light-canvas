/*
 * D站标签的「收藏」（2026-10-09，徐先：「可以每个选项都有收藏功能」）—— 渲染层这一侧的读写。
 *
 * 每一档的每一行都能标星：收藏的排在该档最前面，另有「只看收藏」开关。
 * 形状与读写规矩都照 `@/lib/danbooruCats`（自定义分类）那一套，理由也基本一致：
 *
 *   ① **用户级**：存在 `<dataDir>/danbooru-favorites.json`，换项目、换画布都还在；
 *   ② **模块级缓存 + 订阅**：面板与画布读的是同一份，不会各拿各的；
 *   ③ **乐观写**：先更新缓存再发 IPC —— 收藏这种一点就要看见的反应，
 *      等写盘回来才变星会显得卡顿，而写盘失败只影响「下次开机还在不在」。
 *
 * 🔴 只存 **id 清单**，不存整条内容：内置清单是随包的、会随版本增删，
 *    把标签串抄一份进来的话，「收藏了什么」会跟列表里实际显示的对不上。
 *
 * 🔴 与自定义分类那份**是两份文件**：那份存的是用户自己建的条目（内容归用户），
 *    这份只存「内置清单里哪几条被标了星」（内容归随包的清单）。硬凑一份会让
 *    两边都得判空，而且删一个分类时还得回头清这边的星。
 */

/** 桶 → 这一桶里收藏了哪些 id。桶名的规矩见 `electron/main/danbooru-favs.ts`。 */
export type FavoriteMap = Record<string, string[]>;

/** 自定义分类那一桶的前缀（分类可以删，所以按分类分开存）。 */
const CUSTOM_PREFIX = 'custom:';

/** 内置那一档的桶名就是面板的 tab 键；自定义分类是 `custom:<分类 id>`。 */
export function favBucketOf(tab: string, customId?: string): string {
  if (customId) return `${CUSTOM_PREFIX}${customId}`;
  return String(tab || '').trim();
}

/* ------------------------------------------------------------------ *
 * preload 上那两个方法（只有桌面版有）
 * ------------------------------------------------------------------ */

type FavsApi = {
  danbooruFavsLoad?: () => Promise<{ version: number; favs: unknown }>;
  danbooruFavsSave?: (payload: { favs: FavoriteMap }) => Promise<{ ok: boolean; message: string }>;
};

function favsApi(): FavsApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { api?: FavsApi }).api ?? null;
}

/* ------------------------------------------------------------------ *
 * 模块级缓存 + 订阅
 * ------------------------------------------------------------------ */

let cache: FavoriteMap = {};
let loaded = false;
let inflight: Promise<FavoriteMap> | null = null;
const listeners = new Set<() => void>();

/** 同步读当前这份（没加载过就是空的）。渲染时排序要用，等不了异步。 */
export function favoritesNow(): FavoriteMap {
  return cache;
}

export function subscribeFavorites(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      /* 某个订阅者炸了不该拖垮其余的。 */
    }
  }
}

/** 把从磁盘读回来的东西修成合法形状。读坏了当「还没收藏过」。 */
function normalize(raw: unknown): FavoriteMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: FavoriteMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const bucket = String(key || '').trim();
    if (!bucket || !Array.isArray(value)) continue;
    const ids: string[] = [];
    for (const item of value) {
      const id = String(item || '').trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (ids.length) out[bucket] = ids;
  }
  return out;
}

/** 读一次（模块级缓存，重复调用不重复 IPC）。失败当「还没收藏过」，不抛。 */
export function loadFavorites(): Promise<FavoriteMap> {
  if (loaded) return Promise.resolve(cache);
  if (inflight) return inflight;
  const api = favsApi();
  if (!api?.danbooruFavsLoad) {
    loaded = true;
    return Promise.resolve(cache);
  }
  inflight = api.danbooruFavsLoad()
    .then(file => {
      cache = normalize(file?.favs);
      loaded = true;
      notify();
      return cache;
    })
    .catch(() => {
      cache = {};
      loaded = true;
      return cache;
    })
    .then(result => {
      inflight = null;
      return result;
    });
  return inflight;
}

/** 这一条现在是不是收藏着的。 */
export function isFavorite(bucket: string, id: string): boolean {
  const list = cache[bucket];
  return Array.isArray(list) && list.includes(String(id || ''));
}

/**
 * 标星 / 取消标星。**先改缓存再发 IPC**（乐观写）。
 *
 * 返回新的那份 map，方便调用方直接拿去算。
 */
export function toggleFavorite(bucket: string, id: string): FavoriteMap {
  const key = String(bucket || '').trim();
  const target = String(id || '');
  if (!key || !target) return cache;
  const current = Array.isArray(cache[key]) ? cache[key] : [];
  const next = current.includes(target)
    ? current.filter(item => item !== target)
    : [...current, target];
  const favs: FavoriteMap = { ...cache };
  if (next.length) favs[key] = next;
  else delete favs[key];
  cache = favs;
  loaded = true;
  notify();
  const api = favsApi();
  if (api?.danbooruFavsSave) {
    /* 写盘失败不当场报错：星已经点上了，下次开机丢掉而已 —— 弹红字反而让人以为是没点上。 */
    void api.danbooruFavsSave({ favs: cache }).catch(() => undefined);
  }
  return cache;
}
