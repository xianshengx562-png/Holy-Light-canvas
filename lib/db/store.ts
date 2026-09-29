import path from 'node:path';
import * as jsonEngine from './store-json';
import * as sqliteEngine from './store-sqlite';
import type { Row } from './row';

/**
 * 存储引擎的**选择层**。
 *
 * 上层（`engine.ts`）只认 `rows()` / `markDirty()` / `flushSync()` 这几个函数，
 * 具体落到 SQLite 还是 JSON 由这里决定：
 *
 *   - 默认 `sqlite`：整个库一个 `frame.db`（见 `store-sqlite.ts`）；
 *   - `HOLYLIGHT_DB_ENGINE=json` 强制走老的 JSON 引擎（见 `store-json.ts`）；
 *   - SQLite **打不开**时自动退回 JSON —— 宁可退化也不能起不来。
 *
 * ⚠️ 两个引擎都是**静态 import**，这是被打包器逼出来的、也必须记住的一条：
 *   第一版写成 `require('./store-sqlite')`（想让 `node:sqlite` 惰性加载），
 *   esbuild 把这行**原样留在产物里**、并没有把那个模块打进 bundle ——
 *   运行时 `out/main/` 下根本没有 `store-sqlite.js`，于是每次都 MODULE_NOT_FOUND，
 *   被 try/catch 静默吃掉，退化成 JSON 而**一点迹象都没有**。
 *   代价是 `node:sqlite` 会随后端进程一起加载（Electron 44 内置 Node 24，有），
 *   换来的是「到底用上 SQLite 没有」这件事在构建产物里一眼可查。
 */
export type { Row };

type Engine = {
  setDataDir: (p: string) => void;
  dataDir: () => string;
  rows: (model: string) => Row[];
  markDirty: (model: string) => void;
  flushSync: () => void;
};

let engine: Engine | null = null;
let kind: 'sqlite' | 'json' = 'json';
/** `setDataDir()` 会比引擎选择更早发生（后端一启动就调），先存着，选好了再补上。 */
let dir: string | null = null;

function assign(next: Engine, nextKind: 'sqlite' | 'json'): Engine {
  engine = next;
  kind = nextKind;
  if (dir !== null) next.setDataDir(dir);
  return next;
}

function active(): Engine {
  if (engine) return engine;
  if ((process.env.HOLYLIGHT_DB_ENGINE ?? '').trim().toLowerCase() === 'json') {
    return assign(jsonEngine as unknown as Engine, 'json');
  }
  try {
    const chosen = assign(sqliteEngine as unknown as Engine, 'sqlite');
    /*
     * 真打开一次再说「能用」：模块能 import 只是说明 Node 有 `node:sqlite`，
     * 而磁盘满、目录只读、库文件损坏这些都要到 open() 才暴露。
     * 放在这里而不是等到第一次查数据，是因为那时已经写了一半、退不干净了。
     */
    sqliteEngine.probe();
    return chosen;
  } catch (error) {
    console.error('[db] SQLite 不可用，退回 JSON 存储。', error);
    return assign(jsonEngine as unknown as Engine, 'json');
  }
}

/** 当前到底用的哪个引擎 —— 排障时第一件要确认的事，所以要能从外面问出来。 */
export function engineKind(): 'sqlite' | 'json' {
  active();
  return kind;
}

export function setDataDir(p: string): void {
  dir = p;
  if (engine) engine.setDataDir(p);
}

export function dataDir(): string {
  if (engine) return engine.dataDir();
  const fromEnv = process.env.HOLYLIGHT_DATA_DIR;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : path.join(process.cwd(), '.frame-data');
}

export function rows(model: string): Row[] {
  return active().rows(model);
}

export function markDirty(model: string): void {
  active().markDirty(model);
}

export function flushSync(): void {
  active().flushSync();
}
