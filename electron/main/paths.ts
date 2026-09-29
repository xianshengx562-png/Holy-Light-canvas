/*
 * ⚠️ 这个文件**必须最早被 import**，它的作用只有一个：在任何人去算落盘目录之前，
 * 先把 `HOLYLIGHT_DATA_DIR` / `HOLYLIGHT_LOCAL_STORAGE` 设好。
 *
 * 为什么非要抢这个先后：有的 `lib/*` 模块**在模块加载的那一刻**就算好了自己的
 * 根目录（形如 `const rootDir = path.join(storageRoot(), '…')`），而 ESM 是先跑完所有 import、
 * 最后才轮到入口文件的函数体 —— 也就是说，写在 `app.whenReady()` 里那句赋值（原来唯一的一句）
 * **永远晚一步**。
 *
 * （`lib/media.ts` 与 `lib/latents.ts` 现在**不再**在加载时算根目录了：桌面版允许用户自选产出
 * 目录，那两个走 `lib/output-dir.ts` 在**运行时**取。但它们最终仍是「配置文件没写 → 回落到
 * `storageRoot()`」，所以这条 import 顺序对它们依然是必需的。）
 *
 * 后果不是「路径有点怪」，是**生成的图会落到进程的当前工作目录里**：
 * 从脚本启动就落在脚本的 cwd，安装到 Program Files 之后那里**不可写**，
 * `archiveUploadedImage` 会静默返回 null —— 表现为「资产库里没有图」，而且不报错。
 *
 * 修复套路：把赋值挪到一个模块体里，再让 index.ts 的第一个 import 指向它。
 * 依赖按 import 声明顺序求值，这一句就跑在 `lib/media.ts` 那些 `const rootDir` 之前了。
 *
 * 现在统一走 `lib/runtime-paths.ts`：程序目录（`app/`）与数据目录（`data/`）分开算，
 * 一次 `configureRuntimePaths()` 把整组路径写进环境变量，后面谁先谁后都一样。
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { configureRuntimePaths } from '@/lib/runtime-paths';

try {
  /* `app.getPath` 在 ready 之前能不能用由 Electron 决定，这里一律只画一条警告、不让它炸。 */
  const appDir = app.getAppPath();
  const userData = app.getPath('userData');
  /*
   * 便携布局：与 `app/` 同级放一个 `data/`，并且里面有个 `portable.json` 做标记。
   * 有标记才认 —— 否则随便一个同名目录就会把用户数据带走，那是灾难。
   * （`app/` 是 `resources/app.asar`，所以数据目录在 `resources` 的**上一级**。）
   */
  const portableRoot = path.join(appDir, '..', '..', 'data');
  const portable = !process.env.HOLYLIGHT_DATA_DIR && fs.existsSync(path.join(portableRoot, 'portable.json'));
  configureRuntimePaths({
    appDir,
    dataDir: process.env.HOLYLIGHT_DATA_DIR || (portable ? portableRoot : userData),
    /*
     * 随包资源（llama.cpp / ffmpeg）在 `process.resourcesPath` 下 —— 也就是 `app.asar` 的上一级。
     * 后端进程是纯 Node（拿不到 electron 的 API），只能靠这里算好、塞进环境变量带过去。
     */
    resourcesDir: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? null,
  });
} catch {
  /* 留空：交给 index.ts 里 whenReady 那句补上，顶多落盘晚一点点（媒体写入都发生在用户操作之后）。 */
}

export const storageRootHint = process.env.HOLYLIGHT_LOCAL_STORAGE ?? null;
