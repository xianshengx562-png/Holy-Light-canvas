import readline from 'node:readline';

/*
 * ⚠️ 这个文件的前三个 import 顺序不能动。
 *
 * `./runtime` 必须是第一个：它做的事（算数据目录、写环境变量）必须跑在
 * 任何 `lib/**` 模块被求值之前 —— 那批模块有的在被 import 的那一刻就算好了自己的落盘目录。
 * （理由详见 `runtime.ts` 顶部与 `electron/main/paths.ts`，两处是同一个坑。）
 */
import './runtime';
import { BadInput, runTool, toolManifest } from './tools';
import { flushData } from '@/lib/db';
import { dbDir } from './runtime';

/*
 * stdio MCP 的**第一条铁律**：stdout 是协议通道，只能往外发 JSON-RPC 报文。
 *
 * Holy Light画布那 48 个路由里有 `console.log`（比如 `[db] 补列 xxx`），任何一个漏到 stdout 上，
 * Codex 那边看到的就是「一个 JSON 报文混着一行日志」——整条流从此再也解不出帧，
 * 而且失败方式是**静默**的：工具列表会一直是空的，没有任何报错。
 * 所以这里把 console 的那几个输出方法整体改道到 stderr（那里是给人看的，且不清协议）。
 */
for (const level of ['log', 'info', 'warn', 'debug', 'trace'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
    void original;
  };
}

const SERVER_INFO = { name: 'frame', version: '1.0.0' } as const;
/** 协议版本：客户端带着自己支持的版本来，我们只会比接通了的那几种，够用就不谈新的。 */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';

type JsonRpc = { id?: number | string | null; method?: string; params?: Record<string, unknown> };

function send(message: unknown): void {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    /* 管道断了（Codex 关了）：这时候能做的只有别再崩一次 */
    console.error('[mcp] 写回失败', error);
  }
}

function result(id: number | string | null | undefined, payload: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, result: payload });
}

function failure(id: number | string | null | undefined, code: number, message: string, data?: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

/** 工具的实现抛出来的是**说给人听**的话（「画布里没有这个节点」），原样透给模型，不包一层技术黑话。 */
function describe(error: unknown): string {
  if (error instanceof BadInput) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function handle(request: JsonRpc): Promise<void> {
  const { id, method, params } = request;
  switch (method) {
    case 'initialize': {
      const asked = String((params?.protocolVersion as string) ?? DEFAULT_PROTOCOL);
      result(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case 'ping':
      result(id, {});
      return;
    case 'tools/list':
      result(id, { tools: toolManifest() });
      return;
    case 'tools/call': {
      const name = String((params?.name as string) ?? '');
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      try {
        const value = await runTool(name, args);
        result(id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false });
      } catch (error) {
        console.error(`[mcp] ${name} 失败`, error);
        /* 工具失败**也是**一次成功的 JSON-RPC —— 用 isError 标记，让模型能读到原因。 */
        result(id, { content: [{ type: 'text', text: describe(error) }], isError: true });
      }
      return;
    }
    /* 下面这些是「我们确实没有，但客户端可能会问」的，回空表比回 -32601 更不容易让对方卡住。 */
    case 'resources/list':
      result(id, { resources: [] });
      return;
    case 'resources/templates/list':
      result(id, { resourceTemplates: [] });
      return;
    case 'prompts/list':
      result(id, { prompts: [] });
      return;
    default:
      if (id === undefined || id === null) return; // 通知（notifications/*）：按规矩不回
      failure(id, -32601, `不支持的方法：${method}`);
  }
}

/**
 * 从一个流式缓冲里切出一份份完整的 JSON。
 *
 * 用**括号配对**而不是「一行一个报文」，是因为两件事都会发生：
 * 发的一方可能开了 pretty print（一个报文占二十行），也可能把几个报文挤在一行里。
 * 只按行切会让这两种都解不出来 —— 而症状同样是「工具列表一直是空的」。
 */
function extract<T>(buffer: string): { messages: JsonRpc[]; rest: string } {
  const messages: JsonRpc[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    if (buffer[cursor] !== '{') {
      cursor += 1;
      continue;
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let i = cursor; i < buffer.length; i += 1) {
      const char = buffer[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) break; // 还没收完整
    const slice = buffer.slice(cursor, end + 1);
    try {
      const parsed = JSON.parse(slice) as JsonRpc;
      if (parsed && typeof parsed === 'object') messages.push(parsed);
    } catch (error) {
      console.error('[mcp] 解不出一个报文', (error as Error).message, slice.slice(0, 200));
    }
    cursor = end + 1;
  }
  return { messages, rest: cursor >= buffer.length ? '' : buffer.slice(cursor) };
}

function main(): void {
  let buffer = '';
  const line = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  line.on('line', (chunk) => {
    const next = extract(`${buffer}${chunk}\n`);
    buffer = next.rest;
    void (async () => {
      for (const message of next.messages) await handle(message);
    })();
  });
  /*
   * Codex 关掉 MCP 的方式是把 stdin 关了。此时所有写操作都已经 flush 过了
   * （每一次进程内调用末尾都 flushData()），所以这里只需要干净地退出；
   * 再 flush 一次是为了接住「一次调用都没发生过」这种情况。
   */
  line.on('close', () => {
    try {
      flushData();
    } catch {
      /* 退出路径上不再抛 */
    }
    process.exit(0);
  });

  console.error(`[mcp] Holy Light画布 MCP 就绪 · 数据 ${dbDir} · node ${process.version}`);
}

process.on('uncaughtException', (error) => console.error('[mcp] uncaughtException', error));
process.on('unhandledRejection', (reason) => console.error('[mcp] unhandledRejection', reason));

main();
