import { useSyncExternalStore } from 'react';

/**
 * 一个够用的前端路由。
 *
 * 打包后页面是从 `app://` 加载的静态文件，`history.pushState` 在这种非 http 的源上
 * 改路径会抛 SecurityError。所以路由状态放在 **hash** 里：`#/projects/abc`。
 * 代价是地址栏多了个 `#`，换来的是刷新、前进后退、深链接全都正常。
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let currentParams: Record<string, string> = {};

function emit(): void {
  for (const l of [...listeners]) l();
}

function rawPath(): string {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || '/';
}

export function getPathname(): string {
  const p = rawPath();
  const i = p.indexOf('?');
  return i >= 0 ? p.slice(0, i) : p;
}

export function getSearch(): string {
  const p = rawPath();
  const i = p.indexOf('?');
  return i >= 0 ? p.slice(i + 1) : '';
}

export function navigate(to: string, options?: { replace?: boolean }): void {
  const target = to.startsWith('/') ? to : `/${to}`;
  if (options?.replace) {
    window.location.replace(`${window.location.pathname}#${target}`);
  } else {
    window.location.hash = target;
  }
  // hashchange 在跨帧时才会触发；同帧连点两次同一个地址不会触发，这里补一次
  emit();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setParams(params: Record<string, string>): void {
  currentParams = params;
}

export function getParams(): Record<string, string> {
  return currentParams;
}

window.addEventListener('hashchange', emit);

/** 订阅当前路径。`useSyncExternalStore` 保证刷新/前进后退时组件能跟着变。 */
export function usePathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => getPathname(),
    () => '/',
  );
}

export function useLocation(): string {
  return useSyncExternalStore(subscribe, rawPath, () => '/');
}
