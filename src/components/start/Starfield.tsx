'use client';
import { useEffect, useRef } from 'react';
import '@/app/starfield.css';

/**
 * 首页背景的装饰层。
 *
 * 视觉：四层叠出来 —— 网格（细发丝线，密 + 疏两层）→ 斜切结构块 → 颗粒噪点 → 暗角。
 * 交互：鼠标移动时网格层轻微位移（视差）。
 *
 * ⚠️ 2026-09-19 从「星空」改成了「工业底纹」（用户指定 ak.hypergryph.com 那套语言）。
 * 组件名与文件名都还叫 Starfield / starfield.*，**是故意不改的**：
 *   - `.run-*.py` 里有一条守卫按这个路径检查「组件样式零裸色值」；
 *   - `home.css` 与 `globals.css` 的注释都引用了它。
 * 改名要同时动这三处，收益只是一个更贴切的名字 —— 不值。想改就一起改。
 * 图层从五层变成四层：星云与星点被网格与斜切块取代（`.starfield-nebula` /
 * `.starfield-stars-*` 这些类**已经不存在了**，别再照着旧代码往 JSX 里加）。
 *
 * ⚠️ 原先这里并排还有一个「光标波纹」（划过就在光标处荡开一圈光环），
 * 按用户要求已移除。**别再顺手加回来** —— 源码与样式里都留了反向断言盯着它。
 *
 * 三条不能动的约定：
 *   - `aria-hidden` + `pointer-events: none`：它是纯装饰。读屏软件不该念它；
 *     更要紧的是这一层盖满整个视口，**一旦能吃到点击，首页所有按钮就全点不动了** ——
 *     这个错在界面上看着像「按钮坏了」，很难往背景上想。
 *   - ⚠️ 正因为 `pointer-events: none`，**它自己一个事件都收不到**，所以交互的监听
 *     挂在 `window` 上（`pointermove`），而不是挂在自身上。想「顺手把监听挂到图层上」
 *     是这里最容易写错的一步：写上去不报错、只是永远不触发。
 *   - 色值只在 `app/globals.css` 的 `:root` / `:root[data-theme='light']` 两处定义，
 *     这里一律 `var()` 引用。组件样式零裸色值那条守卫盯着 `starfield.css`。
 *
 * ⚠️ 它**不能当 `.shell` 的直接子元素**。`.shell` 是 `grid-template-columns: 248px 1fr`
 * 的两列网格，多一个直接子元素就会多出一整行、把整页版式顶歪。现在挂在 `.workspace` 里，
 * 只因为那儿是个普通块级容器 —— 它本身是 `position: fixed`，脱离文档流，
 * 既不参与那个网格、也不影响任何兄弟节点的位置。
 */

export default function Starfield() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    /*
     * 「减少动态效果」是用户的明确要求，不是建议：这时候**连监听都不装** ——
     * 装了也只是白算一遍。动画那边另有 `globals.css` 末尾的全局兜底会停掉。
     */
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frame = 0;
    let offsetX = 0;
    let offsetY = 0;

    /* 位移只写进 CSS 变量，真正的 transform 在 CSS 里算（见 starfield.css 第 5 节）。 */
    const commit = () => {
      frame = 0;
      root.style.setProperty('--sf-px', offsetX.toFixed(3));
      root.style.setProperty('--sf-py', offsetY.toFixed(3));
    };

    /* 一帧只写一次：pointermove 一秒能来上百个，直接改样式会把主线程塞满。 */
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(commit);
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return; // 触摸设备上这层只会变成负担

      /* 视口中心为 0、边缘为 ±1。取反 = 「镜头朝鼠标的反方向偏」，
         和真实视差一致（眼睛往右看，远处的景往左移）。 */
      offsetX = -((event.clientX / window.innerWidth) * 2 - 1);
      offsetY = -((event.clientY / window.innerHeight) * 2 - 1);
      schedule();
    };

    /* 指针离开窗口就把底纹收回原位，否则会一直保持一个歪掉的角度。 */
    const recenter = () => {
      offsetX = 0;
      offsetY = 0;
      schedule();
    };

    /* ⚠️ 挂 window，不是挂 root —— 见上面第二条约定。 */
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('mouseleave', recenter);

    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('mouseleave', recenter);
      if (frame) cancelAnimationFrame(frame);
      root.style.removeProperty('--sf-px');
      root.style.removeProperty('--sf-py');
    };
  }, []);

  return <div className="starfield" ref={rootRef} aria-hidden>
    <span className="starfield-layer starfield-mesh" />
    <span className="starfield-layer starfield-shards" />
    <span className="starfield-layer starfield-grain" />
    <span className="starfield-layer starfield-vignette" />
  </div>;
}
