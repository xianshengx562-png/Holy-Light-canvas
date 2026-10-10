import 'server-only';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from '@/lib/api';
import { openCanvasMedia, parseCanvasMediaUrl } from '@/lib/canvas-media';
import { openMediaAsset } from '@/lib/media';
import { PROMPT_VIDEO_FRAMES, sampleFramesPng } from '@/lib/video-ffmpeg';

/**
 * 把画布上的一份媒体变成**模型能读的字节**（2026-10-03：看图 / 看视频反推提示词）。
 *
 * 与 `lib/referenceImages.ts` 是同一件事的两个归宿，别混：
 * - 那边要的是**对端平台的文件名**（上传到 RunningHub / 本机 ComfyUI，再把名字塞进工作流）；
 * - 这边要的是**字节本身** —— 文本模型那头访问不到我们本机的文件，
 *   所以只能内联成 `data:` 一起发过去。
 *
 * 只认三种来源（与 `mediaChain.isResolvableUrl` 同一套判据）：
 *   1. `/api/assets/<id>/media.<ext>` —— 已落盘的资产，读盘即得；
 *   2. `/api/canvas-media/<projectId>/<uuid>.<ext>` —— **拖 / 粘进画布的那份**
 *      （2026-10-10 补）。它刻意没有 Asset 记录（见 `lib/canvas-media.ts`），
 *      走 `openMediaAsset` 会报「媒体不存在」—— 那等于「拖进来的图反推不了」；
 *   3. `http(s)://...` —— 上游留在结果里的远端地址，下载下来。
 * `blob:` 那种本地预览**不算**：它只活在渲染进程内存里，服务端取不到字节。
 *
 * 🔴 **改这里记得问一句「另外几份跟上了吗」**：`referenceImages.ts`（工作流参考图 /
 * 视频 / 音频）、`upscale.ts`（超清输入）、`referenceBytes.ts`（自定义接口出图）、
 * `videoapi/reference.ts`（图生视频首帧）—— 五处是同一件事，只改一处就会
 * 「同一个界面、这一条路能用、那一条路报认不出」。
 *
 * 视频那条路多一步：**抽帧**。文本模型看不了视频文件，能看的是若干张图，
 * 所以这里用内置 FFmpeg 均匀抽 `PROMPT_VIDEO_FRAMES` 张再一起发过去。
 */
export const PROMPT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** 视频整段的上限。抽帧用不到整段之外的东西，给宽一点是为了别把正常的成片挡在门外。 */
export const PROMPT_VIDEO_MAX_BYTES = 300 * 1024 * 1024;

/** 已落盘媒体的地址形状。 */
const ASSET_PATH = /^\/api\/assets\/([0-9a-f-]{8,64})\/[^/]+$/i;

/** 一张准备好了的图：MIME + base64 正文 + 原始字节数（报错与日志要用）。 */
export type PromptImage = { mime: string; base64: string; bytes: number };

/**
 * 模型认得的图片格式。
 *
 * 🔴 只留这四种不是洁癖：`.avif` / `.bmp` / `.tiff` 之类被绝大多数视觉模型直接 400，
 * 而那种 400 报的是「图像解码失败」，用户只会以为是这张图坏了。
 * 本机没有图像处理库（见 `package.json`），转不了格式 —— 那就**提前说清**，
 * 让他在画布上换一张 PNG / JPG，而不是等一次必然失败、又指向错误方向的调用。
 *
 * 抽出来的帧一律是 PNG，所以视频那条路不会撞上这一条。
 */
const SUPPORTED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** 从文件头认格式：扩展名会骗人（工作流落盘常常就叫 `media.png`，实际可能是 webp）。 */
function sniffMime(bytes: Uint8Array): string | null {
  const at = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, 4) === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (at(0, 4) === 'GIF8')) return 'image/gif';
  if (bytes.length >= 12 && at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (bytes.length >= 12 && at(4, 8) === 'ftyp' && /^avif$|^avis$/.test(at(8, 12))) return 'image/avif';
  return null;
}

function mimeOf(name: string, bytes: Uint8Array, declared?: string | null): string {
  const ext = String(name || '').split('?')[0].split('.').pop()?.toLowerCase() || '';
  return sniffMime(bytes) || EXT_MIME[ext] || String(declared || '').toLowerCase().split(';')[0].trim() || 'image/png';
}

function tooBig(size: number, limit: number, label: string) {
  if (size > limit) {
    throw new ApiError(400, `这份${label}有 ${(size / 1024 / 1024).toFixed(1)} MB，超过 ${limit / 1024 / 1024} MB 的上限，发不出去了。换一份小一点的试试。`);
  }
}

