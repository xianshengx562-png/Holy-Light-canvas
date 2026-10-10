import { db } from '@/lib/db';
import { isBuiltinWorkflowId } from '@/lib/workflows/builtin';
import { applyDefaultBindings, boundCanvasControls, configurationSchema, type CanvasControlSummary } from '@/lib/workflows/configuration';
import { defaultWorkflowId } from '@/lib/workflows/defaults';
import { readWorkflowName } from '@/lib/workflows/label';
import { graphNodeCount, readWorkflowProvider, type WorkflowProvider } from '@/lib/workflows/local';
import { readGeneratorKind, type GeneratorKind } from '@/lib/workflows/purpose';
import { readWorkflowCategory } from '@/lib/workflows/category';
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
   *
   * 🔴 类型是 `string` 而不是内置那五个的联合：2026-10-01 起分类可以是**用户自建的**
   * （存在 `WorkflowCategoryItem` 表里，值就是分类名本身）。写死联合类型会让每处比较
   * 都要先把自定义值窄化回去，而那是做不到的 —— 它本来就不是编译期能知道的集合。
   */
  category: string;
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
  /**
   * 这份配置里**已启用**字段都绑到了哪些画布槽位（如 `prompt` / `reference_image_1`）。
   *
   * 为什么连绑定一起带出来：界面要能答「你写在这张画布上的提示词到底送不送得进去」——
   * 一份工作流哪个字段都没绑到 `prompt` 时，提交体里根本没有提示词那一项，
   * 任务照样成功、出的是工作流自己的默认值，全程一句报错都没有。
   * 判这个只能看绑定，光看「启用了几项」答不出来（启用的可能全是步数、种子）。
   */
  enabledBindings: string[];
  /**
   * 这份配置里**有没有能接提示词的字段**（`kind === 'text'`，不论启用没有）。
   *
   * 与 `enabledBindings` 里有没有 `prompt` 是**两个问题**，界面要分别回答：
   * - 「有文本字段、只是没绑」→ 去配置页绑一下就能修，提示可以理直气壮把人支过去；
   * - 「连文本字段都没有」→ 这份东西**自带提示词**（RunningHub 应用最常见：
   *   「Krea2 资产库角色（四视图）」整份只有一个参考图字段），画布上写的字本来就没有去处。
   *   这时候再说「去配置页绑一下」是**一句死路** —— 那边根本没有这个下拉条目。
   */
  hasPromptField: boolean;
  isDefault: boolean;
  /**
   * 这份是不是**软件自带的预设**（2026-10-02 徐先：内置两条 RunningHub 超清工作流）。
   * 内置的不给删、界面上标一句「内置」—— 判定只有 `isBuiltinWorkflowId()` 一处，
   * 这里只是把它带出去给界面看（不新增列：它就是一份代码里的常量清单）。
   */
  builtin: boolean;
  /**
   * 这份本地工作流带了多少个节点（ComfyUI 图的顶层节点数）。
   * 云端工作流恒为 0 —— 它的图不在本地，界面上不该显示这个数。
   */
  graphNodes: number;
  /**
   * 画布控件（开关 / 数字滑块 / 自定义参数分类，2026-10-10 徐先）——
   * **只带「真的有字段接着」的那些**，节点卡片右上角的胶囊照它画。
   *
   * 为什么在这里摊平、不让画布自己去读整份配置：画布列出的是**几十份**工作流的
   * 摘要（不是某一份的完整配置），而胶囊只需要「画什么、量程多少、默认是什么」；
   * 顺带 `value` 一律是字符串，和提交时写进 `nodeInfoList` 的那一串同一个形状。
   *
   * 没绑到任何已启用字段的控件**不在这里** —— 它拧了也没有地方去。
   */
  canvasControls: CanvasControlSummary[];
};

/** 汇总里只用得到这三个键（启没启用 / 绑到哪个槽位 / 是不是文本字段），所以不引完整字段类型。 */
type DraftField = { enabled?: boolean; binding?: string; kind?: string };

/**
 * 三个筛选维度：用途（产出什么）、分类（喂什么参考）、工序（生成还是超清）。
 *
 * 收成一个对象而不是三个位置参数 —— 加第三个之后位置参数已经数不清了，
 * 而传错顺序的代价是一条悄悄查错的列表（不报错、只是少了几条）。
 */
export type WorkflowFilter = {
  kind?: GeneratorKind | null;
  category?: string | null;
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
      /* 只收「启用且真绑了槽位」的：`binding: 'manual'` 是固定值，不吃画布上的任何东西。 */
      enabledBindings: Array.from(new Set(fields
        .filter(field => field?.enabled && field.binding && field.binding !== 'manual')
        .map(field => String(field.binding)))),
      /* 不看 `enabled`：这里答的是「有没有这个去处」，不是「它开着没有」。 */
      hasPromptField: fields.some(field => String(field?.kind || '') === 'text'),
      // 「默认」这个概念只对视频成立：defaultWorkflowId 就是那条视频工作流。
      isDefault: kind === 'video' && draft.workflowId === defaultWorkflowId,
      builtin: isBuiltinWorkflowId(draft.workflowId),
      /* 图在本地才数得出来；云端那份 `graph` 是 NULL，`graphNodeCount` 会返回 0。 */
      graphNodes: readWorkflowProvider(draft.provider) === 'local' ? graphNodeCount(draft.graph) : 0,
      /* 只带绑上的那些：没绑的控件在画布上画出来就是个拧了不生效的旋钮。 */
      canvasControls: boundCanvasControls(applyDefaultBindings(draft.config)),
    };
  });
}
