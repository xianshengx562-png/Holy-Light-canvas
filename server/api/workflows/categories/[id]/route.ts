import { ApiError, api, apiUser, checkOrigin } from '@/lib/api';
import { WORKFLOW_CATEGORY_NAME_MAX } from '@/lib/workflows/category';
import { deleteWorkflowCategory, renameWorkflowCategory } from '@/lib/workflows/customCategory';

/**
 * 改一个自建分类（PATCH）· 删一个自建分类（DELETE）。
 *
 * 两件事**都不只是改一行表**：
 *  - 改名 → 归在这个分类下的工作流一起改（`WorkflowDraft.category` 存的是名字本身）；
 *  - 删除 → 那些工作流**回到「无参考」**，并把动了几份回给前端写回执。
 *    🔴 删标签不删内容：分类只是个标签，不能把工作流一起带走。
 *
 * 删哪个走路径上的 `[id]`（不是 query 上的名字）：名字里可能有 `/`、`?` 这类字符，
 * 塞在 query 里还要额外转义。
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { name?: unknown } | null;
    const outcome = await renameWorkflowCategory({ userId: user.id, id, name: body?.name });
    if (outcome.status === 'not_found') throw new ApiError(404, '这个分类已经不在了。');
    if (outcome.status === 'invalid') {
      throw new ApiError(
        400,
        `分类名要 1 ~ ${WORKFLOW_CATEGORY_NAME_MAX} 个字，而且不能与内置分类同名。`,
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
    const outcome = await deleteWorkflowCategory({ userId: user.id, id });
    if (outcome.status === 'not_found') throw new ApiError(404, '这个分类已经不在了。');
    return Response.json({ deleted: true, name: outcome.name, cleared: outcome.cleared });
  });
}
