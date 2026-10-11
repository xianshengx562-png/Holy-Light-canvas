'use client';

/**
 * 画布便签（2026-10-10 徐先：「画布上可添加注释，右键添加」）。
 *
 * ⚠️ 四条做之前必须知道的事：
 *
 * 1. **它是 react-flow 的节点，但不是流程节点**。`note` 这一档在 `ACCEPTS` 里是空数组
 *    （两边都拦死：从它拉不出线，也没有别的节点能吃它），所以**注释永远不参与生成** ——
 *    这是他要的原话「不参与」落成的样子，不是忘了接线。
 *    走 nodes 这一条（而不是另开一张表）的理由很实在：拖动 / 框选 / 删除 / 撤销 /
 *    随画布一起存，全都是现成的，另开一套这些全要重写一遍。
 *
 * 2. **正文存 `noteText`，不复用 `text`**。`text` 是文本链的源（会被收进提示词），
 *    便签只是给人看的字 —— 复用它的后果是「这块注释哪天被谁连了一根线就进了提示词」。
 *
 * 3. **🔴 编辑是「草稿 + 失焦写一次」，不是边打边写**。边打边 `patch` 会把每一次按键
 *    都记进撤销栈、每一次都让画布脏一遍触发自动保存。所以这里只在**退出编辑**那一瞬间
 *    跟库里的值比一次，不一样才写。
 *    `useEffect` 的依赖**只写 `editing`**：把 `stored` 也放进去的话，
 *    刚写完库回来那一帧会把草稿重新灌一遍，光标跳到别的地儿去。
 *
 * 4. **🔴 `nodrag` / `nowheel` 必须挂在输入框上**。少了它们：在便签里拖选文字会变成
 *    「把整块便签拖走」，滚一下则把画布缩放了（`.cv-sticky-bar` 上也要挂 `nodrag`，
 *    不然点颜色那几颗小圆点会拖走便签）。
 *
 * 5. **字号存的是档位名（`noteScale`），不是像素**。像素在 `nodes.css` 里翻译成**倍率**
 *    （`calc(var(--cv-fs-3) * var(--note-fs))`）→ 全站「界面大小」滑杆一动，
 *    便签跟着整档一起缩放。写死 px 的结果是「界面 150%、便签还停在 13px」。
 *    底栏那四个「A」的字号反过来**必须写死**：它 inherit 的是便签正文字号，
 *    不写死的话把正文调成「特大」，这四个控件会跟着胀大到撑破底栏。
 */
import { useEffect, useRef, useState } from 'react';
import { NodeResizeControl } from '@xyflow/react';
import type { NodeData } from './types';
import {
  DEFAULT_NOTE_SCALE, NOTE_COLOR_LABELS, NOTE_COLORS, NOTE_SCALE_LABELS, NOTE_SCALES,
  isNoteColor, isNoteScale,
} from './nodeMeta';

/** 便签能拖到的范围（比节点卡片宽松：注释常常要写得宽一点）。 */
const NOTE_MIN_W = 150;
const NOTE_MIN_H = 80;
const NOTE_MAX_W = 900;
const NOTE_MAX_H = 900;

