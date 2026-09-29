import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * `next/headers` 的替身（只给主进程 / 后端进程用）。
 *
 * 2026-09-25 之前它是一个**进程级**的空罐子：桌面版只有「本机用户」一个身份，
 * cookie 里永远什么都没有，给个能读能写的 Map 就够了。
 *
 * 现在桌面版**允许登录换账号**了（`lib/auth/session.ts`），请求里开始真的带凭据，
 * 于是它必须变成**按请求隔离**的 —— 否则 A 账号登录后，B 账号的请求也会读到同一份，
 * 两个账号的数据当场串在一起。做法与 Next 一样：`AsyncLocalStorage` 装当前 `Request`。
 *
 * ⚠️ ⚠️ 桌面版的凭据**不在 cookie 里**：`app://` 是自定义协议，Chromium 根本不存
 * 它的 cookie（`document.cookie` 写完立刻读是空，CDP 的 `Network.setCookie` 直接报
 * "URL must have scheme http or https"）。所以桌面版把会话令牌放在
 * `x-frame-session` 请求头里（见 `lib/auth/session.ts` 的 `sessionToken()`），
 * 这个替身要做的就是把请求头原样递过去。
 *
 * ⚠️ 实例挂在 `globalThis` 的 **Symbol.for** 上，不用模块级变量：
 * 本文件被两个入口同时引用（业务代码走 `next/headers` 别名、`electron/backend/dispatch.ts`
 * 走相对路径），打包器理论上会解析成同一个模块，但万一拆成两份，
 * 两份各自 new 一个 AsyncLocalStorage 就等于「设置的那份和读的那份不是同一个」——
 * 症状是登录成功但请求里读不到令牌。挂全局是零成本的保险。
 */
type Cookie = { name: string; value: string };

const ALS_KEY = Symbol.for('frame.desktop.request-context');

type Holder = { als: AsyncLocalStorage<Request> };

const globalRef = globalThis as unknown as Record<symbol, Holder | undefined>;
if (!globalRef[ALS_KEY]) globalRef[ALS_KEY] = { als: new AsyncLocalStorage<Request>() };
const store = (globalRef[ALS_KEY] as Holder).als;

/**
 * 把一次请求的执行包起来，里面的 `cookies()` / `headers()` 才拿得到东西。
 * 后端进程分发路由时用（见 `electron/backend/dispatch.ts`）。
 */
export function runWithRequest<T>(request: Request, fn: () => Promise<T> | T): Promise<T> {
  return store.run(request, async () => fn()) as Promise<T>;
}

/** `Cookie` 头是 `a=1; b=2`，重复名取第一个（与浏览器一致）。 */
function parseCookieHeader(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    out.set(name, decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return out;
}

/** 不在任何请求里（比如进程刚起来时的一次调用）：退化成一个进程内的空罐子，行为与以前一致。 */
const fallback = new Map<string, string>();

function makeJar() {
  const request = store.getStore();
  const read = request ? parseCookieHeader(request.headers.get('cookie')) : fallback;
  /* 本次请求里 `set` 过的要盖住读进来的值 —— Next 的 cookie 罐子也是这个顺序。 */
  const written = new Map<string, string>();
  return {
    get: (name: string): Cookie | undefined => {
      if (written.has(name)) return { name, value: written.get(name) as string };
      return read.has(name) ? { name, value: read.get(name) as string } : undefined;
    },
    getAll: (): Cookie[] => [...new Map([...read, ...written])].map(([name, value]) => ({ name, value })),
    has: (name: string): boolean => written.has(name) || read.has(name),
    /* 第三个参数（httpOnly / secure / sameSite…）在桌面版没有意义：写出去的 cookie
       浏览器根本不会存。但签名必须收下 —— `createSession()` 那边照旧传了三个参数。 */
    set: (name: string, value: string, _options?: Record<string, unknown>) => {
      written.set(name, value);
      if (!request) fallback.set(name, value);
    },
    delete: (name: string) => {
      written.delete(name);
      if (!request) fallback.delete(name);
    },
  };
}

export async function cookies() {
  return makeJar();
}

export async function headers() {
  const request = store.getStore();
  return request ? request.headers : new Headers();
}
