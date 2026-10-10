import 'server-only';
import { readFile } from 'node:fs/promises';
import { imageExtOfBuffer, imageMimeOfExt, mediaExtOf, openMediaAsset } from '@/lib/media';
import { openCanvasMedia, parseCanvasMediaUrl } from '@/lib/canvas-media';
import {
  IMAGE2_MAX_REFERENCES,
  IMAGE2_MAX_REFERENCE_BYTES,
  IMAGE2_MAX_REFERENCE_TOTAL,
} from '@/lib/workflows/image2Params';

/**
 * 把画布上的参考图**变成字节** —— 同步出图那几档要的是文件本身，不是文件名。
 *
 * 这条链路和 RunningHub 那边完全不是一回事：工作流那条路只要把 `remoteFile`（远端文件名）
 * 交给 RunningHub 就行，图一直躺在它自己那儿；而直连的那家是另一个平台，
 * 它不认识 RunningHub 的文件名，所以我们得在这里把图取回来、再当成上传文件转过去。
 *
 * （2026-09-23：这个文件原来叫 `lib/providers/image2/references.ts`。Image 2.0 整条删掉之后
 *  只剩「自定义接口出图」还在用它，所以搬到一个不带引擎名字的地方，名字也改成
 *  `fetchReferenceBytes` —— 它回答的是「把这张参考图取成字节」，跟哪家引擎无关。）
 *
 * 能取到字节的只有三种地址：
 *   1. `/api/assets/<id>/media.<ext>` —— 已经落盘的结果图，直接读磁盘（快、不过期）；
 *   2. `/api/canvas-media/<projectId>/<uuid>.<ext>` —— **拖 / 粘进画布的那张**（2026-10-10 补）。
 *      它刻意没有 Asset 记录（不进资产库），走 `openMediaAsset` 会报「媒体不存在」，
 *      于是「不进资产库」顺带把「自定义接口用不了它」也带上了 —— 那不是他要的；
 *   3. `http(s)://...` —— 上传到 RunningHub 后拿到的预览地址（**24 小时过期**，过期只能重传）。
 *
 * `blob:` / `data:` 一律明确拒绝：那只是浏览器会话里的本地预览，服务端根本没有字节可取。
 * 不说清楚的话症状是「图出来了，但和我的参考图毫无关系」——正是这套 UI 一直在防的静默失败。
 */
export type ReferenceBytes = {
  bytes: Buffer;
  ext: string;
  mime: string;
  /** multipart 里的文件名。带序号，方便在网关那边一眼看出是第几张。 */
  name: string;
};

const fetchTimeout = 60_000;

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 本地资产地址 `/api/assets/<id>/media.png` → 资产 id。认不出来返回空串。 */
function localAssetId(url: string) {
  const segments = url.split(/[?#]/)[0].split('/').filter(Boolean);
  return segments[0] === 'api' && segments[1] === 'assets' ? segments[2] || '' : '';
}

/**
 * 取回这次生成要用到的全部参考图。**失败就抛中文错误**（由调用方转成 400）——
 * 取不到图还硬发出去，跑出来的就是一张和参考图无关的图，界面上什么都不会说。
 *
 * 数量与体积的闸门都在这里：**它在扣分之前跑**，取不到图不该花积分。
 */
export async function fetchReferenceBytes(input: { userId: string; urls: string[] }): Promise<ReferenceBytes[]> {
  const urls = (input.urls || []).map(item => String(item || '').trim()).filter(Boolean);
  if (urls.length > IMAGE2_MAX_REFERENCES) {
    throw new Error(`最多只能用 ${IMAGE2_MAX_REFERENCES} 张参考图，这次接了 ${urls.length} 张。`);
  }

  const out: ReferenceBytes[] = [];
  let total = 0;
  for (const [index, url] of urls.entries()) {
    const label = `第 ${index + 1} 张参考图`;
    let bytes: Buffer;
    if (/^blob:/i.test(url) || /^data:/i.test(url)) {
      throw new Error(`${label}只有浏览器本地的预览地址，服务端取不到它的字节 —— 请重新上传这张图。`);
    }
    const assetId = localAssetId(url);
    const canvas = assetId ? null : parseCanvasMediaUrl(url);
    if (canvas) {
      /*
       * 画布素材（2026-10-10）：拖 / 粘进画布的图就这一种地址。
       * 少了这一支的症状是「自定义接口出图时参考图上传不了」——
       * 图上明明在、线也连好了，服务端却说「第 1 张参考图的地址取不到字节」，
       * 而它其实就躺在盘上（`openCanvasMedia` 认归属、读盘即得）。
       */
      try {
        const media = await openCanvasMedia({ userId: input.userId, projectId: canvas.projectId, file: canvas.file });
        if (!media) throw new Error('这份素材已经不在盘上了 —— 重新拖一次。');
        if (media.size > IMAGE2_MAX_REFERENCE_BYTES) {
          throw new Error(`${label}有 ${megabytes(media.size)}，超过单张 ${megabytes(IMAGE2_MAX_REFERENCE_BYTES)} 的上限。`);
        }
        bytes = await readFile(/*turbopackIgnore: true*/ media.path);
      } catch (error) {
        throw new Error(`${label}读不出来：${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (assetId) {
      try {
        const file = await openMediaAsset(assetId, input.userId);
        if (file.size > IMAGE2_MAX_REFERENCE_BYTES) {
          throw new Error(`${label}有 ${megabytes(file.size)}，超过单张 ${megabytes(IMAGE2_MAX_REFERENCE_BYTES)} 的上限。`);
        }
        bytes = await readFile(/*turbopackIgnore: true*/ file.path);
      } catch (error) {
        /** `openMediaAsset` 那两条文案（不存在 / 未落盘）不带序号，套一层让人知道是哪张。 */
        throw new Error(`${label}读不出来：${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (/^https?:\/\//i.test(url)) {
      let response: Response;
      try {
        response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(fetchTimeout) });
      } catch (error) {
        throw new Error(`${label}下载失败（${error instanceof Error ? error.message : String(error)}）—— 参考图地址可能已过期，请重新上传。`);
      }
      if (!response.ok) {
        throw new Error(`${label}下载失败（HTTP ${response.status}）—— 参考图地址可能已过期，请重新上传。`);
      }
      bytes = Buffer.from(await response.arrayBuffer());
    } else {
      throw new Error(`${label}的地址取不到字节（${url.slice(0, 40)}）。`);
    }

    if (!bytes.length) throw new Error(`${label}取回来是空的，请重新上传这张图。`);
    if (bytes.length > IMAGE2_MAX_REFERENCE_BYTES) {
      throw new Error(`${label}有 ${megabytes(bytes.length)}，超过单张 ${megabytes(IMAGE2_MAX_REFERENCE_BYTES)} 的上限 —— 请压缩后重新上传。`);
    }
    total += bytes.length;
    if (total > IMAGE2_MAX_REFERENCE_TOTAL) {
      throw new Error(`参考图合计 ${megabytes(total)}，超过 ${megabytes(IMAGE2_MAX_REFERENCE_TOTAL)} 的总上限 —— 请减少张数或压缩后再试。`);
    }

    const ext = mediaExtOf(url) || imageExtOfBuffer(bytes);
    out.push({ bytes, ext, mime: imageMimeOfExt(ext), name: `reference-${index + 1}.${ext}` });
  }
  return out;
}
