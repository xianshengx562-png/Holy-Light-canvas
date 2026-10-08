import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import {
  INITIAL_UPDATE_STATE,
  normalizeSource,
  percentOf,
  reduce,
  shouldInstallOnQuit,
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
 * 1. **更新源有默认值、界面上不再出现**（2026-10-01 改）。原来要用户自己填一次才能检查更新，
 *    「开箱即用」是做不到的。现在默认走 `DEFAULT_UPDATE_SOURCE`，
 *    「设置 · 版本与更新」里那张「更新源」卡也收掉了 —— 普通用户根本不该操心这件事。
 *    但仍然**不是写死**：`update-source.json` 优先级更高，换服务器改那一个文件就够了。
 *
 * 2. **后台自动下载，但绝不自动装**（2026-09-29 改：原先连下载都要手动点）。
 *    安装包 120MB，每次都要用户在「发现有新版」之后再点一次「下载」是没必要的操作；
 *    但**装**那一下必须等人 —— 它会退掉进程，正在跑的生成任务会凭空消失。
 *    所以：发现新版就自己在后台下完，下完静静等着，等用户自己关软件时才顺手装上
 *    （`installDownloadedOnQuit()`）。
 *
 * 3. **便携版直接说不支持**。便携版是解压即用的，它没有一个「安装位置」可以覆盖，
 *    真去 `quitAndInstall` 会把人装在 U 盘里的那份搞坏。宁可显示「请重新下载安装包」。
 */

const SOURCE_FILE = 'update-source.json';

/**
 * 默认更新源（2026-10-01 徐先：「更新源默认，并且隐藏选项卡」）。
 *
 * 和 `package.json` 里 `build.publish` 那个地址保持一致 —— 那边是 electron-builder 出包时
 * 写进 `app-update.yml` 的，这边是**运行时**问的地址，两个必须是同一个目录。
 *
 * ⚠️ **有默认值 ≠ 写死**：数据目录里的 `update-source.json` 优先级更高。
 * 换服务器时只要把新地址写进那个文件，已经装在别人机器上的旧包就还能收到新版 ——
 * 这正是「更新源可改」这件事真正的价值，界面入口收掉了，文件这条路必须留着。
 */
export const DEFAULT_UPDATE_SOURCE = 'https://github.com/xianshengx562-png/Holy-Light-canvas/releases/latest/download/';

/*
 * 🔴 默认源**不走 generic**（2026-10-08 修：徐先「检测更新好像有点问题」）。
 *
 *   `github.com/<owner>/<repo>/releases/latest/download/` 是 GitHub 的**网页**下载路径，
 *   在很多网络下（本机实测）会一直连到 21 秒超时，界面上就是「正在检查更新…」转半天，
 *   最后甩一句 `net::ERR_CONNECTION_TIMED_OUT`。而**同一台机器上 `api.github.com` 是通的**
 *   （0.6 秒回）。所以默认源改走 electron-updater 的 `github` provider ——
 *   它问的正是 `api.github.com`；generic 那条路留给 `update-source.json` 里填的自定义源。
 *
 *   ⚠️ 两个 provider 读的都是 release 里的 `latest.yml`，产物不用重新出。
 *   ⚠️ 别把这段简写成"直接把 url 换成 api.github.com"：api 不提供 `latest.yml` 这种
 *      静态文件路径，generic 拼 `url + 'latest.yml'` 出来的地址必然 404。
 */
const GITHUB_OWNER = 'xianshengx562-png';
const GITHUB_REPO = 'Holy-Light-canvas';

/** 一次检查最多等这么久。超时就报错、把按钮放出来 —— 宁可让用户重试，也别一直转圈。 */
const CHECK_TIMEOUT_MS = 20000;

/**
 * 这个地址是不是「本项目在 GitHub 上的 releases」。
 *
 * ⚠️ 判形态不判字符串相等：`update-source.json` 里是同一串地址时两者才相等，
 *    写成不带尾斜杠、带 `www.`、或大小写不一样就悄悄走回 generic ——
 *    而 generic 正是那条连不通的路。认形态就能都接住。
 */
const GITHUB_FEED_RE = new RegExp(
  '^https?://(?:www\\.)?github\\.com/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/releases',
  'i',
);

/** 按当前更新源挑 provider：本项目在 GitHub 上的那份走 API，其余照旧走 generic。 */
function feedFor(source: string):
  | { provider: 'github'; owner: string; repo: string }
  | { provider: 'generic'; url: string } {
  if (GITHUB_FEED_RE.test(source)) {
    return { provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO };
  }
  return { provider: 'generic', url: source };
}

/**
 * 给「问一次有没有新版」套一个超时。
 *
 * ⚠️ electron-updater **没有**超时选项 —— 源不可达时它就这么挂着，
 *    界面上一路是「正在检查更新…」，三个按钮全是灰的，看着像死了。
 *    这里不是要"取消"那次请求（挂起的 promise 取消不掉），而是**先给用户一句人话**；
 *    真要是慢但能通，迟到的事件照样会盖掉这条错误（`available` / `not-available` 都行）。
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /* 🔴 迟到的 rejection 得自己吞掉：超时之后没人再接这个 promise，
     主进程里会冒一条 unhandled rejection 日志 —— 看着像又崩了一次。 */
  work.catch(() => {});
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ETIMEDOUT')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    const saved = normalizeSource(String(JSON.parse(raw)?.url || ''));
    /* 存了空串或非法地址（以前界面允许清空）也回落到默认 —— 不然就永远 unconfigured。 */
    return saved || DEFAULT_UPDATE_SOURCE;
  } catch {
    /* 文件不存在 / 内容坏了 —— 都用默认值，不再让界面催人去填。 */
    return DEFAULT_UPDATE_SOURCE;
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
  /* 🔴 `net::ERR_CONNECTION_TIMED_OUT` 是 Chromium 自己的错误码（2026-10-08 加）：
     源不可达时 electron-updater 甩出来的就是它，原样显示等于没说。 */
  if (/ETIMEDOUT|ERR_CONNECTION_TIMED_OUT|TIMED_OUT|timeout/i.test(message)) {
    return '连不上更新源（等了太久，连接超时）。检查网络，或者过一会儿再试。';
  }
  if (/403|429|rate limit/i.test(message)) {
    return '更新源这会儿不接受查询（同一网络短时间内问太多次会被限流），过一会儿再试。';
  }
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

  /*
   * 后台下载（2026-09-29 起）：发现新版就自己下，不再等用户点「下载更新」。
   * 但**不自动装** —— 装的那一下会退掉进程，正在跑的生成任务会凭空消失。
   */
  autoUpdater.autoDownload = true;
  /*
   * 退出时装这件事**我们自己接**（`before-quit` 里），不靠这一条：
   * 我们的退出要先让后端 flush、收干净子进程，最后走的是 `app.exit(0)`，
   * 到那一刻 electron-updater 自己的钩子已经不跑了。
   */
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
  /* 传空 = 恢复默认。界面已经没有入口了，这条留给以后 / 手动改文件的场景。 */
  const normalized = normalizeSource(url) || DEFAULT_UPDATE_SOURCE;
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
    autoUpdater.setFeedURL(feedFor(state.source));
    await withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS);
  } catch (error) {
    /* 🔴 迟到的超时不算数：electron-updater 的结果常常是**事件**先给的
       （`available` / `not-available` / `error`），而那个 promise 还挂在那儿没落地。
       这时候再甩一句「连接超时」，会把已经出来的正确结果盖掉 ——
       「明明刚说已经是最新版，一转眼又变成连不上」。所以只在**确实还没有结果**时才报。 */
    if (updaterState().phase === 'checking') emit({ kind: 'error', message: errorText(error) });
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
      autoUpdater.setFeedURL(feedFor(state.source));
      await withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS);
      /* ⚠️ 重新读一次（`updaterState()`），不要用上面那个 `phase`：
         它在这句之前是 'error'，而 `checkForUpdates()` 已经把状态推成别的了。 */
      if (updaterState().phase !== 'available') return state;
    }
    await autoUpdater.downloadUpdate();
  } catch (error) {
    /* 同上：状态已经被推走（多半是 'available'）时，别拿一句超时盖掉它。 */
    if (updaterState().phase === 'downloading' || updaterState().phase === 'checking') {
      emit({ kind: 'error', message: errorText(error) });
    }
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

/**
 * 退出时把下好的更新装上（2026-09-29）。
 *
 * 时机由 `index.ts` 的 `before-quit` 定在**后端已经 flush 完、子进程都收干净之后** ——
 * 那时退出最安全；早一点会打断正在跑的生成任务。
 *
 * 装完**不再自动拉起来**：用户是自己关掉软件的，装完又悄悄弹一个窗口回来很吓人，
 * 下次他打开就是新版了。
 *
 * @returns 装了没有。调用方据此决定还要不要自己 `app.exit(0)` —— 这一装进程就没了。
 */
export function installDownloadedOnQuit(): boolean {
  if (!shouldInstallOnQuit(state)) return false;
  try {
    /* `isSilent = true`：不弹安装界面。`isForceRunAfter = false`：装完不自动启动。 */
    autoUpdater.quitAndInstall(true, false);
    return true;
  } catch (error) {
    emit({ kind: 'error', message: errorText(error) });
    return false;
  }
}
