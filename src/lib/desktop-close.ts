/**
 * 关闭窗口确认（只有桌面版有）。
 *
 * 点右上角系统关闭按钮时，主进程**拦下默认退出**（`electron/main/index.ts` 的
 * `win.on('close')` 里 `preventDefault()`），改成通过 IPC 推一个 `request-close`
 * 事件过来，让渲染层弹出自绘的确认框（最小化 / 退出应用）。用户在框里选了之后，
 * 再调 `windowCloseAction` 把选择回传给主进程。
 *
 * web 版没有 `window.api`：两个函数都安静返回（onRequestClose 返回空取消函数、
 * windowCloseAction 解析为已完成的 Promise），界面不会弹框，也不需要为两种版本写两遍。
 */

export type CloseAction = 'minimize' | 'quit';

type DesktopCloseApi = {
  onRequestClose?: (listener: () => void) => () => void;
  windowCloseAction?: (action: CloseAction) => Promise<void>;
};

function closeApi(): DesktopCloseApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { api?: DesktopCloseApi }).api ?? null;
}

/** 订阅「请求关闭」事件，返回取消订阅函数（不在桌面版时返回空函数）。 */
export function onRequestClose(listener: () => void): () => void {
  const api = closeApi();
  if (!api?.onRequestClose) return () => {};
  try {
    return api.onRequestClose(listener);
  } catch {
    return () => {};
  }
}

/** 把用户的选择（最小化 / 退出应用）回传给主进程。 */
export function windowCloseAction(action: CloseAction): Promise<void> {
  const api = closeApi();
  if (!api?.windowCloseAction) return Promise.resolve();
  return api.windowCloseAction(action);
}
