'use client';

/*
 * 图片分割 / 拼接。
 *
 * 两个动作合成一个工具，因为它们是同一件事的两头：**把一张大图拆成几块**，
 * 和**把几块拼回一张**。跑图的工作流常常两头都要 —— 分块出图再拼回来，
 * 中间那步不在 Holy Light画布里，所以别把它们做成两个互不相干的入口。
 *
 * 全程浏览器算：见 `src/lib/image-tools.ts` 文件头的三条约定。
 * 主进程只在最后「存进资产库」那一步露面（`/api/tools/archive`）。
 *
 * ⚠️ 预览是**等比缩放后的 div**，格线用百分比叠上去，不是把原图画进 canvas ——
 * 一张 8K 图每调一次行列数就重解码一次的话，拖数字输入时会明显卡顿。
 */
import { useEffect, useMemo, useState } from 'react';
import { Columns2, Rows2, Scissors, Combine, Loader2 } from 'lucide-react';
import ToolShell from '@/components/tools/ToolShell';
import ToolResult, { type ToolOutput } from '@/components/tools/ToolResult';
import OutputOptions from '@/components/tools/OutputOptions';
import {
  formatBytes,
  sliceBounds,
  sliceImage,
  stitchImages,
  type Background,
  type ImageFormat,
  type StitchAlign,
  type StitchDirection,
} from '@/lib/image-tools';

type Mode = 'slice' | 'stitch';
type Source = { file: File; url: string; width: number; height: number };

/** 行列上限：再往上，切出来的格子自己就是一张需要再切的图，没有意义。 */
const MAX_SIDE = 12;
/** 与后端 `/api/tools/archive` 的 maxFiles 对齐，超了这个数存不下去，早点说。 */
const MAX_PIECES = 60;

const PRESETS: { rows: number; cols: number; label: string }[] = [
  { rows: 1, cols: 2, label: '1 × 2' },
  { rows: 2, cols: 2, label: '2 × 2' },
  { rows: 2, cols: 3, label: '2 × 3' },
  { rows: 3, cols: 3, label: '3 × 3' },
];

const ALIGNS: { value: StitchAlign; label: string }[] = [
  { value: 'start', label: '顶/左对齐' },
  { value: 'center', label: '居中' },
  { value: 'end', label: '底/右对齐' },
];

