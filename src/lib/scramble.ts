/*
 * 图片视觉置乱 —— 用密码把画面打乱成看不懂的样子，同一个密码能原样还原。
 *
 * 五条前提，改这个文件之前先看：
 *
 * 1. **它是置乱，不是加密。** 图仍然是一张正常能打开的 PNG，只是画面被搬乱了；
 *    防的是「随手一点就看见」，不是防专业还原。界面上必须照实说，不能让人拿它当保险箱。
 * 2. **输出只能是 PNG。** JPEG 是有损的，压缩会把像素值改掉一点，而置乱是
 *    「一个字节都不能差」的运算（异或、换位），差 1 就还原不回来。这点在界面上要写死。
 * 3. **不能动 alpha。** canvas 存的是预乘 alpha，`putImageData` → `getImageData`
 *    在 alpha<255 时会引入取整误差 —— 一旦异或了 alpha，还原就有偏差。
 *    所以 RGB 参与异或、alpha 原样跟着像素一起搬位置。
 * 4. **置乱必须是一个双射。** 这里用的是「行置换 × 列置换」：
 *    `out[y][x] = in[rowMap[y]][colMap[x]]`。行、列各自长度一致，所以永远不越界、
 *    也永远可逆；换成「把矩形块整体换位」就会在图片边缘遇到尺寸不齐的块，直接不可逆。
 * 5. **条带大小不能被图片尺寸整除时**，末尾那一小截不参与置换（`stripeMap` 里的
 *    `full`），而不是硬塞进去 —— 换过去的位置装不下就会丢像素，同样是破坏可逆性。
 *
 * 类型上的一处别扭：TS 5.7 起 TypedArray 多了一个缓冲区类型参数，
 * 光写 `Uint8ClampedArray` 等于 `Uint8ClampedArray<ArrayBufferLike>`，
 * 而 `ImageData` 只收 `ArrayBuffer` 那一档（`ImageDataArray = Uint8ClampedArray<ArrayBuffer>`），
 * `Blob` 同理。下面用 `Pixels` / `Bytes` 两个别名把这一档写死 ——
 * 比在每个签名后面拖一条 `<ArrayBuffer>` 尾巴好读。
 */

/** 一张图的像素：`ImageData` / `putImageData` 认的那一档。 */
export type Pixels = Uint8ClampedArray<ArrayBuffer>;
/** PNG 的原始字节：`Blob` 认的那一档。 */
export type Bytes = Uint8Array<ArrayBuffer>;

export type ScrambleLevel = 'light' | 'medium' | 'strong';

export type LevelConfig = {
  id: ScrambleLevel;
  label: string;
  hint: string;
  /** 行条带 / 列条带的像素数。1 = 每一行（列）各自单独重排。 */
  stripe: number;
  /** 是否再做一次颜色异或。关掉的话画面只是被搬了位置，颜色还是原来的。 */
  xor: boolean;
};

export const SCRAMBLE_LEVELS: LevelConfig[] = [
  { id: 'light', label: '轻度', hint: '大条带换位置：看得出是张图，但内容拼不起来', stripe: 32, xor: false },
  { id: 'medium', label: '中度', hint: '细条带换位 + 颜色打乱：看不出画的是什么', stripe: 8, xor: true },
  { id: 'strong', label: '强度', hint: '每一行每一列单独重排 + 颜色打乱：纯噪点', stripe: 1, xor: true },
];

export function levelConfig(level: ScrambleLevel): LevelConfig {
  return SCRAMBLE_LEVELS.find((item) => item.id === level) ?? SCRAMBLE_LEVELS[1];
}

/* ----------------------------------------------------------- 密码 → 随机数种子 */

const FNV_OFFSET = 0x811c9dc5;

/**
 * 没有 Web Crypto 时的兜底。
 *
 * 置乱本来就不承担密码学强度，所以这里用 FNV-1a 拼出 32 字节也够用 ——
 * 真正重要的是**跨设备一致**（换个电脑、换个浏览器，同一个密码必须得到同一张图），
 * 而不是抗碰撞。
 */
