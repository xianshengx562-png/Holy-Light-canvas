'use client';

/*
 * 节点卡片右上角那颗胶囊点开之后的浮层（2026-10-10 徐先）。
 *
 * 里面是**这一份工作流上造过的那些控件**：开关、数字滑块、自定义参数分类（下拉）。
 * 值存在**节点**上（`NodeData.controlValues`），所以同一份工作流挂在几个节点上各调各的。
 *
 * 🔴 **必须 `createPortal`，不能就地渲染在卡片里**（与 `ContextMenu` 那条注释同一个理由）：
 * 卡片的祖先里有 `transform`（画布缩放那一层），`transform` 会给 `position: fixed` 的后代
 * 造一个新的包含块 —— 就地渲染会按卡片定位、还会被卡片的 overflow 裁掉。
 *
 * 挂在 `.cv-stage` 而不是 `document.body`：画布那一套 `--cv-*` 令牌只定义在
 * `.canvas-studio / .flow-shell` 上（`tokens.css`），挂到 body 上会拿不到值，
 * 浮层会变成一堆没有颜色的裸控件（`DanbooruTagPicker` 早就是这么挂的）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { formatControlNumber, type CanvasControlSummary } from '@/lib/workflows/configuration';

/** 离屏幕边缘留 12px：贴边出现会让最后一项永远点不到。 */
const EDGE = 12;

export default function NodeControlsPopover({ at, title, controls, values, onChange, onClose }: {
  /** 胶囊那颗按钮的位置（视口坐标，`getBoundingClientRect()` 直接来）。 */
  at: { x: number; y: number };
  /** 浮层头顶那一行 = 调的是**哪一个节点**。一屏十几个节点，光看条目分不清对象。 */
  title: string;
  controls: CanvasControlSummary[];
  /** 这一节点上的当前值；没填的键由调用方按默认值补齐后传进来。 */
  values: Record<string, string>;
  onChange: (binding: string, value: string) => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  /*
   * 位置量完再定（与 `ContextMenu` 同一套写法）：高度取决于条目数，
   * 先画再挪会出现「先出现在界外再跳回来」那种肉眼可见的闪。
   */
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const left = Math.min(Math.max(at.x, EDGE), Math.max(EDGE, window.innerWidth - width - EDGE));
    const below = at.y + height + EDGE <= window.innerHeight;
    setPos({ left, top: below ? at.y : Math.max(EDGE, window.innerHeight - height - EDGE) });
  }, [at.x, at.y, controls.length]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onEscape);
    /*
     * 🔴 滚动即关**必须放过浮层自己内部的滚动**（2026-10-10 `DockCombo` 那个 bug 的同一条）：
     * 这个监听是**捕获**的，浮层里滚一下也会打过来 —— 一律关闭的话控件一多就翻不动。
     * 再加一层 `overscroll-behavior: contain`（在 CSS 里）：少了它，滚到底之后
     * 滚动链会穿到祖先，照样把浮层关掉。
     */
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onEscape);
      document.removeEventListener('scroll', onScroll, true);
    };

    function onEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    function onScroll(event: Event) {
      const target = event.target;
      if (target instanceof Node && boxRef.current?.contains(target)) return;
      onClose();
    }
  }, [onClose]);

  const host = typeof document !== 'undefined'
    ? (document.querySelector('.cv-stage') as HTMLElement | null) ?? document.body
    : null;
  if (!host) return null;

  return createPortal(
    /*
     * 透明遮罩：点浮层外面（画布上任何地方）就关掉。
     * **不用灰遮罩** —— 调这几个旋钮的时候常常要看着节点上的状态，糊一层灰反而挡事。
     */
    <div className="cv-ctl-mask" data-cv-ctl-mask onMouseDown={onClose}>
      <div
        ref={boxRef}
        className="cv-ctl-panel"
        role="dialog"
        aria-label={`${title} 的画布控件`}
        data-cv-ctl-panel
        style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="cv-ctl-head">
          <span className="cv-ctl-title" title={title}>{title}</span>
          <button type="button" className="cv-ctl-close" aria-label="关闭" data-cv-ctl-close onClick={onClose}>
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <div className="cv-ctl-body">
          {controls.map(item => {
            const value = values[item.binding] ?? item.value;
            if (item.kind === 'toggle')
              return (
                <label className="cv-ctl-row" key={item.binding} data-cv-ctl={item.binding}>
                  <span className="cv-ctl-name">{item.label}</span>
                  <input
                    type="checkbox"
                    className="cv-ctl-switch"
                    aria-label={item.label}
                    checked={value === 'true'}
                    onChange={event => onChange(item.binding, String(event.target.checked))}
                  />
                </label>
              );
            if (item.kind === 'slider') {
              const min = item.min ?? -1;
              const max = item.max ?? 1;
              const precision = item.precision ?? 2;
              const num = Number(value);
              const current = Number.isFinite(num) ? num : min;
              /* 步长跟着小数位走：2 位就是 0.01 —— 不设的话滑块只能停在整数上。 */
              const step = precision > 0 ? Number((10 ** -precision).toFixed(precision)) : 1;
              return (
                <div className="cv-ctl-row cv-ctl-slider" key={item.binding} data-cv-ctl={item.binding}>
                  <span className="cv-ctl-name">{item.label}</span>
                  <input
                    type="range"
                    aria-label={item.label}
                    min={min}
                    max={max}
                    step={step}
                    value={current}
                    onChange={event => onChange(item.binding, formatControlNumber(Number(event.target.value), precision))}
                  />
                  <output className="cv-ctl-read">{formatControlNumber(current, precision)}</output>
                </div>
              );
            }
            const options = item.options ?? [];
            return (
              <label className="cv-ctl-row" key={item.binding} data-cv-ctl={item.binding}>
                <span className="cv-ctl-name">{item.label}</span>
                <select
                  aria-label={item.label}
                  value={options.includes(value) ? value : ''}
                  onChange={event => onChange(item.binding, event.target.value)}
                >
                  <option value="">（不选）</option>
                  {options.map(option => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
            );
          })}
        </div>
        <p className="cv-ctl-foot">改的是这一个节点 —— 同一份工作流挂在别的节点上不受影响。</p>
      </div>
    </div>,
    host,
  );
}
