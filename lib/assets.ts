import 'server-only';
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { latentRoot, mediaRoot, resolveStoredPath } from '@/lib/output-dir';

/**
 * 资产库的读模型 + 删除。
 *
 * 「资产」= `Asset` 表的一行，来源只有两个：
 *  - 生成成功的媒体（`lib/media.ts` 落盘，type = `video` / `image`）
 *  - 接续用的 latent（`lib/latents.ts` gzip 落盘，type = `latent`）
 *
 * 一行资产 = **一条数据库记录 + 一个磁盘文件**，两者必须一起消失，
 * 所以删除只能走这里（见 `deleteAsset`），不要在各处自己 `db.asset.delete`。
 *
 * 反过来「有文件、没记录」的情况（孤儿文件）由 `scanOrphans()` 报出来、
 * `cleanupOrphans()` 收掉——那些文件对应的取流地址一定 404，留着只是占地方。
 */

/** 常量搬到 `lib/asset-kinds.ts` 了（那边纯净、渲染进程也能 import），这里只是转出去保持调用方不变。 */
export type {
  AssetKind, AssetCategoryName, AssetCategoryItem, CategoryFilter,
} from './asset-kinds';
export {
  ASSET_KINDS, KIND_LABEL,
  CATEGORY_ALL, CATEGORY_NONE, CATEGORY_NAME_MAX,
  DEFAULT_CATEGORY_NAMES, LEGACY_CATEGORY_SLUGS,
  normalizeCategoryName, isCategoryName, isCategoryFilter,
} from './asset-kinds';
import type { AssetCategoryItem, AssetKind, CategoryFilter, RelayLatentItem } from './asset-kinds';
import {
  DEFAULT_CATEGORY_NAMES, LEGACY_CATEGORY_SLUGS, isCategoryName, normalizeCategoryName,
} from './asset-kinds';

export type AssetItem = {
  id: string;
  name: string;
  type: AssetKind;
  /** 分类（用户自己维护，**任何类型都能打**）；没打标签是 `null`。存的就是分类名本身。 */
  category: string | null;
  /** 媒体是 `/api/assets/{id}/media.{ext}`，latent 是 `/api/assets/{id}/download`。 */
  url: string;
  /** 下载链接：媒体加 `?download=1` 才会带 attachment 头。 */
  downloadUrl: string;
  size: number;
  /**
   * 时间与体积都在**服务端**格式化后传下去。
   * 客户端再格式化一次会因为服务端/浏览器时区不同触发 hydration 不一致。
   */
  createdLabel: string;
  sizeLabel: string;
  projectId: string;
  projectName: string;
  /** 这次生成是哪条任务 —— 视频能不能「接续」就看它（按它去找那次归档的 latent）。 */
  sourceTaskId: string | null;
  /** 这次生成归档下来的 latent（粗 / 精）。只有视频会有，其它类型是空数组。 */
  relayLatents: RelayLatentItem[];
};

export function formatSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

/** `metadata` 是 Json 列，取字段一律做宽松转换——老记录里缺字段是常态。 */
function metaOf(value: Prisma.JsonValue | null) {
  return (value || {}) as { size?: number; packedSize?: number; sequence?: string; kind?: string };
}

function isKind(value: string): value is AssetKind {
  return value === 'video' || value === 'image' || value === 'audio' || value === 'latent' || value === 'text';
}

