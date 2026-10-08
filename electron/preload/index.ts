import { contextBridge, ipcRenderer, shell } from 'electron';
import type { UpdateState } from '@/lib/update-state';

/**
 * 只把「渲染进程确实需要、且只有主进程做得到」的几件事放过来。
 *
 * 注意这里**没有** API 通道：数据请求全部走 `app://` 协议的 `/api/*`，
 * 被主进程拦截后**转发给后端进程的命名管道**（见 `electron/main/api.ts`），
 * 所以渲染进程里的 `fetch('/api/...')` 一个字都不用改，也不需要经过这里。
 *
 * 唯一例外是 `backendState` / `onBackendState`：它们走的是 IPC 而不是 HTTP。
 * 原因是「后端还没起来」这件事用 HTTP 表达不出来 —— 那时页面拿到的只是
 * 一个 503（body 里写着 `BACKEND_RECONNECTING`），而「正在重连」还是「彻底坏了」
 * 只有主进程的监管器知道。
 */
contextBridge.exposeInMainWorld('api', {
  openExternal: (url: string) => shell.openExternal(url),
  platform: process.platform,
  /** 渲染进程偶尔要知道自己跑在桌面版里（比如隐藏「退出登录」） */
  desktop: true,
  /**
   * 桌面版**不允许**页面自己开新窗口 —— 恒为 false。
   *
   * 桌面版是单窗口的 hash 路由（`app://app/index.html#/...`），而 `target="_blank"`
   * 会把路径形式的链接解析成 `app://app/settings/xxx`：那个地址没有 `#/`，
   * 协议处理器只能回兜底的 index.html —— 用户看到的是**全白窗口**，一句报错都没有
   * （2026-09-19「打开工作流配置后怎么是空的？」就是这条）。
   *
   * `next/link` 的替身读这个值：false 时它把同源链接的 `target` 吃掉、走应用内导航。
   * 主进程那边还有一道 `setWindowOpenHandler` 兜底（挡住不经过该组件的裸链接），
   * 两道都留着 —— 只靠其中一道，另一条路仍会漏出白窗。
   */
  canOpenWindow: false,
  /**
   * 把窗口右上角那三个系统按钮的**符号颜色**跟着主题换。
   *
   * 标题栏本身已经藏掉了（主进程 `titleBarStyle: 'hidden'`），按钮是**浮在页头上**的 ——
   * 浅色页头配浅色符号会看不见，所以每次换肤都要报一次。
   * 单向 `send`：调用方不需要结果，主进程那边失败也只是颜色不对，不该阻断换肤。
   */
  setTitlebarTheme: (dark: boolean) => { ipcRenderer.send('titlebar-theme', dark); },
  /**
   * 选一个本机文件，返回绝对路径（取消返回 null）。
   *
   * 加它是为了「选一个本机文件」（比如导入工作流 JSON、挑一张参考图）：
   * 路径又长又深，让用户手打不现实。通道只做这一件事，且后缀白名单由调用方给。
   */
  pickFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('pick-file', options ?? {}) as Promise<string | null>,
  /**
   * 选一个**文件夹**，返回绝对路径（取消返回 null）。
   *
   * 用途只有一件事：让用户挑「产出存在哪」。桌面版默认落在 `userData/storage`
   * （系统盘底下，又深又不好找），换到自己选的盘之后找文件、备份、外接硬盘都方便。
   */
  pickFolder: (options?: { title?: string; defaultPath?: string }) =>
    ipcRenderer.invoke('pick-folder', options ?? {}) as Promise<string | null>,
  /**
   * 选**多个**文件，返回绝对路径数组（取消返回空数组）。
   *
   * 加它是为了「导入创作预设」：ComfyUI-Easy-Use 那批 styles 是按分类拆成几十个 json 的，
   * 让人一个一个选不现实。
   */
  pickFiles: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('pick-files', options ?? {}) as Promise<string[]>,
  /**
   * 创作预设的导入 / 列表 / 删组（2026-10-07）。
   *
   * 预览图由主进程搬进数据目录并从 `app://app/ipassets/...` 喂回来 ——
   * 所以这里传的只是「选哪个目录 / 归到哪个分类」，字节不过 IPC。
   *
   * `importPresets` 会搬 88 MB 级别的图，可能要几十秒：调用方必须显示「正在导入」，
   * 别让它看起来像卡死了。
   */
  presetImport: (payload: { dir?: string; files?: string[]; category: string }) =>
    ipcRenderer.invoke('preset-import:run', payload) as Promise<{
      ok: boolean; message: string;
      group: { id: string; name: string; source: string; importedAt: string; count: number } | null;
      scanned: number; imported: number; images: number; skipped: string[];
    }>,
  presetImportList: () =>
    ipcRenderer.invoke('preset-import:list') as Promise<{
      version: number;
      groups: { id: string; name: string; source: string; importedAt: string; count: number }[];
      presets: {
        id: string; kind: 'style'; category: string; name: string;
        description: string; prompt: string; preview: string; group: string;
      }[];
    }>,
  presetImportRemove: (groupId: string) =>
    ipcRenderer.invoke('preset-import:remove', groupId) as Promise<{ ok: boolean; message: string }>,
  /**
   * 自定义标签分类（2026-10-08，见 `electron/main/danbooru-cats.ts`）。
   *
   * 读 / 写一份 `<dataDir>/danbooru-categories.json`，外加「读用户选的文件、把条目交回来」。
   * `import` **只读不写**：收不收、收进哪个分类由渲染进程决定 ——
   * 点了导入又反悔时磁盘上不该留下任何东西。
   */
  danbooruCatsLoad: () =>
    ipcRenderer.invoke('danbooru-cats:load') as Promise<{
      version: number;
      categories: {
        id: string; name: string; mode: 'pick' | 'all';
        entries: { id: string; label: string; tags: string; sub?: string; preview?: string }[];
      }[];
    }>,
  danbooruCatsSave: (payload: {
    categories: {
      id: string; name: string; mode: 'pick' | 'all';
      entries: { id: string; label: string; tags: string; sub?: string; preview?: string }[];
    }[];
  }) => ipcRenderer.invoke('danbooru-cats:save', payload) as Promise<{ ok: boolean; message: string }>,
  danbooruCatsImport: (payload: { files: string[] }) =>
    ipcRenderer.invoke('danbooru-cats:import', payload) as Promise<{
      ok: boolean; message: string;
      entries: { id: string; label: string; tags: string; sub?: string; preview?: string }[];
      files: number; skipped: string[];
    }>,
  /**
   * 自建的创作预设：档 / 分类 / 条目（2026-10-08，见 `electron/main/preset-mine.ts`）。
   * 存在 `<dataDir>/creative-presets/mine.json`，与「导入的那批」是两份文件 ——
   * 那份的语义是「同名再导 = 覆盖」，这份是「往我自己的分类里加」。
   */
  presetMineLoad: () =>
    ipcRenderer.invoke('preset-mine:load') as Promise<{
      version: number;
      kinds: { id: string; name: string; single: boolean }[];
      categories: { id: string; kind: string; name: string }[];
      presets: {
        id: string; kind: string; category: string; name: string;
        description: string; prompt: string; preview: string; poster?: string; prefix?: string;
      }[];
    }>,
  presetMineSave: (payload: {
    kinds: { id: string; name: string; single: boolean }[];
    categories: { id: string; kind: string; name: string }[];
    presets: {
      id: string; kind: string; category: string; name: string;
      description: string; prompt: string; preview: string; poster?: string; prefix?: string;
    }[];
  }) => ipcRenderer.invoke('preset-mine:save', payload) as Promise<{ ok: boolean; message: string }>,
  presetMineImport: (payload: { files: string[] }) =>
    ipcRenderer.invoke('preset-mine:import', payload) as Promise<{
      ok: boolean; message: string;
      entries: {
        id: string; kind: string; category: string; name: string;
        description: string; prompt: string; preview: string; poster?: string; prefix?: string;
      }[];
      files: number; skipped: string[];
    }>,
  /**
   * 在系统文件管理器里打开一个目录（Windows 是资源管理器，macOS 是 Finder）。
   *
   * 注意 `shell.openPath` **不抛异常**，只回错误串，所以这里把 `message` 原样带回——
   * 「点了没反应」必须能变成一句看得见的提示。
   */
  openFolder: (dir: string) =>
    ipcRenderer.invoke('open-folder', dir) as Promise<{ ok: boolean; message: string }>,
  /**
   * 后端进程**当前**的状态。挂载时先查一次 —— 推送只在状态变化时发，
   * 页面比后端 ready 晚加载的话一条都收不到，界面会一直卡在「正在连接」。
   */
  backendState: () => ipcRenderer.invoke('backend-state') as Promise<BackendState>,
  /**
   * 订阅后端状态变化，返回取消订阅的函数。
   *
   * `reconnecting` / `failed` 时页面要显示「本机服务正在重新连接」——
   * 后端崩了窗口还在，用户不该对着一个永远转圈的按钮发呆。
   */
  onBackendState: (listener: (state: BackendState) => void) => {
    const handler = (_event: unknown, state: BackendState) => listener(state);
    ipcRenderer.on('backend-state', handler);
    return () => {
      ipcRenderer.removeListener('backend-state', handler);
    };
  },
  /**
   * 存 / 删画布背景图。
   *
   * 传的是**原始字节**而不是 dataURL：图可能有十几 MB，走 IPC 的结构化克隆
   * 比在渲染进程里转成一串 base64 再解析要省一倍内存和一次字符串转换。
   * `width` / `height` 也要一起传 —— 像素上限只有渲染进程量得出来（它那边才解过图）。
   */
  saveWallpaper: (
    payload: { bytes: ArrayBuffer; mime: string; width: number; height: number; slot?: 'canvas' | 'site' },
  ) =>
    ipcRenderer.invoke('save-wallpaper', payload) as Promise<{ ok: true; name: string } | { ok: false; message: string }>,
  removeWallpaper: (slot?: 'canvas' | 'site') =>
    ipcRenderer.invoke('remove-wallpaper', slot) as Promise<{ ok: boolean; message?: string }>,

  /**
   * 画布里的内置浏览器（找参考图不用切出去）。**桌面版专属**。
   *
   * 与别处的通道最大的不同：**矩形由渲染层给**。面板是画在页面里的一个占位 div，
   * 网页视图是主进程盖在它上面的另一个 WebContentsView —— 两者分属不同的层，
   * 只有渲染层量得出「占位区现在在哪、多大」，所以每次布局变了都要重报一次。
   *
   * 所有会改地址的调用（open / navigate / command）都**返回最新状态**而不是只回一个 ok：
   * 地址栏的显示值必须跟着浏览器那边的真实结果走 —— 用户敲了 `bing.com`，
   * 浏览器最终停在 `https://www.bing.com/`，界面要显示后者。
   */
  browserState: () => ipcRenderer.invoke('browser:state') as Promise<BrowserState>,
  browserOpen: (payload: { bounds: BrowserRect; url?: string }) =>
    ipcRenderer.invoke('browser:open', payload) as Promise<BrowserState>,
  browserClose: () => ipcRenderer.invoke('browser:close') as Promise<BrowserState>,
  browserNavigate: (url: string) => ipcRenderer.invoke('browser:navigate', { url }) as Promise<BrowserState>,
  /** 只改位置，不回状态 —— 它会在拖动过程中被高频调用，回值没人看。 */
  browserSetBounds: (bounds: BrowserRect) => ipcRenderer.invoke('browser:set-bounds', { bounds }) as Promise<void>,
  browserCommand: (command: BrowserCommand) => ipcRenderer.invoke('browser:command', { command }) as Promise<BrowserState>,
  onBrowserState: (listener: (state: BrowserState) => void) => {
    const handler = (_event: unknown, state: BrowserState) => listener(state);
    ipcRenderer.on('browser:state', handler);
    return () => {
      ipcRenderer.removeListener('browser:state', handler);
    };
  },
  /**
   * 把网页上的一张图取下来交给画布。
   *
   * 取图在主进程做（渲染层 `fetch` 会被同源策略挡住），所以这里是**单向**的：
   * 调完就返回，图到了会以 `browser:image` 事件的形式回来 —— 右键菜单那条路
   * 根本没有调用方等着要返回值，两条路必须共用同一种交付方式。
   */
  browserGrabImage: (payload: { url: string }) => ipcRenderer.invoke('browser:grab-image', payload) as Promise<boolean>,
  /** 列出当前页面里能当参考图的图片（主进程在页面里跑一段只读脚本抓 `<img>`）。 */
  browserPageImages: () => ipcRenderer.invoke('browser:page-images') as Promise<BrowserPageImage[]>,
  onBrowserImage: (listener: (image: BrowserImage) => void) => {
    const handler = (_event: unknown, image: BrowserImage) => listener(image);
    ipcRenderer.on('browser:image', handler);
    return () => {
      ipcRenderer.removeListener('browser:image', handler);
    };
  },
  /** 取图失败的原因。一定要显示出来：用户点了一张图，画布上没动静是最难自查的一类问题。 */
  onBrowserImageError: (listener: (message: string) => void) => {
    const handler = (_event: unknown, message: string) => listener(message);
    ipcRenderer.on('browser:image-error', handler);
    return () => {
      ipcRenderer.removeListener('browser:image-error', handler);
    };
  },
  /**
   * 从网页上**拖**一张图到画布上松手了。
   *
   * 为什么单独一条通道，而不是复用 `onBrowserImage`：那一条**没有落点**
   * （右键菜单、点缩略图这两条路里不存在「用户在哪松手」），图会落在画布上一个固定位置；
   * 拖拽这条路的全部意义就是「落在我松手的地方」，所以落点必须一起带过来。
   *
   * 分两步交付（先给地址 + 坐标，图稍后以 `browser:image` 事件回来）是因为
   * 取字节在主进程做（渲染层 fetch 会被同源策略挡住），这里拿不到字节。
   * 坐标是**窗口内容区**坐标，与 `getBoundingClientRect()` 同一套。
   */
  onBrowserImageDrop: (listener: (drop: BrowserImageDrop) => void) => {
    const handler = (_event: unknown, drop: BrowserImageDrop) => listener(drop);
    ipcRenderer.on('browser:image-drop', handler);
    return () => {
      ipcRenderer.removeListener('browser:image-drop', handler);
    };
  },

  /**
   * 本机 ComfyUI 的**启动**。和上面的 `backendState` 是一类东西：走 IPC 而不是 HTTP。
   *
   * 原因和内置浏览器同款：ComfyUI 是主进程 `spawn` 出来的长命子进程，
   * 而 `/api/*` 路由跑在后端 utilityProcess 里。后端会被监督器重启，子进程挂在它下面
   * 就会在后端重启时变成孤儿 —— 用户开着生成，应用自己把它丢了。
   *
   * 起一次要 **1～3 分钟**（插件多），所以 `start` 返回时就可能还是 `starting`，
   * 界面必须订阅 `onComfyuiState` 才知道什么时候真的好了。
   */
  comfyuiStatus: () => ipcRenderer.invoke('comfyui-status') as Promise<ComfyuiStatus>,
  comfyuiStart: () =>
    ipcRenderer.invoke('comfyui-start') as Promise<{ ok: boolean; message: string; status?: ComfyuiStatus }>,
  comfyuiStop: () =>
    ipcRenderer.invoke('comfyui-stop') as Promise<{ ok: boolean; message: string; status?: ComfyuiStatus }>,
  onComfyuiState: (listener: (status: ComfyuiStatus) => void) => {
    const handler = (_event: unknown, status: ComfyuiStatus) => listener(status);
    ipcRenderer.on('comfyui-state', handler);
    return () => {
      ipcRenderer.removeListener('comfyui-state', handler);
    };
  },
  /**
   * 本机 ComfyUI 的**侦探**：已经在跑的实例（端口从进程命令行里认）。
   *
   * 它的用处全在「连不上」那一下：填的地址不通时，与其让人猜，不如直接说
   * 「你机器上有个 ComfyUI 正在 8190 上跑，点一下就换过去」。所以返回值里要带
   * 端口**和**目录 —— 光有端口，用户还是不知道那是哪个整合包。
   */
  comfyuiDetectProcesses: () =>
    ipcRenderer.invoke('comfyui-detect-processes') as Promise<{
      ok: boolean; processes: ComfyuiProcessHit[]; message?: string;
    }>,
  /** 扫本机找 ComfyUI 装在哪（用户不记得装到哪个盘时用）。**只读**，不动任何东西。 */
  comfyuiFindInstalls: () =>
    ipcRenderer.invoke('comfyui-find-installs') as Promise<{
      ok: boolean; installs: ComfyuiInstallHit[]; configuredDir: string; message?: string;
    }>,

  /*
   * ComfyUI 扩展（custom_nodes 下的插件）的检测与安装。**这两个会往用户的 ComfyUI 里写文件**
   * —— 是这一整组里唯一有副作用的。
   *
   * 为什么走 IPC 而不是加个 `/api/*` 路由：它要读随包的 `integrations/`（打进 asar，
   * 只有主进程读得到），再往任意一个 custom_nodes 路径写。这两件事后端 utilityProcess
   * 都不该干，而且它的生死会被监督器重启打乱（见 main/index.ts 里那段说明）。
   *
   * `dir` 是「装到哪个 ComfyUI 去」。传空则由主进程回去读库，界面不用自己兜底
   * （COMFYUI-EXTENSIONS-PATCH）。
   */
  comfyuiExtensions: (payload?: { dir?: string }) =>
    ipcRenderer.invoke('comfyui-extensions', payload ?? {}) as Promise<{
      ok: boolean; comfyuiDir: string; extensions: ComfyuiExtensionView[]; message?: string;
    }>,
  comfyuiInstallExtension: (payload: { id: string; dir?: string }) =>
    ipcRenderer.invoke('comfyui-extension-install', payload) as Promise<{
      ok: boolean; comfyuiDir: string; extensions: ComfyuiExtensionView[]; message: string;
    }>,
  /** 上一版 Holy Light画布自己装的 `frame_*` 还在不在（它和新扩展的编号徽标会重叠）。 */
  comfyuiLegacyExtensions: (payload?: { dir?: string }) =>
    ipcRenderer.invoke('comfyui-legacy-extensions', payload ?? {}) as Promise<{
      ok: boolean; comfyuiDir: string; legacy: ComfyuiLegacyExtensionView[]; message?: string;
    }>,
  /** 移除一个上一版装的 `frame_*`。只认清单里写死的那两个 id。 */
  comfyuiRemoveLegacyExtension: (payload: { id: string; dir?: string }) =>
    ipcRenderer.invoke('comfyui-legacy-extension-remove', payload) as Promise<{
      ok: boolean; comfyuiDir: string; legacy: ComfyuiLegacyExtensionView[]; message: string;
    }>,

  /**
   * 画布里的 Codex 对话（能操作画布的那个）。**桌面版专属**。
   *
   * 和 ComfyUI 启动器是同一类东西：codex 是主进程 `spawn` 的长命子进程，
   * 握在渲染层会随页面刷新被丢掉 —— 所以这里只有「发一句话 / 收一段流」，
   * 真正的 stdio 协议在主进程里。
   *
   * 两条通道分开：`codexStatus` 是「现在能不能用」（快照），
   * `onCodexEvent` 是流式增量（一段话、一次工具调用、一次画布被改）。
   * 混在一条里的话，界面每次状态刷新都要重新判断自己该不该重画消息区。
   */
  codexStatus: () => ipcRenderer.invoke('codex-status') as Promise<CodexStatus>,
  codexStart: () => ipcRenderer.invoke('codex-start') as Promise<CodexStatus>,
  codexStop: () => ipcRenderer.invoke('codex-stop') as Promise<CodexStatus>,
  /** 发一句话。项目上下文由渲染层给 —— 同一个会话换项目时，工具必须打到新项目上。 */
  codexSend: (payload: { text: string; projectId: string; projectName: string; skill?: CodexSkill | null }) =>
    ipcRenderer.invoke('codex-send', payload) as Promise<{ ok: boolean; message: string }>,
  codexInterrupt: () => ipcRenderer.invoke('codex-interrupt') as Promise<{ ok: boolean; message: string }>,
  /** 开一个新会话（换项目、或上一轮说歪了想从头来）。 */
  codexNewThread: () => ipcRenderer.invoke('codex-new-thread') as Promise<CodexStatus>,
  /**
   * 换一个模型（2026-10-05）：只影响**这条会话接下来的回合**，聊天记录留着。
   * 还没连上时也能选 —— 主进程记着，下次开会话就用它。
   */
  codexSetModel: (modelId: string) =>
    ipcRenderer.invoke('codex-set-model', modelId) as Promise<{ ok: boolean; message: string }>,
  /** 登录 Codex：主进程拿 OAuth 地址交给系统浏览器，这里只是触发。 */
  codexLogin: () => ipcRenderer.invoke('codex-login') as Promise<{ ok: boolean; message: string }>,
  /**
   * 把这张画布交给 WorkBuddy（2026-09-30）：提示词进剪贴板 + 唤起它。
   * WorkBuddy 是另一个应用（不像 Codex 那样养在这个进程里），所以这里只有「交代过去」这一件事。
   */
  workbuddyLaunch: (payload: { projectId: string; projectName: string; ask?: string }) =>
    ipcRenderer.invoke('workbuddy-launch', payload) as Promise<{ ok: boolean; message: string; copied: boolean }>,
  onCodexEvent: (listener: (event: CodexEvent) => void) => {
    const handler = (_event: unknown, event: CodexEvent) => listener(event);
    ipcRenderer.on('codex:event', handler);
    return () => {
      ipcRenderer.removeListener('codex:event', handler);
    };
  },
  /* 点右上角关闭：主进程拦下默认退出、改推 request-close，渲染层据此弹确认框。
   * 单向 on：渲染进程订阅，主进程 webContents.send('request-close') 推送。 */
  onRequestClose: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('request-close', handler);
    return () => {
      ipcRenderer.removeListener('request-close', handler);
    };
  },
  /* 用户在确认框里选了「最小化 / 退出应用」，回传主进程执行。
   * 'quit' 主进程走 app.quit() -> before-quit 后端 flush，不能直接 destroy。 */
  windowCloseAction: (action: 'minimize' | 'quit') =>
    ipcRenderer.invoke('window-close-action', action) as Promise<void>,

  /*
   * 软件内更新（2026-09-29）。见 `electron/main/updater.ts` 与 `lib/update-state.ts`。
   *
   * 🔴 `updaterInstall` 会**关掉整个软件** —— 它只能由用户点按钮触发，
   *    任何「自动调用」都会让正在跑的生成任务凭空消失。
   *    这也是为什么它单独是一个通道、而不是塞进 `updaterDownload` 的返回值里。
   */
  updaterState: () => ipcRenderer.invoke('updater-state') as Promise<UpdateState>,
  updaterCheck: () => ipcRenderer.invoke('updater-check') as Promise<UpdateState>,
  updaterDownload: () => ipcRenderer.invoke('updater-download') as Promise<UpdateState>,
  updaterInstall: () => ipcRenderer.invoke('updater-install') as Promise<void>,
  updaterSetSource: (url: string) => ipcRenderer.invoke('updater-source', url) as Promise<UpdateState>,
  /** 订阅更新状态变化。与 `onBackendState` 同一套形状：返回取消订阅的函数。 */
  onUpdaterState: (listener: (state: UpdateState) => void) => {
    const handler = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on('updater-state', handler);
    return () => {
      ipcRenderer.removeListener('updater-state', handler);
    };
  },
});

