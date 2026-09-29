'use client';

import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * 画布上那个「居中大浮层」的外壳（2026-09-21 照参考图定的形态）。
 *
 * 左轨五项（资产 / 工作流 / skill / 历史 / 设置）现在共用一个壳：
 * 一张居中偏上的大卡片，顶栏一个 ✕，左列是分类，右边是内容。
 * 之所以要抽出来：五处各写一份「Esc / 点空白关」迟早会长出五种关不掉的方式，
 * 而「关不掉」在画布上尤其难受 —— 画布自己的快捷键正在冒泡阶段等着吃键盘。
 *
 * ⚠️ 四件事别搞混：
 *
 * 1. **Esc 必须走捕获阶段**。画布的快捷键（F / L / I / Ctrl+D…）挂在 window 的冒泡阶段，
 *    浮层要是也挂冒泡，`keydown` 会被画布先吃掉一半。捕获阶段先手 + `stopPropagation()`
 *    才能真的关掉。
 *
 * 2. **两种 Esc 要让出去**：光标在输入框里时（工作流改名那个框靠 Esc 取消编辑），
 *    以及有 `<dialog open>` 时（工作流配置的「参数预览」是个 modal dialog）。
 *    这两种情况下关掉浮层等于把用户正在做的事一起收走。
 *
 * 3. **✕ 只关浮层，不跳页**。参考图顶栏那个「返回工作台」在画布里没有意义 ——
 *    用户是从画布点进来的，关掉就该回到画布（`onClose` 由外面决定做什么）。
 *
 * 4. **左列不是必须的**。`nav` 不传时内容区占满整张卡片（`solo`）：
 *    历史 / skill 没有可分的类，硬凑一列只会变成一行孤零零的字。
 */
export type CanvasOverlayNavItem = { key: string; label: string; count?: number };

export default function CanvasOverlay({
  title, kicker, note, nav, active, onNav, onClose, guard, actions, onHref, children,
}: {
  /** 内容区的大标题（顶栏那个 ✕ 旁边不写字，标题在内容区里 —— 与参考图一致）。 */
  title: string;
  /** 顶栏左侧那串小字。 */
  kicker?: string;
  /** 标题下面那句说明。 */
  note?: ReactNode;
  /** 左列分类。不传就没有左列。 */
  nav?: CanvasOverlayNavItem[];
  active?: string;
  onNav?: (key: string) => void;
  onClose: () => void;
  /**
   * 关之前问一句。返回 `false` = 不关（工作流配置有未保存改动时用它）。
   * 确认框由 `guard` 自己弹 —— 壳不替内容决定该说什么。
   */
  guard?: () => boolean;
  /** 顶栏右侧的一排东西（比如「返回列表」）。 */
  actions?: ReactNode;
  /**
   * 内容区里点到了 `/settings/...` 这类链接时的去处。
   * 那些组件（本机 ComfyUI）里写死了 `<Link href="/settings/...">`，
   * 在画布里照字面跳就是「点了设置里的一句话，画布没了」—— 所以在这里拦下来改成切页。
   */
  onHref?: (href: string) => void;
  children: ReactNode;
}) {
  /* 两个 ref 是给「不重挂监听」用的：`guard` / `onClose` 每次渲染都是新函数，
     直接进 deps 会让 window 上的监听反复摘挂。 */
  const closeRef = useRef(onClose);
  const guardRef = useRef(guard);
  closeRef.current = onClose;
  guardRef.current = guard;

  const requestClose = useCallback(() => {
    if (guardRef.current && !guardRef.current()) return;
    closeRef.current();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('dialog[open]')) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      event.stopPropagation();
      requestClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [requestClose]);

  /** 点卡片外面那一层灰。只认「点在灰上」：卡片里的点击不该被当成关。 */
  const onScrimDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    requestClose();
  };

  /** 内容区里的设置链接改成切页（见上面 onHref 的注释）。 */
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onHref) return;
    const link = (event.target as HTMLElement).closest?.('a[href^="/settings/"]');
    if (!link) return;
    event.preventDefault();
    onHref(link.getAttribute('href') || '');
  };

  return (
    <div className="cv-ov" data-cv-overlay="" onMouseDown={onScrimDown}>
      <div
        className={`cv-ov-card${nav?.length ? '' : ' solo'}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClickCapture={onClickCapture}
      >
        <div className="cv-ov-bar">
          <span className="cv-ov-kicker">{kicker ?? 'Holy Light画布'}</span>
          <div className="cv-ov-actions">{actions}</div>
          <button
            className="cv-ov-x"
            type="button"
            onClick={requestClose}
            aria-label="关闭"
            data-cv-overlay-close=""
          >
            <X size={15} strokeWidth={2} aria-hidden />
          </button>
        </div>

        {!!nav?.length && (
          <nav className="cv-ov-nav" aria-label={`${title} 分类`}>
            {nav.map(item => (
              <button
                key={item.key}
                type="button"
                className={`cv-ov-nav-item${item.key === active ? ' on' : ''}`}
                aria-current={item.key === active}
                data-cv-overlay-nav={item.key}
                onClick={() => onNav?.(item.key)}
              >
                <span>{item.label}</span>
                {typeof item.count === 'number' && <em>{item.count}</em>}
              </button>
            ))}
          </nav>
        )}

        <div className="cv-ov-main">
          <div className="cv-ov-head">
            <h2>{title}</h2>
            {note && <p className="cv-ov-note">{note}</p>}
          </div>
          <div className="cv-ov-body">{children}</div>
        </div>
      </div>
    </div>
  );
}
