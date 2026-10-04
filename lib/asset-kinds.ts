/**
 * 资产种类常量 —— **故意单独成一个文件，不放在 `lib/assets.ts` 里**。
 *
 * `lib/assets.ts` 引了 `node:fs` 和数据库，只能活在主进程；而「全部 / 视频 / 图片 / 音频」
 * 这几个筛选项在渲染进程的资产页也要用。要是把常量留在那边，资产页一 `import` 就会把
 * `node:fs/promises` 一起拖进浏览器包，Vite 直接构建失败。
 *
 * 所以这里只放**纯数据**（不 import 任何东西），`lib/assets.ts` 再 `export *` 转出去，
 * 服务端那边的调用方什么都不用改。
 */

/**
 * `text` 是 2026-10-04 加的：**只吐文字**的应用 / 节点，那段文字也落成本项目下的一份资产
 * （一个 `.txt`）。没有这一档的话，那种任务成功之后资产库里什么都找不到。
 */
export type AssetKind = 'video' | 'image' | 'audio' | 'latent' | 'text';

export const ASSET_KINDS: { value: AssetKind | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'latent', label: 'Latent' },
  { value: 'text', label: '文本' },
];

export const KIND_LABEL: Record<string, string> = {
  video: '视频',
  image: '图片',
  audio: '音频',
  latent: 'Latent',
  text: '文本',
};

/* ------------------------------------------------------------------ *
 * 资产分类（2026-09-26 起由**用户自己维护**）
 * ------------------------------------------------------------------ */

/**
 * 分类名就是一个普通字符串 —— 不再有写死的枚举。
 *
 * 改版前是 `ImageCategory = 'character' | 'scene' | 'prop'` **三选一**，而且只对图片生效；
 * 现在用户在资产页自己增删改，**任何类型的资产都能打分类**（视频、音频、latent 一样能分）。
 *
 * `assets.category` 列里存的就是这个字符串本身（不是分类的 id）：
 *  - 存 id 的好处是改名不用动资产，代价是**改版前那批 `character` / `scene` / `prop` 全部要迁移**，
 *    而且读列表时还得 join 一次才能显示出名字；
 *  - 存名字则新旧数据天然兼容，改名的代价（要把打了这个分类的资产一起改掉）由
 *    `lib/assets.ts` 的 `renameAssetCategory()` 承担，那里是唯一会发生这件事的地方。
 *
 * 显示时**不需要「值 → 标签」的映射表**：名字本身就是给人看的。
 */
export type AssetCategoryName = string;

/** 筛选值：不筛。 */
export const CATEGORY_ALL = 'all';
/** 筛选值：没打过分类（库里是 `NULL`）。 */
export const CATEGORY_NONE = 'none';

/**
 * 筛选值 = `'all'` / `'none'` / 某个分类名。
 *
 * 「未分类」不能和 `null` 挤在同一个值上：否则「筛未分类」和「根本不筛」没法区分
 * （改版前就是靠把类型钉死在图片上来绕开这件事的，而现在已经没有这个限制了）。
 */
export type CategoryFilter = string;

/** 分类名上限。一排 chip 摆在筛选器上，太长会把整行挤换行。 */
export const CATEGORY_NAME_MAX = 24;

/** 首次用到时惰性种进去的三个默认分类。见 `lib/assets.ts` 的 `ensureDefaultCategories()`。 */
export const DEFAULT_CATEGORY_NAMES: readonly string[] = ['角色', '场景', '道具'];

/**
 * 老数据的 slug → 新名字。
 *
 * 改版前库里存的是 `character` / `scene` / `prop`，界面上靠一张 `CATEGORY_LABEL` 翻成中文；
 * 改版后存的就是中文名。这份表只在**那一次**迁移里用。
 */
export const LEGACY_CATEGORY_SLUGS: Record<string, string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
};

/** 一个分类（前端拿到的形状）。`count` = 目前有多少条资产打着它。 */
export type AssetCategoryItem = { id: string; name: string; count: number };

/**
 * 归一化：折行/多空格压成一个空格、去首尾。**超长或不是字符串就返回空串**，由调用方判非法。
 *
 * 与资产改名（`renameAsset`）同一个规矩：名字那一行是 `nowrap + 省略号`，
 * 夹着换行符看着像坏了。
 */
export function normalizeCategoryName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const name = value.replace(/\s+/g, ' ').trim();
  return name.length > CATEGORY_NAME_MAX ? '' : name;
}

/**
 * **纯形状**校验：非空、不超长、不是两个保留字。
 *
 * ⚠️ 这里**只管这个名字长得对不对，不管它存不存在**。存在性要查库，
 * 而这个文件被浏览器包 import，碰不得数据库（见文件头）—— 那一半校验在
 * 服务端的 `lib/assets.ts` 里做。
 */
export function isCategoryName(value: unknown): value is AssetCategoryName {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > CATEGORY_NAME_MAX) return false;
  /* `all` / `none` 是筛选器的保留字：叫这两个名字的话「不筛」和「筛它」就没法区分了。 */
  return name !== CATEGORY_ALL && name !== CATEGORY_NONE;
}

export function isCategoryFilter(value: unknown): value is CategoryFilter {
  return typeof value === 'string'
    && (value === CATEGORY_ALL || value === CATEGORY_NONE || isCategoryName(value));
}

/* ------------------------------------------------------------------ *
 * 「这段视频能不能接续」：一次生成归档下来的 latent
 * ------------------------------------------------------------------ */

/**
 * 一次生成归档下来的那几份 latent（一次会归档两份：粗采样 `coarse` / 精采样 `fine`）。
 *
 * 放在这里而不是 `lib/assets.ts`，是因为**画布那一头也要认这同一份形状** ——
 * 而 `lib/assets.ts` 带 `node:fs` 和数据库，浏览器包一 import 就构建失败。
 */
export type RelayLatentItem = {
  id: string;
  /** 归档编号（L001 这种）。 */
  sequence: string;
  kind: 'coarse' | 'fine';
  size: number;
};
