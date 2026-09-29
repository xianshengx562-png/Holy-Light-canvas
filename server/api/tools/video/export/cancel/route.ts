import { api, ApiError, apiUser, checkOrigin, jsonBody } from '@/lib/api';
import { cancelExport } from '@/lib/video-ffmpeg';

/**
 * 取消一次正在跑的拼接：杀掉 ffmpeg + 收掉临时目录。
 *
 * 为什么是单独一个接口而不是「再点一次导出按钮」：
 * 一段 4K 素材归一要跑几分钟，中间没有别的办法让它停 —— 只能关软件，
 * 而关软件还会把那一堆中间 mp4 留在临时目录里。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    await apiUser();
    const body = await jsonBody(request);
    const id = String(body.id ?? '').trim();
    if (!id) throw new ApiError(400, '没有给任务号。');
    return Response.json({ ok: cancelExport(id) });
  });
}
