import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import {
  INITIAL_UPDATE_STATE,
  normalizeSource,
  percentOf,
  reduce,
  type UpdateEvent,
  type UpdateState,
} from '@/lib/update-state';

/**
 * 软件内更新（2026-09-29）。
 *
 * 徐先的问题：「如果已经到 2.0 了，用户才 1.0，用户怎么在软件内实现更新的效果。」
 * 做法是 `electron-updater`：它读更新源上的 `latest.yml`（一个几十字节的文本，
 * 写着最新版本号 + 安装包文件名 + sha512 + 体积），比自己这一份新就下载安装包、
 * 校验、再交给 NSIS 装上。用户那头只是「发现新版 → 点一下 → 重启」。
 *
 * 三条设计取舍：
 *
 * 1. **更新源由用户填，不写死在包里**。写死一个域名的话，换服务器就要重新打包，
 *    而旧版本的用户恰恰是**最需要**能换源的那一批（他们的包里写的是那个已经下线的地址）。
 *    所以地址存在数据目录的 `update-source.json` 里，设置页可以改 —— 旧的包也能救回来。
 *    代价是「开箱即用」要等填一次，换来的是「以后永远不用重新打包」。
 *
 * 2. **不自动下载**（`autoDownload = false`）。安装包 120MB，用户在用流量或者正忙着的时候
 *    悄悄下一个大文件是冒犯。自动做的只有「启动后悄悄问一次有没有新版」——
 *    问只是几十字节，问到了再让用户点。
 *
 * 3. **便携版直接说不支持**。便携版是解压即用的，它没有一个「安装位置」可以覆盖，
 *    真去 `quitAndInstall` 会把人装在 U 盘里的那份搞坏。宁可显示「请重新下载安装包」。
 */

const SOURCE_FILE = 'update-source.json';

type Listener = (state: UpdateState) => void;

let state: UpdateState = { ...INITIAL_UPDATE_STATE };
let listeners: Listener[] = [];
let sourcePath = '';
let wired = false;

function emit(event: UpdateEvent): void {
  state = reduce(state, event);
  for (const listener of listeners) listener(state);
}

/**
 * 这一份**能不能**自己升级。
 *
 * 三个条件缺一不可：
 *   - `app.isPackaged`：开发态（`electron-vite dev`）没有 `app-update.yml`，检查必然失败；
 *   - Windows：目前只打 Windows 包，别的平台连安装包长什么样都还没定；
 *   - 非便携版：便携版由 electron 设 `PORTABLE_EXECUTABLE_DIR`，有它就是便携版。
 */
function isSupported(): boolean {
  return app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR;
}

function readSource(): string {
  try {
    const raw = fs.readFileSync(sourcePath, 'utf8');
    return normalizeSource(String(JSON.parse(raw)?.url || ''));
  } catch {
    /* 文件不存在 / 内容坏了 —— 都当成「没配」，界面会让人去填。 */
    return '';
  }
}

function writeSource(url: string): void {
  try {
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, JSON.stringify({ url }, null, 2), 'utf8');
  } catch {
    /* 写不进去只是「下次启动还是旧地址」，不该让整个设置页崩掉。 */
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  /* electron-updater 的原生报错是英文的，直接给用户看等于没说。挑三类常见的翻成中文，
     其余原样保留 —— 诊断时那串原文才是线索。 */
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return '连不上更新源，检查一下地址或网络。';
  if (/ECONNREFUSED/i.test(message)) return '更新源那台机器没响应（地址的端口上没人听），检查地址与服务是不是开着。';
  if (/404|Not Found/i.test(message)) return '更新源上没有 latest.yml，检查地址是不是填对了。';
  if (/certificate|SSL|unable to verify/i.test(message)) return '更新源的 HTTPS 证书有问题，无法确认来源。';
  if (/ERR_UNSAFE_PORT|unsafe port/i.test(message)) return '这个端口被浏览器禁用了，换一个普通端口。';
  if (!message) return '检查更新失败。';
  /* 兜底：认不出来的错**也要带中文** —— 直接把英文原文甩给用户等于没说，
     但原文得留着，它是真要查问题时的唯一线索。 */
  return '检查更新失败：' + message;
}

