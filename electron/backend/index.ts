/*
 * 后端进程入口。
 *
 * 桌面版从「主进程里直接跑那 48 个路由」改成**独立后端进程 + Windows 命名管道**：
 *
 *   窗口 (app://app) ──► 主进程协议处理器 ──► 命名管道 ──► 本进程 ──► dispatchRequest
 *
 * 为什么要多这一跳（参考 AIFISHER 的做法，但对 Holy Light画布的规模做了取舍）：
 * - **不占任何 TCP 端口**。管道是每次启动随机生成的 `\\.\pipe\frame-backend-<uuid>`，
 *   没有「端口被占」这种失败模式，也不会被局域网或本机的其他程序碰到。
 * - **后端崩了不等于软件崩了**。它崩了只是这一层重启，窗口还在，页面拿到
 *   503 + `BACKEND_RECONNECTING` 显示「本机服务正在重新连接」。
 *   以前路由跑在主进程里，一个未捕获异常就是整个窗口白屏。
 * - **退出前能自己收尾**：收到 `stop` 先把库 flush 再退出。
 *
 * ⚠️ 这个文件**不能 import electron**。utilityProcess 是纯 Node 环境，
 * `require('electron')` 拿不到东西；所有路径靠主进程通过环境变量喂进来。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { configureRuntimePaths, runtimePaths } from '@/lib/runtime-paths';
import { setDataDir, flushData } from '@/lib/db';
import { shutdownLlm } from '@/lib/local-llm';
import { dispatchRequest } from './dispatch';

type ParentMessage = { type?: string } & Record<string, unknown>;

/**
 * 与父进程说话的通道。
 *
 * Electron 的 utilityProcess 给的是 `process.parentPort`（一个 MessagePort），
 * 普通 `child_process.fork` 给的是 `process.send` —— 两条路都留着，
 * 这样后端既能在 utilityProcess 里跑，也能被单独 `node` 起来排查问题。
 */
function parentChannel() {
  const port = (process as unknown as { parentPort?: { postMessage?: (m: unknown) => void; on?: (e: string, cb: (ev: { data?: unknown }) => void) => void } }).parentPort;
  if (port && typeof port.postMessage === 'function' && typeof port.on === 'function') {
    return {
      post: (message: ParentMessage) => port.postMessage?.(message),
      onMessage: (cb: (message: ParentMessage) => void) => port.on?.('message', (event) => cb((event?.data ?? {}) as ParentMessage)),
    };
  }
  return {
    post: (message: ParentMessage) => {
      if (typeof process.send === 'function') process.send(message);
    },
    onMessage: (cb: (message: ParentMessage) => void) => process.on('message', (m) => cb((m ?? {}) as ParentMessage)),
  };
}

/** 把 Node 的 `IncomingMessage` 转成路由层认识的 `Request`。 */
async function toRequest(req: http.IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const method = (req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && body.length > 0;
  return new Request(`${origin}${req.url || '/'}`, {
    method,
    headers: req.headers as Record<string, string>,
    body: hasBody ? body : undefined,
  });
}

/** 把路由层返回的 `Response` 写回 Node 的 `ServerResponse`。 */
async function writeResponse(res: http.ServerResponse, out: Response): Promise<void> {
  const buf = Buffer.from(await out.arrayBuffer());
  const headers: Record<string, string | string[]> = {};
  out.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return; // 单独处理：可能有多条
    headers[key] = value;
  });
  const cookies = (out.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  if (cookies.length) headers['set-cookie'] = cookies;
  if (!headers['content-length'] && !headers['transfer-encoding']) {
    headers['content-length'] = String(buf.length);
  }
  res.writeHead(out.status, headers);
  res.end(buf);
}

async function start(): Promise<void> {
  const paths = configureRuntimePaths();
  setDataDir(paths.dbDir);
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.runDir, { recursive: true });

  const channel = parentChannel();
  const origin = process.env.HOLYLIGHT_BACKEND_ORIGIN || 'http://localhost:3000';

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const out = await dispatchRequest(await toRequest(req, origin));
        await writeResponse(res, out);
      } catch (error) {
        console.error('[backend] 请求处理失败', error);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '接口异常' }));
      }
    })();
  });

  const pipe = String(process.env.HOLYLIGHT_BACKEND_PIPE || '').trim();
  const port = Number(process.env.HOLYLIGHT_BACKEND_PORT || 0);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (pipe) {
      /*
       * Windows 命名管道。Electron 的 http 模块支持 `socketPath`，
       * 这样整条链路一个端口都不占 —— 也就不存在「上次没退干净端口被占」。
       */
      server.listen(pipe, () => resolve());
    } else {
      /* 开发态 / 非 Windows：只绑回环地址，不给局域网留入口。 */
      server.listen(port || 5174, '127.0.0.1', () => resolve());
    }
  });

  const target = pipe || `127.0.0.1:${(server.address() as { port?: number })?.port ?? port}`;
  console.log(`[backend] 就绪 ${target} · 数据 ${paths.dataDir}`);

  channel.onMessage((message) => {
    if (message?.type !== 'stop') return;
    {
      /*
       * 优雅退出：先收掉本地模型，再把库 flush（写盘是标脏 + 合并的，不刷就丢），最后关监听。
       *
       * llama-server 是**我们自己 spawn 的子进程**，不收就成孤儿：一直占着几 GB 显存，
       * 用户看到的是「软件都关了显卡还是满的」，而且下次启动可能因为显存不够而失败。
       * 这一段 2026-09-20 随「小说转剧本」删过一次，2026-09-27 随「本地模型」加回来 ——
       * 只要这一层还会 spawn 子进程，它就不能省。
       */
      try {
        shutdownLlm();
      } catch (error) {
        console.error('[backend] 退出前收本地模型失败', error);
      }
      try {
        flushData();
      } catch (error) {
        console.error('[backend] 退出前 flush 失败', error);
      }
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    }
  });

  channel.post({ type: 'ready', target });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      try {
        shutdownLlm();
      } catch {
        /* 退出路径上不再抛 */
      }
      try {
        flushData();
      } catch {
        /* 退出路径上不再抛 */
      }
      process.exit(0);
    });
  }

  fs.appendFileSync(
    path.join(paths.logsDir, 'backend-lifecycle.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), event: 'ready', target, dataDir: paths.dataDir })}\n`,
    'utf8',
  );
}

/*
 * 后端进程里任何一个没接住的异常都要留下线索：
 * 它的 stdout/stderr 会被主进程追加写进 `data/logs/backend.*.log`，
 * 否则「点了没反应」这件事在这台机器上就完全没有证据。
 */
process.on('uncaughtException', (error) => {
  console.error('[backend] uncaughtException', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[backend] unhandledRejection', reason);
});

void start().catch((error) => {
  console.error('[backend] 启动失败', error);
  process.exit(1);
});
