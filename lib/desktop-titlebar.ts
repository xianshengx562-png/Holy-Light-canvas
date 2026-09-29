/**
 * 桌面版「隐藏系统标题栏」的渲染侧配套。**web 版里全部是安静的空操作** ——
 * 两个版本共用的组件不必分版本写两遍。
 *
 * 窗口是 `titleBarStyle: 'hidden'` + `titleBarOverlay`（见 `electron/main/index.ts`）：
 * 系统那条标题栏整条不要了，最小化 / 最大化 / 关闭三个按钮改成**浮在页头右上角**。
 * 于是渲染层要补两件事：
 *
 *   1. **量出那三个按钮实际占多宽**，写进 `--window-controls-inset`，页头据此把右侧让出来。
 *      不写死 138px 是因为这个宽度**跟着系统缩放走**（100% 是 138px、125% 是 172px、
 *      150% 是 207px）—— 写死的话，高 DPI 机器上「本机用户 / 返回项目」会被压在按钮底下。
 *      数据来源是 WCO 规范里的 `getTitlebarAreaRect()`：它给的是**留给网页**的那块矩形
 *      （按钮左边），所以「窗口宽 － 它」就是按钮占的宽度。
 *   2. **主题一变就把符号颜色报给主进程**（浅色页头配浅色符号＝按钮等于没有）。
 */

/** preload 暴露的那几个字段。与 `electron/preload/index.ts` 保持一致。 */
export type TitlebarApi = {
  platform?: string;
  setTitlebarTheme?: (dark: boolean) => void;
};

/** WCO（Window Controls Overlay）那套 API 的最小形状 —— 只在 Electron 桌面版里有。 */
type OverlayLike = {
  getTitlebarAreaRect?: () => DOMRect;
  addEventListener?: (type: string, listener: () => void) => void;
};

function api(): TitlebarApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { api?: TitlebarApi }).api ?? null;
}

function overlay(): OverlayLike | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as unknown as { windowControlsOverlay?: OverlayLike }).windowControlsOverlay ?? null;
}

function measure(ov: OverlayLike): void {
  const rect = ov.getTitlebarAreaRect?.();
  if (!rect) return;
  const inset = Math.max(0, Math.round(window.innerWidth - rect.width));
  document.documentElement.style.setProperty('--window-controls-inset', `${inset}px`);
}

/**
 * 装一次即可（在 React 渲染之前调，见 `src/main.tsx`）。
 *
 * 窗口尺寸 / 最大化还原 / 拖到另一块缩放比不同的显示器都会让那块矩形变，
 * 所以除了 WCO 自己的 `geometrychange`，再挂一个 `resize` 兜底
 * （实测最大化还原时前者不一定发）。
 */
export function installTitlebar(): void {
  /* 只有 Windows 有这套 overlay：macOS 的红绿灯在左边、Linux 各家不同。
     不是 win32 就把让位写成 0 —— 宁可少留白，也不要平白空出一块。 */
  if (api()?.platform !== 'win32') {
    document.documentElement.style.setProperty('--window-controls-inset', '0px');
    return;
  }
  const ov = overlay();
  if (!ov?.getTitlebarAreaRect) return;
  measure(ov);
  ov.addEventListener?.('geometrychange', () => measure(ov));
  window.addEventListener('resize', () => measure(ov));
}

/** 换主题时调用（在 `applyAppearance` 里，与写 `<html data-theme>` 同一处）。 */
export function syncTitlebarTheme(dark: boolean): void {
  api()?.setTitlebarTheme?.(dark);
}


/**
 * 现在是桌面版 Windows 吗？
 *
 * 给「只在桌面版才有意义」的零件判断用 —— 比如根上那条兜底拖拽条：
 * 它靠 `-webkit-app-region` 生效，web 版里那条规则整个不存在，
 * 留着就是一条白盖在页面顶端的透明带（还会吃掉顶部 5px 的 hover）。
 */
export function isDesktopWindows(): boolean {
  return typeof window !== 'undefined' && api()?.platform === 'win32';
}
