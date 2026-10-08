/*
 * Danbooru tag picker ("D站标签选择器") — pure logic layer.
 *
 * Same shape as `textChain.ts`: the *rules* (how a draw is made, how the string is
 * assembled) cannot be verified by looking at the UI, so they live in one place that
 * can be asserted on. Comments are in English (2026-10-04, per 徐先); UI text stays Chinese.
 *
 * Data source: Comfyui-Anima-Tools (`js/character_data.js`, `pose_data.js`,
 * `background_data.js`, `data.js`) converted to JSON at `src/public/danbooru/`.
 * It ships inside the package, so no network is needed for the lists.
 * Pose / background *preview images* are remote (jsDelivr) — those degrade silently.
 */

/*
 * 用户自己建的分类（2026-10-08，面板 tab 条最右边那颗「+」）。
 * 形状与读写都在 `@/lib/danbooruCats` —— 那边是唯一那份真相，这里只借类型
 * （`import type` 编译期就抹掉了，不会把那个模块拖进产物）。
 */
import type { CustomCategory } from '@/lib/danbooruCats';

/** One character entry: its Danbooru tag is `name` itself. */
export type DanbooruCharacter = {
  name: string;
  copyright: string;
  post_count: number;
  gender: string;
  hair: string;
  eye: string;
};

/** One artist entry: rendered as `@name`. */
export type DanbooruArtist = { name: string; post_count: number };

/** One pose / background / clothing entry. `tags` is the comma-separated English tag string. */
export type DanbooruScene = {
  id: string;
  name: string;
  name_zh: string;
  tags: string;
  categories: string[];
  preview: string;
};

export type DanbooruData = {
  characters: DanbooruCharacter[];
  artists: DanbooruArtist[];
  poses: DanbooruScene[];
  backgrounds: DanbooruScene[];
  /** 服装（2026-10-08 徐先要的「服装的分类」）。 */
  clothings: DanbooruScene[];
};

/*
 * ---------------------------------------------------------------------------
 * Character preview images
 * ---------------------------------------------------------------------------
 */

/**
 * 角色行的预览图地址。
 *
 * 这份 `characters.json` 里**没有** preview 字段（上游 `character_data.js` 就没有），
 * 但官方站 animadex.net 每个角色都有一张缩略图，地址是**可推导的**：
 * `<name>, <copyright>` 全小写、URL 编码，放在它那个 blobs 域下的 thumbs/ 里。
 * 于是不用为 4000 条各存一份（那份清单 476 KB，再塞 4000 条地址要翻一倍），
 * 也不用发第二次请求 —— 拼出来就行。
 *
 * 🔴 加载不出来时**静默降级**（跟姿势 / 环境那两栏一条规矩）：行高由外面那个固定方块撑着，
 *    图没了名字还在，条目照样点得到 —— 离线 / 墙外的时候整列还是一条能用的清单。
 *
 * `copyright` 为空的那几条（极少数）拼不出地址，返回空串让调用方跳过缩略图。
 */
export function characterThumb(name: string, copyright: string): string {
  const stem = `${String(name || '').trim().toLowerCase()}, ${String(copyright || '').trim().toLowerCase()}`;
  if (!String(copyright || '').trim()) return '';
  return `https://blobs.animadex.net/Outputs/thumbs/${encodeURIComponent(stem)}.webp`;
}

/**
 * What the user picked — the *persistent* part stored on the node.
 *
 * Only names / ids are stored, never the assembled string: the string is the result of
 * one draw, and storing it here would mean "reroll" loses the original picks.
 */
export type TagSelection = {
  /** Character names (the tag is the name). */
  characters: string[];
  /** Pose ids. */
  poses: string[];
  /** Background ids. */
  backgrounds: string[];
  /** Clothing ids. */
  clothings: string[];
  /** Artist names. */
  artists: string[];
  /**
   * 自定义分类：`分类 id -> 选中的条目 id`。
   *
   * 🔴 **按 id 存，不按 `tags` 存**：条目可以改标签串（用户手输改一行），
   *    存串的话改完选择就对不上了；存 id 至少能看出「这条已经不在清单里了」，
   *    抽签时跳过它、别的一串照出（与内置那几档同一条规矩）。
   */
  custom: Record<string, string[]>;
  /** Free-form tags the user typed; always appended verbatim. */
  extra: string;
  /**
   * `random` — draw a fresh batch every time the run starts.
   * `fixed`  — keep the current batch; only "换一批" redraws.
   */
  mode: 'random' | 'fixed';
};

