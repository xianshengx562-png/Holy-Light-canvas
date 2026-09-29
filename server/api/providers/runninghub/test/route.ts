import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { verifyConnection } from '@/lib/providers/runninghub/verify';
import { isRunningHubSite } from '@/lib/providers/runninghub/connection';

/**
 * 探活一次 RunningHub 连接。
 *
 * 2026-09-21 起接受一个可选的 `site`：两个站是**独立账号**，不指定就只能测「当前那个站」，
 * 而「模型服务」页要的正是**两段各测一次**（填了海外站的 Key，得能在没切换过去的情况下验证它）。
 * 不传就测当前站 —— 老调用点（服务连接页）的行为不变。
 */
const schema = z.object({ site: z.string().trim().max(8).optional() }).optional();

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const parsed = schema.safeParse(await jsonBody(request, 1024).catch(() => null));
    if (!parsed.success) throw new ApiError(400, '请求体格式不对。');
    const site = parsed.data?.site;
    if (site !== undefined && !isRunningHubSite(site)) throw new ApiError(400, `未知的站点：${site}`);
    return Response.json(await verifyConnection(user.id, site));
  });
}
