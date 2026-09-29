'use client';

/*
 * 人脸马赛克 / 手动框选打码。
 *
 * YUH Studio 那边是 `mosaic` 和 `manualMosaic` 两个入口，这里合成一个页面：
 * 选完图**自动跑一遍检测**，给出候选框，用户可以在画面上**直接拖一块**补上去，
 * 也可以把误检的框去掉。分成两个入口反而更麻烦 —— 自动检测从来不能一次就准，
 * 「自动给候选 + 手动能改」本来就该是同一件事的两半（详见 `src/lib/mosaic.ts` 文件头第 1 条）。
 *
 * ⚠️ 框的坐标是**原图像素**，不是预览里的像素。预览上一切用百分比换算 ——
 * 一张 4000px 的图在预览里只有 600px 宽，拿预览坐标去打码会打到完全错的地方。
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Eraser, ScanFace, ShieldOff, Loader2 } from 'lucide-react';
import ToolShell from '@/components/tools/ToolShell';
import ToolResult, { type ToolOutput } from '@/components/tools/ToolResult';
import OutputOptions from '@/components/tools/OutputOptions';
import { baseName, formatBytes, type ImageFormat } from '@/lib/image-tools';
import { MOSAIC_STYLES, applyMosaic, clampBox, detectFaces, type MosaicBox, type MosaicStyle } from '@/lib/mosaic';

type Source = { file: File; url: string; width: number; height: number };
/** `manual` 用来区分「检测出来的」和「自己拖的」：重新检测时只替换前者。 */
type Tracked = { id: string; box: MosaicBox; on: boolean; manual: boolean };

/** 拖出来的框太小基本都是误操作（点了一下），不进列表。 */
const MIN_DRAG = 0.02;

