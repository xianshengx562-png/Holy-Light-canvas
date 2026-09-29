'use client';

/*
 * 右键菜单 —— **两页共用一份**（2026-09-26）。
 *
 * 来由：项目卡片那套右键菜单（打开 / 重命名 / 删除项目）先用起来了，资产卡片也要右键
 * （预览 / 重命名 / 删除）。菜单的**位置计算、贴边回弹、方向键上下选、Esc 关闭、点空白关闭**
 * 跟「菜单里有什么」毫无关系 —— 抄第二份就是以后两处各修各的 bug。
 *
 * ⚠️ 一律 `createPortal(…, document.body)`，**不要**图省事挂在卡片或网格里。
 * 卡片 hover 带 `transform: translateY(-2px)`，而 `transform` 会给 `position: fixed` 的后代
 * **造一个新的包含块** —— 菜单会按卡片来定位；再加上卡片自己的 `overflow: hidden`，
 * 菜单会被直接裁掉。两个坑叠一起，表现是「右键之后菜单出现在奇怪的位置或者根本不出现」。
 * 挂到 body 上两个坑一起消失，调用方也不用再记着「必须放在网格外层」这条规矩了。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import './context-menu.css';

/** 菜单离屏幕边缘留 12px：贴边出现会让最后一项永远点不到。 */
const EDGE = 12;

export type MenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** 危险操作（删除）单独一档，用危险色。 */
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
};

export function ContextMenu({ at, title, items, onClose }: {
  at: { x: number; y: number };
  /** 菜单头顶那一行 = **点的是哪一个**。一屏十几张卡，光看条目分不清对象。 */
  title?: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(0);

  /*
   * 位置在 layout effect 里量完再定：菜单高度取决于条目数量，
   * 先用估算值会让「贴着屏幕下沿右键」时菜单先画到界外再跳回来 —— 一次肉眼可见的闪。
   * 先给一颗 visibility:hidden 保证它能被量到（display:none 量出来是 0）。
   */
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const left = Math.min(Math.max(at.x, EDGE), Math.max(EDGE, window.innerWidth - width - EDGE));
    const below = at.y + height + EDGE <= window.innerHeight;
    /* 下方放不下就往上翻；两头都放不下时优先保顶边（贴顶至少能看见第一项）。 */
    setPos({ left, top: below ? at.y : Math.max(EDGE, window.innerHeight - height - EDGE) });
  }, [at.x, at.y, items.length]);

  /* 菜单一出现就接管键盘 —— 否则方向键要先用鼠标点一下才生效。 */
  useEffect(() => { boxRef.current?.focus(); }, []);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('blur', close);
    /* 窗口尺寸变了（切主题面板、拉窗口）菜单位置就失效了，直接关掉比留一个错位的菜单好。 */
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(a => (a + 1) % items.length); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(a => (a - 1 + items.length) % items.length); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const item = items[active];
      if (item && !item.disabled) item.run();
    }
  }

  return createPortal(
    <div
      className="cx-mask"
      data-cx-mask
      onMouseDown={onClose}
      onContextMenu={event => { event.preventDefault(); onClose(); }}
    >
      <div
        ref={boxRef}
        className="cx-menu"
        data-cx-menu
        role="menu"
        tabIndex={-1}
        style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {title && <div className="cx-head" title={title}>{title}</div>}
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
            className={`cx-item${item.danger ? ' danger' : ''}${active === index ? ' hot' : ''}`}
            data-cx-item={item.id}
            onMouseEnter={() => setActive(index)}
            onClick={item.run}
          >
            <span className="cx-glyph">{item.icon}</span>
            <span className="cx-text">{item.label}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 「确认一下」的对话框 —— 与菜单同一份的理由：确认框的结构、遮罩、Esc、
 * 忙碌时不许关掉这一套，两个页面要的完全一样。
 *
 * 默认**不给 Esc 关闭**：这个框只在不可逆的操作前出现（删项目 / 删资产），
 * 手一滑按到 Esc 就关掉，用户会以为「已经取消了」—— 其实什么也没发生，但下一次
 * 他再点删除时会以为上次那个确认还生效。宁可逼他点一下「取消」。
 */
export function ConfirmDialog({
  title, body, error, busy, confirmLabel = '删除', busyLabel = '正在处理…',
  danger = true, onCancel, onConfirm, testId,
}: {
  title: string;
  body?: ReactNode;
  error?: string | null;
  busy?: boolean;
  confirmLabel?: string;
  busyLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** 给探针用的稳定标识（`data-cx-confirm`）。 */
  testId?: string;
}) {
  return createPortal(
    <div
      className="cx-confirm-mask"
      data-cx-confirm-mask
      onMouseDown={() => { if (!busy) onCancel(); }}
    >
      <div
        className="cx-confirm"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-cx-confirm={testId ?? ''}
        onMouseDown={event => event.stopPropagation()}
      >
        <h3>{title}</h3>
        {body}
        {error && <p className="cx-confirm-error" role="alert" data-cx-confirm-error>{error}</p>}
        <div className="cx-confirm-actions">
          <button className="subtle" type="button" data-cx-confirm-cancel disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            className={danger ? 'button danger' : 'button'}
            type="button"
            data-cx-confirm-ok
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
