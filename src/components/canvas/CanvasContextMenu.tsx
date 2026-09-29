'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 画布右键菜单。
 *
 * 三份菜单，按点在什么上面分开：
 * - `global`       点在画布空白处
 * - `node-options` 点在某个节点上
 * - `add-nodes`    选节点类型（正常录入方式：右键 → 选类型）
 *
 * 结构与交互参考参考项目里那种「图标 + 文案 + 快捷键 + 分组线」的菜单，
 * 代码是照着 Holy Light画布自己的节点体系重写的 —— 菜单项只有这里一份，
 * 画布本体不掺和排版。
 */

export type CanvasMenuKind = 'global' | 'node-options' | 'add-nodes';

/** 菜单在哪、针对谁。`x / y` 是**屏幕坐标**（clientX/clientY），不是画布坐标。 */
export type CanvasMenuSpec = {
  kind: CanvasMenuKind;
  x: number;
  y: number;
  /** `node-options` 时才有：被右键的那个节点 */
  nodeId?: string;
};

export type MenuItem = {
  id: string;
  /**
   * 画在行里的文字。
   *
   * ⚠️ 可以是空串 —— 历史上有过「只有图标」的阶段（2026-09-20），2026-09-21 起
   * 「添加节点」栏写回节点名（十个符号没人看得懂，名字回来、图标当速记），
   * 但类型上仍允许空串：空串是合法写法，不是漏填。那种情况下这一行的名字要从别处来：
   * `title`（悬停）和 `ariaLabel`（屏幕阅读器）必须补上，否则「只有图标」就变成
   * 「只有一个不知道是什么的图形」。
   */
  label: string;
  icon?: ReactNode;
  /** 悬停提示。只有图标、或者需要解释为什么禁用时才给。 */
  title?: string;
  /** 无障碍名字。`label` 为空的行必须给。 */
  ariaLabel?: string;
  /** 机器可读的类型标记，落在 DOM 上给测试用（不用去猜第几个图标是什么）。 */
  dataKind?: string;
  /** 右侧灰色说明（节点类型的 tag、「不可接」这类状态） */
  note?: string;
  /** 快捷键文案，显示在最右 */
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  run?: () => void;
};

export type MenuGroup = { title?: string; items: MenuItem[] };

/** 菜单离屏幕边缘留 12px：贴边出现会让最后一项永远点不到。 */
const EDGE = 12;

export default function CanvasContextMenu({
  spec, groups, onClose,
}: {
  spec: CanvasMenuSpec;
  groups: MenuGroup[];
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);

  /* 先把可选项摊平：键盘上下键按渲染顺序走，跳过禁用的那几项。 */
  const flat = groups.flatMap(group => group.items.filter(item => !item.disabled));

  /*
   * 位置在 layout effect 里量完再定：菜单高度取决于条目数量，
   * 先用估算值会让「贴着屏幕下沿右键」时菜单先画到界外再跳回来 —— 一次肉眼可见的闪。
   * useLayoutEffect 里的 setState 会在绘制前同步刷一遍，所以看不到中间态。
   */
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const maxLeft = Math.max(EDGE, window.innerWidth - width - EDGE);
    const left = Math.min(Math.max(spec.x, EDGE), maxLeft);
    /* 放不下就往上翻：往上也要保证顶边不越界，两头都放不下时优先保顶边
       （贴着顶边至少能看见第一项，往下就什么都点不着了）。 */
    const below = spec.y + height + EDGE <= window.innerHeight;
    const top = below ? spec.y : Math.max(EDGE, window.innerHeight - height - EDGE);
    setPos({ left, top });
  }, [spec.x, spec.y, groups]);

  /* 菜单一开就把焦点收进来，否则上下键落在画布上会拖动画布。 */
  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, [onClose]);

  function move(step: number) {
    if (!flat.length) return;
    setActive(prev => {
      const next = prev + step;
      if (next < 0) return flat.length - 1;
      if (next >= flat.length) return 0;
      return next;
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); return; }
    if (event.key === 'Home') { event.preventDefault(); setActive(0); return; }
    if (event.key === 'End') { event.preventDefault(); setActive(flat.length - 1); return; }
    if (event.key === 'Tab') { event.preventDefault(); onClose(); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      const item = flat[active];
      if (!item) return;
      event.preventDefault();
      item.run?.();
    }
  }

  let groupKey = 0;

  return (
    <div className="cv-menu-mask" onMouseDown={onClose} onContextMenu={event => { event.preventDefault(); onClose(); }}>
      <div
        ref={boxRef}
        className={`cv-menu ${spec.kind}`}
        /* 位置没量出来之前先藏住，别先在原点画一帧。 */
        style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' as const }}
        role="menu"
        aria-label={spec.kind === 'node-options' ? '节点操作' : spec.kind === 'add-nodes' ? '添加节点' : '画布操作'}
        tabIndex={-1}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {groups.map(group => {
          groupKey += 1;
          if (!group.items.length) return null;
          return (
            <div className="cv-menu-group" key={groupKey}>
              {group.title && <div className="cv-menu-title">{group.title}</div>}
              {group.items.map(item => {
                const hot = !item.disabled && active >= 0 && flat[active]?.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={`cv-menu-item${item.label ? '' : ' icon-only'}${item.disabled ? ' off' : ''}${item.danger ? ' danger' : ''}${hot ? ' hot' : ''}`}
                    disabled={item.disabled}
                    /*
                     * `title` 走 `data-tip` 才能吃到画布自己那套浮层样式（`cv-tip`），
                     * 原生 title 在这里永远不显形。**但不能照抄任何一项的 data-tip**：
                     * 提示要一直挂在这一行上，所以「这一行是什么」优先
                     * （`item.title`），退而求其次才是「为什么点不了」（`item.note`）。
                     */
                    data-tip={item.title || item.note || undefined}
                    aria-label={item.ariaLabel}
                    data-kind={item.dataKind}
                    onMouseEnter={() => setActive(flat.findIndex(entry => entry.id === item.id))}
                    onClick={() => item.run?.()}
                  >
                    <span className="cv-menu-glyph">{item.icon}</span>
                    {item.label ? <span className="cv-menu-text">{item.label}</span> : null}
                    {item.shortcut && <kbd className="cv-menu-key">{item.shortcut}</kbd>}
                    {item.note && <em>{item.note}</em>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
