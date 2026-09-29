import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { limitAuth } from '@/lib/auth/rate-limit';
import { api, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { isDesktop } from '@/lib/edition';

const schema = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(8).max(128) });

/** 「记住我」在表单里是 checkbox，JSON 调用方可能直接给 true/1。没勾就是会话 cookie。 */
function wantsRemember(value: unknown) {
  return value === true || value === 'on' || value === 'true' || value === '1';
}

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const body = request.headers.get('content-type')?.includes('form')
      ? Object.fromEntries((await request.formData()).entries())
      : await jsonBody(request);
    /*
     * ⚠️ 这里必须用 `safeParse`，不能用 `parse`。
     *
     * zod 抛的是 `ZodError`，它**不是** `ApiError` —— `api()` 的兜底分支会把它当成
     * 「未预期的服务器异常」，回一句 500「服务暂时不可用，请稍后重试。」。
     * 2026-09-26 徐先在「用户」页填了用户名（`xxs`，不是邮箱）看到的就是这句话：
     * 明明是「邮箱格式不对」，看起来却像服务挂了，谁也没法从这个提示猜到要去改哪儿。
     */
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, '这一栏要填邮箱（例如 you@example.com）—— 用户名不行。');
    }
    const input = parsed.data;
    await limitAuth(input.email, 'login');
    const user = await db.user.findUnique({ where: { email: input.email } });
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) throw new ApiError(401, '邮箱或密码不正确。');
    const token = await createSession(user.id, { remember: wantsRemember((body as Record<string, unknown>).remember) });
    /*
     * 桌面版**不能**走重定向：它没有 cookie（见 `lib/auth/session.ts` 的 SESSION_HEADER），
     * 重定向带不回任何凭据。所以这里把 token 当场交回去，前端存起来、之后每个请求带在头上。
     */
    if (isDesktop) return NextResponse.json({ ok: true, token, email: user.email, name: user.name });
    return NextResponse.redirect(new URL('/', request.url));
  });
}
