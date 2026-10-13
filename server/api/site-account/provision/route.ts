import { api, apiUser, ApiError, checkOrigin } from '@/lib/api';
import { provisionSiteProviders } from '@/lib/providers/site';

/**
 * 单独触发一次「自动建令牌 + 按用途建接口」（2026-10-12）。
 *
 * 注册那条路会自动跑一遍，这条是给两种情况的：
 *  · 老账号（登录进来的）从来没开通过，想补一下；
 *  · 上一次开通挂在半路（比如探模型清单超时），想重试。
 *
 * 幂等：令牌按名字复用、接口按名字跳过，重复点不会在站点上堆令牌、也不会撞名报错。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    try {
      return Response.json({ provision: await provisionSiteProviders(user.id) });
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : '自动开通没跑完。');
    }
  });
}
