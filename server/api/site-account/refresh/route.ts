import { api, apiUser } from '@/lib/api';
import { loadSiteBalance } from '@/lib/providers/site';

/**
 * 站点余额的**轻量刷新**（2026-09-28）。
 *
 * 与同级的 `GET /api/site-account` 只差一件事，但那件事决定了「准实时」可不可行：
 * 这里**只打站点一次**（`/api/user/self`），不列令牌清单。
 * 站点那边是「同一 IP、20 次 / 20 分钟」的限流，而余额是**定时**去问的
 * （前端：回前台一趟 + 每 2 分钟一趟 + 每次生成结束一趟），省掉一半请求才撑得住。
 *
 * 所以回包里**没有 tokens** —— 前端合并时保留原来那份，令牌清单不会因为刷余额而变空。
 */
export async function GET() {
  return api(async () => {
    const user = await apiUser();
    return Response.json({ balance: await loadSiteBalance(user.id) });
  });
}
