import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { describeOutputDir, saveOutputRoot } from '@/lib/output-dir';

/**
 * 产出落盘目录的读写（桌面版）。
 *
 * 云端版的产出必须落在服务端自己的 `storage/` 里（用户挑不了，也不该挑），
 * 所以这个接口只在桌面版有意义；但路由对两个版本都开着也无害——云端版调它
 * 也只是把配置写进服务端的 storage 目录，那本来就是默认位置。
 *
 * `PUT` 传 `dir: null` = 恢复默认。
 */
const schema = z.object({
  dir: z.string().trim().max(500).nullable(),
});

export async function GET() {
  return api(async () => {
    await apiUser();
    return Response.json(await describeOutputDir());
  });
}

export async function PUT(request: Request) {
  return api(async () => {
    checkOrigin(request);
    await apiUser();
    const parsed = schema.safeParse(await jsonBody(request, 8 * 1024));
    if (!parsed.success) throw new ApiError(400, '输出目录无效。');
    try {
      return Response.json(await saveOutputRoot(parsed.data.dir));
    } catch (error) {
      /** 「写不进去」「不是绝对路径」都是用户下一秒就能改好的事，一律 400 说人话。 */
      throw new ApiError(400, error instanceof Error ? error.message : '输出目录无效。');
    }
  });
}
