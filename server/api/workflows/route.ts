import { api, apiUser, ApiError } from '@/lib/api';
import { ensureBuiltinWorkflows } from '@/lib/workflows/builtin';
import { listWorkflowDrafts } from '@/lib/workflows/drafts';
import { defaultWorkflowId } from '@/lib/workflows/defaults';
import { isWorkflowCategory } from '@/lib/workflows/category';
import { listWorkflowCategories, workflowCategoryAllowed } from '@/lib/workflows/customCategory';
import { isGeneratorKind } from '@/lib/workflows/purpose';
import { isWorkflowOperation } from '@/lib/workflows/operation';
import { isWorkflowProvider } from '@/lib/workflows/local';

/**
 * 列出当前账号保存过配置的工作流，供「设置 · 工作流列表」管理、也供画布选一个用，不用手打 ID。
 *
 * **`?kind=video|image|audio` 按用途过滤**，画布上视频生成节点只拿视频的、图片生成节点只拿图片的。
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
      throw new ApiError(400, `不支持的工作流用途「${rawKind}」，只能是 video、image 或 audio。`);
    }
    /*
     * 分类同理：认不出来就 400，不忽略也不回退到「返回全部」——「过滤器悄悄不生效」
     * 看起来和「这个分类下没有工作流」一模一样，是最难查的一类问题。
     */
    const rawCategory = new URL(request.url).searchParams.get('category');
    /*
     * 分类可能是内置那五个，也可能是**用户自建的**（2026-10-01 徐先：「分类我自己能加」）。
     * 两种的合法性判断都收敛到 `workflowCategoryAllowed`：内置的查「这个用途下有没有它」，
     * 自建的查那张表里在不在。传了 kind 就按那个用途判；没传（列全部用途）时只需要名字确实存在
     * —— 自建分类不绑用途，所以随便挑一个用途进去问，命中不了内置分支、只会查表。
     */
    if (rawCategory !== null) {
      const ok = rawKind !== null
        ? await workflowCategoryAllowed(user.id, rawKind, rawCategory)
        : (isWorkflowCategory(rawCategory) || await workflowCategoryAllowed(user.id, 'image', rawCategory));
      if (!ok) throw new ApiError(400, `不支持的工作流分类「${rawCategory}」。`);
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
    /*
     * 先把软件自带的预设补进这个用户的库（**只补他还没有的**，见 `ensureBuiltinWorkflows`）。
     *
     * 放在列表这一支而不是启动时：① 新装第一次打开画布就会走到这里（画布一进来就要拉
     * 工作流下拉），不必另找「初始化」的时机；② 所有要用工作流的地方都得先过这一支，
     * 于是「打开软件就有」只需要守这一个口子，不用在每个读接口上各补一次。
     */
    await ensureBuiltinWorkflows(user.id);
    return Response.json({
      defaultWorkflowId,
      workflows: await listWorkflowDrafts(user.id, {
        kind: rawKind, category: rawCategory, operation: rawOperation, provider: rawProvider,
      }),
      /*
       * 用户自建的分类跟着列表一起回（2026-10-01 徐先：「分类我自己能加」）。
       * 一起回而不是另开一个接口：列表页与画布下拉本来就要等这一份数据，
       * 分两次取会让「列表已经显示、分类下拉还空着」闪一下，也容易两处不一致。
       */
      categories: await listWorkflowCategories(user.id),
    });
  });
}
