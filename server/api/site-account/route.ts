import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { clearSite, connectSite, loadSiteAccount } from '@/lib/providers/site';

/**
 * 中转站的**网站账号**（2026-09-25）。
 *
 * 与早先那个 `providers/custom/site-login` 的区别只有一条，但是最关键的一条：
 * **这一族接口不建令牌**。徐先要的是「直接拉取登录账号密钥」—— 站点上有什么就列什么，
 * 他挑一把，我们把它加成兼容接口。建令牌的事交回站点自己的网页（那儿本来就有按钮，
 * 也看得见额度与过期时间），Holy Light画布不替用户在别人的站上造东西。
 *
 * 三个动作：
 *   GET    读账号（余额 + 这个账号已有的密钥清单）
 *   POST   登录并记住（密码加密落盘，第二天 JWT 过期能自动续）
 *   DELETE 换账号 / 退出（连密码一起删掉，不留任何凭据）
 */
export async function GET() {
  return api(async () => {
    const user = await apiUser();
    return Response.json({ site: await loadSiteAccount(user.id) });
  });
}

const schema = z.object({
  baseUrl: z.string().trim().min(1, '站点地址不能为空。').max(500),
  username: z.string().trim().min(1, '用户名不能为空。').max(120),
  password: z.string().min(1, '密码不能为空。').max(200),
});

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const parsed = schema.safeParse(await jsonBody(request));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    try {
      return Response.json({ site: await connectSite(user.id, parsed.data) });
    } catch (error) {
      /* 站点那一侧的原话（「密码错误」之类）直接给人看，别包一层「登录失败」。 */
      throw new ApiError(400, error instanceof Error ? error.message : '登录站点失败。');
    }
  });
}

export async function DELETE(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    await clearSite(user.id);
    return Response.json({ ok: true });
  });
}
