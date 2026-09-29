/**
 * 页面取数失败之后要不要**再问一次**（2026-09-29）。
 *
 * ## 为什么需要它
 *
 * 桌面版的 `/api/*` 不是 HTTP 服务：主进程把它转发给**另一个进程**的命名管道。
 * 于是多了一类 web 版根本没有的失败——后端进程不在：
 *
 * - 窗口是**先开**的，后端异步起（`index.ts` 里那句注释说得很清楚：等后端再开窗，
 *   启动看起来像卡死）。页面挂载得早就会撞上「后端还没 ready」那一两秒；
 * - 后端崩了会自己重启（`backend-supervisor.ts` 的退避 300ms → 8s），重启窗口里
 *   所有请求都是 503。
 *
 * 以前这两种都是**一次性**的：失败就定死在 `error` 上，`useApi` 的 `data` 永远是 `null`，
 * 界面于是把「没读到」当成「没有」—— 表现就是「自定义接口有时候会消失」，
 * 而且切走再切回来（组件重新挂载）它又出现了，怎么看都像玄学。
 *
 * ## 只重试 GET
 *
 * 用它的只有 `useApi`，而 `useApi` 只发 GET。**写请求一律不重试**：
 * 一个 POST 在网络上超时，不代表服务端没收到，再发一次就是建两个项目、扣两次费。
 *
 * ## 退避为什么是这几档
 *
 * 后端重启的退避是 300 / 1000 / 2000 / 4000 / 8000 ms，再叠加它自己启动的一两秒。
 * 所以间隔必须**越等越久**才盖得住，最多盖到 10 秒那一档；再往后就不是「重启」
 * 而是真坏了（监管器会进 `failed`，界面上另有全局提示），继续等下去没意义。
 *
 * ⚠️ 这是纯函数、不 import react：`_test-api-retry.py` 把它单独编成 CJS 跑断言。
 */

/** 第 n 次失败之后等多久再试（下标 = 已经失败的次数 - 1）。数组长度就是重试上限。 */
export const API_RETRY_DELAYS_MS = [500, 1500, 3000, 6000, 10_000];

/**
 * 这个状态码值不值得再试一次。
 *
 * - `0` —— 根本没拿到响应（管道连不上、请求被中断），正是「后端不在」那一类；
 * - `5xx` —— 服务端自己说的「我现在不行」，重启完就好了；
 * - `408` / `429` —— 超时与限流，等一会儿再来是对的。
 *
 * 反过来 400 / 401 / 403 / 404 **不重试**：那些是「这个请求本身不对」，
 * 再发一百次还是同一个答案，白白拖慢界面。
 */
export function isRetryableApiStatus(status: number): boolean {
  if (!Number.isFinite(status)) return false;
  if (status === 0) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * 已经失败 `failedTimes` 次之后，下一次要等多久。**返回 null = 放弃**。
 *
 * 失败第 1 次 → 500ms；第 2 次 → 1500ms；……第 5 次 → 10s；第 6 次 → 放弃。
 */
export function retryDelayMs(failedTimes: number): number | null {
  if (!Number.isInteger(failedTimes) || failedTimes <= 0) return null;
  const delay = API_RETRY_DELAYS_MS[failedTimes - 1];
  return typeof delay === 'number' ? delay : null;
}
