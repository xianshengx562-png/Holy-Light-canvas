import { api, ApiError, apiUser, checkOrigin, jsonBody } from '@/lib/api';
import { job, startExport, type JoinClip } from '@/lib/video-ffmpeg';

/**
 * 起一次拼接（POST）+ 查进度（GET）。
 *
 * 为什么不是一个 POST 把活干完：后端进程的 `writeResponse()` 会把响应**整块 buffer 完
 * 才往下写**（见 `electron/backend/index.ts`），SSE 那种「边跑边推」在这里根本流不出去。
 * 所以 POST 只负责起任务、立刻回一个 id，进度由前端按 400ms 轮询 GET。
 *
 * 轮询而不是长连接的另一个好处：刷新页面也不会丢进度 —— 任务在后端进程里，id 还在就能查。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const body = await jsonBody(request, 65536);
    const raw = Array.isArray(body.clips) ? body.clips : [];
    if (!raw.length) throw new ApiError(400, '还没有素材 —— 先加几段再导出。');
    if (raw.length > 60) throw new ApiError(400, '一次最多拼 60 段。');

    const clips: JoinClip[] = raw.map((item) => {
      const entry = (item || {}) as Record<string, unknown>;
      return {
        assetId: String(entry.assetId ?? '').trim(),
        start: Math.max(0, Math.floor(Number(entry.start ?? 0)) || 0),
        end: Math.max(0, Math.floor(Number(entry.end ?? 0)) || 0),
        imageFrames: Math.max(1, Math.floor(Number(entry.imageFrames ?? 5)) || 5),
      };
    });
    if (clips.some((item) => !item.assetId)) throw new ApiError(400, '有素材没认出来 —— 重新加一次试试。');

    const id = startExport({ userId: user.id, clips, outputName: String(body.outputName ?? '') });
    return Response.json({ id });
  });
}

export async function GET(request: Request) {
  return api(async () => {
    await apiUser();
    const id = String(new URL(request.url).searchParams.get('id') || '').trim();
    if (!id) throw new ApiError(400, '没有给任务号。');
    const found = job(id);
    if (!found) throw new ApiError(404, '这个任务已经不在了（可能已经过了很久）。');
    return Response.json(found);
  });
}
