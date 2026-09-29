import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionHeaders } from './session-token';
import { isRetryableApiStatus, retryDelayMs } from './api-retry';
/* ⚠️ 用别名：`edition.ts` 在**根目录** `lib/` 下（和 `@/lib/db`、`@/lib/api` 同一层），
   `src/lib/` 里没有它 —— 写成 `./edition` 会解析失败。 */
import { isDesktop } from '@/lib/edition';

/**
 * 渲染进程取数的唯一入口。
 *
 * 这些请求走的是 `fetch('/api/...')`，被主进程的自定义协议拦下来直接分发给路由 ——
 * 也就是说**没有 HTTP 服务、没有端口**，但组件里写的还是熟悉的 `/api/xxx`。
 * 换成 IPC 也行，代价是 29 处 fetch 全要改一遍，而它们现在一个字都不用动。
 */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  /*
   * 拿到 HTML 只有一种可能：请求被 SPA 兜底接走了（路由没匹配、或 POST 返回了 303
   * 被 fetch 静默跟掉）。以前这里会退化成「把 HTML 当字符串返回」，于是上层
   * `data.id` 是 undefined、不报错、不进日志 ——「点了没反应」。
   * 这里直接挑明，省得每次都得靠抓包猜。
   */
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/html') || text.trimStart().startsWith('<!doctype')) {
    throw new ApiError(res.status, `接口返回了页面而不是数据（${res.status}），检查一下是不是被重定向带偏了。`);
  }
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `请求失败（${res.status}）`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { headers: { accept: 'application/json', ...sessionHeaders() } }));
}

/**
 * 桌面版的「本站」origin，与主进程 `electron/main/api.ts` 里那个常量必须一致。
 *
 * ⚠️ 写请求**必须**显式带上 `Origin`。浏览器只在跨源请求里自动加这个头，
 * 同源 fetch 是不带的 —— 而主进程只补 `缺了才补`（`if (!headers.has('origin'))`），
 * 于是 `lib/api.ts` 的 `checkOrigin()` 拿到 null、比对失败、返回 403。
 * 症状很别扭：GET 全部正常，凡是要写东西的（新建项目、保存密钥、存草稿）一律失败。
 *
 * 只有 `app://` 下需要这一手：那是自定义协议、又没有本地 HTTP 服务，
 * 请求压根没有真正的「源」可言，这个值就是个双方约定的哨兵。
 */
const APP_ORIGIN = 'http://localhost:3000';

/**
 * ⚠️ 写请求**必须**同时声明 `accept: application/json`。
 *
 * 浏览器给 fetch 的默认 Accept 是「什么都要」的通配值（不含 application/json），
 * 而 `server/api/projects/route.ts` 的 POST 是按 Accept 分流的：里面含 `application/json` 才回 `{ id }`，否则走 303 重定向
 * （那是 web 版不带 JS 的整页表单要的行为）。
 * 于是缺这个头时，fetch 会**静默跟掉**那次重定向 —— SPA 兜底把 index.html 原样返回，
 * `res.status` 是 200、`content-type` 是 text/html，`parse()` 里 JSON.parse 失败退成字符串，
 * 最后 `project.id` 是 undefined。全程没有报错、没有日志，表现就是「新建项目点了没反应」。
 */
export async function apiSend<T = unknown>(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers: Record<string, string> = { accept: 'application/json', origin: APP_ORIGIN, ...sessionHeaders() };
  if (!isForm) headers['content-type'] = 'application/json';
  return parse<T>(
    await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    }),
  );
}

export const apiPost = <T = unknown>(path: string, body?: unknown) => apiSend<T>(path, 'POST', body);
export const apiPatch = <T = unknown>(path: string, body?: unknown) => apiSend<T>(path, 'PATCH', body);
export const apiDelete = <T = unknown>(path: string) => apiSend<T>(path, 'DELETE');

/**
 * 页面取数。原来这些页面是**服务端组件**（`await requireUser()` / `await listProjects()`），
 * 桌面版没有服务端渲染这一步，只能在渲染进程里发请求。
 *
 * `key` 变化时自动重新取；手动 `reload()` 用于「保存完刷新列表」。
 */
