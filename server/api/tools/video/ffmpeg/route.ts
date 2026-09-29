import { api, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { ffmpegStatus, saveFfmpeg } from '@/lib/video-ffmpeg';

/**
 * FFmpeg 的位置：查（GET）与改（POST）。
 *
 * 这一页存在的理由很实在：**ffmpeg 不在 PATH 里是常态**（徐先这台机器上它就躺在一个
 * 带 git hash 的目录里）。自动探测能找到大多数情况，找不到的那部分必须让用户自己
 * 指一下 —— 而不是甩一句「导出失败」。
 */
export async function GET() {
  return api(async () => Response.json(await ffmpegStatus()));
}

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const body = await jsonBody(request);
    const value = String(body.path ?? '').trim();
    if (!value) throw new ApiError(400, '先选一个 ffmpeg.exe，或者它的 bin 目录。');
    return Response.json(await saveFfmpeg(value));
  });
}
