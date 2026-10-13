import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { registerAndProvision } from '@/lib/providers/site';

/**
 * 注册 → 登录 → 自动建令牌 → 按用途建成接口（2026-10-12）。
 *
 * 与 `POST /api/site-account`（只有登录）的区别：这条会**在站点上建一个新账号**，
 * 所以验证码是必填的（站点开了 `email_verification`）。
 *
 * 🔴 开通失败**不算注册失败** —— 账号已经建好了，返回体里带 `provisionError` 让人重试，
 *    别把两个动作绑成「一起成功才算成功」，那会让用户在站点上建出一串同名账号。
 */
const schema = z.object({
  baseUrl: z.string().trim().min(1, '站点地址不能为空。').max(500),
  username: z.string().trim().min(1, '用户名不能为空。').max(120),
  password: z.string().min(1, '密码不能为空。').max(200),
  email: z.string().trim().min(1, '邮箱不能为空。').max(200),
  code: z.string().trim().max(32),
});

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const parsed = schema.safeParse(await jsonBody(request));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    try {
      const out = await registerAndProvision(user.id, {
        baseUrl: parsed.data.baseUrl,
        username: parsed.data.username,
        password: parsed.data.password,
        email: parsed.data.email,
        code: parsed.data.code,
      });
      return Response.json({
        site: out.site,
        provision: out.provision,
        provisionError: out.provisionError,
      });
    } catch (error) {
      /* 站点那一侧的原话（「验证码不对」「用户名已被注册」…）直接给人看，别包一层「注册失败」。 */
      throw new ApiError(400, error instanceof Error ? error.message : '注册站点账号失败。');
    }
  });
}