export async function listAssets(input: {
  userId: string;
  type?: AssetKind | 'all';
  /** 分类筛选：某个分类名 / `'none'`（没打过分类）/ `'all'`（不筛）。 */
  category?: CategoryFilter;
  projectId?: string;
  take?: number;
}): Promise<{ items: AssetItem[]; total: number; totalSize: number }> {
  const take = Math.min(Math.max(input.take ?? 60, 1), 300);
  const category = input.category && input.category !== 'all' ? input.category : '';
  const where: Prisma.AssetWhereInput = {
    userId: input.userId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.type && input.type !== 'all' ? { type: input.type } : {}),
    /*
     * 类型与分类是两个**独立**的维度：任何类型的资产都能打分类（2026-09-26）。
     *
     * 以前这里会把类型钉死成图片 —— 那是为了绕开「`'none'` = `category IS NULL`
     * 会把所有视频 / 音频 / latent 一起捞出来」。现在它们本来就能带分类，
     * 那个补丁既没必要、也是错的（它让「视频 + 未分类」这个组合永远点不出东西）。
     */
    ...(category ? { category: category === 'none' ? null : category } : {}),
  };

  const [rows, groups] = await Promise.all([
    db.asset.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true, name: true, type: true, category: true, url: true, metadata: true, createdAt: true,
        projectId: true, sourceTaskId: true, project: { select: { name: true } },
      },
    }),
    db.asset.groupBy({ by: ['type'], where, _count: { _all: true } }),
  ]);

  /*
   * 视频能不能「接续」：那一次生成归档下来的 latent（粗 / 精）。
   * 🔴 **全库查，不按项目** —— 见本文件顶部注释。
   */
  const taskIds = Array.from(new Set(
    rows.filter(row => row.type === 'video' && row.sourceTaskId).map(row => String(row.sourceTaskId)),
  ));
  const latentRows = taskIds.length
    ? await db.asset.findMany({
      where: { userId: input.userId, type: 'latent', sourceTaskId: { in: taskIds } },
      select: { id: true, sourceTaskId: true, metadata: true },
      orderBy: { createdAt: 'asc' },
    })
    : [];
  const relayByTask = new Map<string, RelayLatentItem[]>();
  for (const row of latentRows) {
    const meta = metaOf(row.metadata);
    const list = relayByTask.get(String(row.sourceTaskId)) || [];
    list.push({
      id: row.id,
      sequence: String(meta.sequence || ''),
      kind: meta.kind === 'fine' ? 'fine' : 'coarse',
      size: Number(meta.size || 0),
    });
    relayByTask.set(String(row.sourceTaskId), list);
  }

  const total = groups.reduce((sum, group) => sum + group._count._all, 0);
  const items = rows.flatMap(row => {
    if (!isKind(row.type)) return [];
    const meta = metaOf(row.metadata);
    const size = Number(meta.size || 0);
    return [{
      id: row.id,
      name: row.name,
      type: row.type,
      /* 库里存的就是分类名本身；空串当成没打（老数据、手工改库都可能留下空串）。 */
      category: typeof row.category === 'string' && row.category ? row.category : null,
      url: row.url,
      // latent 的 /download 本身就是附件，不能再拼 ?download=1（会被当成文件名的一部分）
      downloadUrl: row.type === 'latent' ? row.url : `${row.url}?download=1`,
      size,
      createdLabel: dateFormat.format(row.createdAt),
      sizeLabel: formatSize(size),
      projectId: row.projectId,
      /*
       * 🔴 **项目行可能已经不在了，必须兜住**（2026-10-03 验自动清理时炸出来的）：
       * `deleteProject()` 会连资产一起删，但**删完之后才落盘的那一笔**（还在跑的任务
       * 回来归档）仍然带着旧 `projectId`。这种记录一出现，这里 `row.project.name`
       * 就抛 `Cannot read properties of null` —— 而它在一个 `flatMap` 里，
       * 一抛就是**整个 `/api/assets` 500**，资产页直接打不开（他库里有 6 条，挂了很久没被发现）。
       * 措辞跟 `listAssetProjects()` 里那条保持一致：同一件事在界面上就该是同一句话。
       */
      projectName: row.project?.name ?? '（已删除的项目）',
      sourceTaskId: row.sourceTaskId ? String(row.sourceTaskId) : null,
      /* 只有视频会拿到东西 —— 它就是「接一个 Latent 中转就能续接」的那几份。 */
      relayLatents: row.sourceTaskId ? (relayByTask.get(String(row.sourceTaskId)) || []) : [],
    }];
  });

  return {
    items,
    total,
    totalSize: items.reduce((sum, item) => sum + item.size, 0),
  };
}

/** 项目筛选下拉用的：只列**真的有资产**的项目，空项目出现在筛选器里只会干扰。 */
export async function listAssetProjects(userId: string) {
  const rows = await db.asset.groupBy({
    by: ['projectId'],
    where: { userId },
    _count: { _all: true },
    orderBy: { _max: { createdAt: 'desc' } },
  });
  if (!rows.length) return [];
  const projects = await db.project.findMany({
    where: { id: { in: rows.map(row => row.projectId) } },
    select: { id: true, name: true },
  });
  const names = new Map(projects.map(p => [p.id, p.name]));
  return rows.map(row => ({
    id: row.projectId,
    name: names.get(row.projectId) || '（已删除的项目）',
    count: row._count._all,
  }));
}

/* ------------------------------------------------------------------ *
 * 分类表：用户自己维护（2026-09-26）
 * ------------------------------------------------------------------ */

/**
 * 保证这个用户**至少有分类可用** —— 一个都没有时把默认三个种进去。
 *
 * 为什么是惰性种、而不是升级时一次性迁移：分类表是**每个用户一份**的，
 * 而升级时机上并不存在一个「所有用户」的权威时刻（桌面版是固定单用户，
 * web 版可能一个用户都还没有）。放在「第一次读分类列表」时种，谁用谁有。
 *
 * 顺手做**唯一一次**老数据迁移：`character` / `scene` / `prop` 这三个 slug
 * 翻成中文名（见 `LEGACY_CATEGORY_SLUGS`）。不翻的话，老用户升级前打过的分类
 * 在筛选器上会全部掉回「未分类」—— 那等于升级把人的标签弄丢了。
 */
async function ensureDefaultCategories(userId: string): Promise<void> {
  const existing = await db.assetCategory.count({ where: { userId } });
  if (existing > 0) return;
  for (let i = 0; i < DEFAULT_CATEGORY_NAMES.length; i += 1) {
    const name = DEFAULT_CATEGORY_NAMES[i];
    /*
     * 用 `upsert` 而不是 `create`：资产页一挂载就会并发取好几份数据，两个请求同时
     * 走到这里、都看到「一个都没有」，用 create 的话后一个会撞 `userId + name` 唯一
     * 键直接 500（`assertUnique` 抛 P2002）。`update: {}` 是「命中就什么都不改」。
     */
    await db.assetCategory.upsert({
      where: { userId_name: { userId, name } },
      create: { userId, name, sort: i },
      update: {},
    });
  }
  for (const [slug, name] of Object.entries(LEGACY_CATEGORY_SLUGS)) {
    await db.asset.updateMany({ where: { userId, category: slug }, data: { category: name } });
  }
}