export default function MosaicTool() {
  const [source, setSource] = useState<Source | null>(null);
  const [boxes, setBoxes] = useState<Tracked[]>([]);
  const [style, setStyle] = useState<MosaicStyle>('pixel');
  const [divisions, setDivisions] = useState(8);
  const [color, setColor] = useState('#000000');
  const [format, setFormat] = useState<ImageFormat>('png');
  const [quality, setQuality] = useState(0.92);
  const [outputs, setOutputs] = useState<ToolOutput[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const imageRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLSpanElement | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const current = source;
    return () => {
      if (current) URL.revokeObjectURL(current.url);
    };
  }, [source?.url]);

  /** 跑检测：只替换自动框，用户自己拖的框原样保留。 */
  function scan(image: HTMLImageElement, width: number, height: number) {
    setScanning(true);
    try {
      const found = detectFaces({ source: image, width, height });
      setBoxes((prev) => [
        ...prev.filter((item) => item.manual),
        ...found.map((box, index) => ({ id: `auto-${index}`, box, on: true, manual: false })),
      ]);
    } catch {
      setError('没能在这张图上跑检测，用下面的「手动框」自己拖一块吧。');
    } finally {
      setScanning(false);
    }
  }

  /** 预览上的坐标 → 图片内的 0–1 相对坐标。 */
  function relative(event: MouseEvent) {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  function commitDrag() {
    if (!drag || !source) {
      setDrag(null);
      return;
    }
    const width = Math.abs(drag.x1 - drag.x0);
    const height = Math.abs(drag.y1 - drag.y0);
    if (width >= MIN_DRAG && height >= MIN_DRAG) {
      const box = clampBox(
        {
          x: Math.min(drag.x0, drag.x1) * source.width,
          y: Math.min(drag.y0, drag.y1) * source.height,
          width: width * source.width,
          height: height * source.height,
        },
        source.width,
        source.height,
      );
      seq.current += 1;
      setBoxes((prev) => [...prev, { id: `manual-${seq.current}`, box, on: true, manual: true }]);
    }
    setDrag(null);
  }

  async function run() {
    if (!source) return;
    const image = imageRef.current;
    if (!image) return;
    const picked = boxes.filter((item) => item.on).map((item) => item.box);
    if (!picked.length) {
      setError('至少留一个区域：要么用检测出来的框，要么自己在画面上拖一块。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await applyMosaic({
        source: image,
        width: source.width,
        height: source.height,
        boxes: picked,
        style,
        divisions,
        color,
        format,
        quality,
      });
      const name = `${baseName(source.file.name)}_打码.${format === 'jpeg' ? 'jpg' : format}`;
      setOutputs([
        {
          key: name,
          name,
          blob: result.blob,
          note: `${result.width}×${result.height} · ${picked.length} 处 · ${formatBytes(result.blob.size)}`,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '打码失败。');
      setOutputs([]);
    } finally {
      setBusy(false);
    }
  }

  const dragStyle = drag
    ? {
        left: `${Math.min(drag.x0, drag.x1) * 100}%`,
        top: `${Math.min(drag.y0, drag.y1) * 100}%`,
        width: `${Math.abs(drag.x1 - drag.x0) * 100}%`,
        height: `${Math.abs(drag.y1 - drag.y0) * 100}%`,
      }
    : undefined;

  return (
    <ToolShell active="mosaic" eyebrow="FACE MOSAIC" title="人脸马赛克" intro="自动找出人脸打码，也可以自己在画面上拖一块">
      <section className="tool-panel">
        <div className="tool-pane">
          <label className="tool-drop">
            <input
              type="file"
              accept="image/*"
              data-tool-input="mosaic-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                setBoxes([]);
                setOutputs([]);
                setError(null);
                setSource(file ? { file, url: URL.createObjectURL(file), width: 0, height: 0 } : null);
              }}
            />
            <span className="tool-drop-icon"><ShieldOff size={22} strokeWidth={1.4} aria-hidden /></span>
            <strong>{source ? source.file.name : '选一张要打码的图'}</strong>
            <small className="muted">原图不会被改动，产出是一张新图</small>
          </label>

          {source && (
            <>
              <div className="tool-preview" data-tool-preview={source.width ? 'ready' : 'loading'}>
                <span
                  className="tool-motion-stage"
                  ref={stageRef}
                  onMouseDown={(event) => {
                    const point = relative(event);
                    if (point) setDrag({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
                  }}
                  onMouseMove={(event) => {
                    if (!drag) return;
                    const point = relative(event);
                    if (point) setDrag({ ...drag, x1: point.x, y1: point.y });
                  }}
                  onMouseUp={commitDrag}
                  onMouseLeave={commitDrag}
                >
                  <img
                    ref={imageRef}
                    src={source.url}
                    alt={source.file.name}
                    draggable={false}
                    onLoad={(event) => {
                      const image = event.currentTarget;
                      setSource((prev) =>
                        prev && prev.url === source.url
                          ? { ...prev, width: image.naturalWidth, height: image.naturalHeight }
                          : prev,
                      );
                      /* 图一加载完就跑一次检测：让用户先看到「找到了什么」，
                         再决定要不要改 —— 比让他先点一个按钮顺手。 */
                      scan(image, image.naturalWidth, image.naturalHeight);
                    }}
                  />
                  {boxes.map((item, index) => (
                    <span
                      key={item.id}
                      className={`tool-mosaic-box${item.on ? '' : ' off'}${item.manual ? ' manual' : ''}`}
                      data-tool-box={index}
                      style={{
                        left: `${(item.box.x / source.width) * 100}%`,
                        top: `${(item.box.y / source.height) * 100}%`,
                        width: `${(item.box.width / source.width) * 100}%`,
                        height: `${(item.box.height / source.height) * 100}%`,
                      }}
                    />
                  ))}
                  {dragStyle && <span className="tool-mosaic-box dragging" style={dragStyle} />}
                </span>
              </div>
              <p className="tool-meta">
                {source.width ? `${source.width} × ${source.height} · ` : ''}
                在画面上拖一块就能自己加区域，拖出来的框和检测出来的框可以混着用
              </p>
            </>
          )}
        </div>

        <div className="tool-pane">
          <div className="tool-result-actions">
            <button
              className="button secondary"
              type="button"
              disabled={!source?.width || scanning}
              data-tool-run="detect"
              onClick={() => {
                const image = imageRef.current;
                if (image && source) scan(image, source.width, source.height);
              }}
            >
              {scanning ? <Loader2 className="asset-spin" size={14} aria-hidden /> : <ScanFace size={14} aria-hidden />}
              {scanning ? '正在找…' : '重新检测人脸'}
            </button>
          </div>

          {boxes.length > 0 ? (
            <ul className="tool-filelist" data-tool-boxlist={boxes.length}>
              {boxes.map((item, index) => (
                <li key={item.id} data-tool-boxrow={index}>
                  <span>
                    {item.manual ? '手动框' : '检测到的人脸'} {Math.round(item.box.width)} × {Math.round(item.box.height)}
                  </span>
                  <button
                    className="text-link"
                    type="button"
                    data-tool-boxtoggle={index}
                    onClick={() => setBoxes((prev) => prev.map((row) => (row.id === item.id ? { ...row, on: !row.on } : row)))}
                  >
                    {item.on ? '不打' : '打上'}
                  </button>
                  <button
                    className="text-link"
                    type="button"
                    data-tool-boxremove={index}
                    onClick={() => setBoxes((prev) => prev.filter((row) => row.id !== item.id))}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="tool-hint">
              {source ? '没找到像人脸的区域 —— 直接在画面上拖一块，或者点上面的「重新检测」。' : '先选一张图。'}
            </p>
          )}

          <div className="field">
            <span>打码方式</span>
            <div className="assets-chips">
              {MOSAIC_STYLES.map((item) => (
                <button
                  key={item.value}
                  className={`assets-chip${style === item.value ? ' active' : ''}`}
                  type="button"
                  data-tool-style={item.value}
                  onClick={() => setStyle(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <p className="tool-hint">{MOSAIC_STYLES.find((item) => item.value === style)?.hint}</p>

          {style !== 'solid' && (
            <label className="field">
              <span>切几格 {divisions}</span>
              <input
                type="range"
                min={3}
                max={24}
                step={1}
                value={divisions}
                data-tool-input="divisions"
                onChange={(event) => setDivisions(Number(event.target.value))}
              />
            </label>
          )}
          {style === 'solid' && (
            <label className="field">
              <span>涂成什么颜色</span>
              <input type="color" value={color} data-tool-input="color" onChange={(event) => setColor(event.target.value)} />
            </label>
          )}
          {style !== 'solid' && <p className="tool-hint">格子越少越糊。这个比例跟着区域大小走，大图小图看起来一致。</p>}

          <OutputOptions format={format} onFormat={setFormat} quality={quality} onQuality={setQuality} />

          {error && <p className="error">{error}</p>}

          <button className="button" type="button" disabled={!source || busy || !boxes.some((item) => item.on)} onClick={run} data-tool-run="mosaic">
            {busy ? <Loader2 className="asset-spin" size={14} aria-hidden /> : <Eraser size={14} aria-hidden />}
            打码并生成
          </button>
        </div>
      </section>

      <ToolResult outputs={outputs} emptyHint="还没有产出：左边选图，右边确认要打哪些区域，点「打码并生成」。" onReset={() => setOutputs([])} />
    </ToolShell>
  );
}
