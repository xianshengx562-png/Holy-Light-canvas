'use client';

/*
 * 运镜效果：给一张静图加上推拉摇移，录成一段短视频。
 *
 * 和另外两个工具最大的不同是**产出不是图**，所以预览这块的思路也不一样：
 * 分割是「画格线告诉你切在哪」，这里是「画取景框告诉你镜头从哪到哪」——
 * 起点虚线框、终点实线框，中间那两个小画面是两端的实际构图。
 *
 * ⚠️ 录制是**实时**的（`src/lib/motion.ts` 文件头第 1 条）：一段 6 秒的镜头
 * 就是要等 6 秒。所以按钮上必须给进度 —— 否则它看着就是卡死了。
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Loader2, Video, ZoomIn, ZoomOut } from 'lucide-react';
import ToolShell from '@/components/tools/ToolShell';
import ToolResult, { type ToolOutput } from '@/components/tools/ToolResult';
import { formatBytes } from '@/lib/image-tools';
import {
  MOTION_EASINGS,
  MOTION_PRESETS,
  MOTION_SIZES,
  availableVideoFormats,
  cameraRect,
  canRecord,
  motionCamera,
  motionOutputSize,
  paintCamera,
  renderMotion,
  type Camera,
  type MotionEasing,
  type MotionKind,
  type MotionSize,
  type MotionVideoFormat,
} from '@/lib/motion';

type Source = { file: File; url: string; width: number; height: number };

/** 与 `renderMotion` 里的夹取范围保持一致：超出去了也是被夹回来，不如界面上就别让选。 */
const MIN_DURATION = 1;
const MAX_DURATION = 10;

const KIND_ICON: Record<MotionKind, typeof ZoomIn> = {
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  panLeft: ArrowLeft,
  panRight: ArrowRight,
  panUp: ArrowUp,
  panDown: ArrowDown,
};

const FPS_LIST = [24, 30, 60];

