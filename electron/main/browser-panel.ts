import path from 'node:path';
import { Menu, MenuItem, WebContentsView, clipboard, ipcMain, screen } from 'electron';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';

/**
 * 画布里的内置浏览器：找参考图时不用切出去，网页上的图片直接进画布。
 *
 * 它是同一个窗口里的**第二个 WebContentsView**，盖在画布右侧面板的占位区域上。
 * 网页是不可信内容，所以和画布彻底隔开：
 * - 独立的持久分区，拿不到本应用账号的 Cookie，也没有 `app://` 协议；
 * - 沙箱开启、不给 Node；权限请求一律拒绝，下载一律取消；
 * - 只允许 http/https 导航，且地址与矩形都在**这里**重新校验（渲染进程给什么都不能直接信）。
 *
 * 唯一的例外是 `electron/preload/browser.ts`：它**只**把「网页上拖起来的图片」报上来，
 * 用来补上 Electron 不支持跨 WebContentsView 拖放这个缺口。它不挂任何东西到 window 上，
 * 所以网页拿不到通向本应用的任何能力 —— 见那份文件里的说明。
 *
 * 与 AIFISHER 那套（`browserPanel.mjs`）只有一处结构差异：它的宿主是画布那个 WebContentsView，
 * 我们这里是窗口的 contentView —— 因为 Holy Light画布是单窗口，画布就是整个窗口内容区。
 * 于是矩形直接按**窗口内容区**解释，渲染层报的 `getBoundingClientRect()` 与其一致
 * （页面铺满窗口、自身不滚动，这两个前提由 `CanvasBrowserPanel` 保证）。
 */

export const BROWSER_PARTITION = 'persist:frame-browser';
/** 打开面板时的默认页。用图片搜索而不是空白页：这个面板存在的理由就是找参考图。 */
export const BROWSER_HOME = 'https://www.bing.com/images';

const MAX_URL_LENGTH = 4096;
/** 再小就没法当浏览器用了：地址栏和工具栏都得放得下。 */
const MIN_EDGE = 120;

/** 只有绝对的 http(s) 地址、且不带用户名密码的才可能进到视图里。 */
export function normalizeBrowserUrl(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > MAX_URL_LENGTH) throw new Error('BROWSER_URL_INVALID');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('BROWSER_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('BROWSER_URL_INVALID');
  }
  return url.href;
}

export type BrowserBounds = { x: number; y: number; width: number; height: number };

/**
 * 把渲染层报上来的占位矩形夹进窗口内容区。
 *
 * 夹而不是照抄，原因有两个：一是渲染层可能算出负数（面板被拖出左边界时），
 * 二是 `width` 可能大到把窗口撑破 —— 那时视图会盖住整个画布，用户看不出发生了什么。
 */
export function clampBrowserBounds(bounds: unknown, host: { width: number; height: number }): BrowserBounds {
  const raw = bounds as Partial<BrowserBounds> | null | undefined;
  const nums = [raw?.x, raw?.y, raw?.width, raw?.height].map(Number);
  if (!nums.every(n => Number.isFinite(n))) throw new Error('BROWSER_BOUNDS_INVALID');
  const [x, y, width, height] = nums.map(n => Math.round(n));
  const left = Math.min(Math.max(0, x), Math.max(0, host.width - MIN_EDGE));
  const top = Math.min(Math.max(0, y), Math.max(0, host.height - MIN_EDGE));
  return {
    x: left,
    y: top,
    width: Math.max(MIN_EDGE, Math.min(width, host.width - left)),
    height: Math.max(MIN_EDGE, Math.min(height, host.height - top)),
  };
}

