import { ApiError, api, apiUser, checkOrigin } from '@/lib/api';
import {
  ASSET_NAME_MAX, deleteAsset, isCategoryName, renameAsset, setAssetCategory,
} from '@/lib/assets';

/**
 * 删除一条资产（记录 + 磁盘文件）。
 *
 * 默认**拒绝删除正在被画布引用的资产**，返回 409 并列出是哪几个项目在用——
 * latent 是续接链路的输入，删掉之后那条链下次生成会静默取不到值，用户完全看不出来。
 * 确要删除时带 `?force=1`，前端负责把引用列表讲清楚再让用户确认。
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const force = new URL(request.url).searchParams.get('force') === '1';

    const outcome = await deleteAsset({ assetId: id, userId: user.id, force });
    if (outcome.status === 'not_found') throw new ApiError(404, '资产不存在或无权删除。');
    if (outcome.status === 'in_use') {
      const names = outcome.references.map(item => item.projectName).join('、');
      throw new ApiError(409, `这个资产正被画布引用（${names}），删除后那条链路会取不到值。`);
    }
    /*
     * 文件没删掉不算失败：记录已经没了，用户不会再看到它。但要说出来——
     * 否则用户以为空间已经释放，实际还占着（`storageOverview()` 的孤儿文件数会反映出来）。
     */
    return Response.json({ deleted: true, fileRemoved: outcome.fileRemoved });
  });
}

/**
 * 改一条资产 —— 目前两个可写字段：`name`（改名）与 `category`（**任何类型的**分类）。
 *
 * 走 PATCH 而不是「把整条资产 PUT 上来」：可编辑的只有这两个，收整条记录
 * 等于把 `url` / `metadata.path` 也开放给前端改 —— 后者是**磁盘路径**，改坏了
 * 取流直接 404，而界面上只会显示一张坏图，看不出是谁动的手。
 *
 * 值不合法一律 400，不静默忽略：静默忽略的表现是「点了没反应」，
 * 那是所有反馈里最难排查的一种。
 *
 * 🔴 两个字段**各判各的**，用 `hasOwnProperty` 而不是 `!== undefined`：
 * `{ name: '' }` 是「把名字清空」这种要**拒绝**的请求，用 undefined 判断会把它当成
 * 「没传 name」悄悄放过；`{ category: null }` 更是个**合法值**（取消分类）。
 * 两者混在一个 `if` 里，就会出现「清空名字成功了但分类没传，于是整条 400」这种半截行为。
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { name?: unknown; category?: unknown } | null;
    const has = (key: 'name' | 'category') => !!body && Object.prototype.hasOwnProperty.call(body, key);
    if (!has('name') && !has('category')) throw new ApiError(400, '只认识 name 和 category 两个字段。');

    const result: { id: string; name?: string; category?: string | null } = { id };

    /* 改名（2026-09-26）：卡片右键菜单里的「重命名」。只动库里的 name，磁盘文件不动。 */
    if (has('name')) {
      const outcome = await renameAsset({ assetId: id, userId: user.id, name: body?.name });
      if (outcome.status === 'not_found') throw new ApiError(404, '资产不存在或无权修改。');
      if (outcome.status === 'invalid') {
        throw new ApiError(400, `名字不能是空的，也不能超过 ${ASSET_NAME_MAX} 个字。`);
      }
      result.name = outcome.name;
    }

    if (has('category')) {
      const raw = body?.category;
      const empty = raw === null || raw === undefined || raw === '';
      /*
       * 这里只过**形状**（空 / 超长 / 保留字），「这个名字在不在分类表里」由
       * `setAssetCategory` 查表回答 —— 分类表在库里，只有那一处知道。
       */
      const category = empty ? null : isCategoryName(raw) ? String(raw).trim() : undefined;
      if (category === undefined) throw new ApiError(400, '分类名不对（空的、太长、或叫了保留字）。');
      const outcome = await setAssetCategory({ assetId: id, userId: user.id, category });
      if (outcome.status === 'not_found') throw new ApiError(404, '资产不存在或无权修改。');
      /* 表里已经没有这个名字了（多半是刚被删掉、而页面还开着旧列表），让他刷新一次。 */
      if (outcome.status === 'unknown_category') {
        throw new ApiError(400, '这个分类已经不在了，刷新一下再试。');
      }
      result.category = outcome.category;
    }

    return Response.json(result);
  });
}
