import os from 'node:os';
import path from 'node:path';
import { configureRuntimePaths } from '@/lib/runtime-paths';
import { setDataDir } from '@/lib/db';
import { APP_ORIGIN } from '@/lib/app-origin';

/*
 * ⚠️ 这个模块必须是 index.ts 的**第一个** import，而且它的副作用写在模块体里。
 *
 * 原因和 `electron/main/paths.ts` 那条注释一模一样：有的 `lib/*` 模块
 * **在被 import 的那一刻**就算好了自己的落盘目录，而 ESM 是先跑完所有 import、最后才轮到
 * 入口文件的函数体 —— 写在 `main()` 里的那句赋值永远晚一步，后果是图片落到进程的 cwd 里。
 * 依赖声明顺序就是求值顺序，所以谁要先跑，谁就得排在第一行。
 *
 * 与 electron 版唯一的差别是**没有 `app.getPath('userData')` 可以问**：MCP 是被 Codex 拉起来的
 * 独立进程，不在 Electron 里，只能自己算出那个目录（见下面 `defaultDataDir`）。
 */

/** 打包时由 esbuild 内联的工程根目录（`tools/frame-mcp` 的上两级）。 */
declare const __HOLYLIGHT_ROOT__: string;

/**
 * 程序目录。
 *
 * **`__HOLYLIGHT_ROOT__` 只在构建机上真实存在** —— bundle 一旦被拷到别人机器上，它就成了一个
 * 指向别人磁盘上不存在的路径。而 `appDir` 只是个兜底的程序目录（**与画布无关**：它原先是给
 * 本机的 llama.cpp 找运行时用的，那套 2026-09-20 随「小说转剧本」一起去掉了），
 * 所以这里退一步：构建期的根存在就用它，不存在就用 bundle 自己所在的目录。
 *
 * ⚠️ 真正决定数据在哪的始终是下面的 `dataDir`，`appDir` 兜成什么样都不会动到用户的库。
 */
function appRoot(): string {
  try {
    if (__HOLYLIGHT_ROOT__ && require('node:fs').existsSync(path.join(__HOLYLIGHT_ROOT__, 'package.json'))) {
      return __HOLYLIGHT_ROOT__;
    }
  } catch {
    /* 打不到文件系统就走兜底 */
  }
  return __dirname;
}

/**
 * Electron 的默认数据目录。
 *
 * Electron 的 `app.getPath('userData')` 在没设 `name` 时就是 `<APPDATA>/<package.json 的 name>`，
 * 而 Holy Light画布的 `package.json` 里写的是 `holy-light-canvas` —— 和 `%APPDATA%\holy-light-canvas` 对得上。
 * ⚠️ 改 `package.json` 的 name 就等于在这里换一个全新目录、所有用户数据「凭空消失」，所以那一栏不能动。
 */
function defaultDataDir(): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'holy-light-canvas');
}

/**
 * 数据目录：环境变量优先。
 *
 * 留给 config.toml 的 `[mcp_servers.frame.env]` 去覆盖 —— 便携布局、或者把数据放在别的盘的时候，
 * 只有这一条环境变量要改，MCP 与 Electron 两侧靠 `configureRuntimePaths()` 收敛成同一套布局。
 */
const dataDir = String(process.env.HOLYLIGHT_DATA_DIR || '').trim() || defaultDataDir();

/*
 * 另外两个必须在任何路由模块加载之前钉死的：
 * - `HOLYLIGHT_DATA_DIR`  数据根目录（写进环境变量后，谁先算谁后算都拿到同一份答案）；
 * - `APP_URL`         `lib/api.ts` 的 `checkOrigin()` 比的就是它的 origin，
 *                     不设的话用户 `.env` 里那个值会让所有写接口一律 403（且症状只是「点了没反应」）。
 *
 * `NEXT_PUBLIC_HOLYLIGHT_EDITION` **不在这里赋值**：它是构建期常量（build.mjs 的 define），
 * 再写一句 `process.env.X = ...` 会被 esbuild 当成「给一个常量赋值」并在产物里生成 `"desktop" = ...`。
 */
process.env.HOLYLIGHT_DATA_DIR = dataDir;
process.env.HOLYLIGHT_BACKEND_ORIGIN = APP_ORIGIN;
process.env.APP_URL = APP_ORIGIN;

export const paths = configureRuntimePaths({ appDir: appRoot(), dataDir });

/** 别的模块一律从这里取路径，别各算一遍 —— 两处各自 resolve 是这类 bug 最常见的来源。 */
setDataDir(paths.dbDir);

export const dbDir = paths.dbDir;
export const logsDir = paths.logsDir;
export const dataRoot = paths.dataDir;
