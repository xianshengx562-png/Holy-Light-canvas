import { api, apiUser, ApiError, checkOrigin } from '@/lib/api';
import { markLocalStatus, readLocalCredentials } from '@/lib/providers/local/connection';
import { testLocalConnection } from '@/lib/providers/local/client';

/**
 * 探一次本机 ComfyUI。打的是 `/system_stats` —— 比真的跑一次生成轻得多，
 * 也不会让用户在「我只是想试试连不连得上」的时候白等一次推理。
 *
 * 探完**把结果写进连接状态**（`markLocalStatus`）：设置页那颗「已验证 / 上次失败」的灯
 * 必须由真实探测结果来点，不能靠「保存过就算好了」糊过去。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const creds = await readLocalCredentials(user.id);
    if (!creds.baseUrl) throw new ApiError(400, '还没填本机 ComfyUI 的地址。');
    const result = await testLocalConnection(creds);
    await markLocalStatus(user.id, result.ok ? 'verified' : 'failed');
    return Response.json(result);
  });
}
