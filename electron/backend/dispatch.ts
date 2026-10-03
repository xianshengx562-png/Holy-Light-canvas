import { ROUTES } from '../main/routes.generated';
import { APP_ORIGIN } from '@/lib/app-origin';
/*
 * ⚠️ `next/headers` 的替身必须是**按请求**的：桌面版登录后请求里带着会话令牌
 * （`x-frame-session`，见 `lib/auth/session.ts`），一个进程级的全局罐子会让两个账号
 * 的请求互相读到对方的身份。所以每个 handler 都要包在这一层里。
 */
import { runWithRequest } from '../shims/next-headers';
/*
 * 「当前请求是谁」—— 第二个按请求的上下文，但用途不同：上面那个给 `next/headers` 的替身
 * 读会话令牌用，这一个**只给日志用**（`lib/api.ts` 的兜底 catch 靠它打出
 * 「哪个接口、跑了多久」，见 `lib/requestContext.ts` 的注释）。
 */
import { runInRequest } from '@/lib/requestContext';

/**
 * 路由分发 —— **只跑在后端进程里**。
 *
 * 那 48 个路由文件是**原样**从 Next 的 `app/api` 目录搬过来的（导出 `GET` / `POST` / `PATCH` /
 * `DELETE`，第二参数 `{ params }` 是个 Promise，与 Next 15 一致），业务代码一行没动。
 *
 * ⚠️ 这个文件**不能**被主进程 import：它一进来就把全部路由模块拉进 bundle，
 * 主进程只需要 `forwardToBackend()`（见 `electron/main/api.ts`），
 * 把路由打进主进程产物等于让启动白花一倍时间、产物白胖一倍。
 */
export type ApiHandler = (
  request: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response> | Response;

export type ApiModule = Record<string, unknown>;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function findRoute(pathname: string): { mod: ApiModule; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    const matched = route.regex.exec(pathname);
    if (!matched) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(matched[i + 1]);
    });
    return { mod: route.mod, params };
  }
  return null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * 补一个 `origin` 头。
 *
 * `lib/api.ts` 的 `checkOrigin()` 用 `Origin` 头挡 CSRF —— 那是给云端版用的。
 * 桌面版整个 UI 都跑在 `app://` 下，但路由里那句检查还在，不补这个头的话
 * 「新建项目」这类带 `checkOrigin` 的接口会一律 403。
 *
 * 现在请求是穿过命名管道过来的：主进程转发时**故意丢掉了** `host` / `origin` / `referer`
 * （`app://` 的 origin 解析出来是 `"null"`，透过来只会比对失败），所以这里补是**唯一**的机会。
 */
async function normalize(req: Request): Promise<Request> {
  const headers = new Headers(req.headers);
  if (!headers.has('origin')) headers.set('origin', APP_ORIGIN);
  if (!headers.has('host')) headers.set('host', 'localhost:3000');
  const method = req.method.toUpperCase();
  const needsBody = method !== 'GET' && method !== 'HEAD';
  const raw = needsBody ? await req.arrayBuffer().catch(() => new ArrayBuffer(0)) : null;
  return new Request(req.url, {
    method: req.method,
    headers,
    body: raw && raw.byteLength ? raw : undefined,
  });
}

export async function dispatchRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const hit = findRoute(url.pathname);
  if (!hit) return json({ error: `没有这个接口：${url.pathname}` }, 404);

  /*
   * ⚠️ 这里**必须**按请求自己的方法去挑 handler，不能写成
   * `METHODS.map(m => mod[m]).find(...)` —— 那样拿到的是**方法表里第一个存在的**，
   * 而 `METHODS` 里 GET 排在 POST 前面：一个同时导出 GET 与 POST 的路由
   * （`/api/projects` 就是），POST 请求会被派给 GET 处理。
   *
   * 症状极具迷惑性：POST 返回 200，内容是 GET 的结果（新建项目后拿回一个 `[]`），
   * 没有任何报错、没有异常日志，只有业务结果是错的。
   */
  const method = req.method.toUpperCase();
  const raw = hit.mod[method];
  if (typeof raw !== 'function') {
    const allowed = METHODS.filter((m) => typeof hit.mod[m] === 'function');
    const res = json({ error: `${req.method} 不被支持，可用：${allowed.join(', ')}` }, 405);
    res.headers.set('allow', allowed.join(', '));
    return res;
  }
  const handler = raw as ApiHandler;

  const request = await normalize(req);
  try {
    const out = await runInRequest(
      { method, path: url.pathname, startedAt: Date.now() },
      () => runWithRequest(request, () => handler(request, { params: Promise.resolve(hit.params) })),
    );
    // 路由里可能直接返回 undefined（忘了 return 的分支），别让协议层拿到 undefined 去崩
    return out ?? json({ error: '接口没有返回内容' }, 500);
  } catch (error) {
    console.error(`[api] ${req.method} ${url.pathname} 抛异常`, error);
    return json({ error: error instanceof Error ? error.message : '服务暂时不可用。' }, 500);
  }
}
