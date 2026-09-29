/* ⚠️ 这一行必须在所有别的 import 之前：好几个 `lib/*` 模块一被求值就把自己的根目录钉死了
   （数据库连接就是这种），比 `app.whenReady()` 还早 ——
   详见 `electron/main/paths.ts` 里的说明。
   （`lib/media.ts` 与 `lib/latents.ts` 已经改成运行时取根目录、好让用户换产出目录，
    但它们仍要读 `HOLYLIGHT_LOCAL_STORAGE` 兜底，这条 import 顺序一条都不能少。） */
import './paths';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, protocol, shell, Tray } from 'electron';
import { APP_ORIGIN, forwardToBackend, reconnectingResponse } from './api';
import { createBackendSupervisor } from './backend-supervisor';

/** 后端首次启动时，一个请求最多等它多久 ready（见下面协议处理里那段注释）。 */
const BACKEND_START_WAIT_MS = 8_000;
import { createBrowserPanel } from './browser-panel';
import { createComfyuiSupervisor, parseBaseUrl } from './comfyui-supervisor';
import { detectComfyuiProcesses, findComfyuiInstalls } from './comfyui-detect';
import { inspectExtensions, inspectLegacyExtensions, installExtension, removeLegacyExtension } from './comfyui-extensions';
import { createCodexService } from './codex-service';
import { readWallpaper, removeWallpaper, saveWallpaper } from './wallpaper';
import {
  checkForUpdate, downloadUpdate, initUpdater, installDownloadedOnQuit, installUpdate,
  setUpdaterSource, updaterState,
} from './updater';
import { runtimePathEnv, runtimePaths } from '@/lib/runtime-paths';
import { WALLPAPER_LIMITS } from '@/lib/appearance';

/**
 * 主进程。
 *
 * 这一层只负责：窗口、自定义协议、以及**后端进程的生死**。
 *
 * `/api/*` 不再在进程内分发给那 48 个路由 —— 路由跑在独立的后端进程里，
 * 主进程通过一条 Windows 命名管道把请求转过去（见 `electron/backend/index.ts`）。
 * 于是没有监听端口，后端崩溃也只是它自己重启（页面看到 503「正在重新连接」），
 * 不会再把整个窗口带白。
 */

const SCHEME = 'app';
/** 自定义协议也要有 host，否则相对路径 `/api/x` 会解析成 `app:///api/x`，各浏览器行为不一致。 */
const HOST = 'app';

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** 渲染进程产物目录（打包后是 `resources/app.asar/out/renderer`，asar 里用 fs 读得到）。 */
function rendererRoot(): string {
  return path.join(__dirname, '..', 'renderer');
}

/** 这个 URL 是不是本应用自己的页面（打包后是 `app://app/...`，开发态是 Vite 的 dev server）。 */
function isOwnUrl(url: string): boolean {
  if (url.startsWith(`${SCHEME}://${HOST}`)) return true;
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (!dev) return false;
  try {
    return new URL(url).origin === new URL(dev).origin;
  } catch {
    return false;
  }
}

/**
 * 把「本应用内的一个地址」翻译成**单窗口的 hash 路由地址**。
 *
 * 单页应用的路由在 hash 里（`app://app/index.html#/settings/...`，见 `src/shims/router.ts`），
 * 但页面里写出来的链接是**路径形式**的（`/settings/providers/workflows?id=123`）。
 * 这两者之间的翻译只该有一处，就是这里 —— 渲染进程那边已经有一份（`navigate()`），
 * 主进程要拦住「开新窗 / 整页导航」就必须再来一份，两边对不上就会出现
 * 「同一个链接点法不同、落到的页面不同」这种最难查的 bug。
 *
 * 不是自己人（外站、`about:blank`、其它协议）返回空串，由调用方决定怎么处理。
 */
