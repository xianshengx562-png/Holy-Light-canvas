// electron.vite.config.ts
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { builtinModules } from "node:module";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
var __electron_vite_injected_dirname = "E:\\codex\u7F51\u7AD9\u5F00\u53D1\\\u672C\u5730\\studio";
var root = __electron_vite_injected_dirname;
var SHIM = resolve(root, "electron/shims");
var EXT = [".ts", ".tsx", ".css", ".js", ".jsx", ".json"];
function resolveAt() {
  return {
    name: "frame-resolve-at",
    resolveId(source) {
      if (!source.startsWith("@/")) return null;
      const rel = source.slice(2);
      for (const dir of [resolve(root, "src"), root]) {
        const base = resolve(dir, rel);
        if (existsSync(base) && statSync(base).isFile()) return base;
        for (const ext of EXT) {
          if (existsSync(base + ext)) return base + ext;
        }
        for (const index of ["index.ts", "index.tsx"]) {
          if (existsSync(resolve(base, index))) return resolve(base, index);
        }
      }
      return null;
    }
  };
}
var electron_vite_config_default = defineConfig({
  main: {
    resolve: {
      alias: {
        "@": root,
        "server-only": resolve(SHIM, "server-only.ts"),
        "next/server": resolve(SHIM, "next-server.ts"),
        "next/headers": resolve(SHIM, "next-headers.ts"),
        "next/navigation": resolve(SHIM, "next-navigation.ts"),
        "@prisma/client": resolve(SHIM, "prisma-client.ts")
      }
    },
    /*
     * `lib/edition.ts` 读 `NEXT_PUBLIC_HOLYLIGHT_EDITION`，桌面版必须是 `desktop`：
     * 它决定了「哪些页面存在、哪些接口放行、走本机 ComfyUI 还是云端」。
     * 原版靠 Next 在构建期内联，这里用 Vite 的 define 达到同样效果。
     */
    define: {
      "process.env.NEXT_PUBLIC_HOLYLIGHT_EDITION": JSON.stringify("desktop")
    },
    build: {
      outDir: resolve(root, "out/main"),
      rollupOptions: {
        /*
         * 两个入口，同一份产物目录：
         * `index`   —— 主进程（窗口 + 协议转发）
         * `backend` —— 后端进程（48 个路由 + 数据层），由主进程用 utilityProcess fork 起来，
         *              所以要和主进程产物放在一起，asar 里也一并打包。
         */
        input: {
          index: resolve(root, "electron/main/index.ts"),
          backend: resolve(root, "electron/backend/index.ts")
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
        external: ["electron", "electron-updater", "node:sqlite", ...builtinModules.flatMap((m) => [m, `node:${m}`])]
      }
    }
  },
  preload: {
    resolve: { alias: { "@": root } },
    build: {
      outDir: resolve(root, "out/preload"),
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
          index: resolve(root, "electron/preload/index.ts"),
          browser: resolve(root, "electron/preload/browser.ts")
        },
        external: ["electron"]
      }
    }
  },
  renderer: {
    root: resolve(root, "src"),
    resolve: {
      alias: {
        "server-only": resolve(SHIM, "server-only.ts"),
        "next/link": resolve(root, "src/shims/next-link.tsx"),
        "next/navigation": resolve(root, "src/shims/next-navigation.ts"),
        "next/image": resolve(root, "src/shims/next-image.tsx")
      }
    },
    plugins: [resolveAt(), react(), tailwindcss()],
    /*
     * 开发态的 `/api/*`：渲染进程是从 Vite 的 dev server 加载的，同源相对请求会打回 Vite，
     * 而 Vite 代理不了命名管道 —— 所以让后端在开发态改成监听 127.0.0.1:5174，这里转过去。
     * 打包后完全走管道，这条配置不会被用到。
     */
    server: {
      proxy: {
        "/api": { target: "http://127.0.0.1:5174", changeOrigin: false }
      }
    },
    define: {
      "process.env.NEXT_PUBLIC_HOLYLIGHT_EDITION": JSON.stringify("desktop")
    },
    build: {
      outDir: resolve(root, "out/renderer"),
      rollupOptions: {
        input: { index: resolve(root, "src/index.html") }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
