/**
 * 画布里的内置浏览器（**只有桌面版有**）。
 *
 * 走 preload 暴露的 `window.api.browser*`，web 版里这些字段不存在 ——
 * 两个版本共用的组件直接调就行，拿不到就当「不支持」。
 *
 * 与 `desktop-fs.ts` 同构，差别是这边的通道**会失败，而且失败是常态**：
 * 浏览器那边可能没连上网、地址可能被拒（不是 http）、面板可能已经被关掉。
 * 所以每个函数都吞掉异常、回一个「什么都没发生」的值，把错误交给调用方决定
 * 要不要显示 —— 而不是让一次跳转失败把整个面板炸掉。
 */

export type BrowserState = {
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type BrowserRect = { x: number; y: number; width: number; height: number };

export type BrowserCommand = 'back' | 'forward' | 'reload' | 'stop';

type DesktopBrowserApi = {
  browserState?: () => Promise<BrowserState>;
  browserOpen?: (payload: { bounds: BrowserRect; url?: string }) => Promise<BrowserState>;
  browserClose?: () => Promise<BrowserState>;
  browserNavigate?: (url: string) => Promise<BrowserState>;
  browserSetBounds?: (bounds: BrowserRect) => Promise<void>;
  browserCommand?: (command: BrowserCommand) => Promise<BrowserState>;
  onBrowserState?: (listener: (state: BrowserState) => void) => () => void;
  browserGrabImage?: (payload: { url: string }) => Promise<boolean>;
  browserPageImages?: () => Promise<BrowserPageImage[]>;
  onBrowserImage?: (listener: (image: BrowserImage) => void) => () => void;
  onBrowserImageError?: (listener: (message: string) => void) => () => void;
  onBrowserImageDrop?: (listener: (drop: BrowserImageDrop) => void) => () => void;
};

/** 主进程取下来的一张网页图片。字节直接过 IPC，不落盘。 */
export type BrowserImage = { name: string; mime: string; bytes: Uint8Array; url: string };

/** 页面里一张可用图片的出处（主进程在页面里跑一段只读脚本抓到的 `<img>`）。 */
export type BrowserPageImage = { url: string; width: number; height: number };

/**
 * 从网页上**拖**一张图、在画布上松手的位置。
 *
 * `x` / `y` 与渲染层的 `getBoundingClientRect()` 同一套坐标（窗口内容区，CSS 像素），
 * 所以可以直接喂给 `document.elementFromPoint()` 去找「松手时压在哪个节点上」。
 */
export type BrowserImageDrop = { url: string; x: number; y: number };

function browserApi(): DesktopBrowserApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { api?: DesktopBrowserApi }).api;
  return api?.browserOpen ? api : null;
}

/** 界面上要不要显示「内置浏览器」这个入口（web 版不该显示一个点了没反应的按钮）。 */
export function browserSupported(): boolean {
  return browserApi() !== null;
}

export const CLOSED_BROWSER_STATE: BrowserState = {
  open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false,
};

/**
 * 打开面板并停在 `url`（不给就停在浏览器上次那一页）。
 *
 * ⚠️ `bounds` 是**渲染层量出来的**，主进程只做夹取、不替你猜。
 * 传之前必须是 `getBoundingClientRect()` 那一套坐标（相对视口、CSS 像素）。
 */
export async function openBrowser(bounds: BrowserRect, url?: string): Promise<BrowserState | null> {
  const api = browserApi();
  if (!api?.browserOpen) return null;
  try {
    return await api.browserOpen(url ? { bounds, url } : { bounds });
  } catch {
    return null;
  }
}

export async function closeBrowser(): Promise<BrowserState | null> {
  const api = browserApi();
  if (!api?.browserClose) return null;
  try {
    return await api.browserClose();
  } catch {
    return null;
  }
}

/** 跳转。地址不对（不是 http(s)、带用户名密码、超长）会被主进程拒掉 —— 返回 null。 */
export async function navigateBrowser(url: string): Promise<BrowserState | null> {
  const api = browserApi();
  if (!api?.browserNavigate) return null;
  try {
    return await api.browserNavigate(url);
  } catch {
    return null;
  }
}

/**
 * 占位区挪了 / 变大了，把新矩形告诉主进程。
 *
 * 故意**不 await 也不报错**：它会在拖动边缘的过程中被每秒调用几十次，
 * 任何一次失败都无所谓 —— 下一次成功调用会立刻把它纠正过来。
 */
export function setBrowserBounds(bounds: BrowserRect): void {
  const api = browserApi();
  if (!api?.browserSetBounds) return;
  void api.browserSetBounds(bounds).catch(() => undefined);
}

