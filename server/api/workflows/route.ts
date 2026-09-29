import { api, apiUser, ApiError } from '@/lib/api';
import { listWorkflowDrafts } from '@/lib/workflows/drafts';
import { defaultWorkflowId } from '@/lib/workflows/defaults';
import { categoriesFor, isWorkflowCategory, workflowCategoryLabel } from '@/lib/workflows/category';
import { generatorKindNoun, isGeneratorKind } from '@/lib/workflows/purpose';
import { isWorkflowOperation } from '@/lib/workflows/operation';
import { isWorkflowProvider } from '@/lib/workflows/local';

/**
 * 列出当前账号保存过配置的工作流，供「设置 · 工作流列表」管理、也供画布选一个用，不用手打 ID。
 *
 * **`?kind=video|image` 按用途过滤**，画布上视频生成节点只拿视频的、图片生成节点只拿图片的。
 * 过滤与字段计数都在 `lib/workflows/drafts.ts`（与设置页共用同一份，免得两处数出不同的启用数量）。
 *
 * 传了不认识的 kind 直接 400，不忽略也不回退到「返回全部」——「过滤器悄悄不生效」
 * 看起来和「没有这个用途的工作流」一模一样，是最难查的一类问题。
 */
export async function GET(request: Request) {
  return api(async () => {
    const user = await apiUser();
    const rawKind = new URL(request.url).searchParams.get('kind');
    if (rawKind !== null && !isGeneratorKind(rawKind)) {
      throw new ApiError(400, `不支持的工作流用途「${rawKind}」，只能是 video 或 image。`);
    }
    /*
     * 分类同理：认不出来就 400，不忽略也不回退到「返回全部」——「过滤器悄悄不生效」
     * 看起来和「这个分类下没有工作流」一模一样，是最难查的一类问题。
     */
    const rawCategory = new URL(request.url).searchParams.get('category');
    if (rawCategory !== null && !isWorkflowCategory(rawCategory)) {
      throw new ApiError(400, `不支持的工作流分类「${rawCategory}」。`);
    }
    /*
     * 分类与用途对不上（比如「图片生成 + 视频参考」）也 400：这种组合查出来必然是空的，
     * 和「这个分类下确实没有工作流」在界面上一模一样 —— 又是一个查不出来的静默失败。
     * 没传 kind 时不判（那时拿全部用途，任何分类都合法）。
     */
    if (rawKind !== null && rawCategory !== null && !categoriesFor(rawKind).some(item => item.value === rawCategory)) {
      throw new ApiError(400, `分类「${workflowCategoryLabel(rawCategory)}」不适用于${generatorKindNoun(rawKind)}。`);
    }
    /*
     * 工序与用途正交（视频 / 图片各自都能有超清工作流），所以不需要配对的适用性检查，
     * 但认不出来的值照样 400 —— 道理和上面两处一样。
     */
    const rawOperation = new URL(request.url).searchParams.get('operation');
    if (rawOperation !== null && !isWorkflowOperation(rawOperation)) {
      throw new ApiError(400, `不支持的工作流工序「${rawOperation}」，只能是 generate 或 upscale。`);
    }
    /*
     * 来源：本机 ComfyUI（`local`）/ RunningHub（`runninghub`）。不传 = 两者一起列。
     * 画布下拉不传（两类工作流在同一个节点里都能选）；工作流库页的「本机 ComfyUI」那栏传 `local`。
     */
    const rawProvider = new URL(request.url).searchParams.get('provider');
    if (rawProvider !== null && !isWorkflowProvider(rawProvider)) {
      throw new ApiError(400, `不支持的工作流来源「${rawProvider}」，只能是 local 或 runninghub。`);
    }
    return Response.json({
      defaultWorkflowId,
      workflows: await listWorkflowDrafts(user.id, {
        kind: rawKind, category: rawCategory, operation: rawOperation, provider: rawProvider,
      }),
    });
  });
}
