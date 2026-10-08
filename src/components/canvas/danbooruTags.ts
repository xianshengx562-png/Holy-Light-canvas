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
  /**
   * 这个角色官方那一组特征标签（2026-10-08 徐先：「每个角色都有对应的一堆锁定标签」）。
   *
   * 来源是上游 `character_official_data.json`（7999 条）里对应的那份 `tags`，
   * 由 `.workbuddy/tmp/_anima-chartags.js` 合并进来 —— 当初导入时这个字段**整个丢掉了**，
   * 只留了 name / copyright / 发色 / 眼色。
   *
   * 🔴 上游那颗 `Apply Trigger` 出的是它的 `trigger` 字段，也就是 `名字, 版权` **两段**；
   *    我们这一档仍然只出 `name` —— 那是 1.0.105 起的既有口径，这一轮不擅自改它
   *    （改了会悄悄动到他已经排好的画布）。要跟上流完全对齐，单独说一声再加版权那段。
   * 🔴 出厂那份是**只读的基准**：用户在面板里改过之后存在 `TagSelection.characterTagEdits`，
   *    这里永远是「官方原样」，两者的取舍见 `characterTagsOf`。
   */
  tags?: string[];
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
   * 角色的**输出档位**（2026-10-08 徐先：「可以选择只输出角色名标签，或者输出角色标签」）。
   *
   * `false`（默认）= 只把角色名接进去；`true` = 角色名 + 这个角色那一组特征标签。
   * 对应上游 Anima 角色选择器底下那两颗按钮 `Apply Trigger` / `Apply Trigger + Tags`。
   *
   * 🔴 默认必须是 `false`：老画布上没这个字段，读回来正好就是它原来那份输出 ——
   *    给成 `true` 的话他一开画布，所有节点会当场多接十几个 tag。
   */
  characterDetail: boolean;
  /**
   * 用户**改过**的角色标签组：`角色名 -> 改后那一整组`。
   *
   * 没改过的角色**不在**这张表里（那时候用 `characters.json` 里官方那份）。
   * 所以「整组还原」= 把这个键删掉，而不是存一份跟官方一模一样的数组 ——
   * 后者在上游清单更新之后就变成一份过期的快照了。
   *
   * 🔴 空数组是**有效值**（把标签全删光 = 这一档退化成只出角色名），
   *    所以判「改没改过」要看键在不在，不能看 `length`（见 `characterTagsOf`）。
   */
  characterTagEdits: Record<string, string[]>;
  /**
   * 每一档**自己**的抽签模式：键 = `character` / `clothing` / `pose` / `background` /
   * `artist`，自定义分类是 `dc:<分类 id>`（2026-10-08 晚，徐先：「每个都可以单独设置」）。
   *
   * `random` — 每次点「启动」这一档重新抽；
   * `fixed`  — 这一档保持当前这一批，只有点「换一批」才重抽。
   *
   * 🔴 为什么必须**按档**存：一副画布上，「画师」往往想固定（风格不能乱跳），
   *    而「角色」想每轮换一个 —— 一个全局开关必然按下一个、顶掉另一个。
   *
   * 没写进 `modes` 的档位回落到下面那个老字段 `mode`（见 `tagModeOf`）。
   */
  modes: Record<string, TagMode>;
  /**
   * 老字段（1.0.111 及以前）：**所有档共用**一档模式。
   *
   * 🔴 留着是为了老画布：那时候节点上只有这一个开关，读回来必须让每档都按它走，
   *    否则他一开画布，那些「固定这一批」的节点会当场换一批。
   *    新写的选择只动 `modes`，这个字段不再被改。
   */
  mode: TagMode;
};

export type TagMode = 'random' | 'fixed';

/** 自定义分类在 `modes` / 选择里用的键前缀。面板与抽签两边共用这一份，别各写一遍。 */
export const CUSTOM_KEY_PREFIX = 'dc:';

/** 内置那几档的键（自由文本 `extra` 不参与抽签，所以不在里面）。 */
export const TAG_KINDS = ['character', 'clothing', 'pose', 'background', 'artist'] as const;

export function emptyTagSelection(): TagSelection {
  return {
    characters: [], poses: [], backgrounds: [], clothings: [], artists: [],
    custom: {}, extra: '', modes: {}, mode: 'random',
    characterDetail: false, characterTagEdits: {},
  };
}

/**
 * 这个角色官方那一组特征标签（`characters.json` 里那份）。没有就是空数组。
 *
 * 上游 `character_official_data.json` 里有 56 个角色 `tags` 是空的，而且它们的
 * gender / hair / eye 也都是空的 —— 那些角色在「角色名 + 标签」这一档下就只出角色名，
 * 与上游 `getCharacterTags` 返回空数组的表现一致。
 */
export function officialCharacterTags(item: DanbooruCharacter | undefined): string[] {
  return Array.isArray(item?.tags) ? item.tags.slice() : [];
}