export async function browserCommand(command: BrowserCommand): Promise<BrowserState | null> {
  const api = browserApi();
  if (!api?.browserCommand) return null;
  try {
    return await api.browserCommand(command);
  } catch {
    return null;
  }
}

/**
 * 订阅浏览器状态。**返回取消订阅的函数**。
 *
 * 面板第一次挂载要自己先查一次 `readBrowserState()`：状态推送只在**变化时**发，
 * 而面板打开那一瞬间浏览器早就开着了，一条都收不到。
 */
export function onBrowserState(listener: (state: BrowserState) => void): () => void {
  const api = browserApi();
  if (!api?.onBrowserState) return () => undefined;
  return api.onBrowserState(listener);
}

export async function readBrowserState(): Promise<BrowserState | null> {
  const api = browserApi();
  if (!api?.browserState) return null;
  try {
    return await api.browserState();
  } catch {
    return null;
  }
}

/**
 * 要主进程去取一张网页图片。
 *
 * 这里**只管发请求**：图到了是以 `onBrowserImage` 事件回来的。取图要走主进程是因为
 * 渲染层 `fetch` 会被同源策略挡住（绝大多数图站的图在页面里根本读不到字节），
 * 而主进程用自己的 session 取，连需要登录才看得见的图也能拿到。
 */
export function grabBrowserImage(url: string): boolean {
  const api = browserApi();
  if (!api?.browserGrabImage) return false;
  void api.browserGrabImage({ url }).catch(() => undefined);
  return true;
}

/** 列出当前页面里能当参考图的图片。 */
export async function readBrowserPageImages(): Promise<BrowserPageImage[]> {
  const api = browserApi();
  if (!api?.browserPageImages) return [];
  try {
    const list = await api.browserPageImages();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 图到了。返回取消订阅的函数。 */
export function onBrowserImage(listener: (image: BrowserImage) => void): () => void {
  const api = browserApi();
  if (!api?.onBrowserImage) return () => undefined;
  return api.onBrowserImage(listener);
}

/** 取图失败的原因。**一定要显示出来**：点了图没动静是最难自查的一类问题。 */
export function onBrowserImageError(listener: (message: string) => void): () => void {
  const api = browserApi();
  if (!api?.onBrowserImageError) return () => undefined;
  return api.onBrowserImageError(listener);
}

/**
 * 网页上的图被拖到画布上松手了。
 *
 * ⚠️ 这个事件**只带地址和落点，不带字节**：取字节仍然要走 `grabBrowserImage()`，
 * 图稍后从 `onBrowserImage` 回来。所以调用方要自己把落点记住一小会儿
 * （见 `CanvasEditor` 里的 `browserDropAt`）—— 否则图到了就不知道该放哪儿了。
 */
export function onBrowserImageDrop(listener: (drop: BrowserImageDrop) => void): () => void {
  const api = browserApi();
  if (!api?.onBrowserImageDrop) return () => undefined;
  return api.onBrowserImageDrop(listener);
}

/**
 * 是不是一个「本机 / 内网」的地址。
 *
 * ⚠️ 判的是 **host 那一段**，不是整串：先把端口和路径切掉再匹配。
 * 写成 `/^(localhost|127\.).../` 这种**从头匹配整串**的形式是错的 ——
 * `127\.` 只吃掉 `127.`，剩下的 `.0.1` 会让后面的「端口 / 路径」那一组匹配不上，
 * 于是 `127.0.0.1:8188` 被判成外网地址、补成 https，而 ComfyUI 默认没有 TLS，
 * 用户看到的就是一句看不出原因的「连不上」（2026-09-20 的 e2e 抓到的）。
 *
 * 内网段一并算进来（`10.` / `192.168.` / `172.16-31.`）：局域网里那台跑 ComfyUI 的
 * 机器同样几乎不会开 TLS，道理和 127.0.0.1 一样。
 */
export function isLocalAddress(input: string): boolean {
  const host = String(input || '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')
    .toLowerCase();
  return /^(localhost|\[::1\]|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

export function normalizeTypedAddress(input: string): string {
  const text = String(input || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  /*
   * 本机 / 内网地址补 **http**，不是 https。
   *
   * `127.0.0.1:8188` 这种写法在这个应用里最可能指的是**用户自己的 ComfyUI**，
   * 而 ComfyUI 默认不开 TLS —— 补成 https 的结果一定是 `ERR_SSL_PROTOCOL_ERROR`，
   * 界面上只有一句「连不上」、看不出是协议补错了。外网地址才默认 https。
   */
  if (isLocalAddress(text)) return `http://${text}`;
  /* 看着像域名：`example.com`、`8.8.8.8:8080`。 */
  if (/^[a-z0-9.-]+(:\d+)?(\/|$)/i.test(text) && text.includes('.')) return `https://${text}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}
