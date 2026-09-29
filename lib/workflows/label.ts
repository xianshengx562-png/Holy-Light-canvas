/**
 * 工作流的**名字**：清洗规则与显示回落规则，只有这一处。
 *
 * 为什么需要名字：`workflowId` 是一串 19 位数字，下拉里认不出谁是谁。而这一整套设计里
 * 「选错工作流」的后果都是**静默**的（任务成功、产出另一种媒体），所以让用户按自己起的名字选，
 * 是在源头减少选错 —— 名字不是装饰，是防错的一部分。
 *
 * 这个文件**不引 `server-only`、不碰数据库**，理由与 `purpose.ts` 相同：服务端校验入参、
 * 配置页即时反馈、画布下拉显示三处要用同一套规则，回归脚本也要能直接加载它来测。
 */

/** 名称长度上限。够写「图片工作流 · 参考图版」这种，又长不到把下拉撑爆。 */
export const WORKFLOW_NAME_MAX = 60;

export type WorkflowNameResult = { ok: true; name: string } | { ok: false; message: string };

/**
 * 清洗 + 校验一个名称。
 *
 * 三件事：
 *   1. 掐掉首尾空白；
 *   2. **把换行/制表/控制字符压成单个空格** —— 名字会进 `<option>`，一个换行就能把下拉撑歪；
 *   3. 长度**超限就报错，不静默截断**。截断看起来"更宽容"，但用户会以为自己起的名字存下来了，
 *      下次对着下拉里的半截名字找不到对应的工作流 —— 报错比静默改数据好。
 *
 * 空串是合法的：意思是「不起名字」，界面回落显示 `workflowId`。
 */
export function normalizeWorkflowName(value: unknown): WorkflowNameResult {
  if (value === null || value === undefined) return { ok: true, name: '' };
  if (typeof value !== 'string') return { ok: false, message: '名称必须是文本。' };
  const name = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (name.length > WORKFLOW_NAME_MAX) {
    return { ok: false, message: `名称最多 ${WORKFLOW_NAME_MAX} 个字，现在有 ${name.length} 个。` };
  }
  return { ok: true, name };
}

/** 库里读出来的名字也要过一遍同样的清洗（历史数据、被手改过的库都可能带着换行）。 */
export function readWorkflowName(value: unknown): string {
  /*
   * 非字符串一律当「没起名字」：读的时候报错等于把一个脏值变成打不开的页面，
   * 而造一个字符串出来（`String(123)` → `'123'`）会把这个脏值伪装成一个合法的名字。
   * 回空串 → 界面回落显示工作流 ID，那永远是一个有意义的值。
   */
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  /* 超长的历史值就地截断（读路径不报错，理由同上）。写入路径是报错的，见 normalizeWorkflowName。 */
  return cleaned.slice(0, WORKFLOW_NAME_MAX);
}

/**
 * 给人看的名字：**起了名字就用名字，没起名字回落 `workflowId`**。
 *
 * 回落是刻意的：存量草稿（加名字之前保存的）都没有名字，界面不能出现一行空白选项。
 */
export function workflowDisplayName(item: { name?: string | null; workflowId: string }): string {
  return readWorkflowName(item.name) || item.workflowId;
}
