import { readFile } from 'node:fs/promises';
import { ApiError } from '@/lib/api';
import { openMediaAsset } from '@/lib/media';
import { uploadMediaCached } from '@/lib/providers/runninghub/client';
import { uploadOrExplain } from '@/lib/upload';

/**
 * 参考图的体积上限（与 `/api/providers/runninghub/upload` 同数）。
 * 参考图落在 100 MB 以内基本是常识，这里只防「文件过大传不上去」那一类静默失败。
 */
export const REFERENCE_IMAGE_MAX_BYTES = 100 * 1024 * 1024;

/** `/api/assets/<id>/media.<ext>` —— 落盘媒体的地址形状，扩展名决定了 MIME 与文件名后缀。 */
const ASSET_PATH = /^\/api\/assets\/([0-9a-f-]{8,64})\/[^/]+$/i;

/** `label` 由调用方传进来：视频 / 音频复用的就是这条「取字节 → 重传」的路子，报错文案得跟着变。 */
function tooBig(size: number, label = '参考图') {
  if (size > REFERENCE_IMAGE_MAX_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    throw new ApiError(400, `${label}有 ${mb} MB，超过 100 MB 的上限，传不到工作流里。请换一份更小的文件。`);
  }
}

/**
 * 把一张参考图换成 RunningHub 认得的文件名，与超清（`resolveUpscaleInput`）同一个道理：
 * 画布上拿到的很可能是「已落盘的本地资产」（`/api/assets/...`，比如图片生成节点跑出来的那张图），
 * 而工作流的参考图加载器吃的是 RunningHub 自己那边的文件名。不重传、直接把本地地址塞进去，
 * 结果是任务成功、但参考图根本没生效（出来的视频 / 图片和输入毫无关系）—— 正是要防的静默失败。
 *
 * 与跨平台取参考图（那个要解决「跨越另一个平台」）不同，这里是**同一平台**：
 * 传上去拿名字就行，不需要把字节转发过去两次。
 *
 * 三种形态：
 * 1. `/api/assets/<id>/media.<ext>` —— 常规路径，落盘的媒体，读盘即得字节；
 * 2. `http(s)://...` —— 落盘失败时结果里留的是 RunningHub 原始地址，下载下来再传
 *    （原始地址只有 24 小时有效，过期会失败，所以报错要说清是取不到字节）；
 * 3. 不带斜杠的一串文件名 —— 用户手填的远端文件名（如 `xxxx.png`），原样透传
 *    （和手动填写参考图字段同一个用法，图片输入节点走的就是这条路）。
 */
/**
 * `options` 只影响「值是个链接、要下载下来再传」那一路：
 * - `fallbackName` 决定落盘文件的名字与后缀 —— RunningHub **靠扩展名认类型**，
 *   所以视频 / 音频必须各自给一个带正确后缀的名字（reference.mp4 / reference.mp3），
 *   一律回落成 png 会让对端把它当图片处理。
 * - `label` 只进报错文案（「取不到参考图」→「取不到视频」）。
 * 落盘资产那一路不受影响：`name` 直接取资产自己记的文件名。
 * - `upload` 是「拿到字节之后送到哪儿」。**默认送到 RunningHub**；本地模式下由
 *   `lib/providers/local` 传进来一个改投本机 ComfyUI 的上传函数 ——
 *   「取字节」这一段两条路完全一样，只有最后这一步不同，所以做成参数而不是再抄一遍全文。
 */