/**
 * 这个用户的分类列表，带上每项目前有多少条资产在用。
 *
 * `count` 是给「删分类」那一步用的：删之前要先能告诉用户「有 N 条会变成未分类」，
 * 让他确认，而不是删完才发现少了一批标签。查一次全表的 `category` 列即可
 * （几千行字符串，不值得为它建索引）。
 */
export async function listAssetCategories(userId: string): Promise<AssetCategoryItem[]> {
  await ensureDefaultCategories(userId);
  const rows = await db.assetCategory.findMany({
    where: { userId },
    select: { id: true, name: true, sort: true, createdAt: true },
  });
  rows.sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0)
    || Number(a.createdAt) - Number(b.createdAt));
  const groups = await db.asset.groupBy({
    by: ['category'],
    where: { userId, category: { not: null } },
    _count: { _all: true },
  });
  const counts = new Map<string, number>();
  for (const group of groups) {
    const name = typeof group.category === 'string' ? group.category : '';
    if (!name) continue;
    counts.set(name, Number(group._count?._all ?? 0));
  }
  return rows.map(row => ({
    id: String(row.id),
    name: String(row.name),
    count: counts.get(String(row.name)) ?? 0,
  }));
}

/** 这个名字在这个用户名下**已经在用了**。`excludeId` 给「改名但没真改」这种原地保存用。 */
async function categoryExists(userId: string, name: string, excludeId?: string): Promise<boolean> {
  const rows = await db.assetCategory.findMany({ where: { userId, name }, select: { id: true } });
  return rows.some(row => String(row.id) !== excludeId);
}

export type CreateCategoryOutcome =
  | { status: 'ok'; category: AssetCategoryItem }
  | { status: 'invalid' }
  | { status: 'duplicate' };

/** 新增一个分类。名字先归一化（去首尾空白、折行压成空格）再校验。 */
export async function createAssetCategory(input: {
  userId: string;
  name: unknown;
}): Promise<CreateCategoryOutcome> {
  const name = normalizeCategoryName(input.name);
  if (!isCategoryName(name)) return { status: 'invalid' };
  if (await categoryExists(input.userId, name)) return { status: 'duplicate' };
  const rows = await db.assetCategory.findMany({ where: { userId: input.userId }, select: { sort: true } });
  const sort = rows.reduce((max, row) => Math.max(max, Number(row.sort) || 0), -1) + 1;
  const row = await db.assetCategory.create({ data: { userId: input.userId, name, sort } });
  return { status: 'ok', category: { id: String(row.id), name: String(row.name), count: 0 } };
}

export type RenameCategoryOutcome =
  | { status: 'ok'; category: AssetCategoryItem }
  | { status: 'not_found' }
  | { status: 'invalid' }
  | { status: 'duplicate' };

/**
 * 给一个分类改名，**并且把已经打了这个分类的资产一起改掉**。
 *
 * 只改分类表、不动资产的话，那些资产会一夜之间掉回「未分类」——
 * 因为 `assets.category` 列里存的就是名字本身（取舍见 `lib/asset-kinds.ts`）。
 */
export async function renameAssetCategory(input: {
  userId: string;
  id: string;
  name: unknown;
}): Promise<RenameCategoryOutcome> {
  const name = normalizeCategoryName(input.name);
  if (!isCategoryName(name)) return { status: 'invalid' };
  const row = await db.assetCategory.findFirst({
    where: { id: input.id, userId: input.userId },
    select: { id: true, name: true },
  });
  if (!row) return { status: 'not_found' };
  const before = String(row.name);
  if (before !== name) {
    if (await categoryExists(input.userId, name, String(row.id))) return { status: 'duplicate' };
    await db.asset.updateMany({ where: { userId: input.userId, category: before }, data: { category: name } });
    await db.assetCategory.update({ where: { id: input.id }, data: { name } });
  }
  const used = await db.asset.count({ where: { userId: input.userId, category: name } });
  return { status: 'ok', category: { id: String(row.id), name, count: Number(used) } };
}

export type DeleteCategoryOutcome =
  | { status: 'ok'; name: string; cleared: number }
  | { status: 'not_found' };

/**
 * 删一个分类：把打着它的资产**归到未分类**（`null`），并把改了多少条报回去。
 *
 * 为什么不是另外两种做法：
 *  - 「有资产在用就不许删」→ 分类表会越攒越删不动，最后变成一堆历史遗留；
 *  - 「连资产一起删」→ 删一个分类顺手删掉用户几十张素材，太危险；
 * 归到未分类是**可逆**的（重新建一个同名分类再打回去即可），也是用户确认过的口径。
 */
