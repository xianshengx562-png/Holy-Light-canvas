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
 *
 * 🔴 2026-10-13：后端加了「最短 3 分钟才真去问站点」那道闸（见 `site-guard`），
 *    所以多一个 `?force=1`：定时轮询走闸门，**生成结束 / 手动点刷新走 force** ——
 *    「刚花完钱，余额却还是三分钟前的」是最刺眼的那一种错。
 */
export async function GET(request: Request) {
  return api(async () => {
    const user = await apiUser();
    const force = new URL(request.url).searchParams.get('force') === '1';
    return Response.json({ balance: await loadSiteBalance(user.id, force) });
  });
}