export default function NoteNode({ data, selected }: { data: NodeData; selected?: boolean }) {
  const [editing, setEditing] = useState(false);
  /** 编辑中的草稿；退出时才跟库里的值比一次（见文件头第 3 条）。 */
  const [draft, setDraft] = useState('');
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  const stored = String(data.noteText || '');
  const color = isNoteColor(data.noteColor) ? data.noteColor : 'amber';
  /** 老便签（1.0.126 那批）身上没有 `noteScale` —— 兜到「中」，跟当初的默认一致。 */
  const scale = isNoteScale(data.noteScale) ? data.noteScale : DEFAULT_NOTE_SCALE;
  const sizedWidth = Number(data.width) > 0 ? Math.round(Number(data.width)) : undefined;
  const sizedHeight = Number(data.height) > 0 ? Math.round(Number(data.height)) : undefined;

  useEffect(() => {
    if (!editing) return;
    setDraft(stored);
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    /* 依赖只写 `editing`：见文件头第 3 条。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== stored) data.onNoteText?.(draft);
  };

  /** 行数跟着内容长（改宽度时不用手动再调高度）。 */
  const rows = Math.max(3, draft.split('\n').length + 1);

  return (
    <div
      data-cv-sticky=""
      className={`cv-sticky${selected ? ' selected' : ''}${sizedWidth ? ' sized-w' : ''}${sizedHeight ? ' sized-h' : ''}`}
      data-note-color={color}
      data-note-scale={scale}
      style={{
        ...(sizedWidth ? { width: sizedWidth } : {}),
        ...(sizedHeight ? { height: sizedHeight } : {}),
      }}
      onDoubleClick={() => setEditing(true)}
    >
      {/* 右下角改尺寸：和节点卡片同一套回调（`data.width/height` 随画布存）。 */}
      {data.onResize && (
        <NodeResizeControl
          position="bottom-right"
          className="cv-resize"
          minWidth={NOTE_MIN_W}
          minHeight={NOTE_MIN_H}
          maxWidth={NOTE_MAX_W}
          maxHeight={NOTE_MAX_H}
          onResizeStart={() => data.onResizeBegin?.()}
          onResize={(_event, size) => data.onResize?.(Math.round(size.width), Math.round(size.height))}
          onResizeEnd={() => data.onResizeFinish?.(true)}
        >
          <span className="cv-resize-grip" aria-hidden />
        </NodeResizeControl>
      )}

      {editing ? (
        <textarea
          ref={areaRef}
          className="cv-sticky-input nodrag nowheel"
          value={draft}
          rows={rows}
          spellCheck={false}
          aria-label="便签内容"
          onChange={event => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={event => {
            /* Esc = 这次 edits 全部作废（回库里那份）；Ctrl/⌘+Enter = 收工。 */
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(stored);
              setEditing(false);
              return;
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        <div className="cv-sticky-text">
          {stored || <span className="cv-sticky-ph">双击写点什么…</span>}
        </div>
      )}

      {/*
        底栏：纸色那排小圆点 + 字号那四个「A」。平时整条藏起来（悬停或选中才显形），
        别让一块便签上永远挂九个按钮。
        🔴 `nodrag` 必须有 —— 没有它点这排圆点会把整块便签拖走。
      */}
      <div
        className="cv-sticky-bar nodrag"
        onDoubleClick={event => event.stopPropagation()}
      >
        <div className="cv-sticky-dots">
          {NOTE_COLORS.map(item => (
            <button
              key={item}
              type="button"
              data-note-dot={item}
              className={`cv-sticky-dot${item === color ? ' on' : ''}`}
              title={`纸色：${NOTE_COLOR_LABELS[item]}`}
              aria-label={`纸色 ${NOTE_COLOR_LABELS[item]}`}
              onClick={() => data.onNoteColor?.(item)}
            />
          ))}
        </div>
        <span className="cv-sticky-sep" aria-hidden />
        {/*
          字号档位：四个「A」从小到大排 —— 一眼看出是哪一档，不用读文字。
          ⚠️ 这四个按钮的字号**必须写死**（见 `nodes.css`）：它 inherit 的是便签正文字号，
          不写死的话把正文调成「特大」，这四个控件会跟着一起胀大。
        */}
        <div className="cv-sticky-scales">
          {NOTE_SCALES.map(item => (
            <button
              key={item}
              type="button"
              data-note-scale={item}
              className={`cv-sticky-A${item === scale ? ' on' : ''}`}
              title={`字号：${NOTE_SCALE_LABELS[item]}`}
              aria-label={`字号 ${NOTE_SCALE_LABELS[item]}`}
              onClick={() => data.onNoteScale?.(item)}
            >A</button>
          ))}
        </div>
      </div>
    </div>
  );
}
