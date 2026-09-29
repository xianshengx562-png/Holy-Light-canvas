import 'server-only';
import { rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { latentRoot } from '@/lib/output-dir';
export function projectName(value: unknown) { if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new ApiError(400,'项目名称需要 1–80 个字符。'); return value.trim(); }
/**
 * 卡片封面：从**这个项目自己生成的图片资产**里随机挑一张。
 *
 * 为什么是随机、不是「最新一张」：项目表上那个 `thumbnail` 字段一直没人写
 * （画布侧没有「存一张当封面」这一步），于是每张卡都是同一个空文件夹图标 ——
 * 而资产表里躺着这个项目跑出来的全部图。随机取一张，每次进来看到的还不重样，
 * 也比一张钉死的封面更像「这个项目在做什么」。
 *
 * 只取图片：视频资产的 `url` 是 mp4，`<img>` 放不出来（会是一块黑）。
 * 池子只留最近 60 张 —— 一个项目跑了几千张图时，没必要把整张表捞出来摇号。
 */
const COVER_POOL = 60;

const pickCovers = async (projectIds: string[]) => {
  const covers = new Map<string, string>();
  if (projectIds.length === 0) return covers;
  const rows = await db.asset.findMany({
    where: { projectId: { in: projectIds }, type: 'image' },
    orderBy: { createdAt: 'desc' },
    select: { projectId: true, url: true },
  });
  const pools = new Map<string, string[]>();
  for (const row of rows) {
    const projectId = typeof row.projectId === 'string' ? row.projectId : '';
    const url = typeof row.url === 'string' ? row.url : '';
    if (!projectId || !url) continue;
    const pool = pools.get(projectId);
    if (pool) {
      if (pool.length < COVER_POOL) pool.push(url);
      continue;
    }
    pools.set(projectId, [url]);
  }
  for (const [projectId, pool] of pools) covers.set(projectId, pool[Math.floor(Math.random() * pool.length)]);
  return covers;
};

/**
 * 项目列表。比项目表多一个 `cover`：本项目随机一张图片资产的地址（没有就是 null）。
 * 卡片靠它显示缩略图，见上面 `pickCovers`。
 */
export const listProjects = async (userId: string) => {
  const projects = await db.project.findMany({where:{userId},orderBy:{updatedAt:'desc'},select:{id:true,name:true,thumbnail:true,createdAt:true,updatedAt:true}}) as { id: string; name: string; thumbnail: string | null; createdAt: unknown; updatedAt: unknown }[];
  const covers = await pickCovers(projects.map((p) => p.id));
  return projects.map((p) => ({ ...p, cover: covers.get(p.id) ?? null }));
};
export const getProject = (userId:string,id:string) => db.project.findFirst({where:{id,userId},include:{canvas:true},});
export const createProject = (userId:string,name:string) => db.project.create({data:{userId,name,canvas:{create:{}}},select:{id:true,name:true}});

/* ------------------------------------------------------------------ *
 * 改名 / 删除（2026-09-25，首页与项目列表页的卡片右键菜单）
 * ------------------------------------------------------------------ */

/**
 * 改项目名。名字的规矩与新建时**同一处**（`projectName`）——
 * 两处各写一份校验，迟早会出现「建的时候不许叫这个、改的时候却允许」。
 *
 * 归属用 `findFirst({ id, userId })` 确认，不能直接 `update({ where: { id } })`：
 * 那个 where 只认 id，别人的项目 id 猜中了也能改（引擎不做行级权限）。
 */
export async function renameProject(userId: string, id: string, raw: unknown) {
  const name = projectName(raw);
  const found = await db.project.findFirst({ where: { id, userId }, select: { id: true } });
  if (!found) throw new ApiError(404, '项目不存在，或者不属于当前账号。');
  return db.project.update({ where: { id }, data: { name }, select: { id: true, name: true, updatedAt: true } });
}

export type DeleteProjectOutcome =
  | { status: 'not_found' }
  | {
    status: 'deleted';
    /** 被一起删掉的资产条数（图 / 视频 / latent）。 */
    assets: number;
    /** 磁盘文件删掉了几个、剩几个。 */
    filesRemoved: number;
    filesLeft: number;
  };

/**
 * 删项目 —— **连带清干净**，不留下看不见的残渣。
 *
 * 顺序是刻意的：**先删记录、再删磁盘文件**（与 `deleteAsset` 同一条理由）。
 * 反过来一旦中途失败，用户会看到「项目还在、但图和视频全打不开」；
 * 先删记录最坏只是留下几个孤儿文件 —— 看不见，而且 `storageOverview()` 的孤儿计数认得出来。
 *
 * 几张表要一起清（引擎**不会**级联删除，`schema.ts` 里那些 relation 只是查询用的）：
 *   - `Asset`  按 `projectId`
 *   - `Task`   按 `projectId`（否则任务面板里会留一堆指向不存在项目的行）
 *   - `Canvas` 按 `projectId`（1:1，`@@unique([projectId])`）
 *
 * ⚠️ 这里**不用 `$transaction`**：桌面版那个实现是假的（`engine.ts` 里就是「把同一个 client
 * 交给回调」，注释自己写着没有回滚）。套上去只会让人以为它是原子的。
 * 好在每一步都是幂等的 `deleteMany`，中途失败再点一次删除能接着走完。
 *
 * latent 目录也一起摘：它是 `<latentRoot>/<projectId>/` 下一个**独立目录**，
 * 记录删了但文件留着的话，用户换产出目录后会在磁盘上看到一堆以 cuid 命名的空壳文件夹。
 */
export async function deleteProject(userId: string, id: string): Promise<DeleteProjectOutcome> {
  const project = await db.project.findFirst({ where: { id, userId }, select: { id: true } });
  if (!project) return { status: 'not_found' };

  const assets = await db.asset.findMany({ where: { projectId: id }, select: { id: true, metadata: true } });

  await db.asset.deleteMany({ where: { projectId: id } });
  await db.task.deleteMany({ where: { projectId: id } });
  await db.canvas.deleteMany({ where: { projectId: id } });
  await db.project.delete({ where: { id } });

  let filesRemoved = 0;
  let filesLeft = 0;
  for (const asset of assets) {
    /* 磁盘路径藏在 `metadata.path`（`lib/media.ts` 落盘时写进去的），不在 url 里。 */
    const file = (asset.metadata as { path?: string } | null)?.path || '';
    if (!file) continue;
    try {
      await unlink(file);
      filesRemoved += 1;
    } catch {
      filesLeft += 1;
    }
  }

  await removeLatentDir(id);
  return { status: 'deleted', assets: assets.length, filesRemoved, filesLeft };
}

/**
 * 摘掉一个项目的 latent 目录。
 *
 * 🔴 递归删除**必须**夹住 target：`latentRoot()` 由用户在设置里指定，
 * 万一它解析成空串或者某个上层目录，`rm(recursive)` 就会顺着往上吃。
 * 所以要求 id 非空、不含路径分隔符，且拼出来的路径**最后一段必须恰好等于 id** ——
 * 三条都过了才动手。删不掉也不算失败（那只是几个占空间的旧文件）。
 */
async function removeLatentDir(projectId: string): Promise<void> {
  if (!projectId || projectId === '.' || projectId === '..') return;
  if (projectId.includes('/') || projectId.includes('\\')) return;
  const dir = path.join(await latentRoot(), projectId);
  if (path.basename(dir) !== projectId) return;
  try {
    await rm(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
  } catch {
    /* 文件被别的进程占着之类 —— 记录已经删了，留几个文件不值得让整个删除报错。 */
  }
}
