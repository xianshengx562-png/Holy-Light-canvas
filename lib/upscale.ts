import { readFile } from 'node:fs/promises';
import { ApiError } from '@/lib/api';
import { openMediaAsset } from '@/lib/media';
import { uploadMediaCached } from '@/lib/providers/runninghub/client';
import { uploadOrExplain } from '@/lib/upload';

/**
 * 一次上传的体积上限，与 `/api/providers/runninghub/upload` 那条路由同一个数。
 *
 * 它同时也是「能不能超清」的判断依据：生成出来的视频落盘后动辄几百 MB，
 * 超 100 MB 就传不上去 —— 必须**在扣分之前**说清，不能让用户花了积分才发现。
 */
export const UPSCALE_MAX_BYTES = 100 * 1024 * 1024;

/** `/api/assets/<id>/media.<ext>` —— 落盘媒体的地址形状，扩展名决定了 MIME 与文件名后缀。 */
const ASSET_PATH = /^\/api\/assets\/([0-9a-f-]{8,64})\/[^/]+$/i;

function tooBig(size: number, label: string) {
  if (size > UPSCALE_MAX_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    throw new ApiError(400, `要超清的${label}有 ${mb} MB，超过 100 MB 的上限，传不到工作流里。请先把它压小，或用别的工作流。`);
  }
}

/**
 * 把画布上的「待超清媒体」换成 RunningHub 认得的文件名。
 *
 * 为什么必须重新上传：RunningHub 的工作流输入吃的是**它自己那边的文件名**
 * （跟参考图字段一样），而我们手上这份是已经落盘的本地资产（`/api/assets/...`）。
 * 直接把本地地址塞进去，工作流收到的是一个它取不到的路径 —— 症状通常是「任务成功、
 * 出来的却是和输入毫无关系的东西」，正是这套 UI 一直在防的那种静默失败。
 *
 * 与跨平台取参考图（那个要解决「跨越另一个平台」）不同，这里是**同一平台**：
 * 传上去拿名字就行，不需要把字节转发过去两次。
 *
 * 三种形态：
 * 1. `/api/assets/<id>/media.<ext>` —— 常规路径，落盘的媒体，读盘即得字节；
 * 2. `http(s)://...` —— 落盘失败时结果里留的是 RunningHub 原始地址，下载下来再传
 *    （原始地址只有 24 小时有效，过期会失败，所以报错要说清是取不到字节）；
 * 3. 不带斜杠的一串文件名 —— 用户手填的远端文件名，原样透传（和手动填写参考图字段同一个用法）。
 *
 * `upload` 是「拿到字节之后送到哪儿」，默认送 RunningHub；本地模式传一个改投本机 ComfyUI 的函数
 * （与 `lib/referenceImages.ts` 同一条规矩：只有最后这一步不同，所以做成参数而不是抄一遍）。
 */
export async function resolveUpscaleInput(
  value: string,
  userId: string,
  apiKey: string,
  upload?: (file: File) => Promise<string>,
): Promise<string> {
  const source = String(value ?? '').trim();
  if (!source) throw new ApiError(400, '没有拿到要超清的媒体 —— 请先在节点上生成一次，再点超清。');
  if (!source.includes('/')) return source;

  let bytes: ArrayBuffer;
  let name = 'input.mp4';
  try {
    const assetId = source.match(ASSET_PATH)?.[1];
    if (assetId) {
      const asset = await openMediaAsset(assetId, userId);
      tooBig(asset.size, '媒体');
      name = asset.name || `input.${asset.path.split('.').pop() || 'mp4'}`;
      /* Buffer 是共享内存上的视图，丢指针给 File 之前先拷成独立的一段。 */
      const buffer = await readFile(/*turbopackIgnore: true*/ asset.path);
      bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    } else if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared) tooBig(declared, '媒体');
      const buffer = await response.arrayBuffer();
      tooBig(buffer.byteLength, '媒体');
      /** 没有扩展名时 RunningHub 认不出类型，所以从 MIME 反推一个后缀补上去。 */
      const ext = (source.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1]) || mimeExt(response.headers.get('content-type'));
      name = `input.${ext || 'mp4'}`;
      bytes = buffer;
    } else {
      throw new ApiError(400, `认不出「${source}」这个地址 —— 它既不是已落盘的资产，也不是能下载的链接。`);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, `取不到要超清的媒体（${error instanceof Error ? error.message : '读取失败'}）。它可能是 RunningHub 的原始地址、已经过期了 —— 换一次生成结果再试。`);
  }

  const uploader = upload || ((file: File) => uploadMediaCached(file, apiKey).then(item => item.fileName));
  /* 上传失败要说清「哪一步、为什么」（`uploadOrExplain` 那条注释里就是这一轮撞出来的事）。 */
  return uploadOrExplain('待超清的媒体', () => uploader(new File([bytes], name)));
}

function mimeExt(contentType: string | null) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('webm')) return 'webm';
  if (type.includes('quicktime')) return 'mov';
  if (type.includes('png')) return 'png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  return '';
}
