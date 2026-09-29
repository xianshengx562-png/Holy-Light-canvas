import { ipcRenderer } from 'electron';

/**
 * 内置浏览器视图的 preload —— **只做一件事**：把「网页上开始拖的那张图」告诉主进程。
 *
 * 为什么这个视图需要一份 preload（它本来是刻意「不给 preload」的）：
 * Electron 里**两个 WebContentsView 之间不支持原生拖放**。网页上的图拖到左边画布上，
 * 画布那一侧根本收不到 `drop` —— 用户看到的是「拖过去了、松手了、什么都没发生」。
 * 所以只能由源头记住「这次拖的是哪张图」，等拖完了再由主进程按松手的位置落图
 * （落点换算见 `electron/main/browser-panel.ts`）。
 *
 * 安全性，两道：
 * 1. 这里**不调 contextBridge** —— 网页自己的脚本拿不到 `ipcRenderer`
 *    （contextIsolation 开着，两个 world 不共享全局），所以网页伪造不了这条消息。
 *    能发这条 IPC 的**只有这份脚本**。
 * 2. 主进程那边还会再验一次「发送者是不是浏览器视图自己」，见 browser-panel.ts。
 *
 * 于是即便这是一个跑着不可信网页的沙箱视图，它通向本应用的面也只有「我拖了一张图」
 * 这一条，而且不带任何可执行内容。
 */

const DRAG_START = 'browser:drag-start';
const DRAG_END = 'browser:drag-end';

/** 比这更小的 <img> 不当图 —— 图标、埋点像素、占位符会被用户「顺手」拖出来。 */
const MIN_DRAG_EDGE = 48;

type NodeLike = { closest?: (selector: string) => unknown };

/** 拖拽起点可能是文本节点（拖选中的字），那种没有 `closest`，直接不算。 */
function elementOf(target: EventTarget | null): NodeLike | null {
  const node = target as NodeLike | null;
  return node && typeof node.closest === 'function' ? node : null;
}

function absolute(src: string): string {
  try {
    return new URL(src, window.location.href).href;
  } catch {
    return '';
  }
}

/**
 * 认出「用户拖的是哪张图」。
 *
 * 只认两种源头：`<img>` 元素（含包着它的链接、容器）和 CSS 背景图。
 * **拖文字、拖链接一律不管** —— 那些拖拽本来就有它们自己的去处，
 * 接管了却送不过去（那不是一个图片地址），用户只会看到一句莫名的「取不下来」。
 */
function urlOfDrag(event: DragEvent): string {
  const node = elementOf(event.target);
  if (!node) return '';
  const img = node.closest?.('img') as HTMLImageElement | null;
  if (img && (img.naturalWidth || 0) >= MIN_DRAG_EDGE && (img.naturalHeight || 0) >= MIN_DRAG_EDGE) {
    return absolute(img.currentSrc || img.src || '');
  }
  /* 相当一部分图站的图是 CSS 背景，DOM 里根本没有 <img>。 */
  const style = getComputedStyle(node as unknown as Element);
  const found = /url\((?:"|')?(https?:\/\/[^"')]+)(?:"|')?\)/i.exec(String(style?.backgroundImage || ''));
  return found ? absolute(found[1]) : '';
}

/*
 * 捕获阶段挂在 `window` 上：`dragstart` 从源头元素冒泡上来，
 * 而页面自己可能 `stopPropagation`（图片懒加载、拖拽排序的库都会这么做）。
 * 捕获阶段先拿，不受它们影响。
 *
 * ⚠️ 这里**刻意不 preventDefault**：原生拖拽留着，用户才有「正在拖一张图」的视觉反馈，
 * 而 `dragend` 是唯一的「松手了」信号（拖到别的视图上时，源视图收不到 mouseup）。
 */
window.addEventListener('dragstart', (event) => {
  const url = urlOfDrag(event as DragEvent);
  if (!url) return;
  ipcRenderer.send(DRAG_START, { url });
}, true);

window.addEventListener('dragend', () => {
  ipcRenderer.send(DRAG_END);
}, true);
