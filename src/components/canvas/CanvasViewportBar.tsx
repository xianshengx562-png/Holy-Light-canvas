'use client';

import { useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { HelpCircle, Map, Maximize2, Minus, Plus } from 'lucide-react';

/** 和 ReactFlow 上的 `minZoom / maxZoom` 对齐（见 CanvasEditor），滑块不要越过它们。 */
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.05;

const SHORTCUTS: { keys: string; text: string }[] = [
  { keys: '中键拖拽 / 空格拖拽', text: '平移画布' },
  { keys: '滚轮 / Ctrl+滚轮', text: '缩放' },
  { keys: 'Shift+拖拽', text: '框选多个节点' },
  { keys: 'I', text: '选中两个节点后连接' },
  { keys: 'X', text: '断开连线 · 选中节点则断它身上的' },
  { keys: '右键空白处', text: '添加节点' },
  { keys: 'Ctrl+C / Ctrl+V', text: '复制 / 粘贴节点' },
  { keys: 'Ctrl+X', text: '剪切' },
  { keys: 'Ctrl+D', text: '原地复制一份' },
  { keys: 'Del / Backspace', text: '删除选中' },
  { keys: 'F', text: '适应画布' },
  { keys: 'L', text: '自动排列' },
  { keys: 'Ctrl+S', text: '保存' },
];

/**
 * 左下角视口控制条 + 快捷键说明。
 *
 * 缩放既要有按钮也要有滑块：按钮是「点一下近一点」，滑块是「直接去某个比例」，
 * 两个动作不一样，只留一个必然有一半人别扭。
 *
 * 快捷键说明**必须**写得和实际能按的一致 —— 这也是为什么 F / L / Ctrl+S
 * 这三处快捷方式要真的接上（见 CanvasEditor 的 keydown），不是只在文案里写着好看。
 */
export default function CanvasViewportBar({
  zoom, miniMap, onToggleMiniMap,
}: {
  zoom: number;
  miniMap: boolean;
  onToggleMiniMap: () => void;
}) {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const helpOpen = pinned || hover;

  const percent = Math.round(zoom * 100);

  return (
    <div className="cv-vp">
      <div className="cv-vp-bar">
        <button
          className={`cv-vp-btn${miniMap ? ' on' : ''}`}
          type="button"
          aria-pressed={miniMap}
          aria-label="小地图"
          data-tip="小地图"
          onClick={onToggleMiniMap}
        >
          <Map size={15} strokeWidth={2} aria-hidden />
        </button>
        <div className="cv-vp-sep" />
        <button
          className="cv-vp-btn"
          type="button"
          aria-label="适应画布"
          data-tip="适应画布 · F"
          onClick={() => fitView({ duration: 300, padding: 0.2 })}
        >
          <Maximize2 size={14} strokeWidth={2} aria-hidden />
        </button>
        <div className="cv-vp-sep" />
        <button
          className="cv-vp-btn"
          type="button"
          aria-label="缩小"
          data-tip="缩小"
          onClick={() => zoomOut({ duration: 150 })}
        >
          <Minus size={14} strokeWidth={2} aria-hidden />
        </button>
        <input
          className="cv-vp-slider"
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          value={zoom}
          aria-label="画布缩放"
          onChange={event => zoomTo(Number(event.target.value), { duration: 120 })}
        />
        <button
          className="cv-vp-btn"
          type="button"
          aria-label="放大"
          data-tip="放大"
          onClick={() => zoomIn({ duration: 150 })}
        >
          <Plus size={14} strokeWidth={2} aria-hidden />
        </button>
        <span className="cv-vp-percent">{percent}%</span>
      </div>

      <div
        className="cv-vp-help-wrap"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <button
          className={`cv-vp-round${pinned ? ' on' : ''}`}
          type="button"
          aria-expanded={helpOpen}
          aria-label="快捷键说明"
          data-tip="快捷键说明"
          onClick={() => setPinned(value => !value)}
        >
          <HelpCircle size={16} strokeWidth={2} aria-hidden />
        </button>
        {helpOpen && (
          <div className="cv-vp-help" role="tooltip">
            <div className="cv-vp-help-head">画布快捷键</div>
            {SHORTCUTS.map(row => (
              <div className="cv-vp-help-row" key={row.keys}>
                <kbd>{row.keys}</kbd>
                <span>{row.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
