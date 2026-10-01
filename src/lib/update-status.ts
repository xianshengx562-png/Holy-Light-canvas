/**
 * 渲染进程那一端的「软件内更新」（2026-09-29）。
 *
 * 与 `lib/backend-status.ts` 同一个形状：`window.api` 只在桌面版存在，
 * web 版里这几个函数安静地什么都不做 —— 界面不需要为两种版本写两遍。
 * 真正的状态机在 `lib/update-state.ts`，electron-updater 的接线在 `electron/main/updater.ts`。
 */

/*
 * ⚠️ 走 `@/lib/update-state` 而不是 `./update-state`：状态机放在**工程根**的 `lib/` 里，
 * 因为主进程（`electron/main/updater.ts`）和预加载也要用同一份 —— 那边 `@/` 指向工程根。
 * 渲染进程的 `@/` 是先找 `src/`、找不到再回落工程根（见 `electron.vite.config.ts` 的
 * `resolveAt()`），所以两种版本里这一个 import 都指向同一个文件。
 */
import type { UpdateState } from '@/lib/update-state';

type UpdateApi = {
  updaterState?: () => Promise<UpdateState>;
  onUpdaterState?: (listener: (state: UpdateState) => void) => () => void;
  updaterCheck?: () => Promise<UpdateState>;
  updaterDownload?: () => Promise<UpdateState>;
  updaterInstall?: () => Promise<void>;
  updaterSetSource?: (url: string) => Promise<UpdateState>;
};

function updateApi(): UpdateApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { api?: UpdateApi }).api ?? null;
}

/**
 * 查一次当前状态。返回 null 表示不在桌面版 —— 调用方据此整块不渲染。
 *
 * ⚠️ 光订阅是不够的：推送只在状态**变化**时发，而「启动后自动检查」那一次
 * 很可能发生在页面挂载之前，页面会一条都收不到。所以要先查一次对齐，再订阅。
 */
export async function fetchUpdateState(): Promise<UpdateState | null> {
  const api = updateApi();
  if (!api?.updaterState) return null;
  try {
    return await api.updaterState();
  } catch {
    return null;
  }
}

export function subscribeUpdateState(listener: (state: UpdateState) => void): () => void {
  const api = updateApi();
  if (!api?.onUpdaterState) return () => {};
  try {
    return api.onUpdaterState(listener);
  } catch {
    return () => {};
  }
}

export async function checkUpdate(): Promise<UpdateState | null> {
  const api = updateApi();
  if (!api?.updaterCheck) return null;
  try {
    return await api.updaterCheck();
  } catch {
    return null;
  }
}

export async function downloadUpdate(): Promise<UpdateState | null> {
  const api = updateApi();
  if (!api?.updaterDownload) return null;
  try {
    return await api.updaterDownload();
  } catch {
    return null;
  }
}

/**
 * 退出并安装。
 *
 * 🔴 这一步会**关掉整个软件**，所以只能由用户点按钮触发 —— 任何自动调用都会让
 * 用户正在做的事（生成、上传、写了一半的提示词）凭空消失。
 */
export async function installUpdate(): Promise<void> {
  const api = updateApi();
  if (!api?.updaterInstall) return;
  try {
    await api.updaterInstall();
  } catch {
    /* 装不动就留在原地，界面上的状态没变，用户还能再点一次。 */
  }
}

/**
 * 改更新源（写进数据目录，下次启动还认）。
 *
 * 2026-10-01：**界面上已经没有入口了**（更新源走默认值，那张卡收掉了）。
 * 这一条保留着 —— IPC 通道还在，以后要加「高级设置」或者让站长自己换源时不用重新接线。
 */
export async function setUpdateSource(url: string): Promise<UpdateState | null> {
  const api = updateApi();
  if (!api?.updaterSetSource) return null;
  try {
    return await api.updaterSetSource(url);
  } catch {
    return null;
  }
}
