/**
 * 运镜效果：把一张静图做成一段镜头运动的视频。
 *
 * 四条前提，改这个文件前先读一遍 —— 每一条都对应一个「不这么写就会出怪事」的坑：
 *
 * 1. **录制是实时的。** `canvas.captureStream()` 出来的帧按**墙上时钟**打时间戳，
 *    所以「画 120 帧」不能在一个 tick 里一口气画完 —— 一口气画完得到的是一段
 *    0.2 秒长、却塞了 120 帧的视频。这里按帧率 pacing：一段 4 秒的成片就是要等 4 秒。
 *    （WebCodecs + 自己写一遍 muxer 能绕开这条，代价是多几百行封装代码，不值。）
 * 2. **画面进度按墙上时钟算，不按帧数算。** 掉帧时按帧数推进会让成片变长
 *    （4 秒的镜头录成 6 秒）；按 `elapsed / duration` 推进，掉帧只是少几帧，时长依然准。
 * 3. **画布宽高必须是偶数。** 奇数尺寸在部分编码器里直接失败，或者右边多出一条
 *    永远补不齐的黑边。所以 `motionOutputSize` 一律向下取到偶数。
 * 4. **源矩形按「画布坐标 → 图坐标」换算，不直接拿百分比。** 输出画布的宽高比和原图
 *    不一定相同（方形图塞进 1280×720），中间那层 `cover` 缩放和居中偏移不能省，
 *    省掉之后画面会偏、边缘会露出没画到的黑条。
 */
import { baseName, decode } from '@/lib/image-tools';

/* ------------------------------------------------------------------ 参数 */

/**
 * 六种运镜。都是**单轴**运动：推拉改 zoom，摇移改取景位置。
 * 不做「推近 + 左摇」这种复合 —— 复合运镜在静图上很容易显得晃，
 * 而用户真要做复合，录两段再拼起来更可控。
 */
export type MotionKind = 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'panUp' | 'panDown';

export const MOTION_PRESETS: readonly { value: MotionKind; label: string; hint: string }[] = [
  { value: 'zoomIn', label: '推近', hint: '从整张图缓缓推到局部，最常用的一种' },
  { value: 'zoomOut', label: '拉远', hint: '从局部退回到整张图，适合做开头' },
  { value: 'panLeft', label: '左摇', hint: '镜头转向左侧，画面从图的右边扫到左边' },
  { value: 'panRight', label: '右摇', hint: '镜头转向右侧，画面从图的左边扫到右边' },
  { value: 'panUp', label: '上摇', hint: '镜头抬起，画面从图的下边扫到上边' },
  { value: 'panDown', label: '下摇', hint: '镜头压下，画面从上边扫到下边' },
];

export function motionLabel(kind: MotionKind): string {
  return MOTION_PRESETS.find((item) => item.value === kind)?.label ?? '运镜';
}

/** 输出分辨率。画布按原图方向取横版或竖版，宽高比跟着输出档位走。 */
export type MotionSize = '720p' | '1080p' | 'source';
/** 运动曲线：Ken Burns 那种匀速漂移用线性，想要「起步收尾都轻」用缓入缓出。 */
export type MotionEasing = 'linear' | 'easeInOut';
export type MotionVideoFormat = 'webm' | 'mp4';

export const MOTION_SIZES: readonly { value: MotionSize; label: string }[] = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: 'source', label: '原图尺寸' },
];

export const MOTION_EASINGS: readonly { value: MotionEasing; label: string }[] = [
  { value: 'easeInOut', label: '缓入缓出' },
  { value: 'linear', label: '匀速' },
];

/** 一个镜头状态：放大倍数 + 取景中心在图里的相对位置（0 = 最左/最上，1 = 最右/最下）。 */
export type Camera = { zoom: number; fx: number; fy: number };

export type MotionOptions = {
  kind: MotionKind;
  /** 秒。录制是实时的（见文件头第 1 条），所以这个值直接等于用户要等的时长。 */
  duration: number;
  fps: number;
  size: MotionSize;
  /** 运动幅度，1 = 默认。 */
  strength: number;
  easing: MotionEasing;
  focus: { x: number; y: number };
  format: MotionVideoFormat;
};

/* ------------------------------------------------------------------ 镜头 */

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 推拉/摇移的起止镜头。摇移时 zoom 固定 —— 不推近就没有余量可摇。 */
export function motionCamera(kind: MotionKind, strength: number, focus: { x: number; y: number }) {
  const s = clamp(strength, 0.2, 2.5);
  const fx = clamp(focus.x, 0, 1);
  const fy = clamp(focus.y, 0, 1);
  if (kind === 'zoomIn' || kind === 'zoomOut') {
    const near: Camera = { zoom: 1 + 0.8 * s, fx, fy };
    const far: Camera = { zoom: 1, fx, fy };
    return kind === 'zoomIn' ? { start: far, end: near } : { start: near, end: far };
  }
  const zoom = 1 + 0.45 * s;
  if (kind === 'panLeft') return { start: { zoom, fx: 1, fy }, end: { zoom, fx: 0, fy } };
  if (kind === 'panRight') return { start: { zoom, fx: 0, fy }, end: { zoom, fx: 1, fy } };
  if (kind === 'panUp') return { start: { zoom, fx, fy: 1 }, end: { zoom, fx, fy: 0 } };
  return { start: { zoom, fx, fy: 0 }, end: { zoom, fx, fy: 1 } };
}

