import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setDataDir, flushData } from '@/lib/db';
import { APP_ORIGIN } from '@/lib/app-origin';
import { dbDir, logsDir } from './runtime';

/*
 * MCP 与 Holy Light画布数据之间的**唯一通道**。
 *
 * 两条路，挑哪一条由「Holy Light画布是不是正在跑」决定，而**不是**由配置决定：
 *
 *   1. **旁路（pipe）** —— 转发给 Holy Light画布自己的后端进程。
 *      首选这条路的原因不是「省一次 SQLite 打开」，是**避免两个进程同时持有一份内存表**：
 *      `lib/db/store-sqlite.ts` 是「整表读进内存、脏了整表写回」的模型，两个进程各写一份时，
 *      后写的那个会把先写的那个整表覆盖掉 —— 没有报错、没有冲突提示，只有「刚才的改动没了」。
 *      走管道就只有一个写者（应用自己的后端进程），这个风险从根上不存在。
 *
 *   2. **进程内（in-process）** —— 直接调 `dispatchRequest()`，也就是 Holy Light画布后端跑的同一段分发代码。
 *      这是「应用没开」时唯一的路：Codex 仍然能读项目、改画布、跑生成（生成任务写进的是同一个库，
 *      下次打开 Holy Light画布就能在历史里看到）。
 *
 * ⚠️ 两条路跑的是**同一批路由**（`server/api/**`），不是两套实现。所谓「复用应用自己的后端逻辑」
 *   指的就是这一点：MCP 里没有重写任何一条业务规则。
 */

export type Transport = 'pipe' | 'in-process';

/** 后端每 ready 一次就往这个文件追加一行，里面记着本次监听的管道名（见 `electron/backend/index.ts`）。 */
const LIFECYCLE = 'backend-lifecycle.jsonl';
/** 探测结果的缓存时间：短到不影响「刚关掉应用」，长到不至于每次工具调用都去连一次管道。 */
const PROBE_TTL_MS = 3000;

let cachedProbe: { at: number; pipe: string | null } | null = null;

/**
 * 最近一次 ready 的管道名。
 *
 * 只取**最后一条** ready：这个文件是追加写的，每一次启动都留下自己的一行，
 * 而旧的那个管道在进程退出那一刻就已经不可连了 —— 拿第一条去连，命中率是零。
 */
function lastRecordedPipe(): string | null {
  try {
    const text = fs.readFileSync(path.join(logsDir, LIFECYCLE), 'utf8');
    let found: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { event?: string; target?: string };
        if (record.event === 'ready' && typeof record.target === 'string') found = record.target;
      } catch {
        /* 一行坏了不影响别的行，跳过即可 —— 这是日志，不是账本 */
      }
    }
    return found;
  } catch {
    /* 没有这个文件只说明应用从来没起过，不是错误 */
    return null;
  }
}

/**
 * 这个管道现在连得上吗？
 *
 * 用一次真的 connect 而不是去查进程列表：
 * - 查进程要靠 shell（`tasklist`），而 MCP 是给 Codex 拉起来的，多一个子进程依赖多一处失败点；
 * - 「进程在」和「后端 ready」不是一回事 —— 正在崩溃重启的那几秒进程还在，但管道已经不接了，
 *   而那正是**必须**走进程内那条路的时刻。连得上 = 真的在接请求。
 */
function canReach(pipe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(pipe);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(800);
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
    socket.on('timeout', () => finish(false));
  });
}

async function currentPipe(): Promise<string | null> {
  const now = Date.now();
  if (cachedProbe && now - cachedProbe.at < PROBE_TTL_MS) return cachedProbe.pipe;
  const pipe = lastRecordedPipe();
  const alive = pipe ? await canReach(pipe) : false;
  cachedProbe = { at: now, pipe: alive ? pipe : null };
  return cachedProbe.pipe;
}

/** 忘掉缓存：管道刚断的时候用，免得接下来几秒一直往一条死管道上发。 */
function invalidateProbe(): void {
  cachedProbe = null;
}

export type ApiResult = { transport: Transport; status: number; body: unknown; raw: string };

