/**
 * 桌面版的会话令牌：**存在 localStorage，请求时走 `x-frame-session` 头**。
 *
 * 为什么不是 cookie（web 版就是 cookie）：桌面版的页面跑在 `app://` 下，那是自定义协议，
 * Chromium 不为它存任何 cookie —— 页面里 `document.cookie = 'a=1'` 写完立刻读是空串，
 * CDP 想硬塞一个也直接被拒（"URL must have scheme http or https"）。
 * 所以「服务端 Set-Cookie → 浏览器自动带上」这条路在桌面版根本没有（2026-09-25 实测）。
 *
 * 于是改成显式的：登录接口把 token 回给前端，前端存这里，之后每个请求自己带上。
 * 代价是拿不到 `httpOnly` 那层保护 —— 桌面版本来就是本机单用户、数据在本机库里，
 * 能读到这个 localStorage 的人已经能读到整份数据库了。
 *
 * ⚠️ 服务端只在 `isDesktop` 下认这个头（`lib/auth/session.ts`），web 版一个字没变。
 */
export const SESSION_HEADER = 'x-frame-session';

const KEY = 'frame.session';

export function getSessionToken(): string {
  try {
    return window.localStorage.getItem(KEY) || '';
  } catch {
    /* 隐私模式下 localStorage 会直接抛，当成「没登录」就好，不能让页面崩。 */
    return '';
  }
}

export function setSessionToken(token: string): void {
  try {
    if (token) window.localStorage.setItem(KEY, token);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* 存不下就当没登录：下一次打开会回到本机用户，不会报错。 */
  }
}

export function clearSessionToken(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* 同上。 */
  }
}

/** 给 fetch 用的那一份请求头；没登录时是空对象（不要塞一个空头过去）。 */
export function sessionHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { [SESSION_HEADER]: token } : {};
}
