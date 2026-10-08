import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '@xyflow/react';
import { SlidersHorizontal, X } from 'lucide-react';
import GenerateDock from './GenerateDock';
import NodeParamBar from './NodeParamBar';
import { NodeGlyph } from './nodeIcons';
import { NODE_META, displayLabelOf, usesGenerateDock, upscaleFollowsConnection, upscaleFollowedLabel, upscaleFollowedSide } from './nodeMeta';
import type { NodeKind } from './nodeMeta';
import type { NodeData } from './types';

/**
 * 参数栏宽度（2026-10-07 徐先：「可以调整宽度，初始的宽度可以多一点」）。
 *
 * ⚠️ 存的是**逻辑值**，用的时候才乘 `--ui`（`calc(Npx * var(--ui))`）——
 *    直接存算完的 px 的话，用户之后改「界面大小」这个数就再也不跟着缩放了，
 *    而全站每个尺寸都归那一个乘数管（见 globals.css `:root` 上 `--ui` 那段）。
 * ⚠️ 首帧必须用 `DEFAULT_WIDTH`：localStorage 只有客户端读得到，
 *    直接拿它当 useState 初值会让 SSR 出来的 HTML 跟客户端第一帧对不上（注水不一致警告）。
 */
const WIDTH_KEY = 'frame.inspector-width';
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 760;

function clampWidth(v: number) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(v)));
}

export default function NodeInspector({ node, onClose, tagger }: {
  node: { id: string; data: NodeData } | null;
  onClose: () => void;
  /**
   * D站标签节点：它的「参数」**就是标签选择器本身**（2026-10-08 徐先：
   * 「这样吧，选择标签就是这个节点的参数」）。
   *
   * 由 `CanvasEditor` 组装好传进来，而不是在这里 import：那几颗回调
   * （改选择 / 重抽）都挂在画布那台状态机上，参数栏不该反过来去够它们。
   * 别的一律不传 —— 这里只负责把它摆在正文里。
   */
  tagger?: ReactNode;
}) {
  const kind = (node?.data.kind || 'text') as NodeKind;
  const follows = upscaleFollowsConnection(kind);
  const side = useStore(state => node && follows ? upscaleFollowedSide(node.id, state.nodes, state.edges) : '');
  const from = useStore(state => node && follows ? upscaleFollowedLabel(node.id, state.nodes, state.edges) : '');
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const drag = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(WIDTH_KEY);
      const v = Number(raw);
      if (raw !== null && Number.isFinite(v)) setWidth(clampWidth(v));
    } catch { /* 隐私模式读不了盘：留在默认宽度，不值得吵用户 */ }
  }, []);

  /* 拖左边缘调宽。用 pointer capture —— 鼠标拖到面板外面也不会断。
     面板在**右侧**，所以鼠标往左拖是「变宽」，位移要减。 */
  const onDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
    /* 拖动期间禁掉文本选中：不然整块面板会被刷成蓝色选区。 */
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, [width]);

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setWidth(clampWidth(d.w - (e.clientX - d.x)));
  }, []);

  const onUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 已经释放过 */ }
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    setWidth(w => {
      try { window.localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* 同上 */ }
      return w;
    });
  }, []);

  return <aside
    className="cv-inspector"
    aria-label="节点参数"
    style={{ width: `calc(${width}px * var(--ui))` }}
  >
    <div
      className="cv-inspector-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整参数栏宽度"
      title="拖动调整宽度"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
    <header className="cv-inspector-head">
      <SlidersHorizontal size={16} aria-hidden />
      <h2>节点参数</h2>
      <button className="cv-btn icon ghost" type="button" title="收起参数栏" aria-label="收起参数栏" onClick={onClose}><X size={16} /></button>
    </header>
    {node ? <>
      <div className="cv-inspector-selection">
        <NodeGlyph kind={kind} size={18} />
        <div><strong>{displayLabelOf(node.data) || NODE_META[kind].label}</strong><span>{NODE_META[kind].label}</span></div>
      </div>
      {/*
        D站标签排在最前面判：它既不是生成节点、也不吃 `NodeParamBar` 那套字段
        —— 走 `NodeParamBar` 的话参数栏里是空的（2026-10-08 徐先截图里那块）。
        `cv-inspector-content-fill`：正文这一层不滚，滚动交给面板里的列表
        （标签库 4000 条，交给正文滚会长成一条几万像素的长页）。
      */}
      {kind === 'danbooru-tags'
        ? <div className="cv-inspector-content cv-inspector-content-fill">{tagger}</div>
        : usesGenerateDock(kind)
          ? <GenerateDock key={node.id} data={node.data} nodeId={node.id} inspector />
          : kind !== 'text'
            ? <div className="cv-inspector-content"><NodeParamBar key={node.id} data={node.data} followedSide={side} followedFrom={from} /></div>
            : <div className="cv-inspector-content"><dl className="cv-inspector-facts"><dt>类型</dt><dd>文本</dd><dt>字符</dt><dd>{String(node.data.text || '').length}</dd></dl></div>}
    </> : <div className="cv-inspector-empty"><SlidersHorizontal size={28} strokeWidth={1.3} /><span>未选中节点</span></div>}
  </aside>;
}
