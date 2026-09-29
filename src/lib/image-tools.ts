/**
 * 实用工具底下的图像批处理（分割 / 拼接 / 转格式）。
 *
 * 三条约定，改这个文件前最好先读一遍：
 *
 * 1. **全部跑在浏览器里** —— Canvas + `createImageBitmap`，不依赖 ffmpeg、不依赖主进程、
 *    不联网。桌面版主进程不掺和图像处理，它只负责最后把成品写盘（`/api/tools/archive`）。
 * 2. **一张图生命周期只有三步**：解码 → 画到 canvas → `toBlob`。中间不落字符串、不转
 *    base64 —— 一张 4K 图的 base64 是十几 MB 的字符串，来回复制几遍就卡住界面了。
 * 3. **`ImageBitmap` 用完必须 close()**。它是显存里的东西，GC 不管；切一张 4K 图出 30 格，
 *    不关就是 30 份解码位图同时挂着。所以解码的结果带一个 `close()`，调用方自己收。
 */
export type ImageFormat = 'png' | 'jpeg' | 'webp';

export const IMAGE_FORMATS: readonly {
  value: ImageFormat;
  label: string;
  ext: string;
  mime: string;
  /** 有损格式才有「质量」这一档可调，PNG 调它没意义，界面上也不该出现。 */
  lossy: boolean;
}[] = [
  { value: 'png', label: 'PNG', ext: 'png', mime: 'image/png', lossy: false },
  { value: 'jpeg', label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', lossy: true },
  { value: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp', lossy: true },
];

export function formatInfo(format: ImageFormat) {
  return IMAGE_FORMATS.find((item) => item.value === format) ?? IMAGE_FORMATS[0];
}

/** 去掉扩展名 —— 后续才能拼成 `名_r1c1.png`，而不是 `名.png_r1c1.png`。 */
export function baseName(name: string): string {
  const tail = String(name).split(/[?#]/)[0].split('/').pop() || '未命名';
  const dot = tail.lastIndexOf('.');
  return (dot > 0 ? tail.slice(0, dot) : tail) || '未命名';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 解码后交给 canvas 的一张图。用完必须 `close()`（见文件头第 3 条）。 */
export type Decoded = {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** 图片可能的间距，保持原样不拉伸。 */
  close: () => void;
};

export async function decode(file: File): Promise<Decoded> {
  /* `createImageBitmap` 在 Chromium（含 Electron 的渲染进程）里可用，走它可以把解码挪到
     合成线程以外的独立步骤；退路用 `<img>` —— 行为一致，只是多一次 events 往返。 */
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      /* 继续走下面的 <img> 退路：某些封装过的 File 会在这一步失败，但不代表图是坏的。 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('读不出这张图：格式不支持，或者文件本身坏了。'));
    image.src = url;
  });
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * `toBlob` 是回调式的、且可能给你一个 null（画布太大、编码失败都会走这条路）。
 * 包成 Promise 并且把 null 翻成明确的错误 —— 上层拿到 null 时只会写出一个 0 字节的文件，
 * 而「保存成功」的提示已经打出去了。
 */
function toBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob && blob.size ? resolve(blob) : reject(new Error('这张图没能编码出来，可能尺寸太大了。'))),
      mime,
      quality,
    );
  });
}

/**
 * 画布底色。
 *
 * ⚠️ JPEG **没有透明通道**：透明区域在被编码成 JPEG 时会被压成黑色，看起来像图被烧了一块。
 * 所以输出 JPEG 时一律先铺一层底色（默认白），PNG / WebP 才可以保持透明。
 */
export type Background = 'transparent' | 'white' | 'black';

function paintBackground(ctx: CanvasRenderingContext2D, width: number, height: number, background: Background, forced: Background | null = null) {
  const target = forced ?? background;
  if (target === 'transparent') return;
  ctx.save();
  ctx.fillStyle = target === 'white' ? '#ffffff' : '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/** 输出 JPEG 时强制铺一层白底 —— 透明被压成黑的那一段说明见上。 */
function effectiveBackground(background: Background, format: ImageFormat): Background | null {
  return format === 'jpeg' && background === 'transparent' ? 'white' : null;
}

/* ------------------------------------------------------------------ 分割 */

export type SlicePiece = {
  name: string;
  blob: Blob;
  width: number;
  height: number;
  row: number;
  col: number;
};

/**
 * 把一张图按 `rows × cols` 切成网格。
 *
 * 边界切成整数，而不是简单 `width / cols`：
 * 宽 1000 分 3 列时每格是 333.33 —— 直接用浮点画出来的格子会**右边缘丢一条 1 像素的缝**
 * （`drawImage` 会把源矩形外的部分补齐成透明）。所以这里先把边界取整，再让最后一格
 * 吃掉多出来的那一两个像素：**宁可最后一格宽 1px，也不能中间漏一条透明缝。**
 */
export function sliceBounds(total: number, parts: number): number[] {
  const safe = Math.max(1, Math.floor(parts));
  const bounds: number[] = [];
  for (let i = 0; i <= safe; i += 1) bounds.push(Math.round((i * total) / safe));
  return bounds;
}

export async function sliceImage(input: {
  file: File;
  rows: number;
  cols: number;
  format: ImageFormat;
  quality: number;
  /** 原图本身有透明区（PNG）或转 JPEG 时需要，见 `paintBackground`。 */
  background?: Background;
}): Promise<SlicePiece[]> {
  const info = formatInfo(input.format);
  const decoded = await decode(input.file);
  const pieces: SlicePiece[] = [];
  try {
    const xs = sliceBounds(decoded.width, input.cols);
    const ys = sliceBounds(decoded.height, input.rows);
    const prefix = baseName(input.file.name);
    for (let row = 0; row < ys.length - 1; row += 1) {
      for (let col = 0; col < xs.length - 1; col += 1) {
        const width = xs[col + 1] - xs[col];
        const height = ys[row + 1] - ys[row];
        if (width <= 0 || height <= 0) continue;
        const canvas = makeCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('画不出图：拿不到 canvas 上下文。');
        paintBackground(ctx, width, height, input.background ?? 'transparent', effectiveBackground(input.background ?? 'transparent', input.format));
        ctx.drawImage(decoded.source, xs[col], ys[row], width, height, 0, 0, width, height);
        const blob = await toBlob(canvas, info.mime, input.format === 'png' ? undefined : input.quality);
        /* 名字带行列序号：用户切完通常是按顺序往画布里拖，_r1_c2 这种命名才排得对。 */
        pieces.push({
          name: `${prefix}_r${row + 1}c${col + 1}.${info.ext}`,
          blob,
          width,
          height,
          row: row + 1,
          col: col + 1,
        });
      }
    }
  } finally {
    decoded.close();
  }
  if (!pieces.length) throw new Error('一个格子都没切出来，检查一下行列数。');
  return pieces;
}

/* ------------------------------------------------------------------ 拼接 */

export type StitchDirection = 'horizontal' | 'vertical';
/** 两张不一样大时，小的那张怎么摆。 */
export type StitchAlign = 'start' | 'center' | 'end';

export async function stitchImages(input: {
  first: File;
  second: File;
  direction: StitchDirection;
  align: StitchAlign;
  gap: number;
  background: Background;
  format: ImageFormat;
  quality: number;
}): Promise<{ name: string; blob: Blob; width: number; height: number }> {
  const info = formatInfo(input.format);
  const first = await decode(input.first);
  let second: Decoded | null = null;
  try {
    second = await decode(input.second);
    const gap = Math.max(0, Math.floor(input.gap) || 0);
    const horizontal = input.direction === 'horizontal';
    const across = horizontal ? first.width + gap + second.width : Math.max(first.width, second.width);
    const along = horizontal ? Math.max(first.height, second.height) : first.height + gap + second.height;

    const canvas = makeCanvas(horizontal ? across : along, horizontal ? along : across);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('画不出图：拿不到 canvas 上下文。');
    paintBackground(ctx, canvas.width, canvas.height, input.background, effectiveBackground(input.background, input.format));

    /* 沿拼接方向的那一段是「各自自己的尺寸」，垂直于拼接方向的那一维才要对齐。 */
    const offset = (own: number, total: number) => {
      if (input.align === 'center') return Math.round((total - own) / 2);
      if (input.align === 'end') return total - own;
      return 0;
    };
    if (horizontal) {
      const yFirst = offset(first.height, canvas.height);
      const ySecond = offset(second.height, canvas.height);
      ctx.drawImage(first.source, 0, yFirst);
      ctx.drawImage(second.source, first.width + gap, ySecond);
    } else {
      const xFirst = offset(first.width, canvas.width);
      const xSecond = offset(second.width, canvas.width);
      ctx.drawImage(first.source, xFirst, 0);
      ctx.drawImage(second.source, xSecond, first.height + gap);
    }

    const blob = await toBlob(canvas, info.mime, input.format === 'png' ? undefined : input.quality);
    const name = `${baseName(input.first.name)}+${baseName(input.second.name)}.${info.ext}`;
    return { name, blob, width: canvas.width, height: canvas.height };
  } finally {
    first.close();
    second?.close();
  }
}

/* ------------------------------------------------------------------ 转格式 */

export type ConvertInput = {
  file: File;
  format: ImageFormat;
  quality: number;
  background?: Background;
  /** 等比缩放百分比（100 = 原尺寸）。传入非 100 时才重采样。 */
  scale?: number;
};

export type ConvertResult = {
  name: string;
  blob: Blob;
  width: number;
  height: number;
  /** 转之前的体积，用来告诉用户「省了多少」。 */
  before: number;
};

export async function convertImage(input: ConvertInput): Promise<ConvertResult> {
  const info = formatInfo(input.format);
  const decoded = await decode(input.file);
  try {
    const scale = Math.min(400, Math.max(1, Math.round(input.scale ?? 100))) / 100;
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('画不出图：拿不到 canvas 上下文。');
    /* 缩放要用平滑重采样，否则缩略图锯齿一片，还不如不缩。 */
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    paintBackground(ctx, width, height, input.background ?? 'transparent', effectiveBackground(input.background ?? 'transparent', input.format));
    ctx.drawImage(decoded.source, 0, 0, width, height);
    const blob = await toBlob(canvas, info.mime, input.format === 'png' ? undefined : input.quality);
    return { name: `${baseName(input.file.name)}.${info.ext}`, blob, width, height, before: input.file.size };
  } finally {
    decoded.close();
  }
}

/* ------------------------------------------------------------------ 输出 */

/** 把 Blob 交给浏览器下载。Electron 里由 session 接管（存到默认下载目录）。 */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  /* 立刻 revoke 会让部分浏览器还没开始取数据就丢了这份字节，留足裕量再收。 */
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export type Selection = { name: string; blob: Blob; note: string };

/** 勾选 → 打包上传。公有这点是「`file` 这个名字必须与后端 `formData.getAll('file')` 对上」。 */
export function buildArchiveForm(items: Selection[], projectId: string): FormData {
  const form = new FormData();
  form.set('projectId', projectId);
  items.forEach((item) => form.append('file', item.blob, item.name));
  return form;
}
