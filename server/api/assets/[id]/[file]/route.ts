import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { ApiError, api, apiUser } from '@/lib/api';
import { mediaExtOf, openMediaAsset } from '@/lib/media';

/**
 * 落盘媒体的取流接口：`/api/assets/{id}/media.mp4`。
 *
 * 之所以让扩展名留在路径里而不是用 query（`?ext=mp4`），是因为 `isVideoUrl()`
 * 靠「扩展名紧跟结尾」判断类型——写成 query 会让所有渲染判断失效。
 * 这也是为什么不复用 `/download`：那个接口给 gzip 过的 latent 用，行为不一样。
 *
 * 支持 Range，`<video>` 拖进度条才不会每次从头下。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  return api(async () => {
    const user = await apiUser();
    const { id, file } = await params;
    if (!/^media\.[a-z0-9]+$/i.test(file) || !mediaExtOf(file)) throw new ApiError(404, '文件不存在。');

    let asset;
    try { asset = await openMediaAsset(id, user.id); }
    catch (error) { throw new ApiError(404, error instanceof Error ? error.message : '媒体不存在。'); }

    const headers: Record<string, string> = {
      'content-type': asset.mime,
      'accept-ranges': 'bytes',
      // 媒体不会变，文件名里带着 asset id，可以直接长缓存
      'cache-control': 'private, max-age=31536000, immutable',
    };
    if (new URL(request.url).searchParams.has('download')) {
      headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`;
    }

    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), asset.size - 1) : asset.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= asset.size) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${asset.size}` } });
      }
      const stream = Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ asset.path, { start, end })) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${asset.size}`, 'content-length': String(end - start + 1) },
      });
    }

    const stream = Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ asset.path)) as ReadableStream<Uint8Array>;
    return new Response(stream, { status: 200, headers: { ...headers, 'content-length': String(asset.size) } });
  });
}