export async function deleteAssetCategory(input: {
  userId: string;
  id: string;
}): Promise<DeleteCategoryOutcome> {
  const row = await db.assetCategory.findFirst({
    where: { id: input.id, userId: input.userId },
    select: { id: true, name: true },
  });
  if (!row) return { status: 'not_found' };
  const name = String(row.name);
  const cleared = await db.asset.updateMany({
    where: { userId: input.userId, category: name },
    data: { category: null },
  });
  await db.assetCategory.delete({ where: { id: row.id } });
  return { status: 'ok', name, cleared: Number(cleared.count) };
}

/* ------------------------------------------------------------------ *
 * 给资产打分类
 * ------------------------------------------------------------------ */

export type SetCategoryOutcome =
  | { status: 'ok'; category: string | null }
  | { status: 'not_found' }
  | { status: 'unknown_category' };

/**
 * 给一条资产打（或改、或清）分类。传 `null` = 取消分类。
 *
 * **任何类型的资产都能打**：视频、音频、latent 与图片一视同仁（2026-09-26）。
 *
 * 值必须是这个用户分类表里**已有的名字**：`assets.category` 存的就是名字本身，
 * 放一个表里没有的值进去，筛选器上不会出现它、灯箱里也点不掉，等于打了个隐形标签。
 *
 * 之所以单独开一个入口、而不是让调用方直接 `db.asset.update`：合法性只有一处知道
 * 才不会走散 —— 画布端和 MCP 迟早也要改分类。
 */
export async function setAssetCategory(input: {
  assetId: string;
  userId: string;
  category: string | null;
}): Promise<SetCategoryOutcome> {
  const asset = await db.asset.findFirst({
    where: { id: input.assetId, userId: input.userId },
    select: { id: true },
  });
  if (!asset) return { status: 'not_found' };
  if (input.category !== null && !(await categoryExists(input.userId, input.category))) {
    return { status: 'unknown_category' };
  }
  await db.asset.update({ where: { id: asset.id }, data: { category: input.category } });
  return { status: 'ok', category: input.category };
}

/* ------------------------------------------------------------------ *
 * 改名与批量操作（2026-09-26 资产页的右键菜单 + 批量选择）
 * ------------------------------------------------------------------ */

/** 资产名上限。与项目名（`projectName()` 里那个 80）对齐 —— 两个列表并排看，规矩要一样。 */
export const ASSET_NAME_MAX = 80;

export type RenameAssetOutcome =
  | { status: 'ok'; name: string }
  | { status: 'not_found' }
  | { status: 'invalid' };

/**
 * 改一条资产的名字。
 *
 * ⚠️ **只改库里那个 `name`，不碰磁盘文件名**。两件事是分开的：
 *  - 文件真实路径在 `metadata.path`，取流（`/api/assets/[id]/[file]`）与下载都按它走；
 *  - 下载时附件的文件名用的是 `asset.id`（见 `/api/assets/[id]/download`），也不是 `name`。
 * 所以 `name` 纯粹是给人看的标签，改它零风险。反过来「连文件一起重命名」要动
 * `metadata.path` —— 那是取流的依据，改坏了是一张坏图 + 404，而界面上只显示图裂了，
 * 看不出是谁动的手。
 */
export async function renameAsset(input: {
  assetId: string;
  userId: string;
  name: unknown;
}): Promise<RenameAssetOutcome> {
  /* 折行/多空格压成一个空格：名字那一行是 `nowrap + 省略号`，夹着换行符看着像坏了。 */
  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > ASSET_NAME_MAX) return { status: 'invalid' };
  const result = await db.asset.updateMany({
    where: { id: input.assetId, userId: input.userId },
    data: { name },
  });
  if (!result.count) return { status: 'not_found' };
  return { status: 'ok', name };
}

export type BulkCategoryOutcome =
  | { status: 'ok'; changed: number; skipped: number }
  | { status: 'unknown_category' };

/**
 * 批量打分类。传 `null` = 清掉分类。
 *
 * **不再按类型过滤**（2026-09-26）：任何类型都能打分类，所以「选了 20 项只有 9 项变了」
 * 不会因为类型发生了；`skipped` 现在只剩一种来源 —— 选中的 id 已经不在了。
 */
export async function setAssetCategoryBulk(input: {
  userId: string;
  ids: string[];
  category: string | null;
}): Promise<BulkCategoryOutcome> {
  const ids = [...new Set(input.ids)].filter(Boolean);
  if (!ids.length) return { status: 'ok', changed: 0, skipped: 0 };
  if (input.category !== null && !(await categoryExists(input.userId, input.category))) {
    return { status: 'unknown_category' };
  }
  const rows = await db.asset.findMany({
    where: { id: { in: ids }, userId: input.userId },
    select: { id: true },
  });
  if (rows.length) {
    await db.asset.updateMany({
      where: { id: { in: rows.map(row => row.id) }, userId: input.userId },
      data: { category: input.category },
    });
  }
  return { status: 'ok', changed: rows.length, skipped: ids.length - rows.length };
}

export type BulkDeleteOutcome = {
  deleted: number;
  notFound: number;
  /** 记录删了、磁盘文件没删掉。删不掉不算失败，但得说出来，否则用户以为空间已经放出来了。 */
  filesLeft: number;
  /** 正被画布引用、这一轮**没删**的那些 —— 前端要列出来再问一次。 */
  inUse: { id: string; name: string; projects: string[] }[];
};