export async function resolveReferenceImage(
  value: string | undefined,
  userId: string,
  apiKey: string,
  options: { fallbackName?: string; label?: string; upload?: (file: File) => Promise<string> } = {},
): Promise<string> {
  const label = options.label || '参考图';
  const fallbackExt = String(options.fallbackName || 'reference.png').split('.').pop() || 'png';
  const source = String(value ?? '').trim();
  if (!source) return source;
  /* 没有斜杠 = 已经是 RunningHub 上的文件名，直接透传，不碰字节。 */
  if (!source.includes('/')) return source;

  let bytes: ArrayBuffer;
  let name = options.fallbackName || 'reference.png';
  try {
    const assetId = source.match(ASSET_PATH)?.[1];
    if (assetId) {
      const asset = await openMediaAsset(assetId, userId);
      tooBig(asset.size, label);
      name = asset.name || `reference.${asset.path.split('.').pop() || 'png'}`;
      /* Buffer 是共享内存上的视图，丢指针给 File 之前先拷成独立的一段。 */
      const buffer = await readFile(/*turbopackIgnore: true*/ asset.path);
      bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    } else if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared) tooBig(declared, label);
      const buffer = await response.arrayBuffer();
      tooBig(buffer.byteLength, label);
      /** 没有扩展名时 RunningHub 认不出类型，所以从 MIME 反推一个后缀补上去。 */
      const ext = (source.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1]) || mimeExt(response.headers.get('content-type')) || fallbackExt;
      name = `reference.${ext || 'png'}`;
      bytes = buffer;
    } else {
      throw new ApiError(400, `认不出「${source}」这个地址 —— 它既不是已落盘的资产，也不是能下载的链接。`);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, `取不到${label}（${error instanceof Error ? error.message : '读取失败'}）。它可能是 RunningHub 的原始地址、已经过期了 —— 换一次生成结果再试。`);
  }

  const uploader = options.upload || ((file: File) => uploadMediaCached(file, apiKey).then(item => item.fileName));
  /* 与超清那条同一条规矩：上传失败要报「哪一份东西、上游为什么」，别被兜成「服务暂时不可用」。 */
  return uploadOrExplain(label, () => uploader(new File([bytes], name)));
}

export async function resolveReferenceImages(
  values: string[] | undefined,
  userId: string,
  apiKey: string,
  upload?: (file: File) => Promise<string>,
): Promise<string[] | undefined> {
  if (!values?.length) return values;
  return Promise.all(values.map(value => resolveReferenceImage(value, userId, apiKey, { upload })));
}

/**
 * 从 MIME 反推文件后缀。认不出来时返回 null，由调用方用自己的兜底后缀 ——
 * 视频 / 音频的兜底是 mp4 / mp3，一律回落成 png 会让 RunningHub 把上传物当成图片。
 */
function mimeExt(contentType: string | null) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  if (type.includes('avif')) return 'avif';
  if (type.includes('webm')) return 'webm';
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('mpeg')) return 'mp3';
  if (type.includes('wav') || type.includes('x-wav')) return 'wav';
  if (type.includes('aac')) return 'aac';
  if (type.includes('ogg')) return 'ogg';
  return null;
}

/** 视频 / 音频输入节点的媒体：与参考图同一条「取字节 → 重传 → 拿文件名」的路子，只是后缀与报错文案不同。 */
export function resolveVideoInput(value: string | undefined, userId: string, apiKey: string, upload?: (file: File) => Promise<string>) {
  return resolveReferenceImage(value, userId, apiKey, { fallbackName: 'reference.mp4', label: '视频', upload });
}
export function resolveAudioInput(value: string | undefined, userId: string, apiKey: string, upload?: (file: File) => Promise<string>) {
  return resolveReferenceImage(value, userId, apiKey, { fallbackName: 'reference.mp3', label: '音频', upload });
}

/**
 * **多份**视频 / 音频：画布上连了几个输入节点就有几份，逐份走同一条「取字节 → 重传」的路。
 * 单份那两个函数还在（MCP 之类只交一份的调用方仍在用），这里是新客户端走的那一档。
 */
export async function resolveVideoInputs(
  values: string[] | undefined,
  userId: string,
  apiKey: string,
  upload?: (file: File) => Promise<string>,
): Promise<string[] | undefined> {
  if (!values?.length) return values;
  return Promise.all(values.map(value => resolveVideoInput(value, userId, apiKey, upload)));
}
export async function resolveAudioInputs(
  values: string[] | undefined,
  userId: string,
  apiKey: string,
  upload?: (file: File) => Promise<string>,
): Promise<string[] | undefined> {
  if (!values?.length) return values;
  return Promise.all(values.map(value => resolveAudioInput(value, userId, apiKey, upload)));
}