/** 缓动：匀速就是 t；缓入缓出用二次曲线，起步和收尾都慢，中间快。 */
export function ease(t: number, easing: MotionEasing): number {
  const x = clamp(t, 0, 1);
  if (easing === 'linear') return x;
  return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2;
}

/**
 * 起止镜头之间插值。
 * zoom 走**几何插值**（`start * (end/start)^t`）而不是线性：从 1 倍推到 2 倍时，
 * 线性插值的前半段只走到 1.5 倍、后半段却跨了 0.5 倍，观感是「先慢后猛地一冲」；
 * 几何插值才是匀速推近。
 */
export function cameraAt(start: Camera, end: Camera, t: number, easing: MotionEasing = 'easeInOut'): Camera {
  const e = ease(t, easing);
  const ratio = start.zoom > 0 ? end.zoom / start.zoom : 1;
  return {
    zoom: start.zoom * Math.pow(ratio, e),
    fx: start.fx + (end.fx - start.fx) * e,
    fy: start.fy + (end.fy - start.fy) * e,
  };
}

/* ------------------------------------------------------------------ 画布 */

const MAX_SIDE = 2048;

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * 输出画布尺寸（一定是偶数，见文件头第 3 条）。
 *
 * `720p` / `1080p` 按原图方向取横版或竖版 —— 竖图给 1280×720 会把两边裁掉一大半，
 * 那是「运镜」而不是「重新构图」，不该这么做。
 */
export function motionOutputSize(width: number, height: number, size: MotionSize) {
  const w = Math.max(2, Math.floor(width));
  const h = Math.max(2, Math.floor(height));
  if (size === '720p') return w >= h ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
  if (size === '1080p') return w >= h ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
  /* 原图尺寸也要压一道上限：一张 8000px 宽的图拿去实时编码，一帧都跑不进 1/30 秒。 */
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  return { width: even(w * scale), height: even(h * scale) };
}

/**
 * 画布坐标 → 图坐标的换算。
 *
 * 三步：`cover` 缩放（整张图铺满画布）→ 居中偏移 → 取景矩形。
 * 返回的是**图内的像素矩形**，夹紧在图边界内 —— 浮点误差把源矩形推出图外时，
 * 浏览器会往画布上补一条透明边，成片里就是一条闪动的黑缝。
 */
export function cameraSourceRect(input: {
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
  zoom: number;
  fx: number;
  fy: number;
}) {
  const { width: W, height: H, canvasWidth: w, canvasHeight: h } = input;
  const zoom = Math.max(1, input.zoom);
  const cover = Math.max(w / W, h / H);
  const offsetX = (w - W * cover) / 2;
  const offsetY = (h - H * cover) / 2;
  const vw = w / zoom;
  const vh = h / zoom;
  const vx = clamp(input.fx, 0, 1) * (w - vw);
  const vy = clamp(input.fy, 0, 1) * (h - vh);
  const sw = Math.min(W, vw / cover);
  const sh = Math.min(H, vh / cover);
  const sx = clamp((vx - offsetX) / cover, 0, Math.max(0, W - sw));
  const sy = clamp((vy - offsetY) / cover, 0, Math.max(0, H - sh));
  return { x: sx, y: sy, width: sw, height: sh };
}

/** 同一套换算，但返回**归一化**结果（0–1，相对原图）—— 给预览画取景框用。 */
export function cameraRect(input: Parameters<typeof cameraSourceRect>[0]) {
  const rect = cameraSourceRect(input);
  return {
    x: rect.x / input.width,
    y: rect.y / input.height,
    width: rect.width / input.width,
    height: rect.height / input.height,
  };
}

/** 把某一时刻的画面画进 canvas。预览和录制共用它，保证「看到的」就是「录到的」。 */
export function paintCamera(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  input: { width: number; height: number; zoom: number; fx: number; fy: number },
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画不出画面：拿不到 canvas 上下文。');
  const w = canvas.width;
  const h = canvas.height;
  /* 先铺黑再画：源矩形被夹紧后理论上铺满画布，但编码前的这一层兜底能挡住
     「某一帧边缘少画了 1 像素」这种只在成片里才看得见的毛病。 */
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const rect = cameraSourceRect({ ...input, canvasWidth: w, canvasHeight: h });
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, w, h);
}

/* ------------------------------------------------------------------ 录制 */

/**
 * 各容器按优先级排一串，`isTypeSupported` 从上往下取第一个能用的。
 *
 * webm 一定排在最前：它是 Chromium 里 MediaRecorder 的原生格式，最稳。
 * mp4 要看版本脸色（较新的 Chromium 才支持），能用才在界面上露出。
 */