/**
 * 批量删除：挨条走 `deleteAsset()`，**一条失败不影响其余的**。
 *
 * 为什么不 `db.asset.deleteMany` 一把梭：那会绕过「文件也要删」和「被画布引用要拦」两条 ——
 * 前者留一地孤儿文件，后者把接续链路悄悄剪断。
 *
 * `force` 的语义与单条一致：不传就**不删**正在被引用的那些，把它们连项目名一起交回去，
 * 由前端讲清楚再问一次；传了就一视同仁全删。
 */
/**
 * 某个类型一共有多少条。
 *
 * 「一键删除」这类操作要在按钮上写清会删掉几个 —— 不给数字等于让人盲点
 * （资产页那个常态统计「全部 N 项」2026-10-01 已经按徐先的要求整行删掉了，
 * 这一个数不是把它加回来：它只服务于这个按钮，没有 latent 时按钮整个不出现）。
 */
export async function countAssetsOfKind(userId: string, kind: AssetKind): Promise<number> {
  return Number(await db.asset.count({ where: { userId, type: kind } }));
}

/**
 * 按类型**整批**删除（「一键删掉全部 Latent」）。
 *
 * 为什么不复用「勾全选再删」：列表一次只给 60 条，勾全选删的只是当前这一页，
 * 剩下的还躺在库里 —— 名字叫「一键」却删不干净。所以这里按类型把全部 id 取出来再删。
 * `take` 是安全带：一个账号不该有十万条 latent，真有也不该一次全删。
 */
export async function purgeAssetsOfKind(input: {
  userId: string;
  kind: AssetKind;
  force?: boolean;
}): Promise<BulkDeleteOutcome> {
  const rows = await db.asset.findMany({
    where: { userId: input.userId, type: input.kind },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 2000,
  });
  return deleteAssetsBulk({ userId: input.userId, ids: rows.map(row => row.id), force: input.force });
}

export async function deleteAssetsBulk(input: {
  userId: string;
  ids: string[];
  force?: boolean;
}): Promise<BulkDeleteOutcome> {
  const ids = [...new Set(input.ids)].filter(Boolean);
  const outcome: BulkDeleteOutcome = { deleted: 0, notFound: 0, filesLeft: 0, inUse: [] };
  if (!ids.length) return outcome;
  /* 先取一遍名字：`deleteAsset()` 之后记录就没了，被引用拦下的那些要拿名字去列给用户看。 */
  const rows = await db.asset.findMany({
    where: { id: { in: ids }, userId: input.userId },
    select: { id: true, name: true },
  });
  /* 元组要标出来：`rows.map(r => [r.id, r.name])` 推出来的是数组而不是元组，Map 会退化成 `Map<{}, {}>`。 */
  const nameOf = new Map<string, string>(rows.map(row => [row.id, row.name] as [string, string]));
  for (const id of ids) {
    const result = await deleteAsset({ assetId: id, userId: input.userId, force: input.force });
    if (result.status === 'not_found') { outcome.notFound += 1; continue; }
    if (result.status === 'in_use') {
      outcome.inUse.push({
        id,
        name: nameOf.get(id) ?? '（未命名）',
        projects: result.references.map(item => item.projectName),
      });
      continue;
    }
    outcome.deleted += 1;
    if (!result.fileRemoved) outcome.filesLeft += 1;
  }
  return outcome;
}

/* ------------------------------------------------------------------ *
 * 引用关系：删之前先问一句「谁在用」
 * ------------------------------------------------------------------ */

export type AssetReference = { projectId: string; projectName: string };

/**
 * 这个资产被哪些画布引用着。
 *
 * 两种引用形态都藏在画布节点的 JSON 里：
 *  - latent → 节点的 `data.remoteFile` 是 `asset:<id>`；
 *  - 媒体 → `runs[].url` / `resultUrl` 是 `/api/assets/<id>/media.<ext>`。
 *
 * 不用模糊匹配整个 id：`asset:<id>` 与 `/api/assets/<id>/` 两种精确形态已经覆盖全部场景，
 * 拿裸 id 去 `includes` 反而会误伤（比如 paramRows 里的自由文本）。
 * 画布数据不大（一个是几 KB 的 JSON），直接全量扫，不值得为它做索引。
 */
export async function assetReferences(assetId: string, userId: string): Promise<AssetReference[]> {
  const canvases = await db.canvas.findMany({
    where: { project: { userId } },
    select: { nodes: true, project: { select: { id: true, name: true } } },
  });
  const mediaUrl = `/api/assets/${assetId}/`;
  const latentRef = `asset:${assetId}`;
  const hits: AssetReference[] = [];
  for (const canvas of canvases) {
    const raw = JSON.stringify(canvas.nodes ?? []);
    if (raw.includes(mediaUrl) || raw.includes(latentRef)) {
      hits.push({ projectId: canvas.project.id, projectName: canvas.project.name });
    }
  }
  return hits;
}

export type DeleteOutcome =
  | { status: 'deleted'; fileRemoved: boolean }
  | { status: 'not_found' }
  | { status: 'in_use'; references: AssetReference[] };

