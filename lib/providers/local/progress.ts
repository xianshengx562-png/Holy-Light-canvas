import 'server-only';
import { LOCAL_WS_PATH } from './config';
import type { LocalCredentials } from './client';

/**
 * 本机 ComfyUI 的**实时进度**（跑到了哪个节点、百分之几）。
 *
 * 为什么必须有这一层：ComfyUI 只有 `/history` 能轮询，而它在跑完之前**什么都不给** ——
 * 界面上就是一个转圈的图标，用户分不清「正在跑第 3 步」和「卡住了」。
 * 节点级进度只有 WebSocket 上才有（`executing` / `progress` 两条消息）。
 *
 * ⚠️ 它是**纯增强**：连不上、运行时没有 WebSocket、消息不认得 —— 任何一种情况都只是
 * 「没有进度」，`/history` 那套轮询该怎么跑还怎么跑。进度永远不能成为任务完成与否的依据。
 */

export type LocalProgress = {
  /** ComfyUI 图里的节点编号（`'3'`），用来显示「正在跑哪个节点」。 */
  nodeId?: string;
  /** 节点类型（`KSampler`）。`executing` 消息里没有它，是我们按提交的那张图补上的。 */
  nodeType?: string;
  value?: number;
  max?: number;
  /** 队列里排在这次前面的还有几个。`0` 表示正在跑。 */
  queueRemaining?: number;
  updatedAt: number;
};

/** 一条进度多久没更新就当它过期（任务早跑完了，或者看护断了）。 */
const STALE_MS = 10 * 60 * 1000;
/** 最多记这么多条：跑崩了 / 用户关了窗口时，不能让这个 Map 一直涨。 */
const MAX_ENTRIES = 64;

const store = new Map<string, LocalProgress>();

function prune() {
  const now = Date.now();
  for (const [key, value] of store) {
    if (now - value.updatedAt > STALE_MS) store.delete(key);
  }
  /* 按时间清过一轮还超出上限，就从最老的开始删（Map 保持插入顺序）。 */
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** 给 `/api/tasks/[id]` 用：返回这次任务最新的进度，没有就是 null。 */
export function readLocalProgress(promptId: string): LocalProgress | null {
  const key = String(promptId || '');
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > STALE_MS) {
    store.delete(key);
    return null;
  }
  return entry;
}

/** 任务已经是终态，进度不再有意义 —— 主动删掉，别让 Map 攒着。 */
export function clearLocalProgress(promptId: string): void {
  store.delete(String(promptId || ''));
}

function patch(promptId: string, next: Partial<LocalProgress>) {
  const current = store.get(promptId);
  store.set(promptId, { ...current, ...next, updatedAt: Date.now() });
  prune();
}

/**
 * WebSocket 的构造函数。
 *
 * 不直接写 `new WebSocket(...)`：这个模块跑在服务端的 Node 里，而 `WebSocket` 是
 * **Node 22.4 才默认开启**的全局。拿不到就当作「这台机器没有实时进度」，
 * 绝不能因为在旧运行时里找不到构造函数而让一次生成失败。
 */
type SocketLike = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  close: () => void;
};
type SocketCtor = new (url: string) => SocketLike;

function socketCtor(): SocketCtor | null {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof ctor === 'function' ? (ctor as SocketCtor) : null;
}

/** `http://127.0.0.1:8188` → `ws://127.0.0.1:8188/ws?clientId=...`。 */
export function localWebSocketUrl(base: string, clientId: string): string {
  const trimmed = String(base || '').replace(/\/+$/, '');
  return `${trimmed.replace(/^http/i, 'ws')}${LOCAL_WS_PATH}?clientId=${encodeURIComponent(clientId)}`;
}

export type WatchInput = {
  credentials: LocalCredentials;
  clientId: string;
  promptId: string;
  /** 图里的 `节点编号 → 节点类型`。用来把 `executing` 里的编号说成人看得懂的名字。 */
  nodeTypes?: Record<string, string>;
};

/**
 * 开一条 WS 看护。**不 await**：它只影响「界面上能不能看到百分之几」，
 * 不该让提交那一步等它，也不该让它连不上时把生成拖垮。
 */
export function watchLocalProgress(input: WatchInput): void {
  const Ctor = socketCtor();
  if (!Ctor) return;
  const base = String(input.credentials?.baseUrl || '').trim().replace(/\/+$/, '');
  const promptId = String(input.promptId || '').trim();
  if (!base || !promptId) return;

  patch(promptId, { updatedAt: Date.now() });
  let socket: SocketLike;
  try {
    socket = new Ctor(localWebSocketUrl(base, input.clientId));
  } catch {
    return;
  }

  /* 看护最长活这么久：跑不完的任务由 /history 轮询去收尾，WS 不该一直挂着。 */
  const timer = setTimeout(() => {
    try { socket.close(); } catch { /* 已经关了 */ }
  }, STALE_MS);

  socket.onmessage = (event) => {
    let payload: { type?: string; data?: Record<string, unknown> };
    try {
      payload = JSON.parse(String(event.data ?? '')) as typeof payload;
    } catch {
      return;
    }
    const data = payload.data || {};
    /*
     * ComfyUI 会在同一条连接上广播**所有**客户端的任务，所以必须认 owner。
     * 少数消息（比如 `status`）不带 `prompt_id` —— 那种只更新队列长度，无害。
     */
    if (data.prompt_id != null && String(data.prompt_id) !== promptId) return;
    const nodeTypes = input.nodeTypes || {};

    if (payload.type === 'status') {
      const info = data.status as { exec_info?: { queue_remaining?: number } } | undefined;
      const remaining = Number(info?.exec_info?.queue_remaining);
      if (Number.isFinite(remaining)) patch(promptId, { queueRemaining: remaining });
      return;
    }
    if (payload.type === 'execution_start') {
      patch(promptId, { queueRemaining: 0 });
      return;
    }
    if (payload.type === 'executing') {
      /* `node` 为 null 是「这一轮跑完了」：把节点清掉，别让界面停在最后一个节点上。 */
      const node = data.node == null ? '' : String(data.node);
      patch(promptId, {
        nodeId: node || undefined,
        nodeType: node ? nodeTypes[node] : undefined,
        queueRemaining: 0,
        value: undefined,
        max: undefined,
      });
      return;
    }
    if (payload.type === 'progress') {
      const value = Number(data.value);
      const max = Number(data.max);
      const node = data.node == null ? '' : String(data.node);
      patch(promptId, {
        value: Number.isFinite(value) ? value : undefined,
        max: Number.isFinite(max) && max > 0 ? max : undefined,
        nodeId: node || undefined,
        nodeType: node ? nodeTypes[node] : undefined,
      });
      return;
    }
    /* 跑到终态（报错 / 出结果）就收掉看护，剩下的交给 /history 那边的结论。 */
    if (payload.type === 'execution_error' || payload.type === 'executed') {
      clearTimeout(timer);
      try { socket.close(); } catch { /* 已经关了 */ }
    }
  };
  const finish = () => clearTimeout(timer);
  socket.onerror = finish;
  socket.onclose = finish;
}
