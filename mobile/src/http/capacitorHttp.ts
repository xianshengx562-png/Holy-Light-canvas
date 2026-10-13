/**
 * 手机端**唯一**的出网通道（2026-10-12 新建）。
 *
 * ## 为什么不能直接用 fetch
 *
 * 中转站不一定给跨域响应头。在浏览器里 `fetch` 还行（dev 阶段），
 * 但打包成 App 之后页面是在 `file:///android_asset/public/` 下跑的，
 * WebView 的同源策略会把请求拦掉 —— 表现是「浏览器里好好的、装上就挂」。
 *
 * 所以**原生环境一律走 `CapacitorHttp`**：请求由 Java 层发出，绕过 WebView 的 CORS。
 *
 * ## 与桌面端的唯一差别：超时怎么传
 *
 * 桌面端（`lib/providers/custom/client.ts`）用的是 `signal: AbortSignal.timeout(ms)`。
 * `CapacitorHttp` 不吃 `AbortSignal`，它自己的参数是 `connectTimeout` / `readTimeout`（**秒**）。
 * 所以这里的 `SendInit` 多一个 `timeoutMs` 字段，搬过来的调用点把那个数字**同时**给 `timeoutMs`。
 *
 * ⚠️ `readTimeout` 默认是 **10 秒**，不覆盖的话生图一定超时 —— 这是最容易漏的一处。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { probePaths } from './networkFix';
import { rawRequest } from './rawHttp';

export type SendInit = {
  method?: string;
  headers?: Record<string, string>;
  /** 字符串请求体。图生图（multipart）第一版不做，所以只有 JSON 这种。 */
  body?: string | null;
  /** 毫秒。同时用于 `connectTimeout` 与 `readTimeout`。 */
  timeoutMs?: number;
};

/** `CapacitorHttp` 的返回是 `{ status, data, headers }`，这里还原成一个 `Response`。 */
function toResponse(status: number, data: unknown): Response {
  /*
   * `responseType: 'text'` 时 `data` 是字符串；插件个别版本会在响应头带
   * `content-type: application/json` 时**自作主张**解析成对象。两种都要接住：
   * 后面 `requestFirstJson` 要做 `JSON.parse`，拿到对象就再序列化回去。
   */
  const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
  /* `Response` 只接受 200–599。`CapacitorHttp` 个别失败路径会给 0，那按「连不上」处理。 */
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new Error(`连不上（HTTP ${status || 0}）`);
  }
  return new Response(text, { status });
}

/**
 * 发一个请求，返回 `Response`。
 *
 * 浏览器里（`@capacitor/core` 未实现 `CapacitorHttp`）退回 `fetch`，
 * 好让 `npm run dev` 在电脑上能直接调试。
 */