/**
 * 删除一条资产：**数据库记录 + 磁盘文件一起消失**。
 *
 * 顺序是刻意的——**先删记录、再删文件**。反过来（先删文件）一旦删记录失败，
 * 用户会看到一个「记录还在但图画不出来」的坏卡片；而先删记录最坏只是留下一个孤儿文件，
 * 那是不可见、且可以由 `storageOverview()` 报出来的。两害相权取其轻。
 *
 * `in_use` 时默认拒绝：latent 是画布接续链路的输入，删掉之后那条链下次生成会静默取不到值。
 * 真要删得传 `force`，并且调用方有责任把「哪几个项目在用」讲给用户听。
 */
export async function deleteAsset(input: { assetId: string; userId: string; force?: boolean }): Promise<DeleteOutcome> {
  const asset = await db.asset.findFirst({
    where: { id: input.assetId, userId: input.userId },
    select: { id: true, metadata: true },
  });
  if (!asset) return { status: 'not_found' };

  const references = await assetReferences(asset.id, input.userId);
  if (references.length && !input.force) return { status: 'in_use', references };

  const stored = (asset.metadata as { path?: string } | null)?.path || '';
  /* 删文件前也要找回：路径过期时照原样 `unlink` 会扑空 —— 记录没了，文件却留在盘上。 */
  const file = stored ? await resolveStoredPath(stored) : '';
  await db.asset.delete({ where: { id: asset.id } });

  let fileRemoved = false;
  if (file) {
    try { await unlink(/*turbopackIgnore: true*/ file); fileRemoved = true; }
    catch { fileRemoved = false; }
  }
  return { status: 'deleted', fileRemoved };
}

/* ------------------------------------------------------------------ *
 * 本机路径：给「打开文件所在位置」用（2026-10-09）
 * ------------------------------------------------------------------ */

/**
 * 这一条资产在**本机磁盘上的绝对路径**。找不到（记录没写 path / 文件已经不在了）返回 `null`。
 *
 * 🔴 路径必须过一遍 `resolveStoredPath()`，不能把 `metadata.path` 直接甩出去：
 *    那个字段是**落盘当时**写下的。它会先在原处找一遍（找得到就原样返回 —— 真机实测：
 *    库里那 60 条返回的都是当初那个绝对路径，不是"现在这个数据目录"下的），
 *    找不到才拿 `media` / `latents` 这类锚点在**当前**产出目录下重定位一次。
 *    所以数据目录改过名（`frame-studio` → `holy-light-canvas`）、换过产出目录、
 *    甚至整份数据搬到另一台机器上，它都还有救回来的可能；搬丢了的才落到
 *    最后那个 `exists()` 上返回 `null`。
 *
 * 🔴 返回 `null` 不是"可以凑合着用"：拿一个不存在的路径去「打开文件所在位置」，
 *    资源管理器只会打开一个空白目录（甚至毫无反应，`shell.showItemInFolder` 不报错），
 *    看着像功能坏了。上层要把它翻成人话（"这个文件已经不在了"）。
 *    库里另外三处（取流 / 下载 / 删除）全都走这个函数，这里跟它们保持一致。
 */
export async function assetLocalPath(input: { assetId: string; userId: string }): Promise<string | null> {
  const asset = await db.asset.findFirst({
    where: { id: input.assetId, userId: input.userId },
    select: { metadata: true },
  });
  const stored = (asset?.metadata as { path?: string } | null)?.path || '';
  if (!stored) return null;
  const file = await resolveStoredPath(stored);
  return (await exists(file)) ? file : null;
}

/* ------------------------------------------------------------------ *
 * 磁盘概览与孤儿文件：看得见，也清得掉
 * ------------------------------------------------------------------ */

export type StorageOverview = {
  /*
   * 🔴 2026-10-01：这里原来还有 `counts` / `total` / `diskLabel` 三个（「落盘占用 X」
   * 「全部 N 项：图片 …」）—— 界面按徐先的要求把那条常态统计整行去掉了，
   * 三个字段跟着一起删。**别再加回来**：加回来就意味着又要在资产页上算一遍、显示一遍。
   */
  /** 库里有记录但文件已经不在磁盘上（手动删过 storage/、或落盘中途失败）。 */
  missing: number;
  /** 磁盘上有文件、但库里已经没有对应记录。 */
  orphans: number;
  orphanLabel: string;
  /** 刚落盘、还没过安全期的文件，这一轮不碰（见 `ORPHAN_MIN_AGE_MS`）。 */
  orphanRecent: number;
};

/**
 * 比这更新的文件一律当成「还在写」，这一轮不碰。
 *
 * media 是「先插记录、后写文件」，本来没有窗口；但 latent 反过来
 * （`lib/latents.ts` 的 `store()` 先落盘、再 `db.asset.create`），
 * 中间那几毫秒里文件是存在而无记录的——没有安全期就会把正在生成的 latent 删掉。
 */
const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

