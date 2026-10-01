import { ApiError, api, apiUser, checkOrigin } from '@/lib/api';
import { WORKFLOW_CATEGORY_NAME_MAX } from '@/lib/workflows/category';
import { createWorkflowCategory, listWorkflowCategories } from '@/lib/workflows/customCategory';

/**
 * 自建的工作流分类：列（GET）· 建（POST）。
 *
 * 内置那五个（无参考 / 单图参考 / 多图参考 / 视频参考 / 音频 + 多图参考）是代码里的枚举，
 * **不在这张表里**；这里只管用户自己起的名字（2026-10-01 徐先：「分类我自己能加」）。
 * 增删改放在 `[id]/route.ts`。
 *
 * ⚠️ 这是**静态段**，必须排在 `/api/workflows/[workflowId]` 前面 —— 排在后面的话
 * `/api/workflows/categories` 会被那个动态段截走（拿 `categories` 当 workflowId），
 * 返回的是一句「这份工作流还没有保存过配置」这种**看着像业务问题**的 404。
 */
export async function GET() {
  return api(async () => {
    const user = await apiUser();
    return Response.json({ categories: await listWorkflowCategories(user.id) });
  });
}

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const body = (await request.json().catch(() => ({}))) as { name?: unknown } | null;
    const outcome = await createWorkflowCategory({ userId: user.id, name: body?.name });
    if (outcome.status === 'invalid') {
      throw new ApiError(
        400,
        `分类名要 1 ~ ${WORKFLOW_CATEGORY_NAME_MAX} 个字，而且不能与内置分类（无参考 / 单图参考 / 多图参考 / 视频参考 / 音频 + 多图参考）同名。`,
      );
    }
    /* 同名报 409 而不是静默改成「角色 2」：后者用户根本不知道自己建了个什么名字。 */
    if (outcome.status === 'duplicate') throw new ApiError(409, '已经有同名分类了。');
    return Response.json({ category: outcome.category });
  });
}
