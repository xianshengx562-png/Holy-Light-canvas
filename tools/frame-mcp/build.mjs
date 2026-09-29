import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { builtinModules } from 'node:module';
import esbuild from 'esbuild';

/*
 * 把 `src/index.ts` 打成一个能直接被 `node` 拉起来的 js。
 *
 * 为什么一定要打包：
 *   1. Codex 只会执行一条 `command + args`，它不会先 npm install，也不会认识 `@/` 这个别名；
 *   2. `lib/**` 是被 electron-vite 源样跑起来的那一套（服务端路由 + 自己的数据层），
 *      里面 `@/lib/...` 的写法、`server-only`、`next/server`、`@prisma/client` 这些重定向规则
 *      都只存在于构建配置里 —— 这些 alias 与 define 在别处必须**复刻同样一份**，少一条就是运行时炸。
 *
 * 所以下面这几项是从 `electron.vite.config.ts` 的 `main` 段照抄的，不是另起炉灶：
 * alias、`server-only` 等 shim、`NEXT_PUBLIC_HOLYLIGHT_EDITION` 的 define、以及 externals。
 */

const root = resolve(import.meta.dirname, '..', '..');
const here = resolve(import.meta.dirname);
const OUT = resolve(here, 'dist', 'frame-mcp.js');
const SHIM = resolve(root, 'electron', 'shims');
const EXT = ['.ts', '.tsx', '.js', '.jsx', '.json'];

/** 先精确命中文件，再按扩展名猜，最后试目录下的 index。命中不到返回 null。 */
function tryFile(base) {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of EXT) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const index of ['index.ts', 'index.js']) {
    const hit = resolve(base, index);
    if (existsSync(hit)) return hit;
  }
  return null;
}

/**
 * `@/` → 工程根（主进程 / 预加载那一套的解析方式），**根里没有再退到 `src/`**。
 *
 * 为什么要多退那一步：`tools.ts` 会从**渲染进程**的文件里 import 业务规则
 * （连线合法性、新节点默认值…），而渲染进程那边的 `@/` 是「先 `src/`、再工程根」
 * （见 `electron.vite.config.ts` 的 renderer 段）。那些文件里写的 `@/lib/director`
 * 只存在于 `src/` 下 —— 只按工程根解析的话，构建直接炸在 `resolve 不到 @/lib/director`。
 *
 * ⚠️ 顺序必须是**先根、后 src**：服务端那批模块（`@/lib/db`、`@/lib/providers/...`）
 *    根下才有，先试根才不会悄悄换到 `src/` 下的同名文件上（两边同名时分叉得悄无声息）。
 */
function resolveAt() {
  return {
    name: 'frame-resolve-at',
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => {
        const rel = args.path.slice(2);
        const hit = tryFile(resolve(root, rel)) || tryFile(resolve(root, 'src', rel));
        if (hit) return { path: hit };
        return { errors: [{ text: `resolve 不到 ${args.path}` }] };
      });
    },
  };
}

const result = await esbuild.build({
  entryPoints: [resolve(here, 'src', 'index.ts')],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'inline',
  /* 关掉压缩：`tools.ts` 里那些报错文案是给模型看的，压成一坨反而难排查。 */
  minify: false,
  plugins: [resolveAt()],
  alias: {
    'server-only': resolve(SHIM, 'server-only.ts'),
    'next/server': resolve(SHIM, 'next-server.ts'),
    'next/headers': resolve(SHIM, 'next-headers.ts'),
    'next/navigation': resolve(SHIM, 'next-navigation.ts'),
    '@prisma/client': resolve(SHIM, 'prisma-client.ts'),
  },
  define: {
    'process.env.NEXT_PUBLIC_HOLYLIGHT_EDITION': JSON.stringify('desktop'),
    __HOLYLIGHT_ROOT__: JSON.stringify(root),
  },
  /*
   * `node:sqlite` 必须显式标成外部依赖：`builtinModules` 取自**跑构建**的那个 Node，
   * 它若是 22.5 以前的版本，列表里就没有这一项，esbuild 会把它当第三方包去找然后报找不到。
   * 其余内置模块同理 —— 它们本就该由运行时提供，不该被打进产物。
   */
  external: ['node:sqlite', ...builtinModules.flatMap(m => [m, `node:${m}`])],
  logLevel: 'info',
});

if (result.errors.length) process.exit(1);
console.log('built ->', OUT);
