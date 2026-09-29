import { db } from '@/lib/db';
import { applyDefaultBindings, configurationSchema } from '@/lib/workflows/configuration';
import { defaultWorkflowId } from '@/lib/workflows/defaults';
import { readWorkflowName } from '@/lib/workflows/label';
import { graphNodeCount, readWorkflowProvider, type WorkflowProvider } from '@/lib/workflows/local';
import { readGeneratorKind, type GeneratorKind } from '@/lib/workflows/purpose';
import { readWorkflowCategory, type WorkflowCategory } from '@/lib/workflows/category';
import { readWorkflowOperation, type WorkflowOperation } from '@/lib/workflows/operation';

/**
 * 一份工作流配置在界面上的样子。**这是服务端产出的唯一形状**：
 * 接口 `/api/workflows` 与设置页的「工作流列表」都从这里取，
 * 客户端那边对应的类型是 `components/canvas/types.ts` 的 `WorkflowOption`（字段一一对应）。
 *
 * 这里**不预先算好显示名**：名字的回落规则只有 `workflowDisplayName` 一处，
 * 服务端再算一遍就是第二条规则，迟早和界面显示的不一样。
 *
 * 之所以要抽出来：列表页和接口各算一遍字段数，迟早会出现「设置页显示 12 项启用、画布下拉显示 3 项」
 * —— 因为「要提交哪些参数」这件事只有 `applyDefaultBindings` 知道，两边各写一遍就会各错一遍。
 */
export type WorkflowSummary = {
  workflowId: string;
  /**
   * 这份工作流跑在哪：**本机 ComfyUI**（`local`，图存在这一行里）还是 **RunningHub**（`runninghub`）。
   *
   * 界面据此标一句来源；画布下拉要把两者列在一起（同一份工作流能不能用，取决于节点用途，
   * 不取决于它跑在哪台机器上）。
   */
  provider: WorkflowProvider;
  /** 用户起的名字，空串 = 没起名字。显示时走 `workflowDisplayName` 回落 `workflowId`。 */
  name: string;
  kind: GeneratorKind;
  /**
   * 这份工作流吃什么样的参考输入。与 `kind` 一起决定它出现在哪些筛选条件下。
   * 读取时**按用途兜底**：老数据里可能有「图片工作流标着视频参考」这种组合。
   */
  category: WorkflowCategory;
  /**
   * 工序：普通生成 / 超清。**超清工作流不出现在生成节点的下拉里**（它是被「超清」按钮调用的），
   * 所以画布那一侧必须按它再过一道 —— 少了这一层，用户能在下拉里选到超清工作流，
   * 症状和「选错用途」一样：任务成功，产出一份没有被超清的新媒体。
   */
  operation: WorkflowOperation;
  version: number;
  updatedAt: string;
  totalCount: number;
  enabledCount: number;
  isDefault: boolean;
  /**
   * 这份本地工作流带了多少个节点（ComfyUI 图的顶层节点数）。
   * 云端工作流恒为 0 —— 它的图不在本地，界面上不该显示这个数。
   */
  graphNodes: number;
};

type DraftField = { enabled?: boolean };

/**
 * 三个筛选维度：用途（产出什么）、分类（喂什么参考）、工序（生成还是超清）。
 *
 * 收成一个对象而不是三个位置参数 —— 加第三个之后位置参数已经数不清了，
 * 而传错顺序的代价是一条悄悄查错的列表（不报错、只是少了几条）。
 */
export type WorkflowFilter = {
  kind?: GeneratorKind | null;
  category?: WorkflowCategory | null;
  operation?: WorkflowOperation | null;
  /**
   * 跑在哪条路上：`local` / `runninghub`。不传 = 两者都要。
   *
   * 桌面版画布要列全部（用户可能既有一条本地 ComfyUI 工作流，也有几条云端的）；
   * 工作流库页的「本机 ComfyUI」那一栏只查 `local`。
   */
  provider?: WorkflowProvider | null;
};

/**
 * 列出当前账号保存过配置的工作流，按最近改动排序。
 *
 * 过滤放在服务端而不是让前端 filter：一来少传一半数据，二来「哪些工作流属于哪一类」
 * 这个判断只能有一处。
 *
 * 注意**分类不能单独用**：分类的适用性依附于用途（`categoriesFor(kind)`），
 * 只按 `category: 'video-ref'` 查而不带用途，会把别的用途下同名的分类一起捞出来。
 * 工序与用途正交，`operation: 'upscale'` 单独查是合法的（两类用途都可能有超清工作流）。
 */
export async function listWorkflowDrafts(userId: string, filter: WorkflowFilter = {}): Promise<WorkflowSummary[]> {
  const drafts = await db.workflowDraft.findMany({
    where: {
      userId,
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.operation ? { operation: filter.operation } : {}),
      ...(filter.provider ? { provider: filter.provider } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      workflowId: true, kind: true, category: true, operation: true,
      name: true, version: true, updatedAt: true, config: true, provider: true, graph: true,
    },
  });
  return drafts.map(draft => {
    const raw = (draft.config || {}) as { fields?: unknown };
    const rawFields = Array.isArray(raw.fields) ? (raw.fields as DraftField[]) : [];
    /*
     * Count what a run will actually submit, not what is literally stored. Counts taken from
     * the raw config disagree with the config page and with the generation endpoint, because
     * configs saved before bindings existed are only brought up to date at read time — they
     * look like "3 / 122 enabled" here while a run really sends 17 fields.
     */
    const parsed = configurationSchema.safeParse(applyDefaultBindings(draft.config));
    const fields = parsed.success ? parsed.data.fields : rawFields;
    // 库里可能存着历史脏值（别的版本写进去的用途 / 名字），读的时候兜一次底，别把 undefined 甩给 UI。
    const kind = readGeneratorKind(draft.kind);
    const name = readWorkflowName(draft.name);
    return {
      workflowId: draft.workflowId,
      provider: readWorkflowProvider(draft.provider),
      name,
      kind,
      /** 兜底要带上用途：分类与用途对不上时（老数据、手改过）必须退回默认值。 */
      category: readWorkflowCategory(draft.category, kind),
      operation: readWorkflowOperation(draft.operation),
      version: draft.version,
      updatedAt: draft.updatedAt.toISOString(),
      totalCount: fields.length,
      enabledCount: fields.filter(field => field?.enabled).length,
      // 「默认」这个概念只对视频成立：defaultWorkflowId 就是那条视频工作流。
      isDefault: kind === 'video' && draft.workflowId === defaultWorkflowId,
      /* 图在本地才数得出来；云端那份 `graph` 是 NULL，`graphNodeCount` 会返回 0。 */
      graphNodes: readWorkflowProvider(draft.provider) === 'local' ? graphNodeCount(draft.graph) : 0,
    };
  });
}