export function useApi<T>(path: string | null): {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failed = 0;
    /*
     * 失败了要**再问几次**（2026-09-29，规矩见 `./api-retry`）。
     *
     * 桌面版多了一类 web 版压根没有的失败：后端进程还没 ready、或者崩了正在重启，
     * 期间每一趟请求都是 503。以前失败一次就定死在 `error` 上、`data` 永远是 `null`，
     * 界面于是把「没读到」当成「没有」—— 那就是「自定义接口有时候会消失」的来路。
     */
    const run = () => {
      setLoading(true);
      setError(null);
      apiGet<T>(path)
        .then((value) => {
          if (cancelled) return;
          setData(value);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          failed += 1;
          const status = err instanceof ApiError ? err.status : 0;
          const delay = isRetryableApiStatus(status) ? retryDelayMs(failed) : null;
          /*
           * ⚠️ 重试期间**不清 `data`**：下拉会因为它变成 null 先塌一下再长回来，
           *   而那正是这次要修的那个「消失」。留着上一份，重试成功自然被盖掉。
           */
          if (delay !== null) {
            timer = setTimeout(run, delay);
            return;
          }
          setError(err instanceof Error ? err.message : '加载失败');
          setLoading(false);
        });
    };
    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

/**
 * 当前用户。桌面版**没有登录这一步**（主进程里固定一个「本机用户」），
 * 但页面仍然要拿 `userId` 去拼接口地址，所以这里问一次。
 */
export type SessionUser = { id: string; email: string; name: string; avatar: string | null };

/**
 * 桌面版的**兜底本机用户**。
 *
 * 🔴 桌面版根本不存在「未登录」这个状态（`lib/auth/session.ts` 的 `currentUser()` 在桌面版
 * 无论如何都会给出本机用户），所以 `/api/auth/me` **还没回来**的时候，界面也绝不能判成游客 ——
 * 那会先画出一整块登录引导：右上角一个「登录」按钮 + 「登录后就能看到你的项目」。
 *
 * 2026-09-26 冷启动实测（`_probe-session-flash.js`）：`/api/auth/me` 1318ms 才回来，
 * 1355ms 那一帧 `.home-guest` 就挂在屏幕上、页头渲染的正是「登录」两个字，1439ms 才切走。
 * 本机只闪 ~80ms，但凡机器慢一点、库没热起来、或者这一次请求失败，
 * 这块登录界面就会**一直挂着** —— 徐先 10:38 那张截图就是这个（他以为「免登录」白做了）。
 *
 * 名字与 `lib/auth/session.ts` 的默认名保持一致；真名回来之后自然被覆盖。
 * 它**只用于显示和「算不算游客」的判断**，不参与任何鉴权：写操作的 identity 由服务端会话决定。
 */
const DESKTOP_PLACEHOLDER: SessionUser = {
  id: 'desktop-local',
  email: 'local@frame.desktop',
  name: '用户1',
  avatar: null,
};

export function useSession(): { user: SessionUser | null; loading: boolean } {
  const { data, loading } = useApi<SessionUser | null>('/api/auth/me');
  /* 会话第一问落地就广播一次 —— 启动画面等的就是它（见下面 `whenSessionReady`）。 */
  useEffect(() => {
    if (loading) return;
    sessionReady = true;
    for (const fn of Array.from(sessionWaiters)) fn();
    sessionWaiters.clear();
  }, [loading]);
  return { user: data ?? (isDesktop ? DESKTOP_PLACEHOLDER : null), loading };
}

/**
 * 会话第一问「回来了没有」的一次性广播（2026-09-26，给启动画面用）。
 *
 * ⚠️ 不新增请求：`useApi` **没有跨组件缓存**，启动画面再问一次 `/api/auth/me` 就是两趟，
 *    冷启动本来就是瓶颈（实测 1300ms），再叠一趟只会更慢。这里是「谁先问到谁广播」，
 *    问的人仍然是页面自己（`useSession`）。
 * ⚠️ 只有**真的问过一次**才广播。没人问时（理论上是完全不用会话的页面）
 *    `BootGate` 自己的 2500ms 兜底会接手，不会把牌子挂死。
 */
let sessionReady = false;
const sessionWaiters = new Set<() => void>();
export function whenSessionReady(fn: () => void): () => void {
  if (sessionReady) {
    fn();
    return () => undefined;
  }
  sessionWaiters.add(fn);
  return () => {
    sessionWaiters.delete(fn);
  };
}
