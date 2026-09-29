'use client';

import { createPortal } from 'react-dom';
import { useAppearance } from '@/components/theme/ThemeProvider';

/**
 * 全站背景图（用户自己上传的那一张）。
 *
 * 两层：**图**在下、**薄雾**在上，都固定铺满视口、都不吃事件（`pointer-events: none`）。
 * 薄雾那层不是装饰 —— 挑一张很花的图时，正文压在上面会读不清；它用 `--bg` 掺透明
 * 铺一层，把画面对比度压下来，文字照旧是主题自己的颜色。
 *
 * ⚠️ 用 portal 挂到 `<body>` 直属，**不能**挂在当前组件的位置：
 * 这两层靠 `z-index: -1 / -2` 压在内容下面，而负 z-index 只对**最近的层叠上下文**生效 ——
 * 挂在 React 根里的话，根容器（或中间任何一层有 transform / filter 的祖先）会把它
 * 关在自己的背景之上，图就永远看不见了。挂到 body 上，上面就只有页面内容。
 *
 * 图片地址与淡化 / 模糊由 `applyAppearance()` 写在 `<html>` 的变量上（`--app-wall-*`），
 * 所以首帧（防闪脚本）和这里是同一套规则，不会刷新时闪一下。
 */
export default function SiteBackground() {
  const { appearance } = useAppearance();
  /* 没读到偏好（首帧 / SSR）或没有图时都不渲染 —— 连空 div 都不留。 */
  if (typeof document === 'undefined') return null;
  const wall = appearance?.siteWallpaper;
  if (!wall?.name || !wall.enabled) return null;

  return createPortal(
    <>
      <div className="app-wall-layer" aria-hidden />
      <div className="app-wall-veil" aria-hidden />
    </>,
    document.body,
  );
}