function fallbackHash(data: Uint8Array): Bytes {
  const out = new Uint8Array(32);
  for (let round = 0; round < 8; round += 1) {
    let hash = (FNV_OFFSET + round * 0x9e3779b9) >>> 0;
    for (let i = 0; i < data.length; i += 1) {
      hash ^= data[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out[round * 4] = hash & 255;
    out[round * 4 + 1] = (hash >>> 8) & 255;
    out[round * 4 + 2] = (hash >>> 16) & 255;
    out[round * 4 + 3] = (hash >>> 24) & 255;
  }
  return out;
}

export async function deriveSeed(password: string): Promise<Bytes> {
  const data = new TextEncoder().encode(password);
  if (globalThis.crypto?.subtle) {
    try {
      return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    } catch {
      /* 继续走下面的兜底 */
    }
  }
  return fallbackHash(data);
}

/** sfc32：小而快、周期足够长的 32 位 PRNG。逐像素调用，速度是这里的关键。 */
function makeRandom(seed: Uint8Array): () => number {
  const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
  let a = view.getUint32(0);
  let b = view.getUint32(4);
  let c = view.getUint32(8);
  let d = view.getUint32(12);
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };
}

/* ---------------------------------------------------------------------- 置换表 */

/**
 * 条带置换表：`map[目标位置] = 来源位置`。
 *
 * 末尾不足一条的那截保持不动（见文件头第 5 条）—— 少打乱几行像素看不出来，
 * 但换过去装不下就会丢像素，那是不可逆的。
 */
function stripeMap(length: number, size: number, random: () => number): Uint32Array {
  const map = new Uint32Array(length);
  const full = Math.floor(length / size) * size;
  const groups = full / size;
  if (groups > 1) {
    const order = new Uint32Array(groups);
    for (let i = 0; i < groups; i += 1) order[i] = i;
    for (let i = groups - 1; i > 0; i -= 1) {
      const j = random() % (i + 1);
      const swap = order[i];
      order[i] = order[j];
      order[j] = swap;
    }
    for (let target = 0; target < groups; target += 1) {
      const from = order[target] * size;
      const to = target * size;
      for (let k = 0; k < size; k += 1) map[to + k] = from + k;
    }
  } else {
    for (let i = 0; i < full; i += 1) map[i] = i;
  }
  for (let i = full; i < length; i += 1) map[i] = i;
  return map;
}

function maps(seed: Uint8Array, level: ScrambleLevel, width: number, height: number) {
  const config = levelConfig(level);
  const random = makeRandom(seed);
  const rows = stripeMap(height, config.stripe, random);
  const cols = stripeMap(width, config.stripe, random);
  return { rows, cols, random, config };
}

/* ------------------------------------------------------------------ 置乱 / 还原 */

export function scramblePixels(
  source: Pixels,
  width: number,
  height: number,
  seed: Uint8Array,
  level: ScrambleLevel,
): Pixels {
  const { rows, cols, random, config } = maps(seed, level, width, height);

  /* 第一步：按原图顺序给 RGB 盖一层随机数（alpha 不碰，见文件头第 3 条）。 */
  const staged = new Uint8ClampedArray(source.length);
  if (config.xor) {
    for (let i = 0; i < source.length; i += 4) {
      const key = random();
      staged[i] = source[i] ^ (key & 255);
      staged[i + 1] = source[i + 1] ^ ((key >>> 8) & 255);
      staged[i + 2] = source[i + 2] ^ ((key >>> 16) & 255);
      staged[i + 3] = source[i + 3];
    }
  } else {
    staged.set(source);
  }

  /* 第二步：按行/列置换搬到新位置。 */
  const out = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = rows[y] * width;
    const targetRow = y * width;
    for (let x = 0; x < width; x += 1) {
      const from = (sourceRow + cols[x]) * 4;
      const to = (targetRow + x) * 4;
      out[to] = staged[from];
      out[to + 1] = staged[from + 1];
      out[to + 2] = staged[from + 2];
      out[to + 3] = staged[from + 3];
    }
  }
  return out;
}

export function unscramblePixels(
  source: Pixels,
  width: number,
  height: number,
  seed: Uint8Array,
  level: ScrambleLevel,
): Pixels {
  const { rows, cols, random, config } = maps(seed, level, width, height);

  /* 先把位置搬回来（置乱第二步的逆）。 */
  const staged = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = rows[y] * width;
    const targetRow = y * width;
    for (let x = 0; x < width; x += 1) {
      const from = (targetRow + x) * 4;
      const to = (sourceRow + cols[x]) * 4;
      staged[to] = source[from];
      staged[to + 1] = source[from + 1];
      staged[to + 2] = source[from + 2];
      staged[to + 3] = source[from + 3];
    }
  }

  /* 再把那层随机数盖掉。异或的逆就是它自己，所以是同一段密钥流。 */
  if (!config.xor) return staged;
  const out = new Uint8ClampedArray(source.length);
  for (let i = 0; i < staged.length; i += 4) {
    const key = random();
    out[i] = staged[i] ^ (key & 255);
    out[i + 1] = staged[i + 1] ^ ((key >>> 8) & 255);
    out[i + 2] = staged[i + 2] ^ ((key >>> 16) & 255);
    out[i + 3] = staged[i + 3];
  }
  return out;
}

/* ------------------------------------------------------------- 自动判断强度档 */

/**
 * 画面「粗糙程度」：相邻采样点之间的平均色差。
 *
 * 自然照片这个值很小（相邻像素颜色接近），噪点图很大。两个用途：
 * ① 自动挑强度档（见 `guessLevel`）；② 解密完发现画面**还是噪点**就提示密码不对 ——
 * 比让用户自己盯着屏幕判断可靠。
 *
 * 采样而不是全量遍历：4K 图全量算三遍会明显卡顿。
 */