/**
 * 这个角色**这一刻**要跟出去的那组标签：改过就听改的那份，没改过就是官方那份。
 *
 * 🔴 判据是「表里有没有这个键」，不是「数组长不长」—— 用户把标签**全删光**是一个有效状态
 *    （等于这一档退化成只出角色名）。用 `length` 判的话，删到最后一条时官方那组会当场复活，
 *    看着像「删不掉」。
 */
export function characterTagsOf(
  selection: TagSelection,
  item: DanbooruCharacter | undefined,
): string[] {
  const name = String(item?.name || '');
  const edited = name ? selection.characterTagEdits?.[name] : undefined;
  if (Array.isArray(edited)) return edited.slice();
  return officialCharacterTags(item);
}

/**
 * 这一档这一刻用哪一档模式：`modes` 里有就听它的，没有就跟着老的那个节点级 `mode`。
 *
 * 🔴 回落这一层是老画布的**唯一**兼容点 —— 别改成「没有就算 random」：
 *    老节点上那个 `fixed` 会整批失效。
 */
export function tagModeOf(selection: TagSelection, key: string): TagMode {
  const own = selection.modes?.[key];
  if (own === 'random' || own === 'fixed') return own;
  return selection.mode === 'fixed' ? 'fixed' : 'random';
}

/** 这个节点涉及的所有档位键：内置五档 + 选择里出现过的自定义分类。 */
export function tagKeysOf(selection: TagSelection): string[] {
  const keys: string[] = [...TAG_KINDS];
  for (const id of Object.keys(selection.custom || {})) keys.push(`${CUSTOM_KEY_PREFIX}${id}`);
  return keys;
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
    modes: normalizeModes(src.modes),
    /* 老画布没这个字段 -> `false` = 只出角色名，正好是它原来的行为。 */
    characterDetail: src.characterDetail === true,
    characterTagEdits: normalizeTagEdits(src.characterTagEdits),
    /* Unknown / missing mode falls back to `random` — that is what the node did
       before the switch existed, and it is the mode people asked for. */
    mode: src.mode === 'fixed' ? 'fixed' : 'random',
  };
}

/**
 * 每一档的模式：只认 `'random'` / `'fixed'` 两个值，别的键值一律丢掉。
 *
 * 🔴 **不按当前清单裁键**：画布上的选择是快照，分类可能已经被删了 ——
 *    那一档的键留着是正常的（分类回来了它还在），裁掉反而会丢用户设过的东西。
 */
function normalizeModes(raw: unknown): Record<string, TagMode> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, TagMode> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(key || '').trim();
    if (!name || (value !== 'random' && value !== 'fixed')) continue;
    out[name] = value;
  }
  return out;
}

/**
 * `characterTagEdits` 那一份：`{ 角色名: [标签...] }`。
 *
 * 🔴 **空数组要留着**（跟 `normalizeCustomPicks` 相反）：那里空数组 = 没选，可以直接丢；
 *    这里空数组 = 「这个角色一条标签都不要」，是用户点出来的结果，丢掉就等于把官方那组放回来。
 */
function normalizeTagEdits(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(key || '').trim();
    if (!name || !Array.isArray(value)) continue;
    out[name] = value.map(item => String(item || '').trim()).filter(Boolean);
  }
  return out;
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

/** 每一档这一刻用的种子。键与 `TAG_KINDS` / `CUSTOM_KEY_PREFIX` 同一套。 */
export type TagSeeds = Record<string, number>;

/**
 * 一个数字 + 一个档位键 → 那一档自己的种子（FNV-1a 混一下）。
 *
 * 🔴 每档一条独立随机流的**理由**是「固定这一批」：只传一个数字的话，
 *    角色那一档多抽一次，排在后头的服装就会跟着换 —— 固定不住。
 *    分开流之后，改别的档不会动到这一档。
 */
function keySeed(seed: number, key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (seed ^ (hash >>> 0)) >>> 0;
}

/**
 * 种子怎么推进一步。**三档意图是分开的**，别拿一个布尔糊过去：
 *
 * - `keep`    —— 在面板里改点什么（挑人 / 改模式）。种子**原样不动**：
 *                点一下「固定这一批」不该把别的档重抽一遍，那是同一件事发生两次。
 * - `advance` —— 「启动」跑一轮。`random` 的档换新的、`fixed` 的沿用上一把。
 * - `reroll`  —— 「换一批」。每一档都换（固定那一档也只有这条路能换）。
 *
 * 「上一把」不存在时一律给新的（老画布没有这个字段）。
 */
export type TagSeedRoll = 'keep' | 'advance' | 'reroll';

