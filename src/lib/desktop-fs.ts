/**
 * 只有桌面版（Electron）才有的「本机文件夹」能力。
 *
 * 走 preload 暴露的 `window.api.*`，web 版里这些字段不存在 —— 两个版本共用的组件
 * 直接调就行，拿不到就当「不支持」，不用在每个调用点写一遍 `typeof window`。
 */

export type DesktopApi = {
  pickFile?: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  pickFolder?: (options?: { title?: string; defaultPath?: string }) => Promise<string | null>;
  openFolder?: (dir: string) => Promise<{ ok: boolean; message: string }>;
  /** 桌面版恒为 false：单窗口 hash 路由下，开新窗口只会得到一个没有 hash 的白页。 */
  canOpenWindow?: boolean;
  /** 本机 ComfyUI 启动器（见 `electron/main/comfyui-supervisor.ts`）。web 版没有这几个字段。 */
  comfyuiStatus?: () => Promise<ComfyuiStatus>;
  comfyuiStart?: () => Promise<{ ok: boolean; message: string; status?: ComfyuiStatus }>;
  comfyuiStop?: () => Promise<{ ok: boolean; message: string; status?: ComfyuiStatus }>;
  onComfyuiState?: (listener: (status: ComfyuiStatus) => void) => () => void;
  /** 本机 ComfyUI 的侦探（见 `electron/main/comfyui-detect.ts`）。web 版没有这几个字段。 */
  comfyuiDetectProcesses?: () => Promise<{ ok: boolean; processes: ComfyuiProcessHit[]; message?: string }>;
  comfyuiFindInstalls?: () => Promise<{ ok: boolean; installs: ComfyuiInstallHit[]; configuredDir: string; message?: string }>;
  /** ComfyUI 扩展（`custom_nodes`）的检测与安装（见 `electron/main/comfyui-extensions.ts`）。**会写文件**。 */
  comfyuiExtensions?: (payload?: { dir?: string }) => Promise<{ ok: boolean; comfyuiDir: string; extensions: ComfyuiExtensionView[]; message?: string }>;
  comfyuiInstallExtension?: (payload: { id: string; dir?: string }) => Promise<{ ok: boolean; comfyuiDir: string; extensions: ComfyuiExtensionView[]; message: string }>;
  /** 上一版 Holy Light画布自己装的 `frame_*`（见 `LEGACY_EXTENSIONS`）。 */
  comfyuiLegacyExtensions?: (payload?: { dir?: string }) => Promise<{ ok: boolean; comfyuiDir: string; legacy: ComfyuiLegacyExtensionView[]; message?: string }>;
  comfyuiRemoveLegacyExtension?: (payload: { id: string; dir?: string }) => Promise<{ ok: boolean; comfyuiDir: string; legacy: ComfyuiLegacyExtensionView[]; message: string }>;
};

/** 与 preload 那边 `ComfyuiStatus` 保持一致。 */
export type ComfyuiStatus = {
  state: 'idle' | 'starting' | 'ready' | 'stopped' | 'failed';
  message: string;
  pid: number | null;
  startedAt: string | null;
  command: string | null;
  cwd: string | null;
};

function desktopApi(): DesktopApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { api?: DesktopApi }).api ?? null;
}

/**
 * 打开系统文件夹选择框。返回 null 只有两种可能：**用户取消了**，或者**当前不在桌面版**
 * —— 两种在调用方那里都是「没选」，不必区分，也不用弹错。
 */
export function pickFolderPath(options: { title?: string; defaultPath?: string } = {}): Promise<string | null> {
  const api = desktopApi();
  if (!api?.pickFolder) return Promise.resolve(null);
  return api.pickFolder(options).catch(() => null);
}

/**
 * 打开系统**文件**选择框（挑一个具体文件，而不是目录）。
 *
 * 与 `pickFolderPath` 的唯一区别是「选的是文件」：视频拼接要拿它挑 ffmpeg.exe ——
 * 那个文件躺在一个带 git hash 的目录里，让用户手打路径不现实。
 */
export function pickFilePath(options: { title?: string; filters?: { name: string; extensions: string[] }[] } = {}): Promise<string | null> {
  const api = desktopApi();
  if (!api?.pickFile) return Promise.resolve(null);
  return api.pickFile(options).catch(() => null);
}

/** 界面要不要显示「选一个文件」这个按钮（web 版没有主进程，弹不出系统框）。 */
export function canPickFile(): boolean {
  return Boolean(desktopApi()?.pickFile);
}

/**
 * 在系统文件管理器里打开一个目录。
 *
 * ⚠️ `ok` 为 false 时**一定**要把 `message` 显示出来：`shell.openPath` 不抛异常，
 * 只回一句错误串，吞掉它就成了「点了按钮什么都没发生」—— 那是用户最难自己查明白的一类问题。
 */
export async function openFolderPath(dir: string): Promise<{ ok: boolean; message: string }> {
  const api = desktopApi();
  if (!api?.openFolder) return { ok: false, message: '只有桌面版能打开本机文件夹。' };
  try {
    return await api.openFolder(dir);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '打开文件夹失败。' };
  }
}

