import { readFile } from 'node:fs/promises';
import { ApiError } from '@/lib/api';
import { openMediaAsset } from '@/lib/media';

/**
 * 图生视频的**首帧图**：把画布给的地址变成「网关能吃的东西」。
 *
 * 与 `lib/referenceImages.ts`（那边的目标是 RunningHub 文件名）不同，这里要的是**字节或可下载的地址**：
 * - 地址已经是 `http(s)://` 的 → 网关自己下得到，原样传过去（`{ url }`）；
 * - 地址是本地 `/api/assets/...` 的 → **网关下不到我们机器上的文件**，必须在这里读成字节再转发（`{ file }`）。
 *
 * 第二种是主要场景：图片生成节点跑出来的图都落盘在本地。要是把 `/api/assets/...` 直接塞给网关，
 * 结果是任务成功、视频和首帧图毫无关系 —— 正是这个项目一直在防的那种静默失败。
 *
 * 与自定义接口出图取参考图（`lib/providers/referenceBytes.ts`）是同一件事的两次出现，
 * 但两边服务的网关不同、上限不同，所以各写各的，不共用。
 */

/** 首帧图的体积上限。视频网关对首帧图普遍比「参考图列表」更宽容，但也不该无上限地转。 */
export const VIDEO_API_MAX_FIRST_FRAME_BYTES = 20 * 1024 * 1024;

/** `/api/assets/<id>/media.<ext>` —— 落盘媒体的地址形状。 */
const ASSET_PATH = /^\/api\/assets\/([0-9a-f-]{8,64})\/[^/]+$/i;

export type FirstFrame = { url: string } | { file: File };

export async function readFirstFrame(value: string | undefined, userId: string): Promise<FirstFrame | undefined> {
  const source = String(value ?? '').trim();
  if (!source) return undefined;

  /** 网关自己下得到的地址，不碰字节。 */
  if (/^https?:\/\//i.test(source)) return { url: source };

  const assetId = source.match(ASSET_PATH)?.[1];
  if (!assetId) {
    throw new ApiError(400, `认不出「${source}」这个首帧图地址 —— 它既不是已落盘的资产，也不是网关能下载的链接。`);
  }

  let asset;
  try {
    asset = await openMediaAsset(assetId, userId);
  } catch (error) {
    throw new ApiError(400, `取不到首帧图（${error instanceof Error ? error.message : '读取失败'}）。请换一张图，或重新生成一次。`);
  }
  if (asset.size > VIDEO_API_MAX_FIRST_FRAME_BYTES) {
    const mb = (asset.size / 1024 / 1024).toFixed(1);
    throw new ApiError(400, `首帧图有 ${mb} MB，超过 20 MB 的上限，传不到视频网关。请换一张更小的图。`);
  }

  const buffer = await readFile(/*turbopackIgnore: true*/ asset.path);
  /** Buffer 是共享内存上的视图，丢给 File 之前先拷成独立的一段。 */
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const name = asset.name || `first-frame.${asset.path.split('.').pop() || 'png'}`;
  return { file: new File([bytes], name) };
}
