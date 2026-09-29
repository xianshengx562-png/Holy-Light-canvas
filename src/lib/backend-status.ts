/**
 * 后端进程的连接状态（只有桌面版有）。
 *
 * 桌面版的数据请求走 `app://` 协议的 `/api/*`，由主进程转发给**另一个进程**的命名管道。
 * 那个进程崩了窗口还在，页面只会收到一个 503（body 里写着 `BACKEND_RECONNECTING`）——
 * 「正在重连」还是「彻底坏了」页面自己分不出来，只有主进程的监管器知道。
 * 所以它额外通过 IPC 把状态推过来，这里就是渲染进程那一端。
 *
 * web 版没有 `window.api`，两个函数都安静地什么都不做：界面不需要为两种版本写两遍。
 */

export type BackendState = 'stopped' | 'starting' | 'ready' | 'reconnecting' | 'stopping' | 'failed';

type BackendApi = {
  backendState?: () => Promise<BackendState>;
  onBackendState?: (listener: (state: BackendState) => void) => () => void;
};

function backendApi(): BackendApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { api?: BackendApi }).api ?? null;
}

/** 这个状态要不要打扰用户：`ready` 什么都不用显示。 */
export function isBackendOffline(state: BackendState): boolean {
  return state === 'starting' || state === 'reconnecting' || state === 'failed' || state === 'stopped';
}

export function backendMessage(state: BackendState): string {
  switch (state) {
    case 'starting':
      return '本机服务正在启动，页面暂时读不到数据。';
    case 'reconnecting':
      return '本机服务正在重新连接，请稍后重试。';
    case 'failed':
      return '本机服务多次启动失败，请重启软件；若仍不行，请把数据目录下的 backend.stderr.log 发给我们。';
    case 'stopped':
      return '本机服务已停止。';
    default:
      return '';
  }
}

/** 查一次当前状态（挂载时对齐用，见下面的说明）。返回 null 表示不在桌面版。 */
export async function fetchBackendState(): Promise<BackendState | null> {
  const api = backendApi();
  if (!api?.backendState) return null;
  try {
    return await api.backendState();
  } catch {
    return null;
  }
}

/**
 * 订阅状态变化，返回取消订阅的函数（不在桌面版时返回一个空函数）。
 *
 * ⚠️ 光订阅是不够的：推送只在状态**变化**时发生，而窗口是「不等后端 ready 就先开」的，
 * 页面挂载得晚就一条都收不到，会一直显示「正在连接」。所以调用方要先用
 * `fetchBackendState()` 对齐一次，再订阅后续变化。
 */
export function subscribeBackendState(listener: (state: BackendState) => void): () => void {
  const api = backendApi();
  if (!api?.onBackendState) return () => {};
  try {
    return api.onBackendState(listener);
  } catch {
    return () => {};
  }
}