function sameOriginNavigation(url: string): string {
  const dev = process.env.ELECTRON_RENDERER_URL;
  /* 开发态：渲染进程是从 Vite 的 dev server 加载的，`index.html` 由 Vite 出，hash 直接挂在 origin 上。 */
  if (dev) {
    try {
      const base = new URL(dev);
      const target = new URL(url);
      if (target.origin !== base.origin) return '';
      return `${base.origin}/${base.search}${target.search}${target.hash || `#${target.pathname}`}`;
    } catch {
      return '';
    }
  }
  /*
   * 打包后：`app://` 协议处理器只认 `rendererRoot()` 里的真实文件，所以路径必须**收进 hash**，
   * 让 `index.html` 成为唯一被请求的文档；查询串也要一起带进去 ——
   * 配置页靠 `?id=` 决定打开哪一份工作流，丢了它就只是「页面能打开但没定位」。
   */
  const rest = url.slice(`${SCHEME}://${HOST}`.length) || '/';
  if (!rest.startsWith('/')) return '';
  if (rest.startsWith('/index.html')) {
    return `${SCHEME}://${HOST}/index.html${rest.slice('/index.html'.length)}`.replace(/^([^#]*)\/(#|$)/, '$1$2');
  }
  return `${SCHEME}://${HOST}/index.html#${rest}`;
}

/**
 * 静态文件。刻意只认 `rendererRoot()` 里的东西：
 * `..` 会被 `path.resolve` 吃掉，解析后不在根目录里的一律 404 —— 自定义协议也是外部输入的入口。
 */
async function serveStatic(url: URL): Promise<Response> {
  const root = rendererRoot();
  const name = decodeURIComponent(url.pathname || '/');
  const target = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return new Response('not found', { status: 404 });
  }
  try {
    const data = await fs.promises.readFile(target);
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    return new Response(data, { status: 200, headers: { 'content-type': type } });
  } catch {
    /*
     * 单页应用的路由（`/projects/xxx`）在刷新时会打到这里，而磁盘上没有这个文件 ——
     * 这时必须回 index.html，否则刷新就是白屏。这是 SPA 模式下最容易漏的一条。
     */
    try {
      const fallback = await fs.promises.readFile(path.join(root, 'index.html'));
      return new Response(fallback, { status: 200, headers: { 'content-type': MIME['.html'] } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }
}

/**
 * 最小 `.env` 读取。
 *
 * 只补**进程里还没有**的变量：用户在系统里设了同名环境变量时不该被文件覆盖，
 * 否则「我明明在系统里换了 key，怎么还是旧的」会变成一个查不出来的问题。
 *
 * 顺序是「数据目录优先」：`data/config/.env` 是用户可以改的那一份，
 * 打包资源里的 `.env` 是随程序带的默认值。
 */
function loadEnv(): void {
  const paths = runtimePaths();
  const candidates = app.isPackaged
    ? [paths.envPath, path.join(process.resourcesPath, '.env')]
    : [paths.envPath, path.join(app.getAppPath(), '.env'), path.join(process.cwd(), '.env')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    return;
  }
}

/* ---------- 窗口标题栏形态（2026-09-23）----------
 * 系统那条标题栏整条不要（`titleBarStyle: 'hidden'`），右上角的最小化 / 最大化 / 关闭
 * 改成**浮在页头右上角**（`titleBarOverlay`）。
 *
 * 两个刻意的取值：
 *   - `color: '#00000000'`（全透明）。页头底下可能是主题底色、也可能是用户自己选的背景图，
 *     填任何实色都有一半场合不对；透明时那三个符号直接压在页面上。
 *     代价是**符号颜色得跟着主题报过来**（见下面 `titlebar-theme` 那条通道）——
 *     浅色页头上配浅色符号，等于没有按钮。
 *   - `height: 48` 正好等于画布页那条 `.cv-topbar`。再高就会伸到顶栏**下面**，
 *     在画布右上角盖出一块点不动的死区；主界面页头是 72px，按钮因此偏上一点 ——
 *     这是两边都不得罪的位置，别为了对齐主界面把高度调上去。
 */
const TITLEBAR_HEIGHT = 48;
/* 符号色跟 --text 同源（#16191c / #e8eaed），但只能写死：主进程读不到 CSS 变量。 */
const TITLEBAR_SYMBOL = { light: '#16191c', dark: '#e8eaed' } as const;

/* 关闭窗口拦截标记（2026-09-28）：点右上角 X 不直接退出，主进程拦下、
 * 让渲染层弹确认框让用户选「最小化 / 退出应用」。选退出时走 app.quit() 触发 before-quit
 * （后端优雅 flush 再 app.exit），那一刻要把拦截放行，否则 app.quit() 再触发 close
 * 又被 preventDefault 卡死，永远退不掉。 */
let allowClose = false;

/* 系统托盘（2026-09-28）：「关闭确认框 → 最小化」收进托盘，任务栏不占位。
 * 图标随包走（extraResources 的 icon.ico），开发环境回落仓库根的 build/icon.ico；
 * 图标读不到就保持旧行为（普通最小化到任务栏），按钮永远有响应。 */
let tray: Tray | null = null;

function trayIconPath(): string | null {
  const candidates = [
    path.join(process.resourcesPath, 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* 忽略，试下一个 */ }
  }
  return null;
}

/* 第一次「最小化到托盘」时才建托盘 —— 不用这个功能的用户桌面上不多一个图标。 */
function ensureTray(win: BrowserWindow): boolean {
  if (tray) return true;
  const iconPath = trayIconPath();
  if (!iconPath) return false;
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return false;
  tray = new Tray(icon);
  tray.setToolTip('Holy Light画布');
  const show = () => {
    if (win.isMinimized()) win.restore();
    win.show();
  };
  tray.on('click', show);
  tray.on('double-click', show);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Holy Light画布', click: show },
    { type: 'separator' },
    { label: '退出应用', click: () => { allowClose = true; app.quit(); } },
  ]));
  return true;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0b0f',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: TITLEBAR_SYMBOL.light,
      height: TITLEBAR_HEIGHT,
    },
    webPreferences: {
      /* 预加载脚本仍然要带：渲染进程里有一部分能力（打开外部链接、选文件保存位置）
         只有主进程有，没有这层就只能靠 nodeIntegration —— 那条路更危险。 */
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  /* 点右上角关闭：先拦下默认退出，让渲染层弹确认框（2026-09-28）。
   * 真正的退出由用户在框里选了「退出应用」后走 app.quit()（见 'window-close-action'），
   * 那个分支会把 allowClose 置真，于是这里的拦截放行、窗口正常关闭。 */
  win.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    win.webContents.send('request-close');
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[main] 页面加载失败', code, desc);
  });

  /*
   * 开新窗口这件事**必须自己接住**，不能留给默认行为。
   *
   * 默认行为是把 URL 原样丢给一个新 BrowserWindow，而渲染进程是从 `app://` 加载的：
   * 页面里的 `target="_blank"` + `href="/settings/xxx"` 会被解析成
   * `app://app/settings/xxx`（**查询串丢掉、hash 为空**）。协议处理器那边找不到这个「文件」，
   * 于是回兜底的 index.html —— 一个没有 `#/...` 的 SPA 外壳。
   * 界面看到的是标题栏写着「Holy Light画布 — AI 创作空间」的**纯白窗口**，一句错误日志都没有
   * （2026-09-19 用户就是这么撞上的：「打开工作流配置后怎么是空的？」）。
   *
   * 三种 URL 三套路子：
   *   - `http(s)://` 外部站点 → 交给系统浏览器。应用窗口是单窗口的，开出来也没法导航。
   *   - 本应用自己的地址（`app://` / 开发态的 localhost） → **留在应用内**，由下面的
   *     `will-navigate` 接管成 hash 路由。这是「打开工作流配置」本该走的那条路。
   *   - 其余（`about:blank`、`blob:`、`file:` 之类） → 一律拒绝。
   */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    if (isOwnUrl(url)) return { action: 'allow' };
    return { action: 'deny' };
  });

  /*
   * 兜住所有「整页导航」：外部站点交给系统浏览器，自己的页面塞回单窗口的 hash 路由。
   *
   * ⚠️ 只认 `location.hash = ...` 这种同文档跳转的话会漏掉一个真实的入口 ——
   * **从其他程序拖一个链接进来**（Windows 上的拖放会触发 `will-navigate`）。
   * 那时判断的是完整 URL，`sameOriginNavigation()` 会把 `?id=` 原样带进 hash，
   * 不会出现「配置页打开了、但没定位到那份工作流」。
   */
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return;
    /*
     * ⚠️ 早期桌面版曾为 `<form action="/api/auth/...">` 放行过 `/api/*` 的整页导航，
     * 现在**不再需要**：登录 / 退出改成调接口拿令牌（桌面版没有 cookie，见
     * `lib/auth/session.ts` 的 SESSION_HEADER），页面上不存在往 `/api/` 的整页提交。
     * 留着那条放行反而有害 —— 后端重定向回的是 `http://localhost:3000/`（哨兵 origin），
     * 那不是自己的 `app://` 地址，会被当成外部站点丢给系统浏览器。
     */
    event.preventDefault();
    const target = sameOriginNavigation(url);
    if (target) void win.loadURL(target);
    else if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    else console.warn('[main] 拦下了一次无法处理的跳转', url);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadURL(`${SCHEME}://${HOST}/index.html`);
  }

  /*
   * 画布里的内置浏览器（找参考图不用切出去）。
   *
   * 它的生命周期**绑死在这个窗口上**：窗口关了，视图、IPC 通道一起收掉
   * （见 `browser-panel.ts` 末尾的 `once('closed')`）。之所以在 createWindow 里建而不是
   * 在外面建一次，是因为 macOS 上关掉所有窗口后 `activate` 会再建一个 ——
   * 那种情况下旧的 WebContentsView 已经不存在了，得跟着新窗口再来一份。
   */
  createBrowserPanel({ window: win });
  return win;
}

