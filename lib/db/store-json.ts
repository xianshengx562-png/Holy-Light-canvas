import fs from 'node:fs';
import path from 'node:path';
import { MODELS } from './schema';
import type { Row } from './row';

/**
 * 落盘（JSON 版）：一个模型一个 JSON 文件，放在数据目录下。
 *
 * 这是**旧引擎**，现在默认走 SQLite（见 `store-sqlite.ts`），它留着有两个用途：
 *   1. 兜底：设 `HOLYLIGHT_DB_ENGINE=json` 就回到这里（比如某个 Electron 版本的 `node:sqlite`
 *      被裁掉了，或者 SQLite 文件打不开而用户必须马上能用）；
 *   2. 迁移来源：SQLite 第一次打开时就是从这里的 `.json` 读数据的（见 `store-sqlite.ts`）。
 *
 * ⚠️ 主进程/后端启动时必须先调 `setDataDir()`。
 *    放在这里而不是直接 import electron，是因为 `lib/` 也参与渲染进程的类型检查，
 *    让数据层直接依赖 electron 会把两个世界焊死。
 */
export type { Row };

let dir: string | null = null;
const cache = new Map<string, Row[]>();
const dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function setDataDir(p: string): void {
  dir = p;
  cache.clear();
  dirty.clear();
}

export function dataDir(): string {
  if (dir) return dir;
  const fromEnv = process.env.HOLYLIGHT_DATA_DIR;
  dir = fromEnv && fromEnv.trim() ? fromEnv.trim() : path.join(process.cwd(), '.frame-data');
  return dir;
}

function fileFor(model: string): string {
  const meta = MODELS[model];
  return path.join(dataDir(), `${meta?.table || model}.json`);
}

/**
 * 迁移到 SQLite 之后，原来的 `.json` 会被改名成 `.json.migrated` 保留下来（不删）。
 * 用户切回这个引擎时要能接着那份数据继续用，所以读不到 `.json` 就找 `.json.migrated`。
 */
function existingFile(model: string): string | null {
  const file = fileFor(model);
  if (fs.existsSync(file)) return file;
  const migrated = `${file}.migrated`;
  return fs.existsSync(migrated) ? migrated : null;
}

/** JSON 里没有 Date：读回来要把 datetime 字段还原成 Date 对象，否则上层 `> new Date()` 全是假的。 */
function hydrate(model: string, raw: Row): Row {
  const meta = MODELS[model];
  if (!meta) return raw;
  for (const f of meta.fields) {
    if (f.kind !== 'datetime') continue;
    const v = raw[f.name];
    if (typeof v === 'string') {
      const d = new Date(v);
      raw[f.name] = Number.isNaN(d.getTime()) ? null : d;
    }
  }
  return raw;
}

function dehydrate(model: string, row: Row): Row {
  const meta = MODELS[model];
  if (!meta) return row;
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

export function rows(model: string): Row[] {
  const cached = cache.get(model);
  if (cached) return cached;
  let parsed: Row[] = [];
  const file = existingFile(model);
  try {
    if (file) {
      const text = fs.readFileSync(file, 'utf8').trim();
      const data = text ? JSON.parse(text) : [];
      parsed = Array.isArray(data) ? data.map((r: Row) => hydrate(model, r)) : [];
    }
  } catch (error) {
    /*
     * 文件坏了不能让整个应用起不来：备份一份让用户有机会捞回来，然后当空表继续。
     * 静默丢掉是最坏的结果 —— 用户会以为「我的东西没了」而其实文件还在旁边。
     */
    if (file) {
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败不影响继续跑 */
      }
    }
    console.error(`[db] ${model} 数据文件损坏，已备份并以空表启动`, error);
    parsed = [];
  }
  cache.set(model, parsed);
  return parsed;
}

function writeNow(model: string): void {
  const list = cache.get(model);
  if (!list) return;
  const file = fileFor(model);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  /*
   * 先写临时文件再 rename：写一半断电/崩溃只会留下一个 .tmp，
   * 不会把原来那份好数据截断成半个 JSON。
   */
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list.map((r) => dehydrate(model, r)), null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function markDirty(model: string): void {
  dirty.add(model);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushSync();
  }, 200);
  // 定时器不要挡着进程退出
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }
}

export function flushSync(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  for (const model of dirty) {
    try {
      writeNow(model);
    } catch (error) {
      console.error(`[db] 写入 ${model} 失败`, error);
    }
  }
  dirty.clear();
}