export function nextTagSeeds(
  selection: TagSelection,
  prev: TagSeeds | undefined,
  roll: TagSeedRoll = 'keep',
): TagSeeds {
  const out: TagSeeds = {};
  for (const key of tagKeysOf(selection)) {
    const had = typeof prev?.[key] === 'number';
    if (roll === 'reroll' || !had) { out[key] = freshSeed(); continue; }
    const carry = roll === 'keep' || tagModeOf(selection, key) === 'fixed';
    out[key] = carry ? (prev as TagSeeds)[key] : freshSeed();
  }
  return out;
}

/**
 * 这个节点还值不值得重抽。
 *
 * `false` = 每一档都是「固定这一批」（或者压根没有候选）→ **一个字节都别写**：
 * 老画布上那些整体 fixed 的节点正是靠这一条保持原样，顺手也就省掉一次重绘。
 */
export function tagNeedsRedraw(selection: TagSelection): boolean {
  const draws = (key: string, hasPool: boolean): boolean =>
    hasPool && tagModeOf(selection, key) === 'random';
  if (draws('character', selection.characters.length > 0)) return true;
  if (draws('clothing', selection.clothings.length > 0)) return true;
  if (draws('background', selection.backgrounds.length > 0)) return true;
  if (draws('pose', selection.poses.length > 0)) return true;
  for (const [id, picks] of Object.entries(selection.custom || {})) {
    if (picks.length && tagModeOf(selection, `${CUSTOM_KEY_PREFIX}${id}`) === 'random') return true;
  }
  return false;
}

export type TagDraw = {
  character: string;
  /**
   * 角色名后面跟着的那一组特征标签 —— **只有**「角色名 + 标签」那一档才非空。
   *
   * 顺序就是 `characters.json` 里官方那份的顺序（官方列表本身就是按 danbooru 的热度排的），
   * 不重排：重排等于自己发明一套，跟上游出来的串对不上。
   */
  characterTags: string[];
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
  seed: number | TagSeeds,
  custom: CustomCategory[] = [],
): TagDraw {
  /*
   * 每档一条独立随机流（`keySeed` 那段说明了为什么）。
   * `seed` 收一个数字也认：调用点只想要「随便抽一批」时不用先造一份 map。
   */
  const streamOf = (key: string): (() => number) => {
    if (typeof seed === 'number') return mulberry32(keySeed(seed, key));
    const own = seed?.[key];
    return mulberry32(typeof own === 'number' ? own >>> 0 : 0);
  };
  const pickOne = (pool: string[], rand: () => number): string =>
    pool.length ? pool[Math.floor(rand() * pool.length) % pool.length] : '';
  const character = pickOne(selection.characters, streamOf('character'));
  /*
   * 角色那一段：只有「角色名 + 标签」这一档才把它那组标签接上。
   * 清单里查不到这个角色（内置清单裁过、或者老画布上留着已经删掉的名字）→ 给空数组，
   * 名字照出，别让整段消失。
   */
  const characterItem = character
    ? data.characters.find(item => item.name === character)
    : undefined;
  const characterTags = selection.characterDetail
    ? characterTagsOf(selection, characterItem)
    : [];
  return {
    character,
    characterTags,
    pose: pickOne(selection.poses, streamOf('pose')),
    background: pickOne(selection.backgrounds, streamOf('background')),
    clothing: pickOne(selection.clothings, streamOf('clothing')),
    artists: selection.artists.slice(),
    custom: drawCustom(selection.custom, custom, streamOf),
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
  streamOf: (key: string) => () => number,
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
    /* 每个自定义分类**各用自己那条流**：它排在第几位、前面有几档，都不影响它抽到谁。 */
    const rand = streamOf(`${CUSTOM_KEY_PREFIX}${category.id}`);
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
 * 角色那一段（2026-10-08 晚）：`character + characterTags` —— 后者只有「角色名 + 标签」
 * 那一档才非空，默认（只出角色名）拼出来的串跟这一轮之前**一字不差**。
 *
 * The trailing `", "` mirrors the plugin too: this string is meant to be *prefixed* to
 * more prompt text downstream, so it must not glue onto it.
 */
export function composeTags(draw: TagDraw, data: DanbooruData, extra: string): string {
  const parts: string[] = [];
  for (const name of draw.artists) {
    if (name) parts.push(`@${name}`);
  }
  if (draw.character) {
    parts.push(draw.character);
    /*
     * 角色那组特征标签**紧跟在角色名后面**（上游 `getCharacterPromptParts` 就是这个次序：
     * trigger 先出、tags 再补）。
     *
     * 🔴 去重按大小写不敏感，而且要把**角色名本身**也放进已见集合：官方那份里偶尔会把
     *    自己的名字又列一遍；不去重的话 `hatsune miku, hatsune miku` 这种会直接发出去。
     */
    const seen = new Set([draw.character.trim().toLowerCase()]);
    for (const raw of draw.characterTags || []) {
      const tag = String(raw || '').trim();
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      parts.push(tag);
    }
  }
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
  seed: number | TagSeeds,
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
