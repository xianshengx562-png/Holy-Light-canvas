import { ApiError, api, apiUser, checkOrigin } from '@/lib/api';
import {
  CATEGORY_NAME_MAX, deleteAssetCategory, renameAssetCategory,
} from '@/lib/assets';

/**
 * 改一个分类（PATCH）· 删一个分类（DELETE）。
 *
 * 两件事都**不只是改一行分类表**：
 *  - 改名 → 打了这个分类的资产一起改（`assets.category` 存的是名字本身）；
 *  - 删除 → 打了这个分类的资产**归到未分类**，并把改了多少条回给前端去写回执。
 *
 * 删哪个走路径上的 `[id]`（不是 query 上的 name）：`apiDelete()` 不带 body，
 * 而名字里可能有 `/`、`?` 这类字符，塞在 query 里还要额外转义。
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { name?: unknown } | null;
    const outcome = await renameAssetCategory({ userId: user.id, id, name: body?.name });
    if (outcome.status === 'not_found') throw new ApiError(404, '这个分类已经不在了。');
    if (outcome.status === 'invalid') {
      throw new ApiError(
        400,
        `分类名不能是空的、不能叫「all」或「none」（这两个是筛选器的保留字），也不能超过 ${CATEGORY_NAME_MAX} 个字。`,
      );
    }
    if (outcome.status === 'duplicate') throw new ApiError(409, '已经有同名分类了。');
    return Response.json({ category: outcome.category });
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const outcome = await deleteAssetCategory({ userId: user.id, id });
    if (outcome.status === 'not_found') throw new ApiError(404, '这个分类已经不在了。');
    /*
     * `cleared` 一定要回：**删一个分类会动到别人的标签**，用户得知道动了多少条。
     * 前端在确认框里先报一次数（列表里带了 `count`），删完再用这里那个数写回执 ——
     * 两个数不一致说明中间有人改过，那也得以服务端报的为准。
     */
    return Response.json({ deleted: true, name: outcome.name, cleared: outcome.cleared });
  });
}
