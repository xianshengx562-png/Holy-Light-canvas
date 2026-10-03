import 'server-only';
import { readFile } from 'node:fs/promises';
import { ApiError } from '@/lib/api';
import { openMediaAsset } from '@/lib/media';

/**
 * 把画布上的一张图变成**模型能读的字节**（2026-10-03：看图反推提示词）。
 *
 * 与 `lib/referenceImages.ts` 是同一件事的两个归宿，别混：
 * - 那边要的是**对端平台的文件名**（上传到 RunningHub / 本机 ComfyUI，再把名字塞进工作流）；
 * - 这边要的是**字节本身** —— 文本模型那头访问不到我们本机的文件，
 *   所以只能内联成 `data:` 一起发过去。
 *
 * 只认两种来源（与 `nodeMeta.isResolvableUrl` 同一套判据）：
 *   1. `/api/assets/<id>/media.<ext>` —— 已落盘的资产，读盘即得；
 *   2. `http(s)://...` —— 上游留在结果里的远端地址，下载下来。
 * `blob:` 那种本地预览**不算**：它只活在渲染进程内存里，服务端取不到字节。
 */
export const PROMPT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

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

/** 太大就别发：base64 会再涨三分之一，很多网关卡在 20MB 那条线上。 */
function assertSize(size: number) {
  if (size > PROMPT_IMAGE_MAX_BYTES) {
    throw new ApiError(400, `这张图有 ${(size / 1024 / 1024).toFixed(1)} MB，超过 ${PROMPT_IMAGE_MAX_BYTES / 1024 / 1024} MB 的上限，发不出去了。换一张小一点的图片试试。`);
  }
}

/**
 * 取一张图的字节。
 *
 * 失败一律是 `ApiError(400)` 且**说清是哪一步** —— 「反推失败」这五个字没有下一步，
 * 而「这张图还没落盘 / 下载不下来 / 格式不认」各自指的路完全不同。
 */
export async function resolvePromptImage(value: unknown, userId: string): Promise<PromptImage> {
  const source = String(value ?? '').trim();
  if (!source) throw new ApiError(400, '这张图还没有地址 —— 先让上游那个节点跑出图来，再反推。');
  if (source.startsWith('blob:')) throw new ApiError(400, '这张图还在上传中（本地预览地址），等它上传完再反推。');

  let bytes: Uint8Array;
  let name = '';
  let declared: string | null = null;
  try {
    const assetId = source.match(ASSET_PATH)?.[1];
    if (assetId) {
      const asset = await openMediaAsset(assetId, userId);
      assertSize(asset.size);
      name = asset.name || `media.${asset.path.split('.').pop() || 'png'}`;
      declared = asset.mime;
      /* Buffer 是共享内存上的视图，交出去之前先拷成独立的一段。 */
      const buffer = await readFile(/*turbopackIgnore: true*/ asset.path);
      bytes = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    } else if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
      const got = Number(response.headers.get('content-length') || 0);
      if (got) assertSize(got);
      const buffer = await response.arrayBuffer();
      assertSize(buffer.byteLength);
      name = source.split('?')[0];
      declared = response.headers.get('content-type');
      bytes = new Uint8Array(buffer);
    } else {
      throw new ApiError(400, `认不出「${source}」这个地址 —— 它既不是已落盘的资产，也不是能下载的链接。`);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, `取不到这张图（${error instanceof Error ? error.message : '读取失败'}）。它可能是上游留下的远端地址、已经过期了 —— 换一次生成结果再试。`);
  }

  const mime = mimeOf(name, bytes, declared);
  if (!SUPPORTED_MIME.has(mime)) {
    throw new ApiError(400, `这张图是 ${mime}，视觉模型一般不认这个格式 —— 在画布上换成 PNG / JPG / WebP 再反推。`);
  }
  return { mime, base64: Buffer.from(bytes).toString('base64'), bytes: bytes.byteLength };
}
