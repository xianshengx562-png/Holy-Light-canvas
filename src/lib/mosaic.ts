/**
 * 马赛克：自动找人脸打码 + 手动框一块打码。
 *
 * 四条前提，改这个文件前先读一遍：
 *
 * 1. **没有现成的人脸检测可用。** Chromium 的 `FaceDetector`（Shape Detection API）
 *    在 Electron 里是关着的（实测 `'FaceDetector' in window === false`），
 *    而任何带模型的方案（face-api / MediaPipe）都要联网下几 MB 权重、还要塞进包里。
 *    所以这里是**自己写的肤色检测 + 连通域**：离线、无依赖、几十毫秒出结果。
 *    代价是它**不可能像模型一样准** —— 所以界面必须让人能改（取消勾选、自己补框），
 *    这不是「体验优化」，是这个算法的必要条件。
 * 2. **检测在缩略图上跑。** 原图可能 4000px 宽，逐像素扫一遍要几秒。一律先缩到
 *    最长边 512：既快，缩放本身还顺带把噪点抹平了（对连通域是好事）。
 *    得到的框再按比例放大回原图坐标。
 * 3. **形态学的闭运算（先膨胀后腐蚀）不能省。** 眼睛、嘴在肤色掩膜里是**洞**，
 *    眉毛、发丝会把一块脸切成两块。不闭一次，同一张脸会被框成三四个碎框。
 * 4. **打码按顺序叠加，且从「已经画好的画布」上取样。** 两个框重叠时，后一个
 *    要盖在**前一个马赛克的结果**上，而不是盖在原图上 —— 否则重叠处会露出原图。
 */

/** 一个待打码的区域，单位是**原图像素**。 */
export type MosaicBox = { x: number; y: number; width: number; height: number };

/**
 * 打码样式。
 * `pixel` 关掉平滑放大（硬边格子，就是通常说的马赛克）；
 * `blur` 是**同一套降采样 + 开平滑放大** —— 一行之差，出来是糊的而不是块状的。
 */
export type MosaicStyle = 'pixel' | 'blur' | 'solid';

export const MOSAIC_STYLES: readonly { value: MosaicStyle; label: string; hint: string }[] = [
  { value: 'pixel', label: '马赛克', hint: '经典的一格一格，看不出原样' },
  { value: 'blur', label: '模糊', hint: '同样看不清，但没那么扎眼' },
  { value: 'solid', label: '纯色块', hint: '整块涂成一种颜色，最彻底' },
];

/** 检测用缩略图的最长边：再大就是白烧 CPU，再小会丢掉小脸。 */
const DETECT_MAX = 512;
/** 缩略图上的最小面积（按占全图的比例算），滤掉噪点。 */
const MIN_AREA_RATIO = 0.0015;
/** 整张图最多报多少个框。再多就要开始怀疑算法是不是把背景当脸了。 */
const MAX_FACES = 12;
/** 检测到的框向外扩一点：肤色边界不等于头的边界，照着肤色框会切掉下巴和发际。 */
const EXPAND = 0.12;

/* ------------------------------------------------------------------ 检测 */

type BlobStat = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
  dark: number;
};

/**
 * 在缩略图上找「像人脸的肤色块」。
 *
 * 判据一层比一层严，顺序不能乱：先按肤色圈出掩膜 → 闭运算 → 连通域 → 再按
 * 面积 / 宽高比 / 填充率 / 暗区占比筛。**暗区占比那条最容易被忽略但最有用** ——
 * 一块纯肤色的手和一块脸在几何上几乎没区别，区别是脸上有眼睛和嘴（暗的）。
 */
