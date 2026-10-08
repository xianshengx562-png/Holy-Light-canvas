'use client';

/*
 * 从项目封面里取一支「主色」，给首页那张项目卡染一层很淡的底
 * （2026-10-08 徐先：「主页的卡片颜色可以更丰富一点」）。
 *
 * 为什么要**现场取色**、不预先算一份存下来：`cover` 是每次列项目时从该项目的图片资产里
 * **随机挑的一张**（见 `lib/projects.ts` 的 `pickCovers`）—— 下一次进首页就换了一张，
 * 存下来的颜色跟当前这张封面会对不上。现场取样永远跟着眼睛看到的那张图。
 *
 * 🔴 从**已经在页面上的那个 `<img>`** 上取样，不新建 `new Image()`：
 *    卡片本来就要加载这张图，再 new 一个等于同一张图跑两趟（封面常常是几 MB 的生成图），
 *    而 `drawImage` 一个已经解码好的元素是廉价的。
 * 🔴 返回的是 **`"r, g, b"` 三个数**，不是颜色字符串：深浅两档要的 alpha 不一样，
 *    由 CSS 那边的 `--card-tint-a` 定（见 `workspace-home.css`）。
 *    拼成一个 rgb() 带死 alpha 的话，两档就得写两份取色逻辑。
 */

/** 取样画布的边长。32×32 = 1024 个像素：够稳，又是常数级开销。 */
const SAMPLE = 32;

/**
 * 取样用的画布只建一次。
 *
 * ⚠️ 它**不在 DOM 里**（`createElement` 出来就完事），所以不会被任何 CSS 影响，
 *    也不会在页面上占位置。
 */
let scratch: HTMLCanvasElement | null = null;

/**
 * 取这支封面的主色。取不到就返回 `''` —— 调用方据此回落（没封面走轮换色板、
 * 取色失败就走中性面），**绝不抛异常**：这只是个装饰，不该让卡片渲染不出来。
 */
export function coverTintOf(img: HTMLImageElement): string {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  /* 还没解码完（`loading="lazy"` 还没轮到它）—— 这一次就算了，下次 `load` 再来。 */
  if (!w || !h) return '';
  try {
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratch.width = SAMPLE;
      scratch.height = SAMPLE;
    }
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    if (!ctx) return '';
    ctx.clearRect(0, 0, SAMPLE, SAMPLE);
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    return pickDominant(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
  } catch {
    /* 画布被跨源图污染时 `getImageData` 抛 SecurityError（本机图片是同源的，
       走不到这儿；但这条不写的话，将来换一个图源就是整个首页白屏）。 */
    return '';
  }
}

/**
 * 从像素里挑一支当主色。
 *
 * 🔴 **不能对整张图求算术平均** —— 那也是「取色」最常翻的车：一张深海的图会被大面积的
 *    暗部拉成灰蓝、一张逆光的图会被高光拉成灰白，染到卡上等于没染。
 *    这里只统计**够彩**的那一批像素（饱和度 ≥ 0.12，且不太黑也不太白），
 *    按 `s²` 加权 —— 越彩的像素说话越算数。
 *
 * 🔴 色相用**圆均值**（先把角度铺到单位圆上求向量和再取角），不能直接对色相求平均：
 *    一圈红（h≈0.98）与另一圈红（h≈0.02）的算术平均是 0.5 = 青，正好是反色。
 *
 * 🔴 最后把结果**夹进一个中段带**（s 0.35~0.80、l 0.42~0.62）：
 *    不夹的话，一张几乎纯黑的封面会给出一个几乎纯黑的主色，洗在深灰卡上完全看不出来；
 *    一张惨白的封面同理。夹完的颜色一定「有颜色、不刺眼」。
 */
function pickDominant(data: Uint8ClampedArray): string {
  let hx = 0;
  let hy = 0;
  let sSum = 0;
  let lSum = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    /* 全透明的像素（PNG 的空洞）不算数。 */
    if (data[i + 3] < 128) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (s < 0.12 || l < 0.08 || l > 0.94) continue;
    const w = s * s;
    const angle = h * Math.PI * 2;
    hx += Math.cos(angle) * w;
    hy += Math.sin(angle) * w;
    sSum += s * w;
    lSum += l * w;
    weight += w;
  }
  /* 整张图一个彩色像素都没有（真·黑白图）→ 认输，交给调用方回落。 */
  if (!weight) return '';
  const hue = ((Math.atan2(hy, hx) / (Math.PI * 2)) + 1) % 1;
  const sat = clamp(sSum / weight, 0.35, 0.8);
  const light = clamp(lSum / weight, 0.42, 0.62);
  const [r, g, b] = hslToRgb(hue, sat, light);
  return `${r}, ${g}, ${b}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** `h` 归一到 `[0, 1)`，`s` / `l` 也是 0~1。 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (!s) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hueToChannel(p, q, h + 1 / 3) * 255),
    Math.round(hueToChannel(p, q, h) * 255),
    Math.round(hueToChannel(p, q, h - 1 / 3) * 255),
  ];
}

function hueToChannel(p: number, q: number, t: number) {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}
