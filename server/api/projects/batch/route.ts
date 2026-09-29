import { ApiError, api, apiUser, checkOrigin } from '@/lib/api';
import { deleteProject } from '@/lib/projects';

/**
 * 项目的批量操作（2026-09-26）—— 项目页「勾一堆再一起删」。
 *
 * 目前只有 `action: 'delete'` 一种。**按顺序挨个 `deleteProject()`**：
 * 一条不存在/删不动不打断其余的，最后把明细一起回给前端。
 * 批量删除最烦的就是「删到第 7 个报错，前 6 个删没删也不知道」——
 * 所以这里回的是 `{ deleted, notFound, assets, filesLeft }` 而不是一句 `{ ok: true }`。
 *
 * 路径放在 `/api/projects/batch`（而不是 `…/[id]/delete`）：生成的路由表里
 * 单段的静态路径排在 `[id]` 之前，不会被当成「id = batch」。加了新路由记得跑 `gen-routes.py`。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const body = (await request.json().catch(() => ({}))) as { ids?: unknown; action?: unknown } | null;

    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((id): id is string => typeof id === 'string' && id !== '')
      : [];
    if (!ids.length) throw new ApiError(400, '没有选中任何项目。');
    if (body?.action !== 'delete') throw new ApiError(400, 'action 只能是 delete。');

    let deleted = 0;
    let notFound = 0;
    let assets = 0;
    let filesLeft = 0;
    for (const id of [...new Set(ids)]) {
      const outcome = await deleteProject(user.id, id);
      if (outcome.status === 'not_found') { notFound += 1; continue; }
      deleted += 1;
      assets += outcome.assets;
      filesLeft += outcome.filesLeft;
    }
    return Response.json({ action: 'delete', deleted, notFound, assets, filesLeft });
  });
}
