import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { sendSiteEmailCode } from '@/lib/providers/site';

/**
 * 注册第一步：让站点发一封带验证码的邮件（2026-10-12）。
 *
 * 站点那条路是 `GET /api/verification?email=...`、**不需要登录** ——
 * 所以这一步可以在「还没登录」的状态下做，这也是「应用内注册」能成立的前提。
 *
 * ⚠️ 回 `sent:true` **只能说明站点接了这趟请求**，不代表邮件真的到了：
 *    站点对不存在的邮箱也回 `success:true`。界面上别写成「已发送」。
 */
const schema = z.object({
  baseUrl: z.string().trim().min(1, '站点地址不能为空。').max(500),
  email: z.string().trim().min(1, '邮箱不能为空。').max(200),
});

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    await apiUser();
    const parsed = schema.safeParse(await jsonBody(request));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    const out = await sendSiteEmailCode(parsed.data.baseUrl, parsed.data.email);
    return Response.json({ sent: out.sent, error: out.error, trace: out.trace });
  });
}
