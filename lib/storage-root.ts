import path from 'node:path';
import { EDITION } from './edition';

/**
 * 文件落盘的**根目录**——云端版与桌面版必须分开存：
 *
 * - `web`：服务端 `process.cwd()/storage`。服务器上这个目录可写，行为保持不变。
 * - `desktop`：Electron 主进程通过 `HOLYLIGHT_LOCAL_STORAGE` 把 `userData/storage` 喂进来。
 *   打包后 `process.cwd()` 是**只读**的安装目录（`resources/app`），写进去会直接失败，
 *   所以桌面版绝不能走 `process.cwd()/storage`。
 *
 * 开发态（直接 `next dev` / 直接 `node server.js`，没设 `HOLYLIGHT_LOCAL_STORAGE`）回退到
 * `process.cwd()/storage`，方便本地调试，也不会影响云端版（云端版根本不会设这个环境变量）。
 */
export function storageRoot(): string {
  if (EDITION === 'desktop' && process.env.HOLYLIGHT_LOCAL_STORAGE) {
    return process.env.HOLYLIGHT_LOCAL_STORAGE;
  }
  /*
   * 桌面版走到这里说明 `HOLYLIGHT_LOCAL_STORAGE` 还没设 —— 也就是 `electron/main/paths.ts`
   * 没能先跑起来。装着不含糊：**一旦发生就会把文件写进当前工作目录**
   * （安装后那是只读的安装目录），而上层（媒体的归档流程）会把写失败静默吃掉，
   * 表现只是「资产是空的」。所以这里一定要留话。
   */
  if (EDITION === 'desktop') {
    console.warn('[storage] HOLYLIGHT_LOCAL_STORAGE 尚未设置，正在回退到当前工作目录下的 storage/。检查 electron/main/paths.ts 有没有被最先 import。');
  }
  return path.join(process.cwd(), 'storage');
}