export function detectFaces(input: {
  source: CanvasImageSource;
  width: number;
  height: number;
  maxFaces?: number;
}): MosaicBox[] {
  const W = Math.max(1, Math.floor(input.width));
  const H = Math.max(1, Math.floor(input.height));
  const scale = Math.min(1, DETECT_MAX / Math.max(W, H));
  const dw = Math.max(1, Math.round(W * scale));
  const dh = Math.max(1, Math.round(H * scale));

  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(input.source, 0, 0, dw, dh);
  const data = ctx.getImageData(0, 0, dw, dh).data;

  const skin = new Uint8Array(dw * dh);
  const dark = new Uint8Array(dw * dh);
  for (let i = 0, p = 0; i < skin.length; i += 1, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    /* YCbCr：肤色在 Cb-Cr 平面上聚得很紧，是最经典的粗筛手段。
       RGB 直接比阈值在暖色背景（木桌、夕阳）上会大面积误判，Cb-Cr 不会。 */
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    if (y > 80 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173) skin[i] = 1;
    /* 暗区：脸上有眼睛、眉毛、嘴、鼻影。取一个绝对阈值就够，不需要自适应。 */
    if (y < 110) dark[i] = 1;
  }

  const closed = erode(dilate(skin, dw, dh), dw, dh);
  const total = closed.length;
  const minArea = Math.max(12, Math.round(total * MIN_AREA_RATIO));

  const labels = new Int32Array(total).fill(-1);
  const blobs: BlobStat[] = [];
  const stack: number[] = [];
  for (let start = 0; start < total; start += 1) {
    if (!closed[start] || labels[start] >= 0) continue;
    const id = blobs.length;
    const stat: BlobStat = { minX: dw, minY: dh, maxX: 0, maxY: 0, area: 0, dark: 0 };
    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % dw;
      const y = (p - x) / dw;
      stat.area += 1;
      stat.dark += dark[p];
      if (x < stat.minX) stat.minX = x;
      if (x > stat.maxX) stat.maxX = x;
      if (y < stat.minY) stat.minY = y;
      if (y > stat.maxY) stat.maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= dw || ny < 0 || ny >= dh) continue;
          const q = ny * dw + nx;
          if (!closed[q] || labels[q] >= 0) continue;
          labels[q] = id;
          stack.push(q);
        }
      }
    }
    blobs.push(stat);
  }

  const candidates = blobs
    .filter((stat) => {
      if (stat.area < minArea) return false;
      const bw = stat.maxX - stat.minX + 1;
      const bh = stat.maxY - stat.minY + 1;
      const ratio = bw / bh;
      if (ratio < 0.5 || ratio > 2) return false;
      /* 填充率：一整块肤色（手、胳膊）接近 1，被头发/眼镜切开的一块脸在 0.5 上下。
         低于 0.32 说明这是一条细长的东西（手指缝、衣服上的肤色花纹），不是脸。 */
      const fill = stat.area / (bw * bh);
      if (fill < 0.32) return false;
      /* 暗区占比：脸上有五官。纯色肤色块（比如一块手）这一项是 0，直接排除。 */
      if (stat.dark / stat.area < 0.01) return false;
      return true;
    })
    .sort((a, b) => b.area - a.area);

  const boxes: MosaicBox[] = [];
  for (const stat of mergeOverlaps(candidates)) {
    const bw = stat.maxX - stat.minX + 1;
    const bh = stat.maxY - stat.minY + 1;
    const padX = bw * EXPAND;
    const padY = bh * EXPAND;
    const box = clampBox(
      {
        x: (stat.minX - padX) / scale,
        y: (stat.minY - padY) / scale,
        width: (bw + padX * 2) / scale,
        height: (bh + padY * 2) / scale,
      },
      W,
      H,
    );
    if (box.width >= 4 && box.height >= 4) boxes.push(box);
    if (boxes.length >= (input.maxFaces ?? MAX_FACES)) break;
  }
  return boxes;
}

function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!mask[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          out[ny * w + nx] = 1;
        }
      }
    }
  }
  return out;
}

function erode(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let keep = 1;
      for (let dy = -1; dy <= 1 && keep; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) { keep = 0; break; }
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || !mask[ny * w + nx]) { keep = 0; break; }
        }
      }
      out[y * w + x] = keep;
    }
  }
  return out;
}

/**
 * 合并重叠的候选框。
 *
 * 闭运算之后同一张脸偶尔还是会碎成两块（比如眼镜把脸横着切开一道）。
 * 判据用「小框有多大比例落在大框里」而不是 IoU —— 碎块几乎总是被大块包含的那种。
 */
