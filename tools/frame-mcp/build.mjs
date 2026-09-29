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

/** `@/` → 工程根（先精确命中文件，再按扩展名猜），与 `electron.vite.config.ts` 里同一个思路。 */
function resolveAt() {
  return {
    name: 'frame-resolve-at',
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => {
        const rel = args.path.slice(2);
        const base = resolve(root, rel);
        if (existsSync(base) && statSync(base).isFile()) return { path: base };
        for (const ext of EXT) {
          if (existsSync(base + ext)) return { path: base + ext };
        }
        for (const index of ['index.ts', 'index.js']) {
          if (existsSync(resolve(base, index))) return { path: resolve(base, index) };
        }
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