export type BrowserState = {
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

/** 关掉之后的空状态。渲染层第一次挂载时用它对齐。 */
export const CLOSED_STATE: BrowserState = {
  open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false,
};

function hardenSession(contents: WebContents) {
  const session = contents.session;
  /* 摄像头、麦克风、定位、通知、读剪贴板 —— 一个「看参考图的浏览器」一样都不需要。 */
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  /* 图片是「取」进画布的，不是下载到磁盘的：这个视图永远不产生文件。 */
  session.on('will-download', (event) => event.preventDefault());
}

/** 单张图的上限。再大就是「用户以为自己在拖一张图，其实拖的是原图 RAW」。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 页面里列的图最多这么多：列全了会把几百个图标和埋点像素也铺出来。 */
const MAX_PAGE_IMAGES = 30;

/** 认得的图片类型 → 文件后缀。认不出的一律按 png 落，画布那边只看是不是 `image/`。 */
const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

export type BrowserImage = { name: string; mime: string; bytes: Uint8Array; url: string };

/**
 * 主进程取到的 Response 只用得到这三样。
 *
 * 之所以自己描一遍而不是直接写 `Response`：这份 tsconfig 不加载 DOM 库，
 * `session.fetch` 的返回值在主进程里没有现成的类型可写。
 */
type MinimalResponse = {
  ok: boolean;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
};

/**
 * 从图片地址里推出一个能落盘的文件名。
 *
 * 站点给的名字常常是 `A1B2C3D4` 这种，也可能带 `?` `:` 这类 Windows 文件名里
 * 不允许的字符；推不出来就退回「网页图片-N」，总之不能让一次取名失败把整张图丢掉。
 */
export function imageNameFromUrl(url: string, mime: string, index = 0): string {
  const ext = IMAGE_EXT[mime] || 'png';
  let base = '';
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    /* 地址长得不规范、或者百分号编码是坏的：退回默认名就行。 */
  }
  base = base
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\\/:*?"<>|]/g, '')
    /* 控制字符：`\p{Cc}` 在这里换成字面量区间，免得依赖运行时的 Unicode 属性支持。 */
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 60);
  return `${base || `网页图片-${index + 1}`}.${ext}`;
}

const IMAGE_ERROR_TEXT: Record<string, string> = {
  BROWSER_IMAGE_UNREACHABLE: '这张图取不下来（站点拒绝了这次请求）。',
  BROWSER_IMAGE_TOO_LARGE: '这张图超过 20MB，没有取。',
  BROWSER_IMAGE_NOT_IMAGE: '这个地址返回的不是图片。',
  BROWSER_IMAGE_EMPTY: '这张图是空的。',
  BROWSER_URL_INVALID: '这个地址不是网页图片。',
};

/**
 * 在主进程里把图片**下载成字节**。
 *
 * 不走渲染层 `fetch`：网页里的脚本受同源策略限制，绝大多数图站的图在页面里根本读不到。
 * 用视图自己的 `session.fetch` 则既能拿到登录态下的 Cookie，又完全不碰磁盘
 * —— 字节直接过 IPC 交给画布，这个视图依旧「不产生文件」。
 */