/** 后端状态机的取值，和 `electron/main/backend-supervisor.ts` 里的定义保持一致。 */
export type BackendState = 'stopped' | 'starting' | 'ready' | 'reconnecting' | 'stopping' | 'failed';

/** 内置浏览器的状态。与 `electron/main/browser-panel.ts` 里的 `BrowserState` 保持一致。 */
export type BrowserState = {
  open: boolean;
  /** 页面真实停在哪 —— 地址栏要显示它，而不是用户敲进去的那串。 */
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

/** 占位区在窗口内容区里的矩形（CSS 像素，与 `getBoundingClientRect()` 同一套单位）。 */
export type BrowserRect = { x: number; y: number; width: number; height: number };

/** 工具条能下的命令。与 `browser-panel.ts` 里 `browser:command` 的分支一一对应。 */
export type BrowserCommand = 'back' | 'forward' | 'reload' | 'stop';

/** 主进程取下来的一张网页图片。字节直接过 IPC，中途不落盘。 */
export type BrowserImage = {
  /** 一个能当文件名的名字（已经去掉扩展名里的非法字符）。 */
  name: string;
  mime: string;
  bytes: Uint8Array;
  url: string;
};

/** 页面里一张可用图片的出处。`width` / `height` 用来把图标和埋点像素滤掉。 */
export type BrowserPageImage = { url: string; width: number; height: number };

/**
 * 一次「从网页拖图到画布」的落点。与 `browser-panel.ts` 里 `browser:image-drop` 的载荷一致。
 *
 * `x` / `y` 是**窗口内容区**坐标（`getBoundingClientRect()` 那一套），
 * 不是屏幕坐标 —— 渲染层可以直接拿它去 `document.elementFromPoint`。
 */
export type BrowserImageDrop = { url: string; x: number; y: number };

/**
 * 本机 ComfyUI 启动器的状态。与 `electron/main/comfyui-supervisor.ts` 里的
 * `ComfyuiStatus` 保持一致 —— 两边改一边就要同步另一边。
 */
export type ComfyuiStatus = {
  state: 'idle' | 'starting' | 'ready' | 'stopped' | 'failed';
  /** 给界面直接显示的一句话。失败时这里就是诊断线索。 */
  message: string;
  pid: number | null;
  /** 这次启动是什么时候发起的（ISO）。界面用它显示「已等待 1 分 20 秒」。 */
  startedAt: string | null;
  /** 用的是哪个 python + 什么参数，只读展示用。 */
  command: string | null;
  cwd: string | null;
};

/**
 * 一份随包 ComfyUI 扩展的状态。与 `electron/main/comfyui-extensions.ts` 里的
 * `ComfyuiExtensionView` 保持一致 —— 改一边就要同步另一边（和 ComfyuiStatus 一个规矩）。
 *
 * 注意 `status` 是**五档**而不是布尔：`missing`（没装）和 `up-to-date`（装好了）之间
 * 还夹着 `needs-repair`（文件对不上）和 `update-available`（版本更旧）。
 * 只看「目录在不在」的话，前两种都会显示成「已安装」—— 那种「说好了其实是坏的」
 * 是这一页最不该出现的错。
 */
export type ComfyuiLegacyExtensionView = {
  id: string;
  targetDir: string;
  exists: boolean;
};

export type ComfyuiExtensionView = {
  id: string;
  name: string;
  purpose: string;
  /** 随包那份的版本；读不出来是 null。 */
  bundledVersion: string | null;
  /** 已经装在 custom_nodes 里那份的版本；没装或读不出来是 null。 */
  installedVersion: string | null;
  status: 'unavailable' | 'missing' | 'up-to-date' | 'needs-repair' | 'update-available';
  installable: boolean;
  /** 装不了 / 出问题时的原因，直接显示给用户。 */
  message?: string;
};

/**
 * Codex 的连接状态快照。与 `electron/main/codex-service.ts` 里的同名类型保持一致 ——
 * 改一边就要同步另一边（和 ComfyuiStatus 一个规矩）。
 */
export type CodexStatus = {
  phase: 'off' | 'starting' | 'ready' | 'error';
  message: string;
  version: string | null;
  account: { type: string; email: string | null; planType: string | null } | null;
  /** Codex 说要登录而账号又是空的 → 界面给「登录 Codex」入口。 */
  requiresAuth: boolean;
  /** **当前这条会话实际在用的**模型（真值来自 codex 的 `thread/settings/updated`）。 */
  model: string | null;
  /** 能选的模型（`model/list` 那一份，已滤掉 hidden）。界面用它画那个下拉。 */
  models: { id: string; label: string; hint: string }[];
  mcp: { name: string; tools: number; status: string; error: string | null }[];
  busy: boolean;
  threadId: string | null;
  codexPath: string | null;
};

/**
 * 这次调用挂着的技能（SKILL 社区里选的）。与 `codex-service.ts` 的 `CodexSkill` 一致。
 *
 * 只带**路径**不带正文：正文几万字符，还带着一整个 references 目录，
 * 走 IPC 再进 prompt 会把上下文烧掉一半；让 Codex 自己按路径读才是对的。
 */
export type CodexSkill = {
  id: string;
  title: string;
  /** 技能目录的绝对路径。 */
  dir: string;
  files: string[];
};

/** 一次工具调用的展示用视图（参数与结果都已截断）。 */
export type CodexItemView = {
  id: string;
  type: string;
  server?: string;
  tool?: string;
  status?: string;
  arguments?: string;
  result?: string;
  error?: string | null;
};

/**
 * 侦探找到的**一个正在跑的 ComfyUI 实例**。与 `electron/main/comfyui-detect.ts` 保持一致。
 */
export type ComfyuiProcessHit = {
  pid: number;
  /** 命令行里的 `--port`；没写就是 null（那是默认 8188）。 */
  port: number | null;
  /** 认出来的安装目录；命令行里没有绝对路径时是 null。 */
  dir: string | null;
  commandLine: string;
};

/**
 * 侦探找到的**一处 ComfyUI 安装**。与 `electron/main/comfyui-detect.ts` 保持一致。
 */
export type ComfyuiInstallHit = {
  dir: string;
  name: string;
  hasMain: boolean;
  hasModels: boolean;
  hasCustomNodes: boolean;
  /** 附近有没有能用的 python —— 没有的话「启动」按钮点了也起不来。 */
  hasPython: boolean;
};

/** 流式事件。与 `codex-service.ts` 的 `CodexEvent` 一一对应。 */
export type CodexEvent =
  | { kind: 'status'; status: CodexStatus }
  | { kind: 'message'; itemId: string; text: string }
  | { kind: 'reasoning'; itemId: string; text: string }
  | { kind: 'item'; phase: 'started' | 'completed'; item: CodexItemView }
  | { kind: 'turn'; state: 'started' | 'completed' | 'failed'; error: string | null }
  /** 画布被 frame 工具改过了 —— 画布据此把自己拉成最新。 */
  | { kind: 'canvas' }
  | { kind: 'error'; message: string };
