import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { ApiError, api, apiUser } from '@/lib/api';
import { openCanvasMedia } from '@/lib/canvas-media';

/**
 * 画布素材的取流接口：`/api/canvas-media/{projectId}/{uuid}.{ext}`。
 *
 * 与 `/api/assets/{id}/media.{ext}` 同一套行为（支持 Range，`<video>` 拖进度条才不会
 * 每次从头下），唯一的差别是**它不查 Asset 表** —— 画布素材压根没有记录，
 * 归属由「projectId 属于当前账号」这一条保证（见 `openCanvasMedia`）。
 *
 * 扩展名留在路径里而不是写成 query，理由与资产那条相同：`isVideoUrl()`
 * 靠「扩展名紧跟结尾」判类型，写成 query 会让画布上所有渲染判断失效。
 */
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; file: string }> }) {
  return api(async () => {
    const user = await apiUser();
    const { projectId, file } = await params;
    /* 形状不对（含 `..`、含斜杠）一律 404，别让它有机会被拼进路径里。 */
    const media = await openCanvasMedia({ userId: user.id, projectId, file });
    if (!media) throw new ApiError(404, '文件不存在。');

    const headers: Record<string, string> = {
      'content-type': media.mime,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=31536000, immutable',
    };
    if (new URL(request.url).searchParams.has('download')) {
      headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(media.name)}`;
    }

    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), media.size - 1) : media.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= media.size) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${media.size}` } });
      }
      const stream = Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ media.path, { start, end })) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${media.size}`, 'content-length': String(end - start + 1) },
      });
    }

    const stream = Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ media.path)) as ReadableStream<Uint8Array>;
    return new Response(stream, { status: 200, headers: { ...headers, 'content-length': String(media.size) } });
  });
}
