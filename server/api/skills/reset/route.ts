import { api, ApiError, checkOrigin } from '@/lib/api';
import { seedBuiltin } from '@/lib/skills';

/**
 * 恢复内置技能。
 *
 * 存在的理由只有一个：官方技能被删掉、或者被改坏了之后要有条路回来。
 * **默认（body 里没说覆盖）只补缺的**，覆盖全部要显式传 `{"overwrite": true}` ——
 * 「恢复内置」这个动作本身会冲掉用户在官方技能上做的改动，不能让它悄悄发生。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    let overwrite = false;
    try {
      const body = (await request.json()) as { overwrite?: unknown };
      overwrite = body?.overwrite === true;
    } catch {
      /* 没有 body 就是「只补缺」 */
    }
    const result = seedBuiltin(overwrite);
    if (!result.source) throw new ApiError(500, '包里没找到内置技能，重装一下这个版本。');
    return Response.json(result);
  });
}