export default function SplitterTool() {
  const [mode, setMode] = useState<Mode>('slice');

  const [source, setSource] = useState<Source | null>(null);
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(2);
  const [format, setFormat] = useState<ImageFormat>('png');
  const [quality, setQuality] = useState(0.92);
  const [outputs, setOutputs] = useState<ToolOutput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [first, setFirst] = useState<Source | null>(null);
  const [second, setSecond] = useState<Source | null>(null);
  const [direction, setDirection] = useState<StitchDirection>('horizontal');
  const [align, setAlign] = useState<StitchAlign>('center');
  const [gap, setGap] = useState(0);
  const [background, setBackground] = useState<Background>('transparent');

  /* 三个来源都要「选文件 → 预览地址」这一步，抽成一个函数，避免有一处忘了回收地址。 */
  function pick(file: File | null | undefined): Source | null {
    if (!file) return null;
    return { file, url: URL.createObjectURL(file), width: 0, height: 0 };
  }

  const pieces = rows * cols;
  const tooMany = mode === 'slice' && pieces > MAX_PIECES;

  /*
   * 预览地址要在换图时回收，否则每换一张就多留一份完整字节在内存里。
   *
   * ⚠️ 依赖必须是 `?.url` 而不是整个对象：图片加载完成后还要往 source 上补宽高，
   * 那时对象变了、地址没变 —— 依赖写整个对象就会把正在显示的那个地址回收掉，
   * 预览图当场变成一张裂图。所以这里盯的是「地址本身发生变化」这一件事。
   */
  useEffect(() => {
    const current = source;
    return () => {
      if (current) URL.revokeObjectURL(current.url);
    };
  }, [source?.url]);
  useEffect(() => {
    const current = first;
    return () => {
      if (current) URL.revokeObjectURL(current.url);
    };
  }, [first?.url]);
  useEffect(() => {
    const current = second;
    return () => {
      if (current) URL.revokeObjectURL(current.url);
    };
  }, [second?.url]);

  const grid = useMemo(() => {
    if (!source || !source.width) return null;
    return {
      xs: sliceBounds(source.width, cols).map((value) => (value / source.width) * 100),
      ys: sliceBounds(source.height, rows).map((value) => (value / source.height) * 100),
    };
  }, [source, rows, cols]);

  async function runSlice() {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sliceImage({ file: source.file, rows, cols, format, quality });
      setOutputs(
        result.map((piece) => ({
          key: piece.name,
          name: piece.name,
          blob: piece.blob,
          note: `${piece.width}×${piece.height} · ${formatBytes(piece.blob.size)}`,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '切分失败。');
      setOutputs([]);
    } finally {
      setBusy(false);
    }
  }

  async function runStitch() {
    if (!first || !second) return;
    setBusy(true);
    setError(null);
    try {
      const result = await stitchImages({ first: first.file, second: second.file, direction, align, gap, background, format, quality });
      setOutputs([
        { key: result.name, name: result.name, blob: result.blob, note: `${result.width}×${result.height} · ${formatBytes(result.blob.size)}` },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '拼接失败。');
      setOutputs([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ToolShell
      active="splitter"
      eyebrow="IMAGE SPLITTER"
      title="图片分割"
      intro="把一张图按网格切开，或把两张拼成一张"
      tabs={
        <nav className="settings-tabs tool-tabs" aria-label="工具模式">
          <button className={mode === 'slice' ? 'active' : undefined} type="button" onClick={() => setMode('slice')}>
            <Scissors size={14} aria-hidden /> 分割
          </button>
          <button className={mode === 'stitch' ? 'active' : undefined} type="button" onClick={() => setMode('stitch')}>
            <Combine size={14} aria-hidden /> 拼接
          </button>
        </nav>
      }
    >
      {mode === 'slice' ? (
        <section className="tool-panel">
          <div className="tool-pane">
            <label className="tool-drop">
              <input
                type="file"
                accept="image/*"
                data-tool-input="slice-file"
                onChange={(event) => setSource(pick(event.target.files?.[0]))}
              />
              <span className="tool-drop-icon"><Scissors size={22} strokeWidth={1.4} aria-hidden /></span>
              <strong>{source ? source.file.name : '选一张要切开的图'}</strong>
              <small className="muted">PNG、JPEG、WebP 都行，地址不变图不被改动</small>
            </label>

            {source && (
              <div className="tool-preview" data-tool-preview={source.width ? 'ready' : 'loading'}>
                <img
                  src={source.url}
                  alt={source.file.name}
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    /* 只会回调一次回调里改 state：宽高只有看图才知道，而格线要靠它算百分比。 */
                    setSource((prev) => (prev && prev.url === source.url ? { ...prev, width: image.naturalWidth, height: image.naturalHeight } : prev));
                  }}
                />
                {grid && (
                  <div className="tool-preview-grid" aria-hidden>
                    {grid.xs.map((x) => (
                      <i key={`v${x}`} style={{ left: `${x}%`, top: 0, bottom: 0, width: 1 }} />
                    ))}
                    {grid.ys.map((y) => (
                      <i key={`h${y}`} style={{ top: `${y}%`, left: 0, right: 0, height: 1 }} />
                    ))}
                  </div>
                )}
              </div>
            )}
            {source?.width ? (
              <p className="tool-meta">
                原图 {source.width} × {source.height} · 切成 {pieces} 格 · 每格约{' '}
                {Math.floor(source.width / cols)} × {Math.floor(source.height / rows)}
              </p>
            ) : null}
          </div>

          <div className="tool-pane">
            <div className="tool-row">
              <label className="field">
                <span>行</span>
                <input type="number" min={1} max={MAX_SIDE} value={rows} data-tool-input="rows" onChange={(e) => setRows(clampSide(e.target.value))} />
              </label>
              <label className="field">
                <span>列</span>
                <input type="number" min={1} max={MAX_SIDE} value={cols} data-tool-input="cols" onChange={(e) => setCols(clampSide(e.target.value))} />
              </label>
            </div>
            <div className="assets-chips">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  className={`assets-chip${rows === preset.rows && cols === preset.cols ? ' active' : ''}`}
                  type="button"
                  onClick={() => {
                    setRows(preset.rows);
                    setCols(preset.cols);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <OutputOptions format={format} onFormat={setFormat} quality={quality} onQuality={setQuality} />

            {tooMany && <p className="error">一次最多存 {MAX_PIECES} 张，现在是 {pieces} 格 —— 存的时候会被拦下来。</p>}
            {error && <p className="error">{error}</p>}

            <button className="button" type="button" disabled={!source || busy || tooMany} onClick={runSlice} data-tool-run="slice">
              {busy ? <Loader2 className="asset-spin" size={14} aria-hidden /> : <Rows2 size={14} aria-hidden />}
              切成 {pieces} 格
            </button>
          </div>
        </section>
      ) : (
        <section className="tool-panel">
          <div className="tool-pane">
            <ToolSource inputKey="stitch-a" label="左边的图（先放）" value={first} onChange={setFirst} pick={pick} hint="水平拼接时它在左，垂直拼接时它在上" />
            <ToolSource inputKey="stitch-b" label="右边的图（后放）" value={second} onChange={setSecond} pick={pick} hint="水平拼接时它在右，垂直拼接时它在下" />
          </div>
          <div className="tool-pane">
            <div className="field">
              <span>方向</span>
              <div className="assets-chips">
                <button className={`assets-chip${direction === 'horizontal' ? ' active' : ''}`} type="button" onClick={() => setDirection('horizontal')}>
                  <Columns2 size={13} aria-hidden /> 左右
                </button>
                <button className={`assets-chip${direction === 'vertical' ? ' active' : ''}`} type="button" onClick={() => setDirection('vertical')}>
                  <Rows2 size={13} aria-hidden /> 上下
                </button>
              </div>
            </div>
            <div className="field">
              <span>两张不一样大时</span>
              <div className="assets-chips">
                {ALIGNS.map((item) => (
                  <button key={item.value} className={`assets-chip${align === item.value ? ' active' : ''}`} type="button" onClick={() => setAlign(item.value)}>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>中间留出的空隙（像素）</span>
              <input type="number" min={0} max={200} value={gap} data-tool-input="gap" onChange={(e) => setGap(Math.max(0, Math.min(200, Number(e.target.value) || 0)))} />
            </label>
            <div className="field">
              <span>空隙填上什么颜色</span>
              <div className="assets-chips">
                {(['transparent', 'white', 'black'] as Background[]).map((item) => (
                  <button key={item} className={`assets-chip${background === item ? ' active' : ''}`} type="button" onClick={() => setBackground(item)}>
                    {item === 'transparent' ? '透明' : item === 'white' ? '白' : '黑'}
                  </button>
                ))}
              </div>
            </div>

            <OutputOptions format={format} onFormat={setFormat} quality={quality} onQuality={setQuality} />

            {error && <p className="error">{error}</p>}
            <button className="button" type="button" disabled={!first || !second || busy} onClick={runStitch} data-tool-run="stitch">
              {busy ? <Loader2 className="asset-spin" size={14} aria-hidden /> : <Combine size={14} aria-hidden />}
              拼成一张
            </button>
          </div>
        </section>
      )}

      <ToolResult outputs={outputs} emptyHint="还没有产出：左边选图、右边调好参数，点上面的按钮开始。" onReset={() => setOutputs([])} />
    </ToolShell>
  );
}

function clampSide(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_SIDE, Math.round(value)));
}

function ToolSource({
  inputKey,
  label,
  value,
  onChange,
  pick,
  hint,
}: {
  /** 给端到端脚本固定的钩子：**不能用 label** —— 文案一改，断言就找不到这个输入框了。 */
  inputKey: string;
  label: string;
  value: Source | null;
  onChange: (value: Source | null) => void;
  pick: (file: File | null | undefined) => Source | null;
  hint: string;
}) {
  return (
    <label className="tool-drop">
      <input type="file" accept="image/*" data-tool-input={inputKey} onChange={(event) => onChange(pick(event.target.files?.[0]))} />
      <span className="tool-drop-icon"><Combine size={20} strokeWidth={1.4} aria-hidden /></span>
      <strong>{value ? value.file.name : label}</strong>
      <small className="muted">{value ? formatBytes(value.file.size) : hint}</small>
    </label>
  );
}
