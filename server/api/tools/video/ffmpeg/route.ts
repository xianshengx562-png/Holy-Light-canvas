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
    /*
     * 空串是**一个有效指令**：清掉自定义配置、回到随包自带的那一份。
     * 以前这里把空串当参数错误挡掉了，于是「用回自带的」这件事没有入口。
     */
    const value = String(body.path ?? '').trim();
    return Response.json(await saveFfmpeg(value));
  });
}
