/**
 * 生成器的「用途」—— 工作流是给视频生成用的，还是给图片生成用的。
 *
 * 这个区分必须存在，因为出图和出视频用的是**两套完全不同的工作流**：
 * 视频工作流里有 `Yuan_H3MotionContextLoadLatent`（节点 210 / 278）这类续接节点、
 * 有帧数与时长；出图工作流里有 `KSampler` 的 steps / cfg / seed。
 * 两者混在一个列表里让人挑，选错的后果是**任务成功、但产出的是另一种媒体** ——
 * 没有任何报错，只有人眼看结果才发现。
 *
 * 所以用途是**显式标注**的（`WorkflowDraft.kind`），不做推断：
 * 靠「配置里启用了哪些绑定」去猜看起来聪明，但一个只绑了提示词的工作流两边都像，
 * 猜错的代价还是静默的。显式标注至少是能被用户看见、能被测试钉住的。
 *
 * 这个文件**刻意不引 `server-only`、不碰数据库** —— 服务端校验、接口出参、画布下拉
 * 都要用同一份值域，回归脚本也要能直接加载它来测（见 scripts/test-workflow-purpose.cjs）。
 */

/** 值域。加第三个用途（比如音频）时改这里，`readGeneratorKind` 与接口校验会一起跟上。 */
export const GENERATOR_KINDS = ['video', 'image'] as const;

export type GeneratorKind = (typeof GENERATOR_KINDS)[number];

/**
 * 读到一个无法识别的值（老数据、被手改过的库）时退回哪个用途。
 * 只能是 `video`：历史上所有草稿都是视频工作流。
 */
export const DEFAULT_GENERATOR_KIND: GeneratorKind = 'video';

/** 严格校验，给接口入参用 —— 客户端送来不认识的用途要**报错**，不能悄悄改成默认值。 */
export function isGeneratorKind(value: unknown): value is GeneratorKind {
  return typeof value === 'string' && (GENERATOR_KINDS as readonly string[]).includes(value);
}

/** 读取兜底，给「展示一个从库里读出来的值」用。与 `isGeneratorKind` 的区别是它不报错。 */
export function readGeneratorKind(value: unknown): GeneratorKind {
  return isGeneratorKind(value) ? value : DEFAULT_GENERATOR_KIND;
}

export function generatorKindLabel(value: unknown) {
  return readGeneratorKind(value) === 'image' ? '图片' : '视频';
}

/** 给下拉/分段控件用。放在这里是为了「有哪些用途」只有一处定义。 */
export const GENERATOR_KIND_OPTIONS: { value: GeneratorKind; label: string; hint: string }[] = [
  { value: 'video', label: '视频生成', hint: '含续接 latent、时长与帧率参数' },
  { value: 'image', label: '图片生成', hint: '含步数 / CFG / 种子 / 采样器参数' },
];

/**
 * 把用途拼成 human-readable 的短语，用于报错与提示。
 * 「图片生成工作流」这种说法比「kind=image」有用得多 —— 报错是给用户看的。
 */
export function generatorKindNoun(value: unknown) {
  return `${generatorKindLabel(value)}生成工作流`;
}
