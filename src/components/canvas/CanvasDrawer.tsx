'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * 画布右侧的抽屉外壳。浏览器与 Codex 两个侧栏共用它 ——
 * 两处的形状完全一样（一条头 + 一块内容区，从右边滑出来），
 * 分开写两份只会让它们的动画和层级慢慢长歪。
 *
 * 四条刻意的取舍：
 *
 * 1. **不用遮罩。** 抽屉的目的是「边看画布边用它」，盖一层灰的等于把画布废掉 ——
 *    内置浏览器的核心价值就是「不切出去找参考图」，Codex 那边更是要看着画布改。
 * 2. **进出场交给 CSS animation，不用「先渲染在屏幕外、下一帧加 class」那一套。**
 *    那一套要等 `requestAnimationFrame` 把状态翻过来，而**窗口被遮挡 / 最小化时 rAF 不来** ——
 *    抽屉就永远停在屏幕外（DOM 在、`data-drawer-open` 是 0、用户什么都看不见）。
 *    animation 从 `translateX(100%)` 起跳，元素本身就在终点位置上，不依赖任何一帧回调。
 * 3. **内容延迟卸载（240ms）。** 关闭动画要放完再拆内容：
 *    内置浏览器那块内容一卸载，主进程就会把网页视图收掉，
 *    提前卸载的话用户看到的是「抽屉还在往外滑，网页先没了」。
 * 4. **Esc 走捕获阶段。** 画布自己有一堆快捷键，冒泡阶段的 Esc 会被它们先吃掉。
 */
/** 拖边缘改宽度时的上下限。窄到 360 就没法当网页看了，宽到屏幕的 80% 画布就剩一条缝。 */
const MIN_WIDTH = 360;
const MAX_WIDTH = 1200;

export default function CanvasDrawer({
  open,
  title,
  icon,
  width = 440,
  name,
  resizable = false,
  onResize,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  icon?: ReactNode;
  /** 抽屉宽度（px）。浏览器和对话需要的宽度不一样，交给调用方定。 */
  width?: number;
  /** 给 e2e 用的钩子名，落在 `data-drawer` 上。 */
  name: string;
  /** 左边缘可拖着改宽度。**只有给了 `onResize` 才真的可拖** —— 不给就是固定宽。 */
  resizable?: boolean;
  onResize?: (width: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  /** 动画期间内容还要在，所以「挂载」比「打开」晚一步收。 */
  const [mounted, setMounted] = useState(open);
  /** 正在放关闭动画。放完才卸载内容（见上面第 3 条）。 */
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setClosing(false);
      setMounted(true);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, 240);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      /* 焦点在输入框里时 Esc 是「取消这一次改名」，不是「关掉这块面板」。
         捕获阶段接的，冒泡阶段再 stopPropagation 已经晚了 —— 只能在这儿挡。 */
      if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.stopPropagation();
      onClose();
    };
    /* 捕获阶段：画布的快捷键在冒泡阶段，这儿不截会被它们先吃掉。 */
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  /*
   * 拖左边缘改宽度。
   *
   * 用 pointer events + `setPointerCapture` 而不是 mousemove：指针**移出抽屉、移到画布上**
   * 是常态（改宽就是要往左拖），没有 capture 的话事件在离开那一瞬间就断了，宽度会卡住。
   *
   * 宽度按 `startX - clientX` 增量算（而不是直接把 clientX 当右边界）：
   * 抽屉是右贴边的，往左拖 = 变宽。
   */
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const onGripDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizable || !onResize || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [onResize, resizable, width]);

  const onGripMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || !onResize) return;
    const next = state.startWidth + (state.startX - event.clientX);
    onResize(Math.round(Math.min(Math.max(next, MIN_WIDTH), MAX_WIDTH)));
  }, [onResize]);

  const onGripUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    /* 拖完把 capture 放掉，否则后续普通的点击也会被这个把手吃掉。 */
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  if (!mounted) return null;

  return (
    <div
      className={`cv-drawer${closing ? ' closing' : ''}`}
      style={{ width }}
      data-drawer={name}
      data-drawer-open={closing ? '0' : '1'}
      role="dialog"
      aria-label={title}
    >
      {resizable && onResize && (
        /*
         * 把手是**抽屉内的第一个元素**且绝对定位在左边缘：它压在内容上，
         * 但只有 6px 宽 —— 网页视图那一块盖在上面，真正能点到的是它露出来的那条边。
         * `data-drawer-grip` 给 e2e 用。
         */
        <div
          className="cv-drawer-grip"
          data-drawer-grip={name}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整宽度"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
        />
      )}
      <div className="cv-drawer-head">
        <span className="cv-drawer-title">
          {icon}
          {title}
        </span>
        <button
          className="cv-drawer-close"
          type="button"
          aria-label={`关闭${title}`}
          data-tip="关闭"
          data-drawer-close={name}
          onClick={onClose}
        >
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
      <div className="cv-drawer-body">{children}</div>
    </div>
  );
}
