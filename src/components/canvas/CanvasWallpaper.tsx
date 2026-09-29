'use client';

import { useAppearance } from '@/components/theme/ThemeProvider';

/**
 * 画布背景层。
 *
 * 垫在无限画布底下，**不参与**任何节点图层的命中与拖拽（`pointer-events: none`），
 * 也不随画布平移缩放 —— 它是「墙纸」，不是画布内容的一部分。
 *
 * 放在 React Flow 的**兄弟节点**上、用绝对定位铺满 stage，而不是塞进 `.react-flow`：
 * React Flow 内部的 transform 会作用在它的子元素上，塞进去的图会跟着一起缩放，
 * 于是「不随画布拖拽和缩放」这条就废了。
 */
export default function CanvasWallpaper() {
  const { appearance } = useAppearance();
  const wall = appearance?.wallpaper;
  if (!wall?.name || !wall.enabled) return null;

  return (
    <div
      className="cv-wallpaper"
      aria-hidden
      style={{
        /*
         * 底色用 background-color、图片用 background-image，**分开写**。
         * 用 `background` 简写会把样式表里的规则整体接管掉，画布底色与点阵都会消失 ——
         * 这个坑在 `AppearanceForm` 的预览块那里踩过一次，这里不再踩。
         *
         * 图片来源与淡化 / 模糊三个值由 `applyAppearance()` 写在 <html> 的 CSS 变量上，
         * 所以防闪脚本和这里是同一套规则，不会出现「刷新一下背景闪一下」。
         */
        backgroundImage: 'var(--cv-wall-image)',
        opacity: 'var(--cv-wall-opacity, 1)',
        filter: 'blur(var(--cv-wall-blur, 0px))',
      }}
    />
  );
}
