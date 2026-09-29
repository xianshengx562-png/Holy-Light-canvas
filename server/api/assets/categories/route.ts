import { ApiError, api, apiUser, checkOrigin } from '@/lib/api';
import {
  CATEGORY_NAME_MAX, createAssetCategory, listAssetCategories,
} from '@/lib/assets';

/**
 * 资产分类表：列（GET）· 建（POST）。
 *
 * 分类**只有名字，没有层级**：它是资产筛选器上的一排 chip，不是文件夹。
 * 增删改放在 `server/api/assets/categories/[id]/route.ts`。
 *
 * ⚠️ 这是**静态段**，必须排在 `/api/assets/[id]` 前面 —— `gen-routes.py` 那条
 * 「同位置静态段优先于动态段」的规则就是为它准备的（否则会被 `[id]` 截走，返回 405）。
 */
export async function GET() {
  return api(async () => {
    const user = await apiUser();
    return Response.json({ categories: await listAssetCategories(user.id) });
  });
}

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const body = (await request.json().catch(() => ({}))) as { name?: unknown } | null;
    const outcome = await createAssetCategory({ userId: user.id, name: body?.name });
    if (outcome.status === 'invalid') {
      /* 把规矩一次说完：`all` / `none` 是筛选器的保留字，用户看不到，得点名。 */
      throw new ApiError(
        400,
        `分类名不能是空的、不能叫「all」或「none」（这两个是筛选器的保留字），也不能超过 ${CATEGORY_NAME_MAX} 个字。`,
      );
    }
    /* 同名分类报 409 而不是静默改成「角色 2」：后者用户根本不知道自己建了个什么名字。 */
    if (outcome.status === 'duplicate') throw new ApiError(409, '已经有同名分类了。');
    return Response.json({ category: outcome.category });
  });
}