/** 界面上要不要显示那两个按钮（web 版不该显示一个点了没反应的按钮）。 */
export function canBrowseFolders(): boolean {
  return Boolean(desktopApi()?.pickFolder);
}

/**
 * 「能不能一键启动本机 ComfyUI」——web 版不能，界面上那个按钮就不该出现。
 *
 * 判据是 `comfyuiStart` 而不只是 `comfyuiStatus`：只有状态查询的话按钮点了没反应，
 * 不如只留状态显示。
 */
export function canLaunchComfyui(): boolean {
  return Boolean(desktopApi()?.comfyuiStart);
}

/** 查 ComfyUI 启动器的当前状态。web 版恒回 `idle`，界面照常渲染一块「只有桌面版能启动」。 */
export async function comfyuiStatus(): Promise<ComfyuiStatus> {
  const api = desktopApi();
  if (!api?.comfyuiStatus) return { state: 'idle', message: '只有桌面版能启动本机 ComfyUI。', pid: null, startedAt: null, command: null, cwd: null };
  try {
    return await api.comfyuiStatus();
  } catch (error) {
    return { state: 'failed', message: error instanceof Error ? error.message : '读状态失败。', pid: null, startedAt: null, command: null, cwd: null };
  }
}

/** 点「启动 ComfyUI」。**不阻塞**等它 ready —— 起一次要 1～3 分钟，界面靠订阅状态推进。 */
export async function comfyuiStart(): Promise<{ ok: boolean; message: string; status?: ComfyuiStatus }> {
  const api = desktopApi();
  if (!api?.comfyuiStart) return { ok: false, message: '只有桌面版能启动本机 ComfyUI。' };
  try {
    return await api.comfyuiStart();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '启动失败。' };
  }
}

/** 关掉由我们启动的 ComfyUI。你自己手动起的那个不归我们管，这里停不掉。 */
export async function comfyuiStop(): Promise<{ ok: boolean; message: string; status?: ComfyuiStatus }> {
  const api = desktopApi();
  if (!api?.comfyuiStop) return { ok: false, message: '只有桌面版能停止本机 ComfyUI。' };
  try {
    return await api.comfyuiStop();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '停止失败。' };
  }
}

/** 订阅启动状态变化。返回取消订阅的函数（web 版回一个空操作）。 */
export function onComfyuiState(listener: (status: ComfyuiStatus) => void): () => void {
  const api = desktopApi();
  if (!api?.onComfyuiState) return () => { /* 没有通道，什么都不用做 */ };
  return api.onComfyuiState(listener);
}

/** 一个**正在跑着**的 ComfyUI 实例。与 preload 那边的同名类型保持一致。 */
export type ComfyuiProcessHit = {
  pid: number;
  port: number | null;
  dir: string | null;
  commandLine: string;
};

/** 一处 ComfyUI 安装。与 preload 那边的同名类型保持一致。 */
export type ComfyuiInstallHit = {
  dir: string;
  name: string;
  hasMain: boolean;
  hasModels: boolean;
  hasCustomNodes: boolean;
  hasPython: boolean;
};

/**
 * 找本机**正在跑**的 ComfyUI（端口从进程命令行里认，比扫固定端口准）。
 *
 * 返回空数组是「没跑着」，不是失败 —— 调用方不该把它当错误处理，
 * 该显示的是「没检测到正在运行的 ComfyUI，可以点下面的启动」。
 */
export async function comfyuiDetectProcesses(): Promise<ComfyuiProcessHit[]> {
  const api = desktopApi();
  if (!api?.comfyuiDetectProcesses) return [];
  try {
    const result = await api.comfyuiDetectProcesses();
    return Array.isArray(result?.processes) ? result.processes : [];
  } catch {
    return [];
  }
}

/** 扫本机找 ComfyUI 装在哪。**只读**，最多 8 秒（主进程那边分帧跑，不卡窗口）。 */
export async function comfyuiFindInstalls(): Promise<ComfyuiInstallHit[]> {
  const api = desktopApi();
  if (!api?.comfyuiFindInstalls) return [];
  try {
    const result = await api.comfyuiFindInstalls();
    return Array.isArray(result?.installs) ? result.installs : [];
  } catch {
    return [];
  }
}

/** 界面要不要显示「自动找安装目录」这个按钮（web 版没有主进程，扫不了）。 */
export function canDetectComfyui(): boolean {
  return Boolean(desktopApi()?.comfyuiFindInstalls);
}

/** 一份随包 ComfyUI 扩展的状态。与 preload 那边的同名类型保持一致。 */
export type ComfyuiExtensionView = {
  id: string;
  name: string;
  purpose: string;
  bundledVersion: string | null;
  installedVersion: string | null;
  status: 'unavailable' | 'missing' | 'up-to-date' | 'needs-repair' | 'update-available';
  installable: boolean;
  message?: string;
};