export function emptyTagSelection(): TagSelection {
  return {
    characters: [], poses: [], backgrounds: [], clothings: [], artists: [],
    custom: {}, extra: '', mode: 'random',
  };
}

/** Normalise anything read back from an old canvas into a full selection object. */
export function normalizeTagSelection(raw: unknown): TagSelection {
  const base = emptyTagSelection();
  if (!raw || typeof raw !== 'object') return base;
  const src = raw as Partial<TagSelection>;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : [];
  return {
    characters: list(src.characters),
    poses: list(src.poses),
    backgrounds: list(src.backgrounds),
    clothings: list(src.clothings),
    artists: list(src.artists),
    custom: normalizeCustomPicks(src.custom),
    extra: typeof src.extra === 'string' ? src.extra : '',
    /* Unknown / missing mode falls back to `random` — that is what the node did
       before the switch existed, and it is the mode people asked for. */
    mode: src.mode === 'fixed' ? 'fixed' : 'random',
  };
}

/**
 * `custom` 那一份：`{ 分类 id: [条目 id] }`。
 *
 * 分类被删掉之后，节点上还留着老分类的 id —— 那是**正常**的（画布是快照语义），
 * 抽签时会因为找不到分类而跳过它。所以这里只做形状清理，不按当前清单裁。
 */
function normalizeCustomPicks(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(key || '').trim();
    if (!id || !Array.isArray(value)) continue;
    const list = value.map(item => String(item || '').trim()).filter(Boolean);
    if (list.length) out[id] = list;
  }
  return out;
}

/*
 * ---------------------------------------------------------------------------
 * Data loading
 * ---------------------------------------------------------------------------
 */

const DATA_FILES = {
  characters: '/danbooru/characters.json',
  artists: '/danbooru/artists.json',
  poses: '/danbooru/poses.json',
  backgrounds: '/danbooru/backgrounds.json',
  clothings: '/danbooru/clothings.json',
};

let cache: Promise<DanbooruData> | null = null;

/**
 * Load the bundled lists. Cached at module level: the panel can be opened and closed
 * repeatedly and a 1.1 MB re-fetch + re-parse each time is noticeable.
 *
 * Never throws a half-loaded object — on failure the cache is cleared so the next
 * open retries, and the caller gets a rejection it can show.
 */
