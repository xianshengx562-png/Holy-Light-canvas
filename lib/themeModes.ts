/* 屏幕上的「主题模式」清单（2026-09-22）。

   为什么单独一个文件：同一批模式有**两个不同的入口**，而两边的按钮长相完全不同 ——
   设置页是一排大卡（带小样、带说明），画布右下角那个浮层是一排迷你卡。
   卡片长相不一样，但「有哪几档、每档叫什么、小样什么颜色」必须是同一份：
   色值抄两遍的结果就是换皮时只改一处，两个入口画出两种深浅
   （`theme-swatch` 那段注释里记着一次同样的漏改）。

   这里只放**两块屏幕上都在用的**三档。`ThemeMode` 里还有 `'system'`，
   画布浮层刻意不给它 —— 在画布上调主题是「我现在就要把画布改个色」的动作，
   「跟随系统」会把这个动作交给操作系统，用户点完看不到任何变化，只会以为按钮坏了。 */

import type { ThemeMode } from './appearance';

export const CANVAS_THEME_MODES: { value: Exclude<ThemeMode, 'system'>; label: string; hint: string }[] = [
  { value: 'dark', label: '夜间', hint: '深色界面' },
  { value: 'light', label: '日间', hint: '浅色界面' },
];