/** Windows 上路径大小写不敏感，比较前统一一下，别因为大小写把有记录的文件判成孤儿。 */
function normPath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 扫一层：`<产出根目录>/media/<projectId>/<file>`。根目录本身不是文件。
 *
 * ⚠️ **盘符根一律不扫。** 桌面版允许用户把产出目录指到任意文件夹，万一指到
 * `E:\` 这种盘根，这里就会把整块盘一级子目录里的文件全列出来、全判成孤儿，
 * 而 `cleanupOrphans()` 是**真的删**。宁可少扫一个目录，也不能扫出一场误删。
 */
async function filesUnder(root: string): Promise<string[]> {
  if (!root || path.resolve(root) === path.parse(path.resolve(root)).root) return [];
  let dirs: string[];
  try { dirs = await readdir(/*turbopackIgnore: true*/ root); } catch { return []; }
  const out: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    // 根目录下混进文件时 readdir 会 ENOTDIR（不是目录），跳过就好
    try { names = await readdir(/*turbopackIgnore: true*/ path.join(root, dir)); } catch { continue; }
    for (const name of names) out.push(path.join(root, dir, name));
  }
  return out;
}

export type OrphanScan = { files: string[]; count: number; bytes: number; recent: number };

/**
 * 找出磁盘上已经没有记录的文件。
 *
 * 两个根目录都要扫：`storage/media/<projectId>/<assetId>.<ext>` 的文件名**就是资产 id**，
 * 而 `storage/latents/<projectId>/<taskId>-<编号>-<粗/精>.safetensors` **不含 id**
 * （2026-10-03 之前落的是 `<taskId>-<编号>-<粗/精>.latent.gz`，老档案照样对得上），
 * 只能拿库里的 `metadata.path` 全量对账。所以判定是「命中 id 或命中 path 就算有主」：
 *  - 命中 id   → media 的记录还在（哪怕 `metadata.path` 那次更新没成功，也说明是刚落盘的那一步）
 *  - 命中 path → 任何类型的记录都还在
 *
 * 对账用的是**全库**的 id / path、不按用户过滤：磁盘是整个实例共用的，
 * 按用户过滤会把别人的文件全报成孤儿。
 */
export async function scanOrphans(): Promise<OrphanScan> {
  const rows = await db.asset.findMany({ select: { id: true, metadata: true } });
  const ids = new Set(rows.map(row => row.id));
  const paths = new Set<string>();
  for (const row of rows) {
    const file = (row.metadata as { path?: string } | null)?.path;
    if (!file) continue;
    /*
     * 🔴 **两个都要登记**：原路径留着（文件真在旧位置时也对得上），
     * 找回后的路径更要登记 —— 只记过期路径的话，磁盘上的真文件一个都匹配不上、
     * 全被判成孤儿，用户点一次「清理」就真没了。
     */
    paths.add(normPath(file));
    paths.add(normPath(await resolveStoredPath(file)));
  }

  const files = [...await filesUnder(await mediaRoot()), ...await filesUnder(await latentRoot())];
  const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
  const found: string[] = [];
  let bytes = 0;
  let recent = 0;
  for (const file of files) {
    const idOfName = path.basename(file).replace(/\.[a-z0-9]+$/i, '');
    if (ids.has(idOfName) || paths.has(normPath(file))) continue;
    let info;
    try { info = await stat(/*turbopackIgnore: true*/ file); } catch { continue; }
    if (!info.isFile()) continue;
    if (info.mtimeMs > cutoff) { recent += 1; continue; }
    found.push(file);
    bytes += info.size;
  }
  return { files: found, count: found.length, bytes, recent };
}

export type CleanupResult = { removed: number; bytes: number; failed: number; recent: number };

/**
 * 删掉扫出来的孤儿文件。
 *
 * 只删 `scanOrphans()` **自己走目录扫出来**的路径——不接受调用方传路径，
 * 所以不存在「库里的 `path` 被写歪、顺着它删到 storage 外面去」这种可能。
 *
 * `ENOENT` 不算失败：两个标签页同时点清理时，先跑完的那个已经把文件删了，
 * 后一个 `stat` 就会扑空。文件不在了就是目标达成，把它记成「没删掉」会凭空吓人一跳。
 *
 * **不要在这里顺手删空目录。** 曾经用 `rmdir` 收尾，结果在本机（Windows + Node 22）
 * 上 `fs.rmdir` 对**非空目录**不报 `ENOTEMPTY`，而是**连里面的文件一起递归删掉**——
 * 一次点击把整个 `storage/` 清空了，真实项目里已经归档的 latent 全没了。
 * 空目录不占地方也不显示给用户，留着就留着。
 */
export async function cleanupOrphans(): Promise<CleanupResult> {
  const scan = await scanOrphans();
  let removed = 0;
  let bytes = 0;
  let failed = 0;
  for (const file of scan.files) {
    try {
      const info = await stat(/*turbopackIgnore: true*/ file);
      await unlink(/*turbopackIgnore: true*/ file);
      removed += 1;
      bytes += info.size;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') { removed += 1; continue; }
      failed += 1;
    }
  }
  return { removed, bytes, failed, recent: scan.recent };
}

/* ------------------------------------------------------------------ *
 * 反过来那一半：记录还在、文件没了 —— 自动收掉
 * ------------------------------------------------------------------ */

/** 路径在不在（目录 / 文件都算）。 */
async function exists(target: string): Promise<boolean> {
  try { await stat(/*turbopackIgnore: true*/ target); return true; } catch { return false; }
}

/** 一次自动清理最多删几条（见 `pruneMissingAssets` 的闸门 ③）。 */
const MISSING_PRUNE_MAX = 200;

export type MissingPrune = {
  /** 这一轮删掉了几条。 */
  removed: number;
  /** 这一轮看了几条。 */
  checked: number;
  /** 产出目录不在（盘没挂 / 目录搬走）→ 整轮跳过，一条都没看。 */
  skipped: boolean;
};

/**
 * 把「文件已经不在了」的资产记录删掉 —— **自动，不用用户点**（2026-10-03，徐先：
 * 「没有的图就自动删除记录」）。
 *
 * 他要清的是生成页历史栏里那张点不开的占位（alt 写着 `image.png`）：它是**旧数据目录
 * 时代留下的幽灵** —— `metadata.path` 指着改名前的 `frame-studio\storage\media\...`，
 * 而文件在两个根目录下都已经没有了，记录却一直躺在列表里当坏图。
 *
 * 与 `scanOrphans()` **正好相反**：那边管「有文件、没记录」，这边管「有记录、没文件」。
 * 判据只有一条：`metadata.path` 过一遍 `resolveStoredPath()`（**路径过期会被找回**，
 * 找回后文件真在就不算丢）之后 `stat` 得到。
 *
 * 🔴 **三道闸门，少一道都可能一次清掉一大片**：
 *  ① **产出目录不在就整轮跳过。** `media` 与 `latents` 两个锚点目录一个都不存在时，
 *     全库的文件都会「看起来不在」—— 那是盘没挂 / 产出目录被移到移动硬盘上了，
 *     这时候删记录等于把资产库清空。宁可这一轮什么都不做。
 *  ② **安全期**：只碰 `createdAt` 早于 `ORPHAN_MIN_AGE_MS` 的记录。刚落盘那一步文件
 *     可能还没写完，抢在它前面判死就等于删掉一张刚生成的图。
 *  ③ **一次最多 `MISSING_PRUNE_MAX` 条**。真出岔子也只损失一轮，不会一夜清空。
 *
 * 🔴 **刻意不走 `deleteAsset()`**：那个函数先扫**全部画布**问「谁在引用」，有引用还默认拒删。
 *    这里的记录**文件已经没了**，画布上那条引用早就是 404 的死链 —— 再拦一次只会让坏图
 *    永远留在列表里，正是要清掉的那个东西。另外 `deleteMany` 一把过还有个好处：
 *    两个标签页同时刷到时，后一个不会因为「记录已经不存在」抛错。
 *
 * ⚠️ **`metadata.path` 为空的也删** —— 这不是新规矩，`storageOverview()` 早就把这种行
 *    算进「文件已不在磁盘上」并显示给用户了（资产页那条红线）。两处必须同一个口径，
 *    不然会出现「红线说 N 条坏了，自动清理却说一条都没坏」。
 *
 * ⚠️ 只删记录、**不碰磁盘**：文件已经不在（在的就不是 missing）。所以这里没有 `unlink`。
 */
export async function pruneMissingAssets(input: { userId: string; projectId?: string }): Promise<MissingPrune> {
  /* 闸门 ① */
  const mediaAlive = await exists(await mediaRoot());
  const latentAlive = await exists(await latentRoot());
  if (!mediaAlive && !latentAlive) return { removed: 0, checked: 0, skipped: true };

  const rows = await db.asset.findMany({
    where: { userId: input.userId, ...(input.projectId ? { projectId: input.projectId } : {}) },
    select: { id: true, metadata: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  /* 闸门 ② */
  const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
  const gone: string[] = [];
  for (const row of rows) {
    const created = Date.parse(String(row.createdAt ?? ''));
    if (Number.isFinite(created) && created > cutoff) continue;
    const stored = (row.metadata as { path?: string } | null)?.path || '';
    /* 空路径直接算丢（与 `storageOverview` 同口径）；有路径就先找回一次再 stat。 */
    if (stored && await exists(await resolveStoredPath(stored))) continue;
    gone.push(row.id);
    /* 闸门 ③ */
    if (gone.length >= MISSING_PRUNE_MAX) break;
  }
  if (!gone.length) return { removed: 0, checked: rows.length, skipped: false };

  const result = await db.asset.deleteMany({ where: { id: { in: gone } } });
  return { removed: Number(result.count || 0), checked: rows.length, skipped: false };
}

export async function storageOverview(userId: string): Promise<StorageOverview> {
  const rows = await db.asset.findMany({
    where: { userId },
    select: { metadata: true },
  });
  /**
   * 这里仍然要一条条 `stat` —— 不是为了体积（体积已经不显示了），
   * 而是要**发现「库里登记了、磁盘上却没了」那种记录**：它不主动扫永远不报。
   */
  let missing = 0;
  for (const row of rows) {
    const file = (row.metadata as { path?: string } | null)?.path;
    if (!file) { missing += 1; continue; }
    try { await stat(/*turbopackIgnore: true*/ await resolveStoredPath(file)); } catch { missing += 1; }
  }
  const orphans = await scanOrphans();
  return {
    missing,
    orphans: orphans.count,
    orphanLabel: formatSize(orphans.bytes),
    orphanRecent: orphans.recent,
  };
}