function mergeOverlaps(list: BlobStat[]): BlobStat[] {
  const out: BlobStat[] = [];
  for (const stat of list) {
    const bw = stat.maxX - stat.minX + 1;
    const bh = stat.maxY - stat.minY + 1;
    const hit = out.findIndex((other) => {
      const ow = other.maxX - other.minX + 1;
      const oh = other.maxY - other.minY + 1;
      const ix = Math.min(stat.maxX, other.maxX) - Math.max(stat.minX, other.minX) + 1;
      const iy = Math.min(stat.maxY, other.maxY) - Math.max(stat.minY, other.minY) + 1;
      if (ix <= 0 || iy <= 0) return false;
      const inter = ix * iy;
      return inter / Math.min(bw * bh, ow * oh) > 0.3;
    });
    if (hit < 0) {
      out.push(stat);
      continue;
    }
    const target = out[hit];
    target.minX = Math.min(target.minX, stat.minX);
    target.minY = Math.min(target.minY, stat.minY);
    target.maxX = Math.max(target.maxX, stat.maxX);
    target.maxY = Math.max(target.maxY, stat.maxY);
    target.area += stat.area;
    target.dark += stat.dark;
  }
  return out;
}

export function clampBox(box: MosaicBox, width: number, height: number): MosaicBox {
  const x = Math.max(0, Math.min(width - 1, Math.round(box.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(box.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(box.width))),
    height: Math.max(1, Math.min(height - y, Math.round(box.height))),
  };
}

/* ------------------------------------------------------------------ 打码 */

export type MosaicOptions = {
  boxes: MosaicBox[];
  style: MosaicStyle;
  /**
   * 一块区域横竖切成几格（**比例**，不是绝对像素）。
   *
   * 不用绝对像素是因为它不随图片尺寸缩放：400px 的图格子 12px 刚好，
   * 4000px 的图同样的 12px 等于没打码，而用户不会想到要改这个数字。
   * 按「短边切成 N 格」走，两种尺寸的图看起来是一致的。
   */
  divisions: number;
  /** `style: 'solid'` 时涂什么颜色。 */
  color?: string;
};

/**
 * 把若干块区域打码，返回一张完整的新图。
 *
 * ⚠️ 取样源是**已经画好的这张画布**，不是原图（见文件头第 4 条）：两个框重叠时，
 * 后打的那个必须盖在前一个的马赛克上，从原图取会把重叠处还原成清晰画面。
 */
export async function applyMosaic(
  input: {
    source: CanvasImageSource;
    width: number;
    height: number;
    format: 'png' | 'jpeg' | 'webp';
    quality: number;
  } & MosaicOptions,
): Promise<{ blob: Blob; width: number; height: number }> {
  const width = Math.max(1, Math.floor(input.width));
  const height = Math.max(1, Math.floor(input.height));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画不出图：拿不到 canvas 上下文。');
  /* JPEG 没有透明通道，透明区会被压成黑 —— 先铺白底，和 image-tools 同一口径。 */
  if (input.format === 'jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(input.source, 0, 0, width, height);

  const divisions = Math.max(2, Math.min(40, Math.round(input.divisions)));
  for (const raw of input.boxes) {
    const box = clampBox(raw, width, height);
    if (box.width < 2 || box.height < 2) continue;
    if (input.style === 'solid') {
      ctx.fillStyle = input.color || '#000000';
      ctx.fillRect(box.x, box.y, box.width, box.height);
      continue;
    }
    const block = Math.max(2, Math.round(Math.min(box.width, box.height) / divisions));
    const sw = Math.max(1, Math.round(box.width / block));
    const sh = Math.max(1, Math.round(box.height / block));
    const small = document.createElement('canvas');
    small.width = sw;
    small.height = sh;
    const sctx = small.getContext('2d');
    if (!sctx) continue;
    sctx.drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, sw, sh);
    /* 差别就在这一行：关掉平滑 = 硬边格子（马赛克），开着 = 糊成一片（模糊）。 */
    ctx.imageSmoothingEnabled = input.style === 'blur';
    ctx.drawImage(small, 0, 0, sw, sh, box.x, box.y, box.width, box.height);
    ctx.imageSmoothingEnabled = true;
  }

  const mime = input.format === 'png' ? 'image/png' : input.format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => (value && value.size ? resolve(value) : reject(new Error('这张图没能编码出来，可能尺寸太大了。'))),
      mime,
      input.format === 'png' ? undefined : input.quality,
    );
  });
  return { blob, width, height };
}
