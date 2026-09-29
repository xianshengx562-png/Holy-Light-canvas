/**
 * `next/navigation` 在主进程里的替身。
 *
 * `lib/auth/session.ts` 的 `requireUser()` 会在没有用户时 `redirect('/login')`。
 * 主进程里没有「跳转到页面」这回事 —— 桌面版又是固定登录态，走不到这一支；
 * 真走到了就抛一个明确的错误，总比 import 不到模块崩在半路好。
 */
export function redirect(url: string): never {
  throw new Error(`主进程里无法跳转：${url}`);
}

export function notFound(): never {
  throw new Error('主进程里没有 notFound');
}

export function permanentRedirect(url: string): never {
  throw new Error(`主进程里无法跳转：${url}`);
}
