import path from 'node:path';

/**
 * 运行时路径 —— **数据布局的唯一权威**。
 *
 * 桌面版把「程序」和「数据」分开：程序在 `app/`（安装目录，可能是只读的），
 * 数据在 `data/`（默认 `userData`，便携布局下是程序目录旁边的 `data/`）。
 * 这么分是为了：整个 `data/` 可以被复制走、搬到别的盘、或者指到一个备份目录，
 * 而不用去猜「我的项目到底存在哪」。
 *
 * 三条不能破的规矩：
 *
 * 1. **这个文件不许 `import 'electron'`。**
 *    后端进程（utilityProcess）是纯 Node 环境，拿不到 `app.getPath`；
 *    它靠主进程把算好的路径塞进环境变量来引导。所以这里只认环境变量 + 兜底。
 * 2. **默认布局下的子目录名不能改。**
 *    `data/`（库）、`storage/`（媒体）、`config/`（配置）都是老版本就在用的名字，
 *    改了等于让老用户的东西凭空消失。新增的只有 `logs/` 与 `run/`。
 * 3. **没显式配置时，行为必须和改动前完全一致。**
 *    也就是 `DATA_DIR = userData`，库在 `userData/data`、媒体在 `userData/storage`。
 */

export type RuntimePaths = {
  /** 程序目录。打包后是 `resources/app.asar` 这一层的上级，只读也无所谓。 */
  appDir: string;
  /** 数据根。默认布局 = `userData`；便携布局 = `<app>/data`。 */
  dataDir: string;
  /** 是不是「数据目录被显式指定过」（便携 / 用户自己挑的）。 */
  portable: boolean;
  /** 库（JSON 或 SQLite 落盘的地方）。保持老名字 `data`。 */
  dbDir: string;
  /** 媒体与素材。保持老名字 `storage` —— `HOLYLIGHT_LOCAL_STORAGE` 指的就是它。 */
  storageDir: string;
  /** 日志。后端进程的 stdout/stderr 与生命周期事件都落这里。 */
  logsDir: string;
  /** 运行时（管道名、实例标记这类一次性的东西）。 */
  runDir: string;
  /** 随包分发的原生资源（llama.cpp、ffmpeg）。打包后就是 `<安装目录>/resources`。 */
  resourcesDir: string;
  /** 配置（`.env`、输出目录配置）。 */
  configDir: string;
  envPath: string;
};

const ENV_KEYS = {
  appDir: 'HOLYLIGHT_APP_DIR',
  dataDir: 'HOLYLIGHT_DATA_DIR',
  storageDir: 'HOLYLIGHT_LOCAL_STORAGE',
  logsDir: 'HOLYLIGHT_LOGS_DIR',
  resourcesDir: 'HOLYLIGHT_RESOURCES_DIR',
} as const;

function pick(value: string | undefined | null, fallback?: string | null): string | null {
  const trimmed = String(value ?? '').trim();
  if (trimmed) return path.resolve(trimmed);
  const fb = String(fallback ?? '').trim();
  return fb ? path.resolve(fb) : null;
}

/**
 * 程序目录兜底：`lib/runtime-paths.ts` 在 `<根>/lib/` 下，所以根的上一级就是根。
 * 打包后这个文件被 bundle 进 `out/main/*.js`，那时候主进程一定已经把环境变量设好了，
 * 这里只是「万一没人引导」时的最后一道闸，绝不能让它把数据落到安装目录里。
 */
function defaultAppDir(): string {
  return path.resolve(__dirname, '..', '..');
}

/**
 * 随包资源目录的兜底。
 *
 * 打包后 `appDir` 是 `<安装目录>/resources/app.asar` —— 资源在它的**上一级**；
 * 开发态（直接 `next dev`，没有 electron）`appDir` 就是工程根，资源在 `<工程根>/resources/`。
 * 这两个位置拼出来刚好都叫 `resources`，所以 `lib/video-ffmpeg.ts` 那边只拼一次子目录名就行。
 */
function defaultResourcesDir(appDir: string): string {
  return appDir.includes('.asar') ? path.dirname(appDir) : path.join(appDir, 'resources');
}

export function resolveRuntimePaths(init: { appDir?: string | null; dataDir?: string | null; storageDir?: string | null; logsDir?: string | null; resourcesDir?: string | null } = {}): RuntimePaths {
  const appDir = pick(init.appDir, process.env[ENV_KEYS.appDir]) ?? defaultAppDir();
  const configuredDataDir = pick(init.dataDir, process.env[ENV_KEYS.dataDir]);
  const portable = Boolean(configuredDataDir);
  const dataDir = configuredDataDir ?? path.join(appDir, 'data');
  const storageDir = pick(init.storageDir, process.env[ENV_KEYS.storageDir]) ?? path.join(dataDir, 'storage');
  const logsDir = pick(init.logsDir, process.env[ENV_KEYS.logsDir]) ?? path.join(dataDir, 'logs');
  const resourcesDir = pick(init.resourcesDir, process.env[ENV_KEYS.resourcesDir]) ?? defaultResourcesDir(appDir);
  return {
    appDir,
    dataDir,
    portable,
    resourcesDir,
    dbDir: path.join(dataDir, 'data'),
    storageDir,
    logsDir,
    runDir: path.join(dataDir, 'run'),
    configDir: path.join(dataDir, 'config'),
    envPath: path.join(dataDir, 'config', '.env'),
  };
}

let current: RuntimePaths | null = null;

/**
 * 一次性定好路径并写进环境变量。
 *
 * 写环境变量这一手是给**别的模块**看的：`lib/storage-root.ts`、`lib/db/store.ts`
 * 这类模块有的一加载就算自己的根目录，靠 `import` 顺序抢先后太脆；
 * 统一走环境变量，谁先谁后都一样。
 *
 * 主进程（`electron/main/paths.ts`）与后端入口都必须**最先**调它一次。
 */
export function configureRuntimePaths(init: Parameters<typeof resolveRuntimePaths>[0] = {}): RuntimePaths {
  current = resolveRuntimePaths(init);
  process.env[ENV_KEYS.appDir] = current.appDir;
  process.env[ENV_KEYS.dataDir] = current.dataDir;
  process.env[ENV_KEYS.storageDir] = current.storageDir;
  process.env[ENV_KEYS.logsDir] = current.logsDir;
  process.env[ENV_KEYS.resourcesDir] = current.resourcesDir;
  return current;
}

/** 读路径。没配置过就按当前环境变量现算一次（不会写环境变量）。 */
export function runtimePaths(): RuntimePaths {
  return current ?? resolveRuntimePaths();
}

/** 把当前布局原样导出成环境变量 —— fork 后端进程时直接塞给子进程。 */
export function runtimePathEnv(): Record<string, string> {
  const p = runtimePaths();
  return {
    [ENV_KEYS.appDir]: p.appDir,
    [ENV_KEYS.dataDir]: p.dataDir,
    [ENV_KEYS.storageDir]: p.storageDir,
    [ENV_KEYS.logsDir]: p.logsDir,
    [ENV_KEYS.resourcesDir]: p.resourcesDir,
  };
}
