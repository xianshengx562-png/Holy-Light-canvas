import { ApiError, api, apiUser, checkOrigin } from '@/lib/api';
import {
  ASSET_KINDS, deleteAssetsBulk, isCategoryName, purgeAssetsOfKind, setAssetCategoryBulk,
  type AssetKind,
} from '@/lib/assets';

/**
 * 资产的批量操作（2026-09-26）—— 资产页「选中一堆再一起处理」。
 *
 * 两件事：`action: 'category'` 批量打分类（分类表里有的名字，`null` = 清掉），
 * `action: 'delete'` 批量删除。
 *
 * 为什么不是 `/api/assets/batch/delete` 那种更 REST 的写法：桌面版的路由表是按
 * **路径段数 + 静态优先**生成的，而 `/api/assets/[id]/[file]` 那条正则
 * （`^/api/assets/([^/]+)/([^/]+)$`）会把任何两段的地址先截走 ——
 * `…/batch/delete` 会被当成「id=batch、file=delete」交给取流那个 handler。
 * 放在单段的 `batch` 下最省事，也最不容易被后来的人踩。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const body = (await request.json().catch(() => ({}))) as {
      ids?: unknown; action?: unknown; category?: unknown; kind?: unknown; force?: unknown;
    } | null;

    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((id): id is string => typeof id === 'string' && id !== '')
      : [];
    /*
     * 这道闸只管「要按 id 操作」的那两类。`purge` 是按类型整批删，**不传 ids** ——
     * 一起卡在这里的话，一键删除永远回「没有选中任何资产」。
     */
    if (!ids.length && body?.action !== 'purge') throw new ApiError(400, '没有选中任何资产。');

    if (body?.action === 'category') {
      const raw = body.category;
      const empty = raw === null || raw === undefined || raw === '';
      const category = empty ? null : isCategoryName(raw) ? String(raw).trim() : undefined;
      if (category === undefined) throw new ApiError(400, '分类名不对（空的、太长、或叫了保留字）。');
      const outcome = await setAssetCategoryBulk({ userId: user.id, ids, category });
      if (outcome.status === 'unknown_category') {
        throw new ApiError(400, '这个分类已经不在了，刷新一下再试。');
      }
      return Response.json({ action: 'category', category, ...outcome });
    }

    if (body?.action === 'delete') {
      const outcome = await deleteAssetsBulk({ userId: user.id, ids, force: body.force === true });
      return Response.json({ action: 'delete', ...outcome });
    }

    /*
     * `purge` = **按类型整批删除**（资产页那颗「一键删除 Latent」）。
     * 与 `delete` 的区别：`delete` 删的是前端勾中的那几个 id，而列表一次只给 60 条，
     * 勾全选删不干净；`purge` 由服务端按类型把全部 id 取出来删，不需要前端传 ids。
     */
    if (body?.action === 'purge') {
      const kind = ASSET_KINDS.find(item => item.value === body.kind)?.value as AssetKind | undefined;
      if (!kind) throw new ApiError(400, '要清掉哪一种？目前只支持 latent。');
      const outcome = await purgeAssetsOfKind({ userId: user.id, kind, force: body.force === true });
      return Response.json({ action: 'purge', kind, ...outcome });
    }

    throw new ApiError(400, 'action 只能是 category、delete 或 purge。');
  });
}