export async function send(url: string, init: SendInit = {}): Promise<Response> {
  const { method = 'GET', headers = {}, body = null, timeoutMs } = init;

  if (!Capacitor.isNativePlatform()) {
    return fetch(url, {
      method,
      headers,
      ...(body === null ? {} : { body }),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  }

  const seconds = Math.max(1, Math.ceil((timeoutMs ?? 30_000) / 1000));

  /*
   * 通道优先级（2026-10-13 实测定型）：
   *   1. RawHttp（OkHttp + Proxy.NO_PROXY）—— 同进程裸 socket 已实测能通，
   *      而 CapacitorHttp 的 HttpURLConnection 会被系统代理路径拦死；
   *   2. CapacitorHttp —— 它在某些 ROM 上是好的，留着兜底；
   *   3. WebView fetch —— CORS 挡着，基本到不了，除非站点给了跨域头。
   * 三条路共享下面的重试/自救循环。
   */
  const attempts: Array<(url: string) => Promise<Response>> = [
    url2 =>
      (async () => {
        const outcome = await rawRequest({ url: url2, method, headers, body, timeoutMs });
        if ('error' in outcome) throw new Error(`raw-http: ${outcome.error}`);
        return toResponse(outcome.status, outcome.text);
      })(),
    url2 =>
      CapacitorHttp.request({
        url: url2,
        method,
        headers,
        ...(body === null ? {} : { data: body }),
        responseType: 'text',
        connectTimeout: seconds,
        readTimeout: seconds,
        shouldEncodeUrlParams: true,
      }).then(response => toResponse(response.status, response.data)),
  ];

  /*
   * 失败重试：第一轮全失败后跑一次通路探测（解绑进程网络等自救动作）再试；
   * 超时不重试 —— 服务器卡住时白等一整轮没有意义。
   */
  let lastError: Error | null = null;
  channels: for (let round = 0; round < 3; round++) {
    if (round > 0) {
      await new Promise(resolve => setTimeout(resolve, round === 1 ? 800 : 3000));
      if (round === 1) {
        try { await probePaths(); } catch { /* 探测失败就按原路继续 */ }
      }
    }
    for (const channel of attempts) {
      try {
        return await channel(url);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        /* 打到 WebView 的控制台 —— 真机上查网络问题靠它（USB 调试协议能读到）。 */
        console.error('[hl-http] 通道失败', url, lastError.message);
        if (/timed out|timeout/i.test(lastError.message)) break channels; /* 超时不再白等 */
      }
    }
  }

  /* 到这里 = 原生几条通道都死了。 */

  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(body === null ? {} : { body }),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    console.error('[hl-http] 原生失败但 WebView 通了', url, response.status);
    return response;
  } catch (fetchError) {
    /*
     * 2026-10-13 真机实锤：ColorOS 的系统网络引擎会把**本应用的原生联网**整个掐掉 ——
     * 所有站点几毫秒内被本地拒绝、换 WiFi / 换流量都一样、杀掉 App 重开也没用，
     * 而同一应用里 WebView 的网络层完全正常、手机浏览器也正常。
     * 这里用 no-cors 探测分辨两种死法：
     *   WebView 网络层活着 → 原生通道被系统拦（给出能落地的开关）；
     *   WebView 网络层也死 → 真断网（原有指引）。
     */
    let webviewAlive = false;
    try {
      await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      webviewAlive = true;
    } catch {
      /* no-cors 也不通 —— 网络层真死了 */
    }
    console.error(
      '[hl-http] 两条路都失败',
      url,
      lastError?.message ?? '',
      fetchError instanceof Error ? fetchError.message : String(fetchError),
      webviewAlive ? '（WebView 网络层通 → 原生通道被系统拦）' : '（WebView 网络层也不通）',
    );
    throw webviewAlive
      ? systemBlockedHint()
      : withHint(url, lastError ?? new Error('连不上（没有拿到具体原因）。'));
  }
}

export type ProbeResult = { channel: string; ok: boolean; detail: string };

/**
 * 网络自检：把**两条出网通道各打一次**，结果直接给人看。
 *
 * 为什么要这个：2026-10-13 真机上「手机浏览器打得开站点，App 却连不上」。
 * 光靠「浏览器打得开」判断不出问题在哪一层。这里一次试出来：
 *   - 原生通 → App 出网正常，问题在账号 / 接口层；
 *   - 原生不通 + WebView 网络层通 → 系统把本应用的原生联网拦了（本机实锤过，重启手机能解）；
 *   - 两条都不通 → 这台手机的网络到不了站点（不是 App 的问题）。
 *
 * 🔴 WebView 这边必须用 `mode: 'no-cors'`：普通 fetch 会被**跨域头**挡住读不到响应，
 * 但那不代表网络不通 —— no-cors 测的才是「请求能不能真的发出去」。
 */
export async function probeSite(baseUrl: string): Promise<ProbeResult[]> {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '');
  const url = `${root}/api/status`;
  const out: ProbeResult[] = [];

  if (Capacitor.isNativePlatform()) {
    try {
      const response = await CapacitorHttp.request({
        url,
        method: 'GET',
        responseType: 'text',
        connectTimeout: 15,
        readTimeout: 15,
      });
      out.push({
        channel: '原生通道（App 发请求用的）',
        ok: response.status >= 200 && response.status < 300,
        detail: `HTTP ${response.status}`,
      });
    } catch (error) {
      out.push({
        channel: '原生通道（App 发请求用的）',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    out.push({
      channel: 'WebView 网络层（浏览器走的，不受跨域影响）',
      ok: true,
      detail: '网络层通 —— 这台手机到得了站点',
    });
  } catch (error) {
    out.push({
      channel: 'WebView 网络层（浏览器走的，不受跨域影响）',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return out;
}

/** 网络层失败的最终报错：给出一条立刻能做的验证动作，别让人对着一句英文抓瞎。 */
function withHint(url: string, error: Error): Error {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* url 不是合法 URL 就原样带出去 */
  }
  if (/timed out|timeout/i.test(error.message)) {
    return new Error(`连得上但等不到响应（${host}）：多半是站点那边卡住了，过一会儿再试。`);
  }
  return new Error(
    `${error.message}\n—— 先用手机浏览器打开 https://${host} 试试：浏览器也打不开 = 这台手机的网络到不了它（常见：开了 VPN/代理、WiFi 有限制、站点挂了），换流量或关掉 VPN 再点一次；浏览器打得开 = 是 App 的问题，把这个截图发我。`,
  );
}

/**
 * 原生通道被系统拦、浏览器却通 —— 给能落地的开关，别让人去查网线。
 * 2026-10-13 实测：这种状态下 WiFi / 流量 / 重启 App 全没用，只有「重启手机」确定能解；
 * 电池白名单和联网管理放行是官方给的正规渠道，值得先试。
 */
function systemBlockedHint(): Error {
  return new Error(
    'App 的联网被手机系统拦掉了（同一时刻浏览器是通的，不是断网）。\n—— 按顺序试：① 彻底杀掉本应用再打开；② 系统设置里找「流量管理 / 应用联网管理」，确认没有禁掉本应用；③ 「电池 / 应用耗电管理」里把本应用设为不受限制；④ 重启手机 —— 系统网络引擎卡死时只有重启能解（本机实测过这种状态）。',
  );
}