/** `Accept: application/json` 必须带：`POST /api/projects` 靠它决定回 `{id}` 还是回 303。 */
const JSON_HEADERS = { accept: 'application/json', origin: APP_ORIGIN } as const;

async function viaPipe(pipe: string, method: string, urlPath: string, body: unknown): Promise<ApiResult> {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  const raw = await new Promise<string>((resolve, reject) => {
    const outgoing = http.request({ socketPath: pipe, method, path: urlPath, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      incoming.resume();
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error('Holy Light画布后端 30 秒没有响应。')));
    if (payload !== null) outgoing.write(payload);
    outgoing.end();
  });
  return { transport: 'pipe', status: 200, body: parseBody(raw), raw };
}

/**
 * 进程内那条路的**每次调用**都要补齐三件事，缺一件后果各不相同：
 *
 * - **调用前 `setDataDir(dbDir)`** —— 它会 `db.close()` 并清空整表缓存，下一次读就从磁盘重载。
 *   Holy Light画布开着的时候（这条分支下一般是关的，但保不齐用户边改边用），不重载就会读到 MCP 自己
 *   那份老副本，界面上的新节点一个都看不见。
 * - **`origin` 头** —— `normalize()` 其实也会补，但补的是同一个值，带上只是让意图显式。
 * - **调用后 `flushData()`** —— 写入是「标脏 + 200ms 后合并落盘」的，MCP 这种一次调用完就干等
 *   的用法不 flush 的话，进程一退出最近那次改动就没了。
 */
async function viaDispatch(method: string, urlPath: string, body: unknown): Promise<ApiResult> {
  const { dispatchRequest } = await import('@/electron/backend/dispatch');
  setDataDir(dbDir);
  const headers = new Headers({ ...JSON_HEADERS });
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await dispatchRequest(new Request(`${APP_ORIGIN}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const raw = await response.text();
  flushData();
  return { transport: 'in-process', status: response.status, body: parseBody(raw), raw };
}

function parseBody(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* 少数路由（下载类）回的不是 JSON，把原文带回去，别把有用的报错信息吃掉 */
    return text;
  }
}

export class ApiFailure extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
  }
}

/**
 * 打一次接口。`{ error }` 一律当失败抛 —— 路由层已经把话说清楚了，原文往上透。
 *
 * ⚠️ 光看状态码**不够**：多数业务错误确实带了 404 / 409，但 `/api/tasks/[id]` 这条是
 * 「把 `error` 挂在任务对象上、状态码仍是 200」写的（密钥没配时任务照样要显示出来）。
 * 只看状态码，那一类失败会原样透给用户一个「成功」的结果。
 */
export async function callApi(method: string, urlPath: string, body?: unknown): Promise<ApiResult> {
  const pipe = await currentPipe();
  if (pipe) {
    try {
      const result = await viaPipe(pipe, method, urlPath, body);
      if (result.status >= 400 || hasErrorShape(result.body)) {
        throw new ApiFailure(errorText(result.body, result.raw), result.body);
      }
      return result;
    } catch (error) {
      // 管道是在半路断的才值得静默切路；业务报错（服务端明确回了 error）不许在这丢掉。
      if (error instanceof ApiFailure) throw error;
      invalidateProbe();
      console.error('[mcp] 管道转发失败，改为进程内执行', error);
    }
  }
  const result = await viaDispatch(method, urlPath, body);
  if (result.status >= 400 || hasErrorShape(result.body)) {
    throw new ApiFailure(errorText(result.body, result.raw), result.body);
  }
  return result;
}

function hasErrorShape(body: unknown): boolean {
  return Boolean(body) && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string';
}

function errorText(body: unknown, raw: string): string {
  if (hasErrorShape(body)) return String((body as { error: string }).error);
  return raw.slice(0, 500) || '接口调用失败。';
}

/** `frame_status` 要用：现在到底走的哪条路、应用开没开。 */
export async function transportState(): Promise<{ transport: Transport; appRunning: boolean }> {
  const pipe = await currentPipe();
  return { transport: pipe ? 'pipe' : 'in-process', appRunning: Boolean(pipe) };
}