/** 取一份媒体的字节 —— 图与视频共用这一段，差别只在体积上限与后面的处理。 */
async function fetchBytes(value: unknown, userId: string, limit: number, label: string) {
  const source = String(value ?? '').trim();
  if (!source) throw new ApiError(400, `这份${label}还没有地址 —— 先让上游那个节点跑出来，再反推。`);
  if (source.startsWith('blob:')) throw new ApiError(400, `这份${label}还在上传中（本地预览地址），等它上传完再反推。`);

  let bytes: Uint8Array;
  let name = '';
  let declared: string | null = null;
  try {
    const canvas = parseCanvasMediaUrl(source);
    const assetId = canvas ? '' : (source.match(ASSET_PATH)?.[1] || '');
    if (canvas) {
      /*
       * 画布素材（2026-10-10）：拖 / 粘进画布的那份就这一种地址、且没有 Asset 记录。
       * 少了这一支的症状是「在画布上贴了张图、点看图反推却说认不出这个地址」——
       * 而那份字节就躺在盘上（`openCanvasMedia` 认归属、读盘即得）。
       */
      const media = await openCanvasMedia({ userId, projectId: canvas.projectId, file: canvas.file });
      if (!media) throw new Error('这份素材已经不在盘上了 —— 重新拖一次。');
      tooBig(media.size, limit, label);
      name = media.name || `media.${media.ext || 'png'}`;
      declared = media.mime;
      /* Buffer 是共享内存上的视图，交出去之前先拷成独立的一段。 */
      const buffer = await readFile(/*turbopackIgnore: true*/ media.path);
      bytes = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    } else if (assetId) {
      const asset = await openMediaAsset(assetId, userId);
      tooBig(asset.size, limit, label);
      name = asset.name || `media.${asset.path.split('.').pop() || 'png'}`;
      declared = asset.mime;
      /* Buffer 是共享内存上的视图，交出去之前先拷成独立的一段。 */
      const buffer = await readFile(/*turbopackIgnore: true*/ asset.path);
      bytes = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    } else if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
      const got = Number(response.headers.get('content-length') || 0);
      if (got) tooBig(got, limit, label);
      const buffer = await response.arrayBuffer();
      tooBig(buffer.byteLength, limit, label);
      name = source.split('?')[0];
      declared = response.headers.get('content-type');
      bytes = new Uint8Array(buffer);
    } else {
      throw new ApiError(400, `认不出「${source}」这个地址 —— 它既不是已落盘的资产，也不是能下载的链接。`);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, `取不到这份${label}（${error instanceof Error ? error.message : '读取失败'}）。它可能是上游留下的远端地址、已经过期了 —— 换一次生成结果再试。`);
  }
  return { bytes, name, declared, source };
}

/** 一张图 → 模型能读的那一串。 */
export async function resolvePromptImage(value: unknown, userId: string): Promise<PromptImage> {
  const got = await fetchBytes(value, userId, PROMPT_IMAGE_MAX_BYTES, '图');
  const mime = mimeOf(got.name, got.bytes, got.declared);
  if (!SUPPORTED_MIME.has(mime)) {
    throw new ApiError(400, `这张图是 ${mime}，视觉模型一般不认这个格式 —— 在画布上换成 PNG / JPG / WebP 再反推。`);
  }
  return { mime, base64: Buffer.from(got.bytes).toString('base64'), bytes: got.bytes.byteLength };
}

/**
 * 一段视频 → **若干张**模型能读的图。
 *
 * FFmpeg 只吃**本地文件**，所以远端地址要先落到一个临时文件里。
 * 用完就删：这个临时目录在系统 temp 下，留着只会一天天涨。
 */
export async function resolvePromptVideo(value: unknown, userId: string): Promise<PromptImage[]> {
  const got = await fetchBytes(value, userId, PROMPT_VIDEO_MAX_BYTES, '视频');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'frame-prompt-video-'));
  const file = path.join(dir, 'input.mp4');
  try {
    await writeFile(/*turbopackIgnore: true*/ file, got.bytes);
    const frames = await sampleFramesPng({ file, cacheKey: `${userId}-${Date.now()}` });
    return frames.map(buf => ({
      mime: 'image/png',
      base64: buf.toString('base64'),
      bytes: buf.byteLength,
    }));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, `这段视频没能抽出帧（${error instanceof Error ? error.message : '解码失败'}）。换一段能正常播放的视频试试。`);
  } finally {
    await rm(/*turbopackIgnore: true*/ dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 抽帧张数（界面上要说清「看着 N 帧反推」）。 */
export { PROMPT_VIDEO_FRAMES };
