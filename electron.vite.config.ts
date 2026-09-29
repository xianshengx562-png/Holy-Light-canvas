import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Holy Light画布桌面版 —— electron-vite 三件套结构（参考 YUH Studio 的摆放方式）：
 *
 *   electron/main     主进程：窗口 + `app://` 协议；`/api/*` 只做转发，不跑业务。
 *   electron/backend  后端进程：所有原来 Next 的 API 路由（lib/ 原样跑在 Node 里），
 *                     主进程用 utilityProcess fork 它，双方只通过一条 Windows 命名管道说话，
 *                     不占任何 TCP 端口。数据落在 data/（默认 userData）。
 *   electron/preload  只暴露一个 window.api，渲染进程不直接碰 ipcRenderer。
 *   src             纯 React 渲染进程（Vite），原来 app/ 的页面 + components/ 原样搬过来。
 *
 * 两边都把 `@` 指到工程根，所以 `import { x } from '@/lib/...'` 这种写法不用改。
 */
const root = __dirname;

/** 主进程里 `import 'server-only'` 必须变成空模块，否则 node 侧会抛「不能在客户端组件里引入」。 */
const SHIM = resolve(root, 'electron/shims');

const EXT = ['.ts', '.tsx', '.css', '.js', '.jsx', '.json'];

/**
 * 渲染进程的 `@/` 解析：**先 `src/`、再工程根**。
 *
 * 迁移时把 `app/**` 和 `components/**` 都搬进了 `src/`，但它们内部的 import 写的还是
 * `@/components/...`、`@/app/globals.css` —— 一个字都不想改。同时 `@/lib/...` 多数要指向
 * **根** 的 `lib/`（服务端那套，只做 `import type`），少数（`src/lib/client.ts`）是渲染进程独有的。
 * 单一 alias 满足不了「两个目录同名前缀」这种情况，所以这里自己解析。
 *
 * ⚠️ 渲染进程的 alias 里**不能**再写 `'@': root`：Vite 内置的 aliasPlugin 排在所有用户插件之前，
 * 那条 alias 会把 `@/...` 先截走，本插件根本没机会跑。
 */
function resolveAt(): Plugin {
  return {
    name: 'frame-resolve-at',
    resolveId(source) {
      if (!source.startsWith('@/')) return null;
      const rel = source.slice(2);
      for (const dir of [resolve(root, 'src'), root]) {
        const base = resolve(dir, rel);
        /*
         * 先按原样找：`@/app/globals.css`、`@/lib/foo.json` 这种 import 本身带扩展名，
         * 只去拼 `globals.css.css` 是永远命中不了的。
         */
        if (existsSync(base) && statSync(base).isFile()) return base;
        for (const ext of EXT) {
          if (existsSync(base + ext)) return base + ext;
        }
        for (const index of ['index.ts', 'index.tsx']) {
          if (existsSync(resolve(base, index))) return resolve(base, index);
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@': root,
        'server-only': resolve(SHIM, 'server-only.ts'),
        'next/server': resolve(SHIM, 'next-server.ts'),
        'next/headers': resolve(SHIM, 'next-headers.ts'),
        'next/navigation': resolve(SHIM, 'next-navigation.ts'),
        '@prisma/client': resolve(SHIM, 'prisma-client.ts'),
      },
    },
    /*
     * `lib/edition.ts` 读 `NEXT_PUBLIC_HOLYLIGHT_EDITION`，桌面版必须是 `desktop`：
     * 它决定了「哪些页面存在、哪些接口放行、走本机 ComfyUI 还是云端」。
     * 原版靠 Next 在构建期内联，这里用 Vite 的 define 达到同样效果。
     */
    define: {
      'process.env.NEXT_PUBLIC_HOLYLIGHT_EDITION': JSON.stringify('desktop'),
    },
    build: {
      outDir: resolve(root, 'out/main'),
      rollupOptions: {
        /*
         * 两个入口，同一份产物目录：
         * `index`   —— 主进程（窗口 + 协议转发）
         * `backend` —— 后端进程（48 个路由 + 数据层），由主进程用 utilityProcess fork 起来，
         *              所以要和主进程产物放在一起，asar 里也一并打包。
         */
        input: {
          index: resolve(root, 'electron/main/index.ts'),
          backend: resolve(root, 'electron/backend/index.ts'),
        },
        /*
         * `'node:sqlite'` 也要显式列出来：`builtinModules` 取自**跑构建的**那个 Node，
         * 它可能是 22.4 之前的版本（那时 `node:sqlite` 还没进列表）。不列出来的话
         * esbuild 会把它当第三方包去找，然后报「Could not resolve」。
         */
        /*
         * `electron-updater` 也要 external（2026-09-29）：它内部有按环境变量分叉的
         * `require`、还要读自己包里的 `app-update.yml` 逻辑，被 rollup 打进 bundle 之后
         * 那些路径就全变了 —— 症状是「启动不报错，但检查更新永远失败」。
         * 留成运行时 require，electron-builder 会把它从 node_modules 一起装进包里
         * （它在 dependencies 里，本来就会被带上）。
         */
        external: ['electron', 'electron-updater', 'node:sqlite', ...builtinModules.flatMap((m) => [m, `node:${m}`])],
      },
    },
  },
  preload: {
    resolve: { alias: { '@': root } },
    build: {
      outDir: resolve(root, 'out/preload'),
      rollupOptions: {
        /*
         * 两个入口：
         * `index`   —— 应用自己的渲染进程（window.api 那一套）
         * `browser` —— **内置浏览器那个网页视图**的 preload。它只做一件事
         *              （把网页上拖起来的图片报给主进程），必须与主窗口那份分开：
         *              那份往 window 上挂了整个 `api`，而网页是**不可信内容**，
         *              绝不能拿到 `pickFile` / `openFolder` 这类能力。
         *              两个入口共用同一份产物目录，主进程按文件名取。
         */
        input: {
          index: resolve(root, 'electron/preload/index.ts'),
          browser: resolve(root, 'electron/preload/browser.ts'),
        },
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: resolve(root, 'src'),
    resolve: {
      alias: {
        'server-only': resolve(SHIM, 'server-only.ts'),
        'next/link': resolve(root, 'src/shims/next-link.tsx'),
        'next/navigation': resolve(root, 'src/shims/next-navigation.ts'),
        'next/image': resolve(root, 'src/shims/next-image.tsx'),
      },
    },
    plugins: [resolveAt(), react(), tailwindcss()],
    /*
     * 开发态的 `/api/*`：渲染进程是从 Vite 的 dev server 加载的，同源相对请求会打回 Vite，
     * 而 Vite 代理不了命名管道 —— 所以让后端在开发态改成监听 127.0.0.1:5174，这里转过去。
     * 打包后完全走管道，这条配置不会被用到。
     */
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:5174', changeOrigin: false },
      },
    },
    define: {
      'process.env.NEXT_PUBLIC_HOLYLIGHT_EDITION': JSON.stringify('desktop'),
    },
    build: {
      outDir: resolve(root, 'out/renderer'),
      rollupOptions: {
        input: { index: resolve(root, 'src/index.html') },
      },
    },
  },
});
