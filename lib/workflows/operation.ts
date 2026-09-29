/**
 * 工作流的「工序」—— 这份工作流是**从无到有生成**，还是**拿一份现成的媒体再加工**（超清）。
 *
 * 与「用途」（产出什么）、「分类」（喂什么参考）都正交：超清工作流自己也有用途
 * （视频超清 / 图片超清），它只是 MID 的一步后处理，不需要提示词、不需要参考图、不需要 latent，
 * **唯一的输入就是待处理的那一份媒体**。
 *
 * 为什么不做成第三、第四个用途：用途决定它出现在哪类生成节点的下拉里，而超清工作流
 * **不出现在生成下拉里**（它是被「超清」按钮调用的）。混进用途会让「图片节点为什么有一条
 * 视频工作流可选」这种问题重新出现 —— 那正是上次加用途要消灭的混乱。
 *
 * 与用途同一个套路：**显式标注、不推断**（从「工作流有没有 prompt 字段」去猜超清，
 * 猜错的代价还是静默的 —— 任务成功、产出一份没有被超清的媒体）。
 *
 * 这个文件同样**不引 `server-only`、不碰数据库**：接口校验、页面下拉、回归脚本都要用同一份。
 */

/** 值域。加工序时改这里，接口校验、下拉选项、回归断言会一起跟上。 */
export const WORKFLOW_OPERATIONS = ['generate', 'upscale'] as const;

export type WorkflowOperation = (typeof WORKFLOW_OPERATIONS)[number];

/** 读到一个认不出的值（老数据、被手改过的库）时退回的工序。 */
export const DEFAULT_WORKFLOW_OPERATION: WorkflowOperation = 'generate';

/** 严格校验，给接口入参用 —— 客户端送来不认识的工序要**报错**，不能悄悄改成默认值。 */
export function isWorkflowOperation(value: unknown): value is WorkflowOperation {
  return typeof value === 'string' && (WORKFLOW_OPERATIONS as readonly string[]).includes(value);
}

/** 读取兜底，给「展示一个从库里读出来的值」用。与 `isWorkflowOperation` 的区别是它不报错。 */
export function readWorkflowOperation(value: unknown): WorkflowOperation {
  return isWorkflowOperation(value) ? value : DEFAULT_WORKFLOW_OPERATION;
}

/** 下拉 / 分段控件用的一行。放在这里是为了「有哪些工序」只有一处定义。 */
export const WORKFLOW_OPERATION_OPTIONS: { value: WorkflowOperation; label: string; hint: string }[] = [
  { value: 'generate', label: '普通生成', hint: '按提示词与参考素材生成' },
  { value: 'upscale', label: '超清', hint: '拿一份现成的视频 / 图再加工' },
];

export function workflowOperationLabel(value: unknown) {
  return WORKFLOW_OPERATION_OPTIONS.find(item => item.value === readWorkflowOperation(value))!.label;
}

export function workflowOperationOption(value: unknown) {
  return WORKFLOW_OPERATION_OPTIONS.find(item => item.value === readWorkflowOperation(value))!;
}