void app.whenReady().then(() => {
  const paths = runtimePaths();
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.storageDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  loadEnv();
  /*
   * `checkOrigin()` 认这个 origin（见 `api.ts` 里的说明）。放在 `loadEnv()` 之后、
   * 注册协议之前 —— 早了会被 .env 里可能存在的 APP_URL 覆盖掉，两个值不一致就是全线 403。
   */
  process.env.APP_URL = APP_ORIGIN;

  /*
   * 软件内更新（2026-09-29）。
   *
   * ⚠️ 放在这里而不是 `createWindow()` 里：更新这件事与窗口无关，
   *    窗口关掉再开（或者压根还没开）时它也该有自己的状态。
   *    状态变化推给**当时存在的所有窗口** —— 于是「启动后自动检查」那一次
   *    即使发生在页面挂载之前，页面挂载时也能用 `updater-state` 查到（不用靠推送）。
   *
   * 启动 8 秒后才问一次：开机那一会儿磁盘和网络都在忙（后端、ComfyUI 检测都在这时跑），
   * 别让「问一句有没有新版」抢在最前面。而它只是几十字节的 latest.yml，不影响启动速度。
   */
  initUpdater({
    dataDir: paths.dataDir,
    onState: (state) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('updater-state', state);
    },
  });
  /* 主进程里没有 `window` —— 这里就是 Node 的 `setTimeout`。 */
  setTimeout(() => { void checkForUpdate(); }, 8000);

  const backend = createBackendSupervisor({
    /*
     * 后端入口与本进程产物在同一个目录里（`out/main/`）。
     * utilityProcess 能读 asar 里的模块，所以打包后不用额外解包。
     */
    entry: path.join(__dirname, 'backend.js'),
    /*
     * ⚠️ cwd 必须是**真实目录**，不能是 `app.asar` 里的路径：asar 是一个打包文件，
     * 把子进程的工作目录指进去会让它起不来（退出码非 0，且一句 stderr 都没有）。
     * 打包后程序目录是 `resources/app.asar`，所以工作目录用它的上一级 `resources/..`。
     */
    cwd: app.isPackaged ? path.dirname(process.resourcesPath) : paths.appDir,
    environment: {
      ...process.env,
      ...runtimePathEnv(),
      APP_URL: APP_ORIGIN,
      HOLYLIGHT_RESOURCES_DIR: process.resourcesPath || '',
      NEXT_PUBLIC_HOLYLIGHT_EDITION: 'desktop',
    },
    logsDir: paths.logsDir,
    devPort: app.isPackaged ? undefined : 5174,
  });

  /* 退出时要能拿到它去发 stop（见文件末尾的 before-quit）。 */
  (globalThis as unknown as { __frameBackend?: { stop: () => Promise<void> } }).__frameBackend = backend;

  /*
   * 本机 ComfyUI 的启动器。**它不跟着应用自动起** —— 只有用户在「ComfyUI 服务」
   * 那一页点「启动 ComfyUI」才会起（用户 2026-09-20 明确要的：一键启动，但不用自动）。
   */
  const comfyui = createComfyuiSupervisor({ logsDir: paths.logsDir });
  (globalThis as unknown as { __frameComfyui?: ReturnType<typeof createComfyuiSupervisor> }).__frameComfyui = comfyui;

  /*
   * 画布里的 Codex。**也不跟着应用自动起** —— 它要 spawn 一个 codex 进程，
   * 用户没打开那个侧栏就不该白白占着（而且没登录的话起来也用不了）。
   * 同样是长命子进程，所以握在主进程：页面刷新不会把它丢掉。
   */
  const codex = createCodexService();
  (globalThis as unknown as { __frameCodex?: ReturnType<typeof createCodexService> }).__frameCodex = codex;
  /* 流式事件推给所有窗口。渲染层只认 IPC，不直接碰 stdio。 */
  codex.attach();

  /*
   * 后端状态推给窗口：页面拿到 `reconnecting` / `failed` 时能显示
   * 「本机服务正在重新连接」，而不是让用户对着一个转圈的按钮发呆。
   */
  backend.onState((state) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('backend-state', state);
    }
  });

  /* ComfyUI 的状态变化同样推给窗口：它启动要 1～3 分钟，界面得能一直显示「正在启动…」。 */
  comfyui.onState((status) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('comfyui-state', status);
    }
  });

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    /*
     * 画布背景图走 `app://app/wallpaper`。
     * 不放行 `/wallpaper` 这个路径给静态文件，是因为图在**数据目录**里、不在产物目录里 ——
     * 让渲染进程拿绝对路径再自己去读是没有通道的（也没有必要），
     * 由主进程读出来喂回去，路径就永远不会出现在 DOM 里。
     */
    if (url.pathname === '/wallpaper') {
      /* `?slot=site` 是整站背景那张，默认是画布那张（老版本只有一张，不能改它的路径）。 */
      const slot = url.searchParams.get('slot') === 'site' ? 'site' : 'canvas';
      const found = readWallpaper(slot);
      if (!found) return new Response('no wallpaper', { status: 404 });
      return new Response(new Uint8Array(found.data), {
        status: 200,
        headers: {
          'content-type': found.mime,
          /* 文件名带在查询串里（`?v=wallpaper.png`），换图就换 URL，所以可以长缓存 */
          'cache-control': 'no-cache',
        },
      });
    }
    /*
     * 读一个**本机文件**的字节（目前只有「用户刚选的背景图」在用）。
     *
     * 渲染进程拿不到本机文件的字节：`app://` 协议下没有 `fetch(file://)` 这条路，
     * 而打开 `webSecurity` / `allowFileAccess` 等于把整个渲染进程的隔离放松掉，
     * 为了读一张图不值得。所以由主进程读、把字节喂回去。
     *
     * 这也意味着这是一条**能读任意路径**的通道，必须自己把门看住：
     * 只放行图片扩展名，且必须是绝对路径。它仍然只能被本应用自己的页面调用
     * （`app://` 协议只对本窗口开放，没有外部入口）。
     */
    if (url.pathname === '/local-file') {
      const target = url.searchParams.get('path') || '';
      if (!path.isAbsolute(target)) return new Response('需要绝对路径', { status: 400 });
      const ext = path.extname(target).toLowerCase();
      const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
      if (!IMAGE_EXT.includes(ext)) return new Response('只允许读取图片文件', { status: 400 });
      try {
        const data = await fs.promises.readFile(target);
        const type =
          ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        return new Response(new Uint8Array(data), { status: 200, headers: { 'content-type': type } });
      } catch {
        return new Response('读不到这个文件', { status: 404 });
      }
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(url);
    /*
     * 后端还在**首次启动**时，这一趟请求**等它 ready** 而不是立刻回 503（2026-09-29）。
     *
     * 窗口是先开的（下面那句注释说了为什么），于是页面第一批请求经常撞在「后端还没 ready」
     * 那一两秒上。以前那一下就是终局：`useApi` 的 `data` 永远是 `null`，界面把「没读到」
     * 当成「没有」，表现就是「自定义接口有时候会消失」—— 而用户一无所知，只会以为没配。
     *
     * ⚠️ 只等 `starting`（**首次启动**），不等 `reconnecting`：重启是已知异常，
     *    那时光等没用（退避最长 8s + 启动），界面上另有「正在重新连接」那条全局提示，
     *    前端那边由 `useApi` 的重试兜住。这里要是也等，一个坏掉的后端会让每个请求都挂 8 秒。
     */
    let pipe = backend.pipePath();
    if (!pipe && backend.state() === 'starting') {
      await backend.awaitReady(BACKEND_START_WAIT_MS);
      pipe = backend.pipePath();
    }
    return pipe ? forwardToBackend(request, pipe) : reconnectingResponse();
  });

  /*
   * 后端没起来也要先把窗口开出来：窗口里会显示「正在连接」，
   * 而后端一旦 ready 就自动能用了。反过来（等后端起好再开窗）会让启动看起来像卡死。
   */
  void backend.start().catch((error) => {
    console.error('[main] 后端启动失败', error);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/*
 * 打包后没有控制台，主进程里任何一个没接住的异常都会**静默**消失 ——
 * 表现就是「按钮点了没反应」，而且一句日志都没有，只能靠猜。
 * 这两个兜底把现场写进数据目录的 main-error.log：用户把那一行发过来就有线索了。
 */
function logFatal(kind: string, error: unknown): void {
  const text = `[${new Date().toISOString()}] ${kind}\n${
    error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  }\n\n`;
  try {
    fs.appendFileSync(path.join(runtimePaths().logsDir, 'main-error.log'), text, 'utf8');
  } catch {
    /* 连日志都写不进去就只能放弃了，别再抛一个异常出来 */
  }
  process.stderr.write(text);
}

process.on('uncaughtException', (error) => logFatal('uncaughtException', error));
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* 关闭确认框的响应（2026-09-28）：渲染层弹框后把用户的选择回传主进程。
 * - 'minimize'：窗口收起，进程继续（后端不重启、数据不动）。
 * - 'quit'：走 app.quit() -> before-quit（后端优雅 flush 再退出）；绝不能 win.destroy()，
 *   那会跳过 before-quit，后端可能没落盘。allowClose 置真放行随后的 close 拦截。 */
ipcMain.handle('window-close-action', (_event, action: string) => {
  const win = BrowserWindow.fromWebContents(_event.sender);
  if (!win) return;
  if (action === 'minimize') {
    /* 收进系统托盘（2026-09-28）：hide() 让窗口从任务栏消失，点托盘图标还原。
     * 托盘建不起来（图标读不到）就退回普通最小化，按钮不空转。 */
    if (ensureTray(win)) {
      win.hide();
    } else {
      win.minimize();
    }
    return;
  }
  allowClose = true;
  app.quit();
});

/*
 * 退出前先让后端优雅退：它会 flush 数据，然后才轮到进程退出。
 * 以前这些活在主进程里做（`flushData()` 等），现在归后端 —— 主进程不再碰数据与子进程。
 */
app.on('before-quit', (event) => {
  /* 托盘图标随进程一起收掉，别在通知区留一个死图标。 */
  try { tray?.destroy(); tray = null; } catch { /* 已经没了 */ }

  /*
   * Codex 同样是本进程 spawn 的子进程，而且它还会再拉自己的子进程 —— 一并收掉，
   * 不然一退出就留下一串孤儿（它占的是管道和句柄，用户根本看不出来是谁留下的）。
   */
  const codex = (globalThis as unknown as { __frameCodex?: { dispose: () => void } }).__frameCodex;
  try { codex?.dispose(); } catch { /* 已经没了 */ }

  /*
   * 先收 ComfyUI 这个子进程。**必须同步收**：它是在本进程 spawn 的，
   * 我们一退它就成孤儿 —— 用户下次想不起来自己起过，再点一次启动会撞端口。
   * `dispose()` 内部就是一次 kill()，不阻塞。
   */
  const comfyui = (globalThis as unknown as { __frameComfyui?: { dispose: () => void } }).__frameComfyui;
  try { comfyui?.dispose(); } catch { /* 已经没了 */ }

  const backend = (globalThis as unknown as { __frameBackend?: { stop: () => Promise<void> } }).__frameBackend;
  /*
   * 更新在**最后**才装（2026-09-29）：这时后端已经 flush 完、子进程也收干净了，
   * 退出是最安全的时机 —— 早一点会打断正在跑的生成任务。
   * `installDownloadedOnQuit()` 装上之后进程就没了，所以只有它没装时才轮到 `app.exit(0)`。
   */
  if (!backend) {
    installDownloadedOnQuit();
    return;
  }
  event.preventDefault();
  void backend.stop().finally(() => {
    if (installDownloadedOnQuit()) return;
    app.exit(0);
  });
});

/*
 * 选文件。渲染进程没有 `dialog`，也没有 node —— 而「选一个 GGUF 模型」这件事
 * 让用户手打路径不现实（路径又长又容易错）。所以开一个只有这一个用途的通道：
 * 参数里带了允许的后缀白名单，用户选不到别的东西。
 */
ipcMain.handle('pick-file', async (_event, options: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = win
    ? await dialog.showOpenDialog(win, {
        title: options?.title || '选择文件',
        properties: ['openFile'],
        filters: options?.filters?.length ? options.filters : [{ name: '所有文件', extensions: ['*'] }],
      })
    : await dialog.showOpenDialog({
        title: options?.title || '选择文件',
        properties: ['openFile'],
        filters: options?.filters?.length ? options.filters : [{ name: '所有文件', extensions: ['*'] }],
      });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

/*
 * 选文件夹。用途只有「挑一个产出目录」：桌面版把生成结果存在用户自己选的盘上，
 * 而这个路径同样不可能让用户手打（而且打错了要等生成失败才发现）。
 *
 * `createDirectory` 是刻意的：用户多半想选一个「还没建的」新文件夹（比如 `E:\我的产出`），
 * 没有它就得先去资源管理器里建好再来选。
 */
ipcMain.handle('pick-folder', async (_event, options: { title?: string; defaultPath?: string }) => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const dialogOptions = {
    title: options?.title || '选择文件夹',
    defaultPath: options?.defaultPath || undefined,
    properties: ['openDirectory' as const, 'createDirectory' as const],
  };
  const result = win
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

/*
 * 在系统文件管理器里打开一个目录。
 *
 * `shell.openPath` 打不开时**不抛异常**，只回一句错误串——所以必须把返回值原样带回渲染进程，
 * 否则「点了没反应」会变成最难查的一类 bug（用户以为软件坏了，其实是目录被删了）。
 */
ipcMain.handle('open-folder', async (_event, dir: string) => {
  const target = String(dir || '').trim();
  if (!target) return { ok: false, message: '目录为空。' };
  const message = await shell.openPath(target);
  return message ? { ok: false, message } : { ok: true, message: '' };
});

/** 找 WorkBuddy 的几个落点：能用环境变量指定，正常走默认安装目录。 */
const WORKBUDDY_EXE_GUESSES = [
  process.env.WORKBUDDY_EXE || '',
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'WorkBuddy', 'WorkBuddy.exe'),
  path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
].filter(Boolean);

/*
 * 把这张画布交给 WorkBuddy（2026-09-30）。
 *
 * 做两件事：**提示词进剪贴板** + **唤起 WorkBuddy**。
 *
 * 为什么是「唤起」而不是把这个面板也做成支持 WorkBuddy：画布的能力全在
 * `tools/frame-mcp` 那 14 个工具里，Codex 只是被挂上去的一个 MCP 客户端 —— 换谁驱动都一样。
 * 而内嵌要逆 WorkBuddy 自带 headless CLI 的参数 / 输出格式 / 鉴权，它一升级就可能失效。
 *
 * 提示词里**必须带 projectId**：那 14 个工具全都要它，靠项目名猜等于让对面先做一次
 * `frame_list_projects`。剪贴板而不是命令行参数 —— `workbuddy://` 只注册了 `"%1"`，
 * 参数格式没有文档，剪贴板是稳的。
 */
ipcMain.handle('workbuddy-launch', async (_event, payload: { projectId?: string; projectName?: string; ask?: string } | undefined) => {
  const projectId = String(payload?.projectId || '').trim();
  const projectName = String(payload?.projectName || '').trim() || '(未命名画布)';
  const ask = String(payload?.ask || '').trim();
  const text = [
    '【Holy Light画布】请用画布 MCP（frame_* 工具）直接改这张画布，改完不用问我确认。',
    '项目：' + projectName,
    projectId ? 'projectId：' + projectId + '（调 frame_* 时传这个，别只按项目名找）' : '',
    '',
    '我的要求：',
    ask || '（在这里写你的要求）',
  ].filter(line => line !== '').join('\n');
  clipboard.writeText(text);

  /* 先 spawn exe：WorkBuddy 已经在跑时，它的单实例锁会把现有窗口激活 —— 这是最确定的一条。
     exe 找不到才退到协议（`workbuddy://` 已注册为 `WorkBuddy.exe "%1"`）。 */
  let opened = false;
  let why = '';
  for (const guess of WORKBUDDY_EXE_GUESSES) {
    try {
      if (!fs.existsSync(guess)) continue;
      const child = spawn(guess, [], { detached: true, stdio: 'ignore' });
      child.unref();
      opened = true;
      break;
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
    }
  }
  if (!opened) {
    try {
      await shell.openExternal('workbuddy://');
      opened = true;
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
    }
  }

  /* 提示词在剪贴板里，所以「没唤起成功」不算彻底失败 —— 如实说，别让用户白等。 */
  return opened
    ? { ok: true, message: '提示词已复制 · 切到 WorkBuddy 里 Ctrl+V 发送', copied: true }
    : { ok: false, message: `没能帮你打开 WorkBuddy（${why || '找不到它的安装位置'}）—— 提示词已复制，你自己打开粘贴即可。`, copied: true };
});

/*
 * 换主题时把窗口按钮的**符号颜色**换掉（渲染进程每次 applyAppearance 都发一条）。
 *
 * 只改符号色、底色恒为透明：页头底下是主题底色还是用户的背景图，主进程猜不出来。
 * `send` 而不是 `invoke`：调用方不等结果，也**不该**因为它失败而卡住换肤。
 *
 * 两处防御都不是多余的：
 *   - `process.platform !== 'win32'`：`setTitleBarOverlay` 只有 Windows 有；
 *   - try/catch：窗口没开 overlay（或被系统策略禁掉）时这个方法会抛，
 *     「标题栏颜色不对」绝不该把整个应用带崩。
 */
ipcMain.on('titlebar-theme', (event, dark: unknown) => {
  if (process.platform !== 'win32') return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  try {
    win.setTitleBarOverlay({
      color: '#00000000',
      symbolColor: dark === true ? TITLEBAR_SYMBOL.dark : TITLEBAR_SYMBOL.light,
      height: TITLEBAR_HEIGHT,
    });
  } catch {
    /* 见上：静默即可 */
  }
});

/*
 * 后端状态**查询**（配合上面的推送一起用）。
 *
 * 推的那一路只在状态**变化**时发，而窗口是「不等后端 ready 就先开」的 ——
 * 页面挂载得比后端 ready 还晚的话，一条推送都收不到，界面会一直显示「正在连接」。
 * 所以补一个「现在是什么状态」的查询，让页面挂载时先对齐一次，再订阅后续变化。
 */
ipcMain.handle('backend-state', () => {
  const backend = (globalThis as unknown as { __frameBackend?: { state: () => string } }).__frameBackend;
  return backend ? backend.state() : 'stopped';
});

/*
 * ---------- 本机 ComfyUI：查状态 / 启动 / 停止 ----------
 *
 * ⚠️ **为什么这几个 handler 在主进程，而不是在 `server/api` 里加个路由**：
 * 启动 ComfyUI 就是 `child_process.spawn` 一个长命进程，而 `server/api` 那些路由跑在
 * **后端 utilityProcess** 里。后端是会被监督器重启的（崩一次就换一个进程），
 * 子进程挂在它下面的话，后端一重启 ComfyUI 就变孤儿 —— 用户开着生成，应用自己把它丢了。
 * 主进程与窗口同生共死，是唯一合适的归属。这也是 `dispatch.ts` 里那条「不要跨界」的规矩推出来的。
 *
 * 参数（装在哪、监听哪个端口）存在**后端**的库里，所以启动前要向后端问一次。
 * 那条 `/api/local/connection` 就在同一个后端上，直接走已有的转发通道，不重复读库。
 */
async function readComfyuiLaunchInput(): Promise<{ comfyuiDir: string; baseUrl: string; portableRoot: string }> {
  const backend = (globalThis as unknown as { __frameBackend?: { pipePath: () => string | null } }).__frameBackend;
  const pipe = backend?.pipePath();
  if (!pipe) throw new Error('本机服务还没连上，稍等一下再试。');
  const response = await forwardToBackend(new Request(`${APP_ORIGIN}/api/local/connection`), pipe);
  if (!response.ok) throw new Error(`读不到 ComfyUI 配置（HTTP ${response.status}）。`);
  const view = await response.json() as { comfyuiDir?: string; baseUrl?: string };
  return {
    comfyuiDir: String(view?.comfyuiDir || '').trim(),
    baseUrl: String(view?.baseUrl || '').trim() || 'http://127.0.0.1:8188',
    /*
     * TE 整合包把 python 放在 `ComfyUI` 的**上一级**（`python_embeded` 与 `ComfyUI` 平级），
     * 而配置里填的是 `ComfyUI` 本身。多带一个候选根目录，让 `findPython` 能往上找一层。
     */
    portableRoot: path.dirname(String(view?.comfyuiDir || '').trim()),
  };
}

ipcMain.handle('comfyui-status', () => {
  const comfyui = (globalThis as unknown as { __frameComfyui?: ReturnType<typeof createComfyuiSupervisor> }).__frameComfyui;
  return comfyui ? comfyui.status() : { state: 'idle', message: '启动器还没准备好。', pid: null, startedAt: null, command: null, cwd: null };
});

ipcMain.handle('comfyui-start', async () => {
  const comfyui = (globalThis as unknown as { __frameComfyui?: ReturnType<typeof createComfyuiSupervisor> }).__frameComfyui;
  if (!comfyui) return { ok: false, message: '启动器还没准备好。' };
  try {
    const input = await readComfyuiLaunchInput();
    if (!input.comfyuiDir) {
      return { ok: false, message: '还没配 ComfyUI 安装目录。先在下面选一下它装在哪，再点启动。' };
    }
    const { host, port } = parseBaseUrl(input.baseUrl);
    const status = await comfyui.start({ comfyuiDir: input.comfyuiDir, portableRoot: input.portableRoot, host, port });
    return { ok: status.state === 'ready' || status.state === 'starting', message: status.message, status };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '启动失败。' };
  }
});

ipcMain.handle('comfyui-stop', async () => {
  const comfyui = (globalThis as unknown as { __frameComfyui?: ReturnType<typeof createComfyuiSupervisor> }).__frameComfyui;
  if (!comfyui) return { ok: false, message: '启动器还没准备好。' };
  const status = await comfyui.stop();
  return { ok: true, message: status.message, status };
});

/*
 * ---------- 本机 ComfyUI：侦探（正在跑的实例 / 装在哪） ----------
 *
 * 与上面「启动器」那组是同一件事的两半：启动器负责**让它跑起来**，侦探负责
 * **找出它是不是已经跑着、跑在哪个端口、装在哪**。两半都走 IPC 而不是 HTTP，
 * 理由和启动器一样（要 spawn 进程 / 扫本机磁盘，后端 utilityProcess 干不了这些）。
 *
 * 这一组的存在意义是「连不上」那一下：用户填的 8188 不通时，最有用的回答不是
 * 「确认它启动了」，而是「它其实跑在 8190，点一下就换过去」。
 */
ipcMain.handle('comfyui-detect-processes', async () => {
  try {
    const hits = await detectComfyuiProcesses();
    return { ok: true as const, processes: hits };
  } catch (error) {
    /* 扫不出来不是错误 —— 只是「没找到」。但真炸了也得让人看得见原因。 */
    return { ok: false as const, processes: [], message: error instanceof Error ? error.message : '读本机进程列表失败。' };
  }
});

ipcMain.handle('comfyui-find-installs', async () => {
  try {
    const input = await readComfyuiLaunchInput();
    const installs = await findComfyuiInstalls(input.comfyuiDir);
    return { ok: true as const, installs, configuredDir: input.comfyuiDir };
  } catch (error) {
    return { ok: false as const, installs: [], configuredDir: '', message: error instanceof Error ? error.message : '扫描本机目录失败。' };
  }
});

/*
 * ---------- 本机 ComfyUI：扩展（custom_nodes）的检测与安装 ----------
 *
 * 前面两组是「让它跑起来」和「找出它装在哪」，这一组是**唯一会往用户的 ComfyUI 里
 * 写文件的**。所以它比那两组多两道门：路径必须夹在 custom_nodes 里面、写入必须原子
 * （见 `comfyui-extensions.ts` 开头的四条纪律）。也仍然留在主进程 ——
 * 后端 utilityProcess 会被监督器重启，而「写了一半被打断」是最难收拾的一种失败。
 *
 * 目录**优先用调用方传进来的那个**（界面上刚存下的值），传空才回去读库：
 * 这样「刚存完目录立刻检测」不会因为后端慢半拍而查到旧路径；后端没起来时也只是
 * 每张卡片显示「还装不了」，而不是整块空白（COMFYUI-EXTENSIONS-PATCH）。
 */
async function resolveComfyuiDirForExtensions(explicit?: unknown): Promise<string> {
  const given = String(explicit || '').trim();
  if (given) return given;
  try {
    return (await readComfyuiLaunchInput()).comfyuiDir;
  } catch {
    return '';
  }
}

ipcMain.handle('comfyui-extensions', async (_event, payload: { dir?: string } | undefined) => {
  const comfyuiDir = await resolveComfyuiDirForExtensions(payload?.dir);
  try {
    return { ok: true as const, comfyuiDir, extensions: inspectExtensions(app.getAppPath(), comfyuiDir) };
  } catch (error) {
    return {
      ok: false as const,
      comfyuiDir,
      extensions: [],
      message: error instanceof Error ? error.message : '读 ComfyUI 扩展状态失败。',
    };
  }
});

ipcMain.handle('comfyui-extension-install', async (_event, payload: { id?: string; dir?: string } | undefined) => {
  const comfyuiDir = await resolveComfyuiDirForExtensions(payload?.dir);
  const appDir = app.getAppPath();
  const supervisor = (globalThis as unknown as { __frameComfyui?: ReturnType<typeof createComfyuiSupervisor> }).__frameComfyui;
  /*
   * ComfyUI 正在跑也**不打断它**：写文件对已经 import 完的 Python 进程没有影响，
   * 重启才会打断队列里的任务。这个值只用来决定回执里要不要补半句「重启后生效」。
   */
  let running = false;
  try {
    running = supervisor?.status().state === 'ready';
  } catch {
    running = false;
  }
  try {
    const result = installExtension(appDir, comfyuiDir, payload?.id, running);
    return {
      ok: true as const,
      comfyuiDir,
      extensions: inspectExtensions(appDir, comfyuiDir),
      message: result.changed
        ? `「${result.name}」已${result.status === 'updated' ? '更新' : '安装'}到 custom_nodes。${result.restartRequired ? '重启 ComfyUI 后生效。' : ''}`
        : `「${result.name}」已经是最新的，没有改动。`,
    };
  } catch (error) {
    return {
      ok: false as const,
      comfyuiDir,
      /* 装失败也把**重新检测过的**列表带回去：失败时的真实状态比那句错误更值得看。 */
      extensions: inspectExtensions(appDir, comfyuiDir),
      message: error instanceof Error ? error.message : '安装 ComfyUI 扩展失败。',
    };
  }
});

ipcMain.handle('comfyui-legacy-extensions', async (_event, payload: { dir?: string } | undefined) => {
  const comfyuiDir = await resolveComfyuiDirForExtensions(payload?.dir);
  try {
    return { ok: true as const, comfyuiDir, legacy: inspectLegacyExtensions(comfyuiDir) };
  } catch (error) {
    return { ok: false as const, comfyuiDir, legacy: [], message: error instanceof Error ? error.message : '读旧版扩展状态失败。' };
  }
});

/*
 * 移除上一版 Holy Light画布自己装的 `frame_*`。**只删清单里写死的那两个目录**，而且要求目录里的
 * manifest 确实写着同一个 id —— 名字撞车但不是我们装的，绝不动。
 * 上一个扩展（`fisherai_node_ids`）的编号徽标和它画在同一坐标，两个都在就是一团糊字，
 * 所以这个功能不是洁癖：留着会真的影响看编号。
 */
ipcMain.handle('comfyui-legacy-extension-remove', async (_event, payload: { id?: string; dir?: string } | undefined) => {
  const comfyuiDir = await resolveComfyuiDirForExtensions(payload?.dir);
  try {
    const result = removeLegacyExtension(comfyuiDir, payload?.id);
    return {
      ok: true as const,
      comfyuiDir,
      legacy: inspectLegacyExtensions(comfyuiDir),
      message: result.removed ? `已移除旧版扩展「${result.id}」。` : `「${result.id}」本来就不在，没有改动。`,
    };
  } catch (error) {
    return {
      ok: false as const,
      comfyuiDir,
      /* 失败也把重新检测过的列表带回去：真实的残留状态比那句错误更值得看。 */
      legacy: inspectLegacyExtensions(comfyuiDir),
      message: error instanceof Error ? error.message : '移除旧版扩展失败。',
    };
  }
});

/*
 * Codex 对话（画布右上角的侧栏）。
 *
 * 和 ComfyUI 那一组是同一个路子：进程握在主进程，这里只做「转发 + 把错误变成一句人话」。
 * 每个 handler 都把异常吞成 `{ok:false, message}` —— 侧栏里要显示的是「为什么用不了」，
 * 而不是让 promise 一路 reject 到控制台去。
 */
function readCodex() {
  return (globalThis as unknown as { __frameCodex?: ReturnType<typeof createCodexService> }).__frameCodex ?? null;
}

function codexOff() {
  return { phase: 'off', message: 'Codex 还没准备好。', version: null, account: null, requiresAuth: false, model: null, mcp: [], busy: false, threadId: null, codexPath: null };
}

ipcMain.handle('codex-status', () => {
  const codex = readCodex();
  return codex ? codex.status() : codexOff();
});

ipcMain.handle('codex-start', async () => {
  const codex = readCodex();
  if (!codex) return codexOff();
  await codex.start();
  return codex.status();
});

ipcMain.handle('codex-stop', () => {
  const codex = readCodex();
  if (!codex) return codexOff();
  codex.stop();
  return codex.status();
});

ipcMain.handle('codex-send', async (
  _event,
  payload: { text: string; projectId: string; projectName: string; skill?: { id: string; title: string; dir: string; files: string[] } | null },
) => {
  const codex = readCodex();
  if (!codex) return { ok: false, message: 'Codex 还没准备好。' };
  try {
    const raw = payload?.skill ?? null;
    await codex.send(String(payload?.text ?? '').trim(), {
      projectId: String(payload?.projectId ?? ''),
      projectName: String(payload?.projectName ?? ''),
      /*
       * 技能只透传「路径 + 标题」三个字段：正文留给 Codex 自己按路径读。
       * 顺便挡掉没给目录的脏数据（那只会让 Codex 去读一个不存在的路径）。
       */
      skill: raw && String(raw.dir ?? '').trim()
        ? {
          id: String(raw.id ?? ''),
          title: String(raw.title ?? '未命名技能'),
          dir: String(raw.dir),
          files: Array.isArray(raw.files) ? raw.files.slice(0, 40).map(item => String(item)) : [],
        }
        : null,
    });
    return { ok: true, message: '' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '发给 Codex 失败。' };
  }
});

ipcMain.handle('codex-interrupt', async () => {
  const codex = readCodex();
  if (!codex) return { ok: false, message: 'Codex 还没准备好。' };
  await codex.interrupt();
  return { ok: true, message: '' };
});

ipcMain.handle('codex-new-thread', async () => {
  const codex = readCodex();
  if (!codex) return codexOff();
  try {
    await codex.newThread();
  } catch { /* 建会话失败时状态里已经有原因，下面照旧回状态 */ }
  return codex.status();
});

ipcMain.handle('codex-login', async () => {
  const codex = readCodex();
  if (!codex) return { ok: false, message: 'Codex 还没准备好。' };
  try {
    await codex.login();
    return { ok: true, message: '已在浏览器里打开登录页，登录完回到这里即可。' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '打开登录页失败。' };
  }
});

/*
 * 画布背景图：传 / 删 / 恢复默认。
 *
 * 传的是**原始字节**（渲染进程读成 ArrayBuffer 送过来），不让渲染进程自己转 dataURL：
 * 转码会多占一份内存、而且在 localStorage 上会撞额度（见 `wallpaper.ts` 里的说明）。
 *
 * 尺寸与体积在这里**再校验一遍**。渲染进程那边已经拦过一次，但这一层是真正的落盘口，
 * 只信调用方传什么就写什么是很危险的 —— 一个坏掉的调用点就能把几百 MB 写进数据目录。
 */
ipcMain.handle(
  'save-wallpaper',
  async (
    _event,
    payload: { bytes: ArrayBuffer | Uint8Array; mime: string; width: number; height: number; slot?: string },
  ) => {
    try {
      const mime = String(payload?.mime || '');
      if (!WALLPAPER_LIMITS.mimes.includes(mime)) return { ok: false, message: '只支持 JPG、PNG、WebP 三种图片。' };
      const bytes = payload?.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array(payload?.bytes ?? []);
      if (!bytes.byteLength) return { ok: false, message: '图片是空的，没有读到内容。' };
      if (bytes.byteLength > WALLPAPER_LIMITS.maxBytes) {
        return { ok: false, message: `图片 ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB，超过 20 MB 上限。` };
      }
      const pixels = Number(payload?.width || 0) * Number(payload?.height || 0);
      if (!pixels) return { ok: false, message: '读不到图片尺寸，请换一张试试。' };
      if (pixels > WALLPAPER_LIMITS.maxPixels) {
        return { ok: false, message: `图片有 ${(pixels / 1_000_000).toFixed(1)} 万像素，超过 3200 万上限。` };
      }
      const slot = String(payload?.slot || '') === 'site' ? 'site' : 'canvas';
      return { ok: true, name: saveWallpaper(bytes, mime, slot) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '保存背景图失败。' };
    }
  },
);

ipcMain.handle('remove-wallpaper', (_event, slot?: string) => {
  try {
    removeWallpaper(slot === 'site' ? 'site' : 'canvas');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '删除背景图失败。' };
  }
});

/* ---------------------------------------------------------------------------
   软件内更新（2026-09-29）。见 `electron/main/updater.ts`。
   ⚠️ `updater-install` 是**会关掉整个软件**的那一个，所以主进程这边只认一个条件：
      状态必须是 `downloaded`（`installUpdate()` 里挡着）。界面上的按钮也只在那时能点，
      两道都有 —— 自动重启一次就能让正在跑的生成任务凭空消失。
   --------------------------------------------------------------------------- */
ipcMain.handle('updater-state', () => updaterState());
ipcMain.handle('updater-check', async () => await checkForUpdate());
ipcMain.handle('updater-download', async () => await downloadUpdate());
ipcMain.handle('updater-install', () => {
  installUpdate();
});
ipcMain.handle('updater-source', (_event, url: string) => setUpdaterSource(String(url || '')));
