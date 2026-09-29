import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { api, checkOrigin, jsonBody } from '@/lib/api';
import { hashPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { limitAuth } from '@/lib/auth/rate-limit';
import { grantSignupWallet } from '@/lib/wallet';
import { isDesktop } from '@/lib/edition';

const schema = z.object({
  name: z.string().trim().min(2).max(40),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
});

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
    const input = schema.parse(body);
    await limitAuth(input.email, 'register');
    const passwordHash = await hashPassword(input.password);
    /*
     * 建号和送积分放在一个事务里 —— 送失败就整条回滚，否则会留下一个「注册报 500、但邮箱已被占用、
     * 且没有积分」的账号，本人重试注册只会拿到冲突。
     */
    const user = await db.$transaction(async tx => {
      const created = await tx.user.create({ data: { name: input.name, email: input.email, passwordHash } });
      await grantSignupWallet(created.id, tx);
      return created;
    });
    const token = await createSession(user.id, { remember: wantsRemember((body as Record<string, unknown>).remember) });
    /* 桌面版没有 cookie，令牌只能当场交回前端（理由同 `/api/auth/login`）。 */
    if (isDesktop) return NextResponse.json({ ok: true, token, email: user.email, name: user.name });
    return NextResponse.redirect(new URL('/', request.url));
  });
}