const VIDEO_MIME: Record<MotionVideoFormat, string[]> = {
  webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
  mp4: ['video/mp4;codecs=avc1', 'video/mp4'],
};

export function canRecord(): boolean {
  return typeof window !== 'undefined' && typeof window.MediaRecorder === 'function';
}

export function pickVideoMime(format: MotionVideoFormat): string | null {
  if (!canRecord()) return null;
  for (const mime of VIDEO_MIME[format]) {
    if (window.MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

/** 这台机器能录哪几种容器 —— 界面只列出能用的，不给用户一个点了会报错的选项。 */
export function availableVideoFormats(): MotionVideoFormat[] {
  return (['webm', 'mp4'] as MotionVideoFormat[]).filter((format) => pickVideoMime(format));
}

function videoExt(format: MotionVideoFormat): string {
  return format === 'mp4' ? 'mp4' : 'webm';
}

/**
 * 码率按「像素 × 帧率」估：1080p30 约 4.3 Mbps，720p30 约 1.9 Mbps。
 * 上下都夹一道 —— 低了糊成一片，高了体积失控（一段 8 秒的视频不该有 100 MB）。
 */
function bitrateFor(width: number, height: number, fps: number): number {
  const raw = width * height * fps * 0.07;
  return Math.round(Math.min(24_000_000, Math.max(1_000_000, raw)));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type MotionResult = {
  name: string;
  blob: Blob;
  width: number;
  height: number;
  /** 请求录制的时长（秒）；成片与它差不了多少，但编码器有它自己的收尾节奏。 */
  duration: number;
  frames: number;
};

/**
 * 录一段运镜。
 *
 * ⚠️ 这一段是**实时**的：调它之前先想清楚调用方是不是在 UI 线程上 ——
 * 是的，所以界面上必须给出进度（掉帧也好、等待也好，别让按钮看着像卡死了）。
 */
export async function renderMotion(
  input: { file: File } & MotionOptions & { onProgress?: (ratio: number) => void },
): Promise<MotionResult> {
  if (!canRecord()) throw new Error('这个浏览器不支持录制视频（MediaRecorder 不可用）。');
  const mime = pickVideoMime(input.format);
  if (!mime) throw new Error(`这台机器不支持录制 ${input.format === 'mp4' ? 'MP4' : 'WebM'}，换一种格式试试。`);

  const duration = clamp(input.duration, 0.5, 15);
  const fps = clamp(Math.round(input.fps), 12, 60);
  const decoded = await decode(input.file);
  try {
    const { width, height } = motionOutputSize(decoded.width, decoded.height, input.size);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const { start, end } = motionCamera(input.kind, input.strength, input.focus);
    const draw = (t: number) => {
      const camera = cameraAt(start, end, t, input.easing);
      paintCamera(canvas, decoded.source, { width: decoded.width, height: decoded.height, zoom: camera.zoom, fx: camera.fx, fy: camera.fy });
    };

    /* 先画首帧再 start：录制器一启动就开始抓帧，此刻画布还是空的，
       成片开头会有一帧纯黑。 */
    draw(0);

    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrateFor(width, height, fps) });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error('录制中断了，换个分辨率或短一点的时长再试。'));
    });

    recorder.start();
    const t0 = performance.now();
    const totalMs = duration * 1000;
    const frameMs = 1000 / fps;
    let frames = 1;
    try {
      while (performance.now() - t0 < totalMs) {
        const target = t0 + frames * frameMs;
        const wait = target - performance.now();
        if (wait > 0) await sleep(wait);
        /* 进度取墙上时钟（见文件头第 2 条）：掉帧时画面照常走完，只是少几帧。 */
        const elapsed = performance.now() - t0;
        draw(Math.min(1, elapsed / totalMs));
        frames += 1;
        input.onProgress?.(Math.min(1, elapsed / totalMs));
      }
      /* 收尾帧 + 一点余量：stop() 会立刻封口，最后那几帧还在编码器里没写出来。 */
      draw(1);
      await sleep(Math.max(frameMs * 2, 120));
    } catch (err) {
      /* 出错也要让录制器收口：不 stop 的话这条流会一直挂在进程上。 */
      if (recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
      throw err;
    }
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    /*
     * ⚠️ 轨道要**等 stop 事件到了再关**。反过来写（先关轨道再等）的表现是
     * 成片结尾少一小截：编码器还没把最后几帧写出来，源就被掐断了。
     */
    stream.getTracks().forEach((track) => track.stop());

    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    if (!blob.size) throw new Error('录出来的文件是空的：换个分辨率或短一点的时长再试。');
    const ext = videoExt(input.format);
    return {
      name: `${baseName(input.file.name)}_${motionLabel(input.kind)}${Math.round(duration)}s.${ext}`,
      blob,
      width,
      height,
      duration,
      frames,
    };
  } finally {
    decoded.close();
  }
}
