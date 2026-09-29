/**
 * 工作流的「分类」—— 这份工作流吃什么样的参考输入。
 *
 * 用途（`purpose.ts` 的 video / image）回答的是「产出什么」，分类回答的是「喂什么进去」。
 * 两者叠起来才够用：同样是视频生成工作流，「只吃提示词」和「要喂九张参考图 + 一条音频」
 * 在画布上是完全不同的用法 —— 混在一个下拉里挑，选中的那份缺了它要的输入位，
 * 症状又是这套 UI 一直在防的那种：任务成功、参数被静默丢掉。
 *
 * 与用途同一个套路，**刻意不推断、必须显式标注**：想从「配置里启用了哪些绑定」倒推出分类
 * 看起来聪明，但分类说的是这份工作流**支持**什么，而配置说的是用户**启用了**什么 ——
 * 一份支持多图参考的工作流没人给它启用那些字段，就会被推成「无参考」。
 *
 * 这个文件同样**不引 `server-only`、不碰数据库**：接口校验、页面下拉、回归脚本都要用同一份。
 */

import { DEFAULT_GENERATOR_KIND, readGeneratorKind, type GeneratorKind } from './purpose';

/** 值域。加分类时改这里，接口校验、下拉选项、回归断言会一起跟上。 */
export const WORKFLOW_CATEGORIES = ['none', 'single', 'multi', 'video-ref', 'audio-multi'] as const;

export type WorkflowCategory = (typeof WORKFLOW_CATEGORIES)[number];

/** 读到一个认不出的值（老数据、被手改过的库）时退回的分类。 */
export const DEFAULT_WORKFLOW_CATEGORY: WorkflowCategory = 'none';

export type WorkflowCategoryOption = {
  value: WorkflowCategory;
  label: string;
  hint: string;
  /** 这个分类对哪些用途成立。**分类不是全局的**：出图工作流不会拿视频当参考。 */
  kinds: GeneratorKind[];
};

/**
 * 给下拉与筛选用。放在这里是为了「有哪些分类、各属于哪些用途」只有一处定义 ——
 * 配置页、列表页、服务端校验都从这里取，谁也不许自己列一份。
 */
export const WORKFLOW_CATEGORY_OPTIONS: WorkflowCategoryOption[] = [
  { value: 'none', label: '无参考', hint: '只有提示词，不喂任何参考素材', kinds: ['video', 'image'] },
  { value: 'single', label: '单图参考', hint: '一张参考图（角色 / 场景）', kinds: ['video', 'image'] },
  { value: 'multi', label: '多图参考', hint: '多张参考图，画布上最多九张', kinds: ['video', 'image'] },
  { value: 'video-ref', label: '视频参考', hint: '拿一段视频当参考', kinds: ['video'] },
  { value: 'audio-multi', label: '音频 + 多图参考', hint: '一条音频配上多张参考图', kinds: ['video'] },
];

/** 严格校验，给接口入参用 —— 客户端送来不认识的分类要**报错**，不能悄悄改成默认值。 */
export function isWorkflowCategory(value: unknown): value is WorkflowCategory {
  return typeof value === 'string' && (WORKFLOW_CATEGORIES as readonly string[]).includes(value);
}

export function workflowCategoryOption(value: unknown): WorkflowCategoryOption | undefined {
  return WORKFLOW_CATEGORY_OPTIONS.find(item => item.value === value);
}

export function workflowCategoryLabel(value: unknown) {
  return workflowCategoryOption(value)?.label ?? workflowCategoryOption(DEFAULT_WORKFLOW_CATEGORY)!.label;
}

/**
 * 某个用途下可选的分类。
 * 用途本身也兜一层底：手改过的库里可能存着第三种用途，那样至少还能列出一份不会崩的选项。
 */
export function categoriesFor(kind: unknown): WorkflowCategoryOption[] {
  const resolved = readGeneratorKind(kind);
  return WORKFLOW_CATEGORY_OPTIONS.filter(item => item.kinds.includes(resolved));
}

/**
 * 读取兜底，给「展示一个从库里读出来的值」用。**它同时管住「分类和用途对不上」这种情况**：
 * 一份标着「视频参考」的草稿被改成了图片用途，读出来的分类必须退回去，
 * 否则列表页会显示一个这个用途下根本选不到的分类。
 */
export function readWorkflowCategory(value: unknown, kind: unknown = DEFAULT_GENERATOR_KIND): WorkflowCategory {
  if (!isWorkflowCategory(value)) return DEFAULT_WORKFLOW_CATEGORY;
  return categoriesFor(kind).some(item => item.value === value) ? value : DEFAULT_WORKFLOW_CATEGORY;
}
