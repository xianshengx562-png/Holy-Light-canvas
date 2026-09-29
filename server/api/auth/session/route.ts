import { NextResponse } from 'next/server';
import { sessionState } from '@/lib/auth/session';
import { api } from '@/lib/api';

/**
 * 「现在是不是真登录着」（2026-09-25）。
 *
 * 桌面版**默认免登录**：没有会话时 `currentUser()` 照样返回一个「本机用户」，
 * 所以界面根本没法靠「有没有用户」来区分 —— 这个接口就是补上那一位信息。
 *
 * - `hasSession=false` + `local=true`：桌面版的默认状态，本机用户，免登录；
 * - `hasSession=true`：真登录着（cookie 里有有效会话），界面上该给「退出登录」。
 *
 * ⚠️ 不返回任何凭据，只有两个布尔和一个邮箱（邮箱本来就在用户信息里）。
 */
export async function GET() {
  return api(async () => NextResponse.json(await sessionState()));
}