export default function MotionTool() {
  const [source, setSource] = useState<Source | null>(null);
  const [kind, setKind] = useState<MotionKind>('zoomIn');
  const [strength, setStrength] = useState(1);
  const [duration, setDuration] = useState(4);
  const [fps, setFps] = useState(30);
  const [size, setSize] = useState<MotionSize>('720p');
  const [easing, setEasing] = useState<MotionEasing>('easeInOut');
  const [focus, setFocus] = useState({ x: 0.5, y: 0.5 });
  const [format, setFormat] = useState<MotionVideoFormat>('webm');
  const [formats, setFormats] = useState<MotionVideoFormat[]>(['webm']);

  const [outputs, setOutputs] = useState<ToolOutput[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const imageRef = useRef<HTMLImageElement | null>(null);
  const startRef = useRef<HTMLCanvasElement | null>(null);
  const endRef = useRef<HTMLCanvasElement | null>(null);

  /* 支持哪些容器只有真跑一遍才知道（`isTypeSupported` 是运行时的），不能在模块级算。 */
  useEffect(() => {
    const list = availableVideoFormats();
    if (list.length) {
      setFormats(list);
      if (!list.includes('webm')) setFormat(list[0]);
    }
  }, []);

  /* 换图时回收预览地址 —— 理由和分割页那三个来源一样：不 revoke 就是内存泄漏。 */
  useEffect(() => {
    const current = source;
    return () => {
      if (current) URL.revokeObjectURL(current.url);
    };
  }, [source?.url]);

  const output = useMemo(
    () => (source?.width ? motionOutputSize(source.width, source.height, size) : null),
    [source?.width, source?.height, size],
  );

  const rects = useMemo(() => {
    if (!source?.width || !output) return null;
    const base = { width: source.width, height: source.height, canvasWidth: output.width, canvasHeight: output.height };
    const { start, end } = motionCamera(kind, strength, focus);
    return { start: cameraRect({ ...base, ...start }), end: cameraRect({ ...base, ...end }) };
  }, [source?.width, source?.height, output, kind, strength, focus]);

  /* 两端的实际构图。用页面上那个已经加载好的 <img> 当绘制源 —— 不多解码一次原图。 */
  useEffect(() => {
    const image = imageRef.current;
    const a = startRef.current;
    const b = endRef.current;
    if (!image || !a || !b || !source?.width || !output) return;
    const scale = Math.min(1, 320 / output.width);
    const width = Math.max(2, Math.round(output.width * scale));
    const height = Math.max(2, Math.round(output.height * scale));
    const { start, end } = motionCamera(kind, strength, focus);
    const shots: [HTMLCanvasElement, Camera][] = [
      [a, start],
      [b, end],
    ];
    for (const [canvas, camera] of shots) {
      canvas.width = width;
      canvas.height = height;
      paintCamera(canvas, image, { width: source.width, height: source.height, zoom: camera.zoom, fx: camera.fx, fy: camera.fy });
    }
  }, [source?.url, source?.width, source?.height, output, kind, strength, focus]);

  const preset = MOTION_PRESETS.find((item) => item.value === kind);

  async function run() {
    if (!source) return;
    setBusy(true);
    setProgress(0);
    setError(null);
    try {
      const result = await renderMotion({
        file: source.file,
        kind,
        duration,
        fps,
        size,
        strength,
        easing,
        focus,
        format,
        onProgress: setProgress,
      });
      setOutputs([
        {
          key: result.name,
          name: result.name,
          blob: result.blob,
          note: `${result.width}×${result.height} · ${result.duration}s · ${formatBytes(result.blob.size)}`,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '录制失败。');
      setOutputs([]);
    } finally {
      setBusy(false);
    }
  }

  /** 点预览图任意位置 = 把那儿设成镜头焦点（推近时最终停在哪儿）。 */
  function pickFocus(event: MouseEvent<HTMLImageElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    setFocus({
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    });
  }

  return (
    <ToolShell
      active="motion"
      eyebrow="CAMERA MOVE"
      title="运镜效果"
      intro="给一张静图加上推拉摇移，录成一段可以用的镜头"
    >
      {!canRecord() && (
        <p className="error">这个浏览器不支持录制视频（MediaRecorder 不可用），换 Chromium 内核的浏览器再试。</p>
      )}

      <section className="tool-panel">
        <div className="tool-pane">
          <label className="tool-drop">
            <input
              type="file"
              accept="image/*"
              data-tool-input="motion-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                setSource(file ? { file, url: URL.createObjectURL(file), width: 0, height: 0 } : null);
                setFocus({ x: 0.5, y: 0.5 });
              }}
            />
            <span className="tool-drop-icon"><Video size={22} strokeWidth={1.4} aria-hidden /></span>
            <strong>{source ? source.file.name : '选一张要运镜的图'}</strong>
            <small className="muted">PNG、JPEG、WebP 都行，原图一个字节都不会被改动</small>
          </label>

          {source && (
            <>
              <div className="tool-preview" data-tool-preview={source.width ? 'ready' : 'loading'}>
                <span className="tool-motion-stage">
                  <img
                    ref={imageRef}
                    src={source.url}
                    alt={source.file.name}
                    onClick={pickFocus}
                    data-tool-stage="1"
                    onLoad={(event) => {
                      const image = event.currentTarget;
                      setSource((prev) =>
                        prev && prev.url === source.url
                          ? { ...prev, width: image.naturalWidth, height: image.naturalHeight }
                          : prev,
                      );
                    }}
                  />
                  {rects && (
                    <>
                      <span className="tool-motion-box start" style={boxStyle(rects.start)}>
                        <b>起</b>
                      </span>
                      <span className="tool-motion-box end" style={boxStyle(rects.end)}>
                        <b>终</b>
                      </span>
                      <span className="tool-motion-focus" style={{ left: `${focus.x * 100}%`, top: `${focus.y * 100}%` }} aria-hidden />
                    </>
                  )}
                </span>
              </div>
              <p className="tool-meta">
                原图 {source.width} × {source.height} → 输出 {output ? `${output.width} × ${output.height}` : '…'}
                {' · '}
                点画面任意一处可以设焦点（推近/拉远最终停在哪儿）
              </p>
              <div className="tool-motion-frames">
                <figure>
                  <canvas ref={startRef} data-tool-motion-frame="start" />
                  <figcaption>起点画面</figcaption>
                </figure>
                <figure>
                  <canvas ref={endRef} data-tool-motion-frame="end" />
                  <figcaption>终点画面</figcaption>
                </figure>
              </div>
            </>
          )}
        </div>

        <div className="tool-pane">
          <div className="field">
            <span>运镜方式</span>
            <div className="assets-chips">
              {MOTION_PRESETS.map((item) => {
                const Icon = KIND_ICON[item.value];
                return (
                  <button
                    key={item.value}
                    className={`assets-chip${kind === item.value ? ' active' : ''}`}
                    type="button"
                    data-tool-motion={item.value}
                    onClick={() => setKind(item.value)}
                  >
                    <Icon size={13} aria-hidden /> {item.label}
                  </button>
                );
              })}
            </div>
          </div>
          {preset && <p className="tool-hint">{preset.hint}</p>}

          <label className="field">
            <span>时长 {duration}s</span>
            <input
              type="range"
              min={MIN_DURATION}
              max={MAX_DURATION}
              step={0.5}
              value={duration}
              data-tool-input="duration"
              onChange={(event) => setDuration(Number(event.target.value))}
            />
          </label>

          <label className="field">
            <span>幅度 {strength.toFixed(1)}×</span>
            <input
              type="range"
              min={0.2}
              max={2.5}
              step={0.1}
              value={strength}
              data-tool-input="strength"
              onChange={(event) => setStrength(Number(event.target.value))}
            />
          </label>

          <div className="field">
            <span>帧率</span>
            <div className="assets-chips">
              {FPS_LIST.map((value) => (
                <button
                  key={value}
                  className={`assets-chip${fps === value ? ' active' : ''}`}
                  type="button"
                  data-tool-fps={value}
                  onClick={() => setFps(value)}
                >
                  {value} fps
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>输出尺寸</span>
            <div className="assets-chips">
              {MOTION_SIZES.map((item) => (
                <button
                  key={item.value}
                  className={`assets-chip${size === item.value ? ' active' : ''}`}
                  type="button"
                  data-tool-size={item.value}
                  onClick={() => setSize(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>运动曲线</span>
            <div className="assets-chips">
              {MOTION_EASINGS.map((item) => (
                <button
                  key={item.value}
                  className={`assets-chip${easing === item.value ? ' active' : ''}`}
                  type="button"
                  data-tool-easing={item.value}
                  onClick={() => setEasing(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {formats.length > 1 && (
            <div className="field">
              <span>封装格式</span>
              <div className="assets-chips">
                {formats.map((value) => (
                  <button
                    key={value}
                    className={`assets-chip${format === value ? ' active' : ''}`}
                    type="button"
                    data-tool-vformat={value}
                    onClick={() => setFormat(value)}
                  >
                    {value === 'webm' ? 'WebM' : 'MP4'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p className="error">{error}</p>}

          <button className="button" type="button" disabled={!source || busy || !canRecord()} onClick={run} data-tool-run="motion">
            {busy ? <Loader2 className="asset-spin" size={14} aria-hidden /> : <Video size={14} aria-hidden />}
            {busy ? `录制中 ${Math.round(progress * duration * 10) / 10}s / ${duration}s` : `开始录制（${duration}s）`}
          </button>
          {busy && (
            <div className="tool-progress" data-tool-progress={progress.toFixed(2)}>
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
          <p className="tool-hint">录制是按真实时间走的：{duration} 秒的镜头要等 {duration} 秒，别把窗口切走。</p>
        </div>
      </section>

      <ToolResult outputs={outputs} emptyHint="还没有产出：左边选一张图，右边挑好运镜方式，点「开始录制」。" onReset={() => setOutputs([])} />
    </ToolShell>
  );
}

/** 取景框用百分比定位 —— 换尺寸、换幅度都不需要重新解码原图。 */
function boxStyle(rect: { x: number; y: number; width: number; height: number }) {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}
