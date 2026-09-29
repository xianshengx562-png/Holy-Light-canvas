import http from 'node:http';
import { Readable } from 'node:stream';
import { APP_ORIGIN } from '@/lib/app-origin';

/**
 * 主进程这一侧的协议转发。
 *
 * `/api/*` 不再在进程内分发给那 48 个路由 —— 路由跑在独立的**后端进程**里
 * （分发代码在 `electron/backend/dispatch.ts`），主进程只负责把请求转到它的命名管道。
 *
 * ⚠️ 这个文件**不能** import `routes.generated`：那会把全部路由模块拖进主进程产物，
 * 而主进程一个都用不上。要判「这个路径是不是接口」只看前缀就够了。
 *
 * 好处是路由里一个未捕获的异常不再让窗口白屏 —— 现在只让后端进程重启一次，
 * 页面拿到的是 503 + `BACKEND_RECONNECTING`。
 */
export { APP_ORIGIN };

/** 逐跳头不能透传，转发层自己会决定。 */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'];
/*
 * `host` / `origin` / `referer` 也要丢掉：后端只信任管道，而 `app://app` 这种自定义协议的
 * origin 解析出来是字符串 `"null"`，透过去只会让后端的 `checkOrigin()` 全线 403。
 * 后端那一侧的 `normalize()` 会补上正确的 origin —— 那是唯一一次机会。
 */
const DROPPED_REQUEST_HEADERS = new Set<string>([...HOP_BY_HOP, 'host', 'origin', 'referer']);
const DROPPED_RESPONSE_HEADERS = new Set<string>(HOP_BY_HOP);

/**
 * 后端不在（正在重启 / 起不来）时给页面的响应。
 *
 * 必须是 **503 + 一个固定的 code**，让前端能把它显示成「本机服务正在重新连接」，
 * 而不是「网络错误」—— 后者会让人以为断网了，去查根本无辜的网络。
 */
export function reconnectingResponse(): Response {
  return new Response(JSON.stringify({ error: '本机服务正在重新连接，请稍后重试。', code: 'BACKEND_RECONNECTING' }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '1' },
  });
}

/**
 * 把请求转到后端的命名管道。
 *
 * 请求体与响应体都是**流式**的：`Range` 头也一路透传，所以视频拖动、大图预览
 * 不会在中间被整块读进内存。
 */
export function forwardToBackend(request: Request, pipe: string): Promise<Response> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!DROPPED_REQUEST_HEADERS.has(key)) headers[key] = value;
  });

  return new Promise<Response>((resolve) => {
    let answered = false;
    const answer = (response: Response) => {
      if (answered) return;
      answered = true;
      resolve(response);
    };
    const outgoing = http.request(
      { socketPath: pipe, method: request.method, path: `${url.pathname}${url.search}`, headers },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (DROPPED_RESPONSE_HEADERS.has(key)) continue;
          for (const item of [value].flat()) responseHeaders.append(key, String(item));
        }
        const empty = request.method === 'HEAD' || incoming.statusCode === 204 || incoming.statusCode === 304;
        if (empty) incoming.resume();
        answer(
          new Response(empty ? null : (Readable.toWeb(incoming) as ReadableStream), {
            status: incoming.statusCode ?? 502,
            headers: responseHeaders,
          }),
        );
      },
    );
    /* 后端在处理途中退出，对页面来说就是「正在重连」，不是网络故障。 */
    outgoing.on('error', () => answer(reconnectingResponse()));
    request.signal?.addEventListener('abort', () => outgoing.destroy(), { once: true });
    if (request.body) {
      const body = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]);
      body.on('error', () => outgoing.destroy());
      body.pipe(outgoing);
    } else {
      outgoing.end();
    }
  });
}
