import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 「现在正在处理的这个请求是谁」—— **只给日志用**。
 *
 * 为什么需要它：`lib/api.ts` 的兜底 catch 只知道**抛了什么异常**，不知道**是哪个接口**。
 * 2026-10-03 徐先截图问「服务暂时不可用是什么原因」时卡住的正是这一点 ——
 * 日志里躺着 11 行 `[DOMException [TimeoutError]]`，没有路径、没有时间，
 * 能确定「有东西超时了」，却**定不到是哪一步**（生成这一条路上带超时的 fetch 有七八处：
 * 上传素材、拉的原始素材、本机 ComfyUI 查询、视频网关提交/查询……）。
 *
 * 用 `AsyncLocalStorage` 而不是一个模块级变量：后端是单进程、请求会并发交错，
 * 模块级变量在 await 边界上会被另一个请求覆盖 —— 写出来的日志是错的，那还不如没有。
 *
 * ⚠️ 只有桌面版（`electron/backend/dispatch.ts`）会设它。web 版没有这一层，
 * `currentRequest()` 返回 `undefined`，日志少一段路径而已，**不会报错**。
 */
export type RequestContext = {
  /** 大写的方法名，如 `POST`。 */
  method: string;
  /** 路径，如 `/api/projects/xxx/generation`。 */
  path: string;
  /** 进来的时刻（`Date.now()`），用来算「这个请求已经跑了多久」。 */
  startedAt: number;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runInRequest<T>(context: RequestContext, run: () => T): T {
  return storage.run(context, run);
}

export function currentRequest(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * `AbortSignal.timeout()` 把 fetch 掐断时抛的就是它。
 *
 * 按 `name` 认而不是 `instanceof DOMException`：跨 realm（打包、worker）拿不到同一个
 * 构造函数，而 `name` 是稳的。`AbortError` 也一起收 —— 手动 abort 与超时对使用者
 * 是同一件事：**这次没等到**。
 *
 * ⚠️ 这种异常**没有 stack**（undici 自己构造的），所以在日志里长得跟别的不一样：
 * `[DOMException [TimeoutError]: ...]` 带方括号，而不是 `Error: ...` 加一串 at。
 */
export function isTimeoutError(error: unknown): boolean {
  const name = error && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name || '')
    : '';
  return name === 'TimeoutError' || name === 'AbortError';
}