/** 把 electron-updater 的事件接到状态机上。**只接一次** —— 重复 on 会让每条事件翻两倍。 */
function wire(): void {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => emit({ kind: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    const notes = Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((n) => String(n.note ?? '')).join('\n')
      : typeof info.releaseNotes === 'string' ? info.releaseNotes : '';
    emit({ kind: 'available', version: String(info.version || ''), notes });
  });
  autoUpdater.on('update-not-available', (info) => {
    emit({ kind: 'not-available', version: String(info?.version || '') });
  });
  autoUpdater.on('download-progress', (progress) => {
    emit({ kind: 'progress', percent: percentOf(progress.transferred, progress.total) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    emit({ kind: 'downloaded', version: String(info.version || '') });
  });
  autoUpdater.on('error', (error) => {
    emit({ kind: 'error', message: errorText(error) });
  });
}

/**
 * 初始化。要在 `app.whenReady()` 之后调 —— `app.getVersion()` 那时要能用，
 * 而且数据目录已经建好了。
 */
export function initUpdater(options: { dataDir: string; onState?: Listener }): UpdateState {
  sourcePath = path.join(options.dataDir, SOURCE_FILE);
  if (options.onState) listeners.push(options.onState);
  wire();
  emit({
    kind: 'reset',
    currentVersion: app.getVersion(),
    source: readSource(),
    supported: isSupported(),
  });
  return state;
}

export function updaterState(): UpdateState {
  return state;
}

/** 改更新源。改完立刻回到「待检查」，并且**写盘** —— 下次启动还认它。 */
export function setUpdaterSource(url: string): UpdateState {
  const normalized = normalizeSource(url);
  writeSource(normalized);
  emit({
    kind: 'reset',
    currentVersion: state.currentVersion || app.getVersion(),
    source: normalized,
    supported: isSupported(),
  });
  return state;
}

/**
 * 问一次「有没有新版」。
 *
 * ⚠️ 每次都要 `setFeedURL`：更新源是运行时可改的，而 electron-updater 自己只在启动时
 * 读一次 `app-update.yml`。不重设的话，用户在设置页改了地址之后仍然在问老地址 ——
 * 「我明明改了，怎么还是说连不上」。
 */
export async function checkForUpdate(): Promise<UpdateState> {
  if (state.phase === 'unsupported' || state.phase === 'unconfigured') return state;
  if (state.phase === 'checking' || state.phase === 'downloading') return state;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: state.source });
    await autoUpdater.checkForUpdates();
  } catch (error) {
    emit({ kind: 'error', message: errorText(error) });
  }
  return state;
}

/** 下载。只在已经发现新版之后才有意义（见 `canDownload`）。 */
export async function downloadUpdate(): Promise<UpdateState> {
  /* 先把 phase 取成局部量：下面 `await` 期间事件处理器可能已经改过 `state`，
     一直拿 `state.phase` 去比，比的是一个早就过时的值。 */
  const phase = state.phase;
  if (phase !== 'available' && phase !== 'error') return state;
  try {
    if (phase === 'error') {
      /* 上一步失败过，重新问一次再下 —— 不然 `downloadUpdate()` 会因为
         「electron-updater 自己不记得有可用更新」而静默什么都不做。 */
      autoUpdater.setFeedURL({ provider: 'generic', url: state.source });
      await autoUpdater.checkForUpdates();
      /* ⚠️ 重新读一次（`updaterState()`），不要用上面那个 `phase`：
         它在这句之前是 'error'，而 `checkForUpdates()` 已经把状态推成别的了。 */
      if (updaterState().phase !== 'available') return state;
    }
    await autoUpdater.downloadUpdate();
  } catch (error) {
    emit({ kind: 'error', message: errorText(error) });
  }
  return state;
}

/**
 * 退出并安装。
 *
 * ⚠️ 只有 `downloaded` 才走这一步：没下载完就装，装的是一个半成品。
 * `isForceRunAfter = true` —— 装完自动拉起来，不然用户会以为软件被关掉了。
 */
export function installUpdate(): void {
  if (state.phase !== 'downloaded') return;
  autoUpdater.quitAndInstall(false, true);
}
