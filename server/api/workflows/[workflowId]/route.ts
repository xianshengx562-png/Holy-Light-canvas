import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { db } from '@/lib/db';
import { normalizeWorkflowName, readWorkflowName } from '@/lib/workflows/label';
import { categoriesFor, isWorkflowCategory, readWorkflowCategory, workflowCategoryLabel } from '@/lib/workflows/category';
import { generatorKindNoun, readGeneratorKind } from '@/lib/workflows/purpose';
import { providerFromWorkflowId, workflowIdError } from '@/lib/workflows/local';

type Context = { params: Promise<{ workflowId: string }> };
/*
 * 工作流 ID 的合法性 —— 以前一律要求纯数字（RunningHub 的 ID 就是数字），
 * 现在本地工作流带 `local-` 前缀，共用同一个 URL 段，所以判断收敛到
 * `lib/workflows/local.ts` 那一个函数里：**路由和界面必须判的是同一件事**，
 * 否则会出现「列表里点得开、保存时报 400」这种两边不一致的问题。
 */
async function workflowKey(context: Context) {
  const { workflowId } = await context.params;
  const message = workflowIdError(workflowId);
  if (message) throw new ApiError(400, message);
  return workflowId;
}

/*
 * 名字与分类**都是「标签」而不是配置内容**，所以共用这一个接口、两个字段都可选。
 * 分类严格校验放在代码里做（不用 `z.enum`）：不认识的值要报一句中文、
 * 并把「这个用途下能选哪些」说全，zod 的默认文案做不到。
 */
const patchSchema = z.object({
  /**
   * 新名字。长度与清洗规则在 `lib/workflows/label.ts`（那里报中文错，比 zod 默认文案有用）。
   * **空串是有效操作**（= 清掉名字，界面回落显示工作流 ID），所以只能用类型校验，不能加 `.min(1)`。
   */
  name: z.string().optional(),
  /** 新分类。必须适用于这份工作流**当前的用途**（分类的适用性依附于用途，见 `category.ts`）。 */
  category: z.string().optional(),
});

/**
 * 改一份工作流配置的**标签**（名字 / 分类）。
 *
 * 为什么单独一个接口，而不是复用 `PATCH .../config`：那个接口要**整份配置 + 版本号**才肯收，
 * 而改名字或分类只需要一个值。设置页的列表要能就地改，画布下拉也要按名字认人 ——
 * 为了改个标签先把一百多个字段拉下来再整体回写，既慢又给并发冲突平白加了风险。
 *
 * **改标签不递增 `version`**：版本号是给「整份配置的乐观并发」用的，改个显示名或分类与
 * 配置内容无关。递增它只会让另一个开着配置页的标签页在保存时收到一个假冲突
 * （"配置已在其他页面修改"），而那个页面里的字段其实一个字都没变。
 */
export async function PATCH(request: Request, context: Context) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const workflowId = await workflowKey(context);
    const parsed = patchSchema.safeParse(await jsonBody(request, 64 * 1024));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    const nameInput = parsed.data.name;
    const categoryInput = parsed.data.category;
    if (nameInput === undefined && categoryInput === undefined) {
      throw new ApiError(400, '请求体里需要有 name 或 category 字段。');
    }

    if (categoryInput !== undefined && !isWorkflowCategory(categoryInput)) {
      throw new ApiError(400, `不支持的工作流分类「${categoryInput}」。`);
    }

    /*
     * 先查草稿：一来分类的适用性要按它**现在的用途**判断，二来没保存过配置的工作流
     * 本来就没有这两个标签可改。
     */
    const current = await db.workflowDraft.findUnique({
      where: { userId_workflowId: { userId: user.id, workflowId } },
      select: { kind: true },
    });
    /*
     * 没有草稿 → 404。不能「改标签时顺手建一份空草稿」：空草稿在画布下拉里是一条
     * 0 项启用的选项，看着像工作流本身坏了，而用户只是想把名字先起好（上传工作流是另一步）。
     */
    if (!current) throw new ApiError(404, '这份工作流还没有保存过配置，先在配置页保存一次再改。');

    const kind = readGeneratorKind(current.kind);
    if (categoryInput !== undefined && !categoriesFor(kind).some(item => item.value === categoryInput)) {
      const allowed = categoriesFor(kind).map(item => item.label).join(' / ');
      throw new ApiError(400, `分类「${workflowCategoryLabel(categoryInput)}」不适用于${generatorKindNoun(kind)}，这个用途只能选：${allowed}。`);
    }

    const data: { name?: string; category?: string } = {};
    if (nameInput !== undefined) {
      const cleaned = normalizeWorkflowName(nameInput);
      /* 超长要**报错**，不能截断后再存：用户会以为名字存下了，下次对着下拉里的半截名字找不到它。 */
      if (!cleaned.ok) throw new ApiError(400, cleaned.message);
      data.name = cleaned.name;
    }
    if (categoryInput !== undefined) data.category = categoryInput;

    /* `updateMany` 而不是 `update`：条件里带着 userId，别人的草稿根本进不来。 */
    const result = await db.workflowDraft.updateMany({ where: { userId: user.id, workflowId }, data });
    if (!result.count) throw new ApiError(404, '这份工作流还没有保存过配置，先在配置页保存一次再改。');

    const saved = await db.workflowDraft.findUnique({
      where: { userId_workflowId: { userId: user.id, workflowId } },
      select: { name: true, category: true, version: true },
    });
    return Response.json({
      workflowId,
      name: readWorkflowName(saved?.name),
      category: readWorkflowCategory(saved?.category, kind),
      version: saved?.version,
    });
  });
}

/**
 * 删掉一份已保存的工作流配置。
 *
 * 本地工作流连带删掉存在这一行里的图 —— 那份图没有第二个存放的地方，留下来就是一条
 * 「看得见、但已经没法跑」的记录。云端工作流不存在这个问题：删的只是本地这份配置，
 * RunningHub 上的工作流本体不会被删（那是别人平台上的东西，也删不掉）。
 *
 * 已经跑过的任务不受影响：任务的外键挂在 `Workflow` 表（按 `provider` + `workflowId` upsert
 * 出来的那一行），不挂在这份草稿上，所以删掉草稿不会让历史任务查不到东西 ——
 * 「已保存的配置」和「跑起来的时候用的工作流」本来就是两件事，各自有自己的生命周期。
 */
export async function DELETE(request: Request, context: Context) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const workflowId = await workflowKey(context);
    /* 同样用 `deleteMany` 而不是 `delete`：userId 进条件，别人的草稿删不掉。 */
    const result = await db.workflowDraft.deleteMany({ where: { userId: user.id, workflowId } });
    if (!result.count) throw new ApiError(404, '这份工作流还没有保存过配置。');
    return Response.json({ workflowId, provider: providerFromWorkflowId(workflowId) });
  });
}