export function loadDanbooruData(): Promise<DanbooruData> {
  if (cache) return cache;
  cache = (async () => {
    const [characters, artists, poses, backgrounds, clothings] = await Promise.all([
      fetchJson<DanbooruCharacter[]>(DATA_FILES.characters),
      fetchJson<DanbooruArtist[]>(DATA_FILES.artists),
      fetchJson<DanbooruScene[]>(DATA_FILES.poses),
      fetchJson<DanbooruScene[]>(DATA_FILES.backgrounds),
      fetchJson<DanbooruScene[]>(DATA_FILES.clothings),
    ]);
    return { characters, artists, poses, backgrounds, clothings };
  })().catch(error => {
    cache = null;
    throw error;
  });
  return cache;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/*
 * ---------------------------------------------------------------------------
 * Drawing
 * ---------------------------------------------------------------------------
 */

/** Small deterministic PRNG. Same seed -> same batch, so "fixed" is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed that changes every call (`random` mode / pressing "换一批"). */
export function freshSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

export type TagDraw = {
  character: string;
  pose: string;
  background: string;
  clothing: string;
  artists: string[];
  /** 自定义分类这一轮真正要接上去的那几串（已经按各分类自己的模式抽过）。 */
  custom: string[];
};

/**
 * Draw one batch out of the selection.
 *
 * Character / pose / background / clothing: pick **one** from the chosen pool.
 * Artist: **all** of them, in the order the user picked them (徐先: "画师串" — the whole
 * chain goes in, not a random one).
 *
 * 🔴 A pick is skipped (not crashed) when a name is no longer in the bundled list
 * (e.g. the bundled set was trimmed): the rest of the string must still be produced.
 */
export function drawTags(
  selection: TagSelection,
  data: DanbooruData,
  seed: number,
  custom: CustomCategory[] = [],
): TagDraw {
  const rand = mulberry32(seed);
  const pickOne = (pool: string[]): string =>
    pool.length ? pool[Math.floor(rand() * pool.length) % pool.length] : '';
  return {
    character: pickOne(selection.characters),
    pose: pickOne(selection.poses),
    background: pickOne(selection.backgrounds),
    clothing: pickOne(selection.clothings),
    artists: selection.artists.slice(),
    custom: drawCustom(selection.custom, custom, rand),
  };
}

/**
 * 自定义分类那一档。
 *
 * `all` 按**分类里的顺序**接（不是点击顺序）：那个顺序就是用户排出来的顺序，
 * 抽签不该把它打乱 —— 「质量词」这类整串接上的东西，顺序错了会被模型当成两回事。
 *
 * 🔴 分类被删了 / 条目被删了 → **跳过，不炸**：画布上的 `tagSelection` 是一份快照，
 *    分类清单却是随时能改的外挂数据，两边对不上是常态（同 `drawTags` 顶上那条）。
 */
function drawCustom(
  picks: Record<string, string[]>,
  categories: CustomCategory[],
  rand: () => number,
): string[] {
  const out: string[] = [];
  for (const category of categories) {
    const chosen = picks?.[category.id] || [];
    if (!chosen.length) continue;
    const pool = category.entries.filter(entry => chosen.includes(entry.id));
    if (!pool.length) continue;
    if (category.mode === 'all') {
      for (const entry of pool) if (entry.tags) out.push(entry.tags);
      continue;
    }
    const one = pool[Math.floor(rand() * pool.length) % pool.length];
    if (one?.tags) out.push(one.tags);
  }
  return out;
}

/**
 * Assemble the final tag string.
 *
 * Order follows the Anima-Tools composer (`artist, character, clothing, background, pose`)
 * with the user's own categories next and their free-form tags last — that is the order the
 * upstream models are trained on, and the order the reference plugin emits.
 * 自定义分类插在**姿势之后、自由文本之前**（2026-10-08）：它是用户自己往上加的，
 * 排在「内置的那五档」后面才不会把既有那串的顺序改掉。
 *
 * The trailing `", "` mirrors the plugin too: this string is meant to be *prefixed* to
 * more prompt text downstream, so it must not glue onto it.
 */
export function composeTags(draw: TagDraw, data: DanbooruData, extra: string): string {
  const parts: string[] = [];
  for (const name of draw.artists) {
    if (name) parts.push(`@${name}`);
  }
  if (draw.character) parts.push(draw.character);
  const clothing = data.clothings.find(item => item.id === draw.clothing);
  if (clothing?.tags) parts.push(clothing.tags);
  const background = data.backgrounds.find(item => item.id === draw.background);
  if (background?.tags) parts.push(background.tags);
  const pose = data.poses.find(item => item.id === draw.pose);
  if (pose?.tags) parts.push(pose.tags);
  for (const text of draw.custom || []) if (text) parts.push(text);
  const own = String(extra || '').trim().replace(/,\s*$/, '');
  if (own) parts.push(own);
  if (!parts.length) return '';
  return `${parts.join(', ')}, `;
}

/** Draw + assemble in one step (what the node stores into `tagText`). */
export function rollTagText(
  selection: TagSelection,
  data: DanbooruData,
  seed: number,
  custom: CustomCategory[] = [],
): string {
  return composeTags(drawTags(selection, data, seed, custom), data, selection.extra);
}

/*
 * ---------------------------------------------------------------------------
 * Search
 * ---------------------------------------------------------------------------
 */

/**
 * Case-insensitive substring match over the fields people actually type.
 * Chinese names are matched too (`name_zh`), so typing 海滩 finds the beach set.
 */
export function matchCharacter(item: DanbooruCharacter, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return item.name.toLowerCase().includes(q) || item.copyright.toLowerCase().includes(q);
}

export function matchArtist(item: DanbooruArtist, query: string): boolean {
  if (!query) return true;
  return item.name.toLowerCase().includes(query.toLowerCase());
}

export function matchScene(item: DanbooruScene, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return item.name.toLowerCase().includes(q)
    || item.name_zh.toLowerCase().includes(q)
    || item.tags.toLowerCase().includes(q);
}

/** Cap on rendered rows: a 4000-row list is neither fast nor scannable. */
export const SEARCH_LIMIT = 120;

/** Human label for a chosen id, used by the "已选" chips. */
export function sceneLabelOf(data: DanbooruData, kind: 'poses' | 'backgrounds' | 'clothings', id: string): string {
  const item = data[kind].find(entry => entry.id === id);
  if (!item) return id;
  return item.name_zh || item.name || id;
}
