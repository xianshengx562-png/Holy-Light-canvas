/**
 * 首页那个大输入框（`components/start/ComposeBar.tsx`）用到的纯数据与纯函数。
 *
 * 单独一个文件、不引 `server-only`、不碰库：接口（`/api/projects/quick`）、组件和回归脚本
 * 要读的是**同一份**定义 —— 上限或示例文案写两遍，迟早漂。
 */

/*
 * 只引**类型**：`compose.ts` 要用本文件的 `PROMPT_MAX`（值），这边要用它的 `ComposeMode`（类型）。
 * 类型导入编译后会被完全擦除，所以这不构成运行时循环依赖。
 */
import type { ComposeMode } from './compose';

/**
 * 一句话的长度上限。
 * 它会被塞进 URL（`?prompt=`）带进画布，太长会撞浏览器对地址长度的限制；
 * 同时它也决定了用户能一口气丢多长的想法（再长就该用画布上的提示词节点写了）。
 */
export const PROMPT_MAX = 1200;

/**
 * 用一句话当项目名：压掉换行、截到 24 个字符。
 * 24 是列表里的显示宽度定的 —— 再长就被 CSS 截断，用户看到的和存下来的对不上。
 */
export function projectNameFromPrompt(prompt: string) {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (!flat) return '未命名项目';
  return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
}

/** 去向的值域就是 `compose.ts` 那两个 —— 首页按钮、快捷胶囊、画布 seed 必须是同一份。 */
export type QuickMode = ComposeMode;

/** 输入框下面那排快捷提示。点一下 = 切到对应去向 + 把这段示例填进输入框（用户可改）。 */
export type QuickChip = { id: string; label: string; mode: ComposeMode; text: string };

export const QUICK_CHIPS: QuickChip[] = [
  { id: 'image', label: '文生图', mode: 'image', text: '晨雾中的山谷，柔和的自然光，安静辽阔的电影感，竖版构图' },
  { id: 'video', label: '图生视频', mode: 'video', text: '霓虹雨巷，雨滴落下，镜头缓慢推近，6 秒' },
];

/** 两个去向的按钮文案只有这一处 —— 按钮和它的 title 都从这里取。 */
export const QUICK_TARGETS: Record<ComposeMode, { label: string; hint: string }> = {
  image: { label: '生成图片', hint: '新建项目并打开画布，按你选的比例与分辨率出一张图' },
  video: { label: '生成视频', hint: '新建项目并打开画布，按你选的比例、分辨率与时长出一段视频' },
};

/**
 * 未登录时的说明 —— 两个去向按钮的 title 与输入框下面那行提示共用一句。
 * 用户什么都没做错，只是还没登录，所以它不是错误文案（不要画成红色）。
 */
export const GUEST_HINT = '还没登录 —— 点上面的按钮会先去登录，登录后就能开始。';
