import { NextResponse } from 'next/server';
import { destroySession } from '@/lib/auth/session';
import { api, checkOrigin } from '@/lib/api';
import { isDesktop } from '@/lib/edition';

/** 桌面版退出也是一次普通的接口调用（前端带着 `x-frame-session` 头），不需要整页跳转。 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    await destroySession();
    if (isDesktop) return NextResponse.json({ ok: true });
    return NextResponse.redirect(new URL('/', request.url));
  });
}
