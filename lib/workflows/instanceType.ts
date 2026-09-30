/**
 * RunningHub 的**运行规格** —— 这一发任务跑在多大的机器上（2026-09-30，徐先要的）。
 *
 * 官方定义的三个值（来自 RunningHub API 文档「发起 ComfyUI 任务-高级」那一页）：
 *   - `default`：24G 显存机器（**不传就是这个**）
 *   - `plus`   ：48G 显存机器
 *   - `ultra`  ：84G 显存机器
 *
 * ## 为什么要有这个选项
 *
 * 在这之前**界面上一个字都没有**：提交时永远不带 `instanceType`，于是官方按 24G 给我们派机器。
 * 那些吃显存的工作流（大模型 + 高分辨率 + 视频）在 24G 上跑不起来时，报出来的是上游的
 * 显存不足 —— 用户在自己这一侧找不到任何可以调的东西，只能去官网上手动跑。
 *
 * ## 为什么它是**节点上的字段**，而不是设置里的一个全局开关
 *
 * 同一个项目里不同镜头的胃口差得远：批量跑的分镜用 24G 就够，重点镜头可能要 48G。
 * 这也是它跟 `engine` 一样长在节点上的原因（而不是「配置一次全局生效」）。
 *
 * ## 🔴 只对 RunningHub 云端有意义
 *
 * 本机 ComfyUI 用的是**用户自己的显卡**，网关那两档（`videoapi` / `custom`）是别人家的机房 ——
 * 这三档都没有「租哪种机器」这回事。所以界面上只在这一节点真的走 RunningHub 时才画出来
 * （判据是 `provider === 'runninghub'`，见 `GenerateDock`）。
 *
 * 值域与兜底规则放在这里（不引 `server-only`、不碰数据库），因为 UI 渲染、提交前的组包、
 * 回归脚本都要同一份定义。
 */

export const RUNNINGHUB_INSTANCE_TYPES = ['default', 'plus', 'ultra'] as const;

export type RunningHubInstanceType = (typeof RUNNINGHUB_INSTANCE_TYPES)[number];

/**
 * 缺省规格。**只能是 `default`**：加这个选项之前所有节点都没有这个字段，
 * 它们必须继续按 24G 跑 —— 默认值一旦不是 `default`，老画布会集体涨价。
 */
export const DEFAULT_INSTANCE_TYPE: RunningHubInstanceType = 'default';

/** 严格校验，给接口入参用 —— 送来不认识的规格要**报错**，不能悄悄改成默认值。 */
export function isInstanceType(value: unknown): value is RunningHubInstanceType {
  return typeof value === 'string' && (RUNNINGHUB_INSTANCE_TYPES as readonly string[]).includes(value);
}

/** 读取兜底，给「展示一个从库里读出来的值」用。与 `isInstanceType` 的区别是它不报错。 */
export function readInstanceType(value: unknown): RunningHubInstanceType {
  return isInstanceType(value) ? value : DEFAULT_INSTANCE_TYPE;
}

/**
 * 下拉里那三行。
 *
 * ⚠️ `label` 要**短**：操作排上是颗胶囊（`.cv-dock-eng`），长标签会把「参数摘要」挤下去。
 * 显存数字保留（那是用户真正在乎的差别），「机器」两个字省掉 —— 上下文已经说明白了。
 * 完整的说法进 `hint`，两边分工，别把长句塞进下拉。
 */
export const INSTANCE_TYPE_OPTIONS: { value: RunningHubInstanceType; label: string; hint: string }[] = [
  { value: 'default', label: 'STANDARD 24G', hint: '标准档 · 24G 显存（官方默认，不加价）—— 出图与大多数工作流都够用' },
  { value: 'plus', label: 'PLUS 48G', hint: 'PLUS · 48G 显存 —— 重模型 / 大分辨率 / 视频更稳，官方按更高单价计费' },
  { value: 'ultra', label: 'ULTRA 84G', hint: 'ULTRA · 84G 显存 —— 给最重的工作流用，单价最高' },
];

export function instanceTypeLabel(value: unknown) {
  return INSTANCE_TYPE_OPTIONS.find(item => item.value === readInstanceType(value))?.label || 'STANDARD 24G';
}

/** 这一档的完整说明（title / 提示文字用）。 */
export function instanceTypeHint(value: unknown) {
  return INSTANCE_TYPE_OPTIONS.find(item => item.value === readInstanceType(value))?.hint || '';
}

/** 是不是「用户主动改过」—— 没改过（字段缺省）时界面上不必特意强调。 */
export function isDefaultInstanceType(value: unknown) {
  return readInstanceType(value) === DEFAULT_INSTANCE_TYPE;
}
