import 'server-only';
import { db } from '@/lib/db';
import {
  DEFAULT_WORKFLOW_CATEGORY, categoriesFor, isWorkflowCategory, isWorkflowCategoryName,
  normalizeWorkflowCategoryName, type WorkflowCategoryItem,
} from '@/lib/workflows/category';

/**
 * 用户自建的**工作流分类**（2026-10-01 徐先：「分类我自己能加」）。
 *
 * 内置那五个是代码里的枚举（`category.ts`）；这一份是用户自己起的名字，存在
 * `WorkflowCategoryItem` 表里。两边的值**都写进 `WorkflowDraft.category` 那一列**，
 * 存的就是名字本身 —— 与资产分类（`lib/assets.ts`）同一个取舍：
 * 列表拿来就能显示、不用再查一次表；代价是改名 / 删除要**连带更新草稿**，
 * 那两件事都在这里做，别处不许直接改那张表。
 *
 * `category.ts` 是纯函数（客户端也要用），这个文件引了 `db`，**只能服务端引**。
 */

/** 列表 / 下拉里的一项。`count` = 有多少份工作流归在它下面。 */
export type { WorkflowCategoryItem };

export type CreateCategoryOutcome =
  | { status: 'ok'; category: WorkflowCategoryItem }
  | { status: 'invalid' }
  | { status: 'duplicate' };

export type RenameCategoryOutcome =
  | { status: 'ok'; category: WorkflowCategoryItem }
  | { status: 'not_found' }
  | { status: 'invalid' }
  | { status: 'duplicate' };

export type DeleteCategoryOutcome =
  | { status: 'ok'; name: string; cleared: number }
  | { status: 'not_found' };

/**
 * 这个名字是不是已经有一个分类在用（内置的也算「已占用」）。
 * `exceptId` 给改名用：改成一个自己原来的名字不算重复。
 */
async function taken(userId: string, name: string, exceptId?: string): Promise<boolean> {
  if (isWorkflowCategory(name)) return true;
  const rows = await db.workflowCategoryItem.findMany({
    where: { userId },
    select: { id: true, name: true },
  });
  return rows.some(row => String(row.name) === name && String(row.id) !== exceptId);
}

/** 用着某个分类的工作流有多少份。`category` 里存的就是名字，直接数。 */
async function used(userId: string, name: string): Promise<number> {
  return Number(await db.workflowDraft.count({ where: { userId, category: name } }));
}

export async function listWorkflowCategories(userId: string): Promise<WorkflowCategoryItem[]> {
  const rows = await db.workflowCategoryItem.findMany({
    where: { userId },
    select: { id: true, name: true, sort: true, createdAt: true },
  });
  rows.sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0)
    || Number(a.createdAt) - Number(b.createdAt));
  /* 计数一次查完再配上去：每行各查一次是 N+1，分类多起来列表会肉眼可见地卡。 */
  const groups = await db.workflowDraft.groupBy({
    by: ['category'],
    where: { userId },
    _count: { _all: true },
  });
  const counts = new Map<string, number>();
  for (const group of groups) {
    const name = typeof group.category === 'string' ? group.category.trim() : '';
    if (name) counts.set(name, Number(group._count?._all ?? 0));
  }
  return rows.map(row => ({
    id: String(row.id),
    name: String(row.name),
    count: counts.get(String(row.name)) ?? 0,
  }));
}

export async function createWorkflowCategory(input: {
  userId: string;
  name: unknown;
}): Promise<CreateCategoryOutcome> {
  const name = normalizeWorkflowCategoryName(input.name);
  if (!isWorkflowCategoryName(name)) return { status: 'invalid' };
  if (await taken(input.userId, name)) return { status: 'duplicate' };
  const rows = await db.workflowCategoryItem.findMany({ where: { userId: input.userId }, select: { sort: true } });
  const sort = rows.reduce((max, row) => Math.max(max, Number(row.sort) || 0), -1) + 1;
  const row = await db.workflowCategoryItem.create({ data: { userId: input.userId, name, sort } });
  return { status: 'ok', category: { id: String(row.id), name: String(row.name), count: 0 } };
}

/**
 * 改名，**并且把已经归在这个分类下的工作流一起改掉**。
 *
 * 只改分类表、不动草稿的话，那些工作流会一夜之间掉回「无参考」——
 * 因为 `WorkflowDraft.category` 里存的就是名字本身（取舍见 `schema.ts` 那张表的注释）。
 */
export async function renameWorkflowCategory(input: {
  userId: string;
  id: string;
  name: unknown;
}): Promise<RenameCategoryOutcome> {
  const name = normalizeWorkflowCategoryName(input.name);
  if (!isWorkflowCategoryName(name)) return { status: 'invalid' };
  const row = await db.workflowCategoryItem.findFirst({
    where: { id: input.id, userId: input.userId },
    select: { id: true, name: true },
  });
  if (!row) return { status: 'not_found' };
  const before = String(row.name);
  if (before !== name) {
    if (await taken(input.userId, name, String(row.id))) return { status: 'duplicate' };
    await db.workflowDraft.updateMany({
      where: { userId: input.userId, category: before },
      data: { category: name },
    });
    await db.workflowCategoryItem.update({ where: { id: input.id }, data: { name } });
  }
  return { status: 'ok', category: { id: String(row.id), name, count: await used(input.userId, name) } };
}

/**
 * 删掉一个自定义分类。**归在它下面的工作流不会跟着删**，只是回到「无参考」——
 * 分类是个标签，删标签不该带走内容。界面上那句话要说清楚这件事（见 `WorkflowCategoryDialog`）。
 */
export async function deleteWorkflowCategory(input: {
  userId: string;
  id: string;
}): Promise<DeleteCategoryOutcome> {
  const row = await db.workflowCategoryItem.findFirst({
    where: { id: input.id, userId: input.userId },
    select: { id: true, name: true },
  });
  if (!row) return { status: 'not_found' };
  const name = String(row.name);
  const affected = await db.workflowDraft.updateMany({
    where: { userId: input.userId, category: name },
    data: { category: DEFAULT_WORKFLOW_CATEGORY },
  });
  await db.workflowCategoryItem.deleteMany({ where: { id: input.id, userId: input.userId } });
  /* `cleared` 要回给前端：**删一个分类会动到别人的标签**，用户得知道动了多少份。 */
  return { status: 'ok', name, cleared: Number(affected?.count ?? 0) };
}

/**
 * 这个分类值（内置的、或某个自定义分类）能不能用在这份**这个用途**的工作流上。
 *
 * 三处校验（改标签的 PATCH、保存配置的 `/config`、列表筛选的 GET）都走这一条 ——
 * 各写一遍的话迟早出现「列表里筛得出来、点进去保存却 400」。
 */
export async function workflowCategoryAllowed(userId: string, kind: unknown, value: unknown): Promise<boolean> {
  if (typeof value !== 'string') return false;
  const name = value.trim();
  if (!name) return false;
  if (isWorkflowCategory(name)) return categoriesFor(kind).some(item => item.value === name);
  const rows = await db.workflowCategoryItem.findMany({ where: { userId }, select: { name: true } });
  return rows.some(row => String(row.name) === name);
}