async function downloadImage(contents: WebContents, raw: unknown, index = 0): Promise<BrowserImage> {
  const url = normalizeBrowserUrl(raw);
  const fetcher = contents.session.fetch as unknown as
    (input: string, init?: unknown) => Promise<MinimalResponse>;
  let res: MinimalResponse;
  try {
    res = await fetcher(url, { headers: { accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' } });
  } catch {
    throw new Error('BROWSER_IMAGE_UNREACHABLE');
  }
  if (!res.ok) throw new Error('BROWSER_IMAGE_UNREACHABLE');
  /* 先信一下 `content-length`，省得把 2GB 的东西读进内存再判。 */
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error('BROWSER_IMAGE_TOO_LARGE');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Error('BROWSER_IMAGE_EMPTY');
  /* 声明的长度可以撒谎，真的读完了再判一次。 */
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('BROWSER_IMAGE_TOO_LARGE');
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('image/')) throw new Error('BROWSER_IMAGE_NOT_IMAGE');
  return { name: imageNameFromUrl(url, mime, index), mime, bytes: new Uint8Array(bytes), url };
}

/** `srcURL` 这类来自网页的字符串：能不能当网页地址用。 */
function isHttpUrl(value: unknown): boolean {
  try {
    normalizeBrowserUrl(value);
    return true;
  } catch {
    return false;
  }
}

/** 页面里所有能当参考图的 `<img>`。太小的（图标、埋点像素）不算。 */
const PAGE_IMAGES_SCRIPT = `(() => {
  const seen = new Set();
  const out = [];
  const add = (src, width, height) => {
    if (!src || out.length >= 60) return;
    let url;
    try { url = new URL(src, location.href).href; } catch { return; }
    if (!/^https?:/.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, width: width || 0, height: height || 0 });
  };
  for (const img of document.querySelectorAll('img')) add(img.currentSrc || img.src, img.naturalWidth, img.naturalHeight);
  return out.filter((entry) => entry.width >= 64 && entry.height >= 64).slice(0, ${MAX_PAGE_IMAGES});
})()`;

/**
 * 面板只属于「打开着的画布」：整页导航（切到别的应用页面、退出登录）时立刻收起。
 *
 * ⚠️ 只靠这里是收不干净的：Holy Light画布是 hash 路由，画布 → 首页属于**同文档跳转**
 * （`isSameDocument === true`），不会触发 `did-start-navigation`。
 * 所以真正的主力是渲染层组件卸载时主动 `browser:close`（见 `CanvasBrowserPanel`），
 * 这里只是兜住「整页刷新 / 加载另一个文档」这类少数路径。
 */
/** 网页拖图：源视图报「开始拖的是什么」，拖完再报「结束了」。只认本视图发来的。 */
const DRAG_START = 'browser:drag-start';
const DRAG_END = 'browser:drag-end';
/**
 * 落图：把「拖的是哪张图 + 松手在哪」交给画布。
 *
 * 与 `browser:image` 的区别：那个只带图（右键菜单 / 点缩略图那两条路没有落点概念），
 * 这个额外带一个**窗口内容区坐标**，画布据此把节点放在松手的位置而不是一个固定偏移。
 */
const IMAGE_DROP = 'browser:image-drop';

export function createBrowserPanel({ window }: { window: BrowserWindow }) {
  let view: WebContentsView | null = null;
  let attached = false;
  /** 正在拖的那张图的地址。`dragend` 之前为 null。 */
  let dragUrl: string | null = null;

  const hostSize = () => {
    const [width, height] = window.getContentSize();
    return { width, height };
  };

  const state = (): BrowserState => {
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed()) return { ...CLOSED_STATE };
    return {
      open: attached,
      url: contents.getURL() || '',
      title: contents.getTitle() || '',
      loading: contents.isLoading(),
      /* Electron 32 起 `canGoBack` 归并到 `navigationHistory`；老写法留着兜底。 */
      canGoBack: Boolean(contents.navigationHistory?.canGoBack?.() ?? false),
      canGoForward: Boolean(contents.navigationHistory?.canGoForward?.() ?? false),
    };
  };

  const publish = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send('browser:state', state());
  };

  const load = (url: unknown) => {
    const target = normalizeBrowserUrl(url);
    if (!view) return target;
    void view.webContents.loadURL(target).catch(() => {
      /* 失败由 did-fail-load 报给渲染层；这里再抛一次只会让 invoke 变成未捕获异常。 */
    });
    return target;
  };

  const ensure = (): WebContentsView => {
    if (view && !view.webContents.isDestroyed()) return view;
    view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        /*
         * 只这一件事需要 preload：**网页上的图片拖拽**。
         * Electron 不支持在两个 WebContentsView 之间做原生拖放，画布那一侧收不到 drop，
         * 所以由这份脚本在源头记下拖的是哪张图，主进程在 `dragend` 时按松手位置落图。
         * 它不往 window 上挂任何东西（网页拿不到 ipcRenderer），见该文件里的说明。
         */
        preload: path.join(__dirname, '..', 'preload', 'browser.js'),
      },
    });
    const contents = view.webContents;
    hardenSession(contents);

    /* 要求开新标签的链接改在本视图里打开；不是网页地址的（下载链接之类）直接丢掉。 */
    contents.setWindowOpenHandler(({ url }) => {
      try {
        load(url);
      } catch {
        /* 不是 http(s)：不跳。 */
      }
      return { action: 'deny' };
    });

    /* 导航闸门：重定向也要过一遍，不然一个 302 就能把视图带到 file:// 上。 */
    const guard = (event: { preventDefault: () => void }, url: string) => {
      try {
        normalizeBrowserUrl(url);
      } catch {
        event.preventDefault();
      }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', (event) => event.preventDefault());

    /*
     * 在图片上右键 → 「发送到画布」。
     *
     * 这才是这个面板真正的用处：找参考图不用切出去。**只有右键落在图片上**时才接管菜单，
     * 其它地方照旧交给 Electron 的默认菜单（刷新、检查元素……）—— 接管了又什么都不给，
     * 用户只会以为右键坏了。
     */
    contents.on('context-menu', (event, params) => {
      const src = String(params?.srcURL || '');
      if (!isHttpUrl(src)) return;
      event.preventDefault();
      const menu = new Menu();
      menu.append(new MenuItem({ label: '发送到画布', click: () => { void deliver(src); } }));
      menu.append(new MenuItem({ label: '复制图片地址', click: () => clipboard.writeText(src) }));
      menu.popup({ window });
    });

    /*
     * 逐个注册，不写成 `for (name of [...])`：`webContents.on` 是**重载**，
     * 事件名一旦是联合类型就匹配不上任何一条重载分支（`did-fail-load` 和
     * `zoom-changed` 的回调签名不一样）。逐个写虽然啰嗦，但每条都各自对得上。
     *
     * 这六个事件涵盖了「地址变了 / 标题变了 / 加载状态变了 / 加载失败了」四种变化，
     * 少了任何一个，地址栏或那个转圈的图标就会停在旧状态。
     */
    contents.on('did-start-loading', publish);
    contents.on('did-stop-loading', publish);
    contents.on('did-navigate', publish);
    contents.on('did-navigate-in-page', publish);
    contents.on('page-title-updated', publish);
    contents.on('did-fail-load', publish);
    return view;
  };

  const hide = () => {
    if (!view || !attached) return;
    attached = false;
    try {
      window.contentView.removeChildView(view);
    } catch {
      /* 视图已经被销毁（窗口关闭）：remove 会抛，此时没什么可收的。 */
    }
    /* 页面走了就把键盘还给画布，否则画布收不到快捷键。 */
    if (!window.webContents.isDestroyed()) window.webContents.focus();
    publish();
  };

  const show = (bounds: unknown) => {
    const target = ensure();
    target.setBounds(clampBrowserBounds(bounds, hostSize()));
    if (!attached) {
      window.contentView.addChildView(target);
      attached = true;
    }
    /* 焦点跟着走：不 focus 的话地址栏打不出字（键盘还在画布上）。 */
    target.webContents.focus();
  };

  /**
   * 取一张图交给画布。
   *
   * ⚠️ 失败**不发异常，而是发一条 `browser:image-error`**：右键菜单那条路没有调用方等返回值，
   * 抛了就只是主进程里的一句未捕获错误，用户看到的是「点了没反应」。
   * 成功同理走事件 —— 画布那边统一在 `browser:image` 上收。
   */
  const deliver = async (raw: unknown) => {
    if (!view || view.webContents.isDestroyed()) return;
    try {
      const image = await downloadImage(view.webContents, raw);
      if (!window.webContents.isDestroyed()) window.webContents.send('browser:image', image);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!window.webContents.isDestroyed()) {
        window.webContents.send('browser:image-error', IMAGE_ERROR_TEXT[code] || '这张图没取下来。');
      }
    }
  };

  /**
   * 松手的那一刻，把光标位置换算成**窗口内容区坐标**。
   *
   * 渲染层报的 `bounds` 也是这套坐标（`getBoundingClientRect()`，页面铺满窗口且自身不滚动），
   * 所以两边能直接比 —— 用 `getContentBounds()` 而不是 `getPosition()`：后者给的是
   * **外框**左上角，减去它会差一个标题栏 + 边框的高度（Windows 上约 32px），
   * 图就会落在比松手位置低一截的地方。
   */
  const dropPoint = (): { x: number; y: number } | null => {
    try {
      const cursor = screen.getCursorScreenPoint();
      const content = window.getContentBounds();
      return { x: cursor.x - content.x, y: cursor.y - content.y };
    } catch {
      return null;
    }
  };

  /** 落点还在网页视图里 = 用户拖了一圈又放回面板上，那是**取消**，不是提交。 */
  const insideView = (point: { x: number; y: number }): boolean => {
    if (!view || !attached) return false;
    try {
      const box = view.getBounds();
      return point.x >= box.x && point.x <= box.x + box.width
        && point.y >= box.y && point.y <= box.y + box.height;
    } catch {
      return false;
    }
  };

  /**
   * 注册一条**只认浏览器视图自己**的单向通道。
   *
   * ⚠️ 这里不能照抄下面那批 `ipcMain.handle` 的 `assertOwnSender`：那条校验看的是
   * sender 的 **URL**，而这个视图里跑的是**任意网页**（URL 是网站的，不是我们的）。
   * 能用的判据只有「sender 是不是这个 WebContents」—— 配合网页拿不到 ipcRenderer
   * （preload 没挂 contextBridge），这就是完整的两道锁。
   */
  const onFromView = (channel: string, run: (payload: unknown) => void): (() => void) => {
    const listener = (event: IpcMainEvent, payload: unknown) => {
      if (!view || view.webContents.isDestroyed()) return;
      if (event.sender !== view.webContents) return;
      run(payload);
    };
    ipcMain.on(channel, listener);
    return () => { ipcMain.removeListener(channel, listener); };
  };

  /*
   * 拖图的三段：
   * 1. `dragstart` —— 记下地址（preload 已经滤掉了「拖的不是图」的那些）。
   * 2. `dragend`   —— 松手了。此刻读一次光标位置：原生拖拽期间页面收不到 mousemove，
   *                   而 `screen.getCursorScreenPoint()` 是直接问操作系统要，不受影响。
   * 3. 落点在面板内 → 当作取消；否则把「图 + 落点」推给画布。
   *
   * ⚠️ `dragend` 在拖到别的视图上时**依然会触发**（那是源视图唯一能拿到的结束信号），
   * 而 `mouseup` 不会 —— 所以整个方案只能挂在 `dragend` 上。
   */
  const offDragStart = onFromView(DRAG_START, (payload) => {
    /* 地址在这里再验一次：preload 那份跑在不可信页面里，它说什么都不能直接信。 */
    const url = String((payload as { url?: string } | undefined)?.url || '');
    dragUrl = isHttpUrl(url) ? url : null;
  });
  const offDragEnd = onFromView(DRAG_END, () => {
    const url = dragUrl;
    dragUrl = null;
    if (!url || !attached) return;
    const point = dropPoint();
    if (!point || insideView(point)) return;
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(IMAGE_DROP, { url, x: point.x, y: point.y });
  });

  const handlers: Record<string, (payload: unknown) => unknown> = {
    'browser:open': (payload) => {
      const input = payload as { bounds?: unknown; url?: string } | undefined;
      show(input?.bounds);
      const current = view?.webContents?.getURL?.() || '';
      /* 重新打开面板要停在用户上次看的那一页，不要每次都回首页。 */
      if (input?.url || !current) load(input?.url || BROWSER_HOME);
      publish();
      return state();
    },
    'browser:close': () => {
      hide();
      return state();
    },
    'browser:navigate': (payload) => {
      if (!attached) throw new Error('BROWSER_CLOSED');
      load((payload as { url?: string } | undefined)?.url);
      return state();
    },
    'browser:set-bounds': (payload) => {
      if (!attached || !view) return;
      view.setBounds(clampBrowserBounds((payload as { bounds?: unknown } | undefined)?.bounds, hostSize()));
    },
    'browser:command': (payload) => {
      if (!attached || !view) throw new Error('BROWSER_CLOSED');
      const command = String((payload as { command?: string } | undefined)?.command || '');
      const contents = view.webContents;
      const history = contents.navigationHistory;
      if (command === 'back') history.goBack();
      else if (command === 'forward') history.goForward();
      else if (command === 'reload') contents.reload();
      else if (command === 'stop') contents.stop();
      else throw new Error('BROWSER_COMMAND_INVALID');
      return state();
    },
    'browser:state': () => state(),
    /* 面板里的「本页图片」和右键菜单共用同一个 `deliver`，所以它们落地的图走的是同一条路。 */
    'browser:grab-image': (payload) => {
      if (!attached || !view) throw new Error('BROWSER_CLOSED');
      void deliver((payload as { url?: string } | undefined)?.url);
      return true;
    },
    'browser:page-images': () => {
      if (!attached || !view) throw new Error('BROWSER_CLOSED');
      /* 只读不写：这段脚本在沙箱里跑，拿不到 Node，也改不了页面状态。 */
      return view.webContents.executeJavaScript(PAGE_IMAGES_SCRIPT, true) as Promise<unknown[]>;
    },
  };

  /*
   * 每个通道都只认「本应用的页面」发来的调用。
   *
   * 这层校验看着多余（窗口里就一个页面），但它防的是**未来**：一旦哪天浏览器视图
   * 里的某个脚本拿到了 ipcRenderer（比如有人为了图省事给它加了 preload），
   * 没有这道闸门就意味着网页能自己开面板、自己跳任意地址。
   */
  const assertOwnSender = (event: IpcMainInvokeEvent) => {
    const url = event.senderFrame?.url || event.sender.getURL?.() || '';
    const own = url.startsWith('app://')
      || (process.env.ELECTRON_RENDERER_URL ? url.startsWith(process.env.ELECTRON_RENDERER_URL) : false);
    if (!own) throw new Error('BROWSER_SENDER_DENIED');
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, payload) => {
      assertOwnSender(event);
      return handler(payload);
    });
  }

  window.webContents.on('did-start-navigation', (details) => {
    if (details?.isMainFrame && !details.isSameDocument) hide();
  });

  window.on('resize', () => {
    /* 矩形是渲染层报的，窗口一变它就会重报；这里只在还开着时补一次，
       免得用户拖窗口的过程中视图停在旧位置。 */
    if (attached) publish();
  });

  window.once('closed', () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    /* 这两条是 `on` 注册的（不是 handle），漏掉的话窗口关了监听器还挂着，
       而它们内部会去读已经销毁的 view。 */
    offDragStart();
    offDragEnd();
    view?.webContents.close?.();
    view = null;
    attached = false;
    dragUrl = null;
  });

  return { hide, state, isOpen: () => attached };
}
