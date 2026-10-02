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
  /**
   * 内置分类的值，或**用户自建分类的名字**（2026-10-01）。
   * 这里刻意不写死成枚举联合：下拉、筛选条、保存路径都要能装下自建分类，
   * 而它的取值不是编译期能知道的集合。
   */
  value: string;
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
  /*
   * 音频（2026-10-02）也列进前三档：不列的话 `categoriesFor('audio')` 是**空数组**，
   * 配置页那个分类下拉一个选项都没有 —— 一份音频工作流根本存不下来。
   * 后两档（视频参考 / 音频 + 多图）仍然只属于视频。
   */
  { value: 'none', label: '无参考', hint: '只有提示词，不喂任何参考素材', kinds: ['video', 'image', 'audio'] },
  { value: 'single', label: '单图参考', hint: '一张参考图（角色 / 场景）', kinds: ['video', 'image', 'audio'] },
  { value: 'multi', label: '多图参考', hint: '多张参考图，画布上最多九张', kinds: ['video', 'image', 'audio'] },
  { value: 'video-ref', label: '视频参考', hint: '拿一段视频当参考', kinds: ['video'] },
  { value: 'audio-multi', label: '音频 + 多图参考', hint: '一条音频配上多张参考图', kinds: ['video'] },
];

/** 用户自建分类的一项。`count` = 有多少份工作流归在它下面。 */
export type WorkflowCategoryItem = { id: string; name: string; count: number };

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
 *
 * 🔴 2026-10-01 起**返回值不再限于内置那五个**：用户自建的分类（`WorkflowCategoryItem` 表）
 * 存进 `WorkflowDraft.category` 的也是名字本身，所以**认不出来的值要原样保留**。
 * 原来那句「不认识就退回 `none`」会把用户刚起的分类名悄悄吃掉 —— 他要的正是
 * 「分类我自己能加」，加完一读就没了，比不给这个功能更糟。
 * 内置值与用途的配对检查照旧（自定义分类不绑用途，它对哪个用途都成立）。
 */
export function readWorkflowCategory(value: unknown, kind: unknown = DEFAULT_GENERATOR_KIND): string {
  if (typeof value !== 'string') return DEFAULT_WORKFLOW_CATEGORY;
  const name = value.trim();
  if (!name) return DEFAULT_WORKFLOW_CATEGORY;
  if (!isWorkflowCategory(name)) return name;
  return categoriesFor(kind).some(item => item.value === name) ? name : DEFAULT_WORKFLOW_CATEGORY;
}

/** 用户自建分类的名字上限。与资产分类（`CATEGORY_NAME_MAX`）保持同一个量级。 */
export const WORKFLOW_CATEGORY_NAME_MAX = 20;

/**
 * 清洗用户输入的分类名。**先清再判**：两端空白会让「我的分类」和「我的分类 」变成两个分类，
 * 而界面上它们一模一样，删都删不干净。内部空白保留（「角色 参考」是合理的写法）。
 */
export function normalizeWorkflowCategoryName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 这是个能用的自定义分类名吗。
 *
 * 🔴 **内置那五个也要拒绝**，而且要**两个字段都拒**：
 *  - 值（`none` / `multi` / …）—— 撞了值，之后分不清这条工作流走的是哪一套规则；
 *  - 显示名（无参考 / 单图参考 / …）—— 用户看到的就是这个名字，起一个同名分类，
 *    筛选条上会出现两个一样的 chip，他永远分不清点的是哪个。
 * （第一版只挡了值，`isWorkflowCategoryName('无参考')` 放过去了 —— 单测当场抓出来。）
 */
export function isWorkflowCategoryName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value || value.length > WORKFLOW_CATEGORY_NAME_MAX) return false;
  if (isWorkflowCategory(value)) return false;
  return !WORKFLOW_CATEGORY_OPTIONS.some(item => item.label === value);
}