/**
 * 查随包的那两个扩展在目标 ComfyUI 里装没装。**只读**，不写任何东西。
 *
 * `dir` 传空时由主进程回去读库；界面上已经有那个值了，传过去能省一次后端往返，
 * 也让「刚存完目录立刻查」这一步不会因为后端慢半拍而查到旧路径。
 */
export async function comfyuiExtensions(dir?: string): Promise<ComfyuiExtensionView[]> {
  const api = desktopApi();
  if (!api?.comfyuiExtensions) return [];
  try {
    const result = await api.comfyuiExtensions(dir ? { dir } : {});
    return Array.isArray(result?.extensions) ? result.extensions : [];
  } catch {
    return [];
  }
}

/** 一份「上一版 Holy Light画布装的扩展」的状态。与 preload 那边的同名类型保持一致。 */
export type ComfyuiLegacyExtensionView = {
  id: string;
  targetDir: string;
  exists: boolean;
};

/**
 * 查上一版 Holy Light画布自己装的 `frame_*` 还在不在。**只读**。
 *
 * 它们和新扩展（`fisherai_node_ids`）的编号徽标画在同一坐标，两个都在就是一团糊字，
 * 所以查出来不是为了「清理垃圾」，是为了让用户能看清节点编号。
 */
export async function comfyuiLegacyExtensions(dir?: string): Promise<ComfyuiLegacyExtensionView[]> {
  const api = desktopApi();
  if (!api?.comfyuiLegacyExtensions) return [];
  try {
    const result = await api.comfyuiLegacyExtensions(dir ? { dir } : {});
    return Array.isArray(result?.legacy) ? result.legacy : [];
  } catch {
    return [];
  }
}

/**
 * 移除一个上一版装的 `frame_*`。**会删目录**，所以只认主进程写死的那两个 id，
 * 且要求目录里的 manifest 确实写着同一个 id —— 名字撞车但不是我们装的，主进程会拒绝。
 */
export async function comfyuiRemoveLegacyExtension(id: string, dir?: string): Promise<{ ok: boolean; message: string; legacy: ComfyuiLegacyExtensionView[] }> {
  const api = desktopApi();
  if (!api?.comfyuiRemoveLegacyExtension) return { ok: false, message: '只有桌面版能移除旧版扩展。', legacy: [] };
  try {
    const result = await api.comfyuiRemoveLegacyExtension(dir ? { id, dir } : { id });
    return {
      ok: Boolean(result?.ok),
      message: String(result?.message || ''),
      legacy: Array.isArray(result?.legacy) ? result.legacy : [],
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '移除失败。', legacy: [] };
  }
}

/**
 * 装一个扩展。**这是这一组里唯一会写文件的操作。**
 *
 * 返回的是**装完之后重新检测的整份列表**，界面不用再查一次 ——
 * 而且那份列表是主进程回读磁盘得到的：写盘的谎话比读取的多，只有回读过的状态才算数。
 */
export async function comfyuiInstallExtension(id: string, dir?: string): Promise<{ ok: boolean; message: string; extensions: ComfyuiExtensionView[] }> {
  const api = desktopApi();
  if (!api?.comfyuiInstallExtension) return { ok: false, message: '只有桌面版能安装 ComfyUI 扩展。', extensions: [] };
  try {
    const result = await api.comfyuiInstallExtension(dir ? { id, dir } : { id });
    return {
      ok: Boolean(result?.ok),
      message: String(result?.message || ''),
      extensions: Array.isArray(result?.extensions) ? result.extensions : [],
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '安装失败。', extensions: [] };
  }
}

/** 界面要不要显示「ComfyUI 扩展」这一块（web 版没有主进程，读不到随包的扩展）。 */
export function canManageComfyuiExtensions(): boolean {
  return Boolean(desktopApi()?.comfyuiExtensions);
}

/**
 * 窗口要开新窗口时问一下「该不该开」—— 桌面版的唯一答案是不能。
 *
 * ⚠️ 这条门卫必须挂上，**不能省**。桌面版是单窗口的 hash 路由（`app://app/index.html#/...`），
 * 而页面里的 `target="_blank"` 会把路径形式的链接解析成 `app://app/settings/xxx`：
 * 那个地址在协议处理器那边找不到文件、只能回兜底的 index.html —— 一个**没有 hash 的 SPA 外壳**。
 * 用户看到的是标题栏写着「Holy Light画布 — AI 创作空间」的纯白窗口，一句报错都没有
 * （2026-09-19 用户报的「打开工作流配置后怎么是空的？」就是它）。
 *
 * 所以这里在**打开之前**就返回 null：调用方会把 `target="_blank"` 当成普通链接，
 * 走应用内的 hash 路由（`navigate()`）—— 同一窗口、同一份状态，也是用户真正想要的结果。
 *
 * web 版没有这段预加载脚本，`canOpenNewWindow()` 回 false，行为与以前完全一致。
 */
export function canOpenNewWindow(): boolean {
  return Boolean(desktopApi()?.canOpenWindow);
}