export function roughness(pixels: Pixels, width: number, height: number): number {
  const step = Math.max(1, Math.round(Math.sqrt((width * height) / 20000)));
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += step) {
    const row = y * width;
    for (let x = 0; x + step < width; x += step) {
      const a = (row + x) * 4;
      const b = (row + x + step) * 4;
      sum += Math.abs(pixels[a] - pixels[b]) + Math.abs(pixels[a + 1] - pixels[b + 1]) + Math.abs(pixels[a + 2] - pixels[b + 2]);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

/** 三档各还原一次，挑画面最「像照片」的那一档。 */
export function guessLevel(source: Pixels, width: number, height: number, seed: Uint8Array): ScrambleLevel {
  let best: ScrambleLevel = SCRAMBLE_LEVELS[0].id;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const config of SCRAMBLE_LEVELS) {
    const score = roughness(unscramblePixels(source, width, height, seed, config.id), width, height);
    if (score < bestScore) {
      bestScore = score;
      best = config.id;
    }
  }
  return best;
}

/* ------------------------------------------------------- 参数写进 PNG 文本块 */

/**
 * 强度档存在 PNG 的 `tEXt` 块里。
 *
 * 为什么不靠文件名：用户改个名、或者在别处转存一次，信息就没了。
 * 做法是把 `canvas.toBlob()` 出来的 PNG 字节在 **IHDR 之后插一个 chunk** ——
 * 不需要自己实现 PNG 编码器，IDAT 一节都没动，只是拼接字节。
 *
 * 兜底有两条：读不到就按文件名猜，再猜不出就跑 `guessLevel()`。
 */
export const META_KEY = 'frame-scramble';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[i] = value >>> 0;
    }
  }
  const table = crcTable;
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function writeU32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >>> 24) & 255;
  bytes[at + 1] = (value >>> 16) & 255;
  bytes[at + 2] = (value >>> 8) & 255;
  bytes[at + 3] = value & 255;
}

export function insertPngText(bytes: Bytes, keyword: string, text: string): Bytes {
  if (!isPng(bytes) || bytes.length < 33) return bytes;
  const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  /* 不是 IHDR 打头的 PNG（理论上不会）就不冒险改了：动错位置的后果是图直接打不开。 */
  if (type !== 'IHDR') return bytes;
  const at = 8 + 12 + readU32(bytes, 8);

  const payload = new TextEncoder().encode(`${keyword}\0${text}`);
  const chunk = new Uint8Array(12 + payload.length);
  writeU32(chunk, 0, payload.length);
  chunk[4] = 0x74; /* t */
  chunk[5] = 0x45; /* E */
  chunk[6] = 0x58; /* X */
  chunk[7] = 0x74; /* t */
  chunk.set(payload, 8);
  writeU32(chunk, 8 + payload.length, crc32(chunk.subarray(4, 8 + payload.length)));

  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(bytes.subarray(at), at + chunk.length);
  return out;
}

export function readPngText(bytes: Bytes, keyword: string): string | null {
  if (!isPng(bytes)) return null;
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = readU32(bytes, at);
    if (length > bytes.length - at - 12) return null;
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (type === 'tEXt') {
      const data = bytes.subarray(at + 8, at + 8 + length);
      const zero = data.indexOf(0);
      if (zero > 0 && new TextDecoder().decode(data.subarray(0, zero)) === keyword) {
        return new TextDecoder().decode(data.subarray(zero + 1));
      }
    }
    if (type === 'IEND') return null;
    at += 12 + length;
  }
  return null;
}

/** 文件名兜底：我们自己下载的那份会带 `_已加密_强度档`。 */
export function levelFromName(name: string): ScrambleLevel | null {
  const hit = /[_-](light|medium|strong)(?=\.[^.]+$)/i.exec(name);
  const value = hit?.[1]?.toLowerCase();
  return value === 'light' || value === 'medium' || value === 'strong' ? value : null;
}

/* ---------------------------------------------------------------- 画布进出字节 */

export async function pixelsToPngBlob(
  pixels: Pixels,
  width: number,
  height: number,
  meta?: string,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画布不可用');
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('导出 PNG 失败'))), 'image/png');
  });
  if (!meta) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Blob([insertPngText(bytes, META_KEY, meta)], { type: 'image/png' });
}

export async function fileToPixels(file: File): Promise<{ pixels: Pixels; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  /* ⚠️ 尺寸要**先**存下来：`close()` 之后 bitmap 的 width/height 就没了，
     而下面 `getImageData` 还要用 —— 写成 `bitmap.width` 会拿到 0，画布变成空的。 */
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('画布不可用');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, width, height);
  return { pixels: image.data, width: image.width, height: image.height };
}
