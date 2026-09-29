import { useMemo } from 'react';
import { getParams, getSearch, navigate, useLocation, usePathname as subscribePathname } from './router';

/**
 * `next/navigation` 的替身（渲染进程用；主进程另有一份，见 electron/shims/）。
 *
 * 11 个组件在用 `useRouter / usePathname / useSearchParams`。语义尽量对齐 Next：
 *  `push` 入栈、`replace` 替换、`back` 后退、`refresh` 重新加载。
 * `prefetch` 在单页应用里没有意义（没有按路由拆包的 RSC payload 可预取），留空实现。
 */
export function useRouter() {
  return useMemo(
    () => ({
      push: (href: string) => navigate(href),
      replace: (href: string) => navigate(href, { replace: true }),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      refresh: () => window.location.reload(),
      prefetch: () => undefined,
    }),
    [],
  );
}

/**
 * ⚠️ 这里**必须**用 router 里那份带订阅的实现，不能写成 `getPathname()`。
 * `getPathname()` 只是读一次当前值，不订阅 —— 于是点了导航、hash 变了，
 * 用 `usePathname()` 的组件（设置页的高亮、`SideNav` 的 active）根本不会重渲染，
 * 表现是「地址栏变了、界面纹丝不动」。
 */
export function usePathname(): string {
  return subscribePathname();
}

export function useSearchParams() {
  const location = useLocation();
  return useMemo(() => new URLSearchParams(getSearch()), [location]);
}

/**
 * 动态段参数（`/projects/[id]` 的 `id`）。
 * 值由 `App.tsx` 匹配路由时写进 router，子组件再读出来 —— 顺序上是先匹配后渲染，拿得到。
 */
export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return getParams() as T;
}

/**
 * ⚠️ 这里**必须**订阅当前地址，不能只 `getParams()`。
 *
 * 根因：同一个 `<App>` 要在 `/projects/a` → `/projects/b` 之间切换时，React 会复用同一个
 * `<Project>` 实例而不是重新挂载 —— 于是组件里那个
 * `const { id } = use(paramsPromise)`（等价于 `React.use(promise)`）**不会再执行**。
 * 表现就是「点了另一个项目，界面还是上一个」。
 *
 * 挂一个订阅、把当前路径塞进依赖里，路由一变就要一个新的 promise，`use()` 才会重新读。
 */
export function useParamsPromise<T>(): Promise<T> {
  const location = useLocation();
  return useMemo(() => Promise.resolve(getParams() as T), [location]);
}

export function redirect(href: string): void {
  navigate(href, { replace: true });
}

export function notFound(): never {
  throw new Error('404');
}
