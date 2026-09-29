import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MODELS, type FieldKind, type FieldMeta, type ModelMeta } from './schema';
import { setRowRevision, type Row } from './row';

/**
 * 落盘（SQLite 版）：整个库一个 `frame.db`，放在数据目录下。
 *
 * 为什么换掉 JSON（旧实现见 `store-json.ts`）：
 *   1. **一个文件**：备份、迁移、发给别人都只需要拷一个文件，不用管 21 个 `.json`；
 *   2. **写入是事务**的：以前「先写 .tmp 再 rename」只是尽力而为，现在 `BEGIN`/`COMMIT`
 *      由 SQLite 保证，写一半断电不会留下半张表；
 *   3. **不会整个文件解析失败**：JSON 那个分支里「文件坏了就备份 + 空表启动」是无奈之举，
 *      SQLite 没有这种整体损坏模式。
 *
 * ⚠️ 这一层**不做查询**：过滤、排序、关联仍然在 `engine.ts` 里用内存完成。
 *    把 Prisma 那套 `where` 翻译成 SQL 是另一件大得多的事，而现在的量级（几千行）
 *    根本用不上 —— 这里只负责「把表读成数组、把数组写回表」。
 *
 * 上层接口与 JSON 版**完全一致**（`setDataDir` / `rows` / `markDirty` / `flushSync`），
 * 选哪个引擎由 `store.ts` 决定，本文件不知道自己是不是被选中。
 */
export type { Row };

const REV_COLUMN = '_rev';

const SQL_TYPE: Record<FieldKind, string> = {
  string: 'TEXT',
  int: 'INTEGER',
  boolean: 'INTEGER',
  datetime: 'TEXT',
  json: 'TEXT',
  enum: 'TEXT',
};

let dir: string | null = null;
let db: DatabaseSync | null = null;
const cache = new Map<string, Row[]>();
const dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function setDataDir(p: string): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* 关不掉就算了，进程也要退了 */
    }
  }
  db = null;
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

function dbFile(): string {
  return path.join(dataDir(), 'frame.db');
}

/** 标识符一律加引号：表名/列名可能是 `order`、`group` 这类 SQL 关键字。 */
function quote(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

function tableName(m: ModelMeta): string {
  return m.table || m.name;
}

function columnOf(f: FieldMeta): string {
  return f.column || f.name;
}

/** 关联字段是查询引擎自己算出来的，不落盘。 */
function scalarFields(m: ModelMeta): FieldMeta[] {
  return m.fields.filter((f) => !f.relation);
}

function encode(f: FieldMeta, value: unknown): null | number | string {
  if (value === undefined || value === null) return null;
  switch (f.kind) {
    case 'int': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    /* SQLite 没有布尔：存 0/1。 */
    case 'boolean':
      return value ? 1 : 0;
    /* ISO 串是定宽的，字典序 == 时间序，所以直接当 TEXT 存也能正确排序、也看得懂。 */
    case 'datetime':
      return value instanceof Date ? value.toISOString() : String(value);
    /*
     * JSON 列**一律** stringify，不能「本来是字符串就原样存」：
     * 一个字符串字段的内容恰好是 `{"a":1}` 时，原样存进去再 JSON.parse 读出来
     * 就变成一个**对象**了 —— 写进去是字符串、读出来是对象，这种变形最难查。
     * 统一加一层引号后，`'"{\"a\":1}"'` parse 回来还是原来那个字符串。
     */
    case 'json':
      return JSON.stringify(value);
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

function decode(f: FieldMeta, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (f.kind) {
    case 'int':
      return typeof value === 'number' ? value : Number(value);
    case 'boolean':
      return Boolean(value);
    case 'datetime': {
      const d = new Date(value as string | number);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    case 'json': {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        /* 坏掉的 JSON 列：返回原串，起码不会让整张表读不出来 */
        return value;
      }
    }
    default:
      return value;
  }
}

/** 表里现有的列名（`PRAGMA table_info` 的结果只需要 `name` 这一列）。 */
function existingColumns(current: DatabaseSync, table: string): Set<string> {
  const info = current.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name?: unknown }[];
  const out = new Set<string>();
  for (const row of info) if (typeof row.name === 'string') out.add(row.name);
  return out;
}

/**
 * 给一列算「回填值」。
 *
 * 只在**加完列之后补老行**这一步用：`ALTER TABLE ADD COLUMN` 只能加出一个全 NULL 的列，
 * 而上层模型给这类字段写了默认值（`provider` 默认 `'runninghub'` 这种），
 * 不回填的话每一行都要在读的时候兜一次底 —— 那等于把默认值规则复制到了二十几个调用点。
 *
 * 返回 `undefined` = 不回填：`cuid` 造不出（而且撞主键 / 唯一键的风险不值得在迁移里冒），
 * `none` 本来就是「没有默认值」。
 */
function seedValue(f: FieldMeta): string | number | boolean | null | undefined {
  if (f.default.type === 'literal') return f.default.value;
  if (f.default.type === 'now') return new Date().toISOString();
  return undefined;
}

function ensureSchema(current: DatabaseSync): void {
  for (const m of Object.values(MODELS)) {
    const cols = scalarFields(m)
      .map((f) => `${quote(columnOf(f))} ${SQL_TYPE[f.kind]}`)
      .concat(`${quote(REV_COLUMN)} INTEGER NOT NULL DEFAULT 1`);
    current.exec(`CREATE TABLE IF NOT EXISTS ${quote(tableName(m))} (${cols.join(', ')})`);
    ensureColumns(current, m);
  }
}

/**
 * 补齐缺失的列 —— **`CREATE TABLE IF NOT EXISTS` 不会管这件事**。
 *
 * 背景：`MODELS` 是建表的唯一来源，给某个模型加一个字段（比如给 `WorkflowDraft`
 * 加 `provider`）之后，新库有这一列、**已经存在的 `frame.db` 没有**。
 * 少了这一层，`loadTable` 的 `SELECT "provider" FROM ...` 会直接
 * `SqliteError: no such column`，而且是**打开任意一个页面都崩**——桌面版升级后
 * 第一件事就是开库。
 *
 * 用 `PRAGMA table_info` 和模型对一遍即可，比维护一串手写迁移稳：漏写一个字段名
 * 的代价是某个用户的库崩掉，而手写迁移偏偏就是最容易漏的那类东西。
 */
function ensureColumns(current: DatabaseSync, m: ModelMeta): void {
  const table = quote(tableName(m));
  const existing = existingColumns(current, tableName(m));
  for (const f of scalarFields(m)) {
    const col = columnOf(f);
    if (existing.has(col)) continue;
    current.exec(`ALTER TABLE ${table} ADD COLUMN ${quote(col)} ${SQL_TYPE[f.kind]}`);
    const seed = seedValue(f);
    if (seed === undefined) continue;
    /* 值用占位参数绑进去：`name` 之类的 TEXT 默认值里出现单引号是迟早的事。 */
    current.prepare(`UPDATE ${table} SET ${quote(col)} = ? WHERE ${quote(col)} IS NULL`).run(encode(f, seed));
    console.log(`[db] ${tableName(m)} 补列 ${col}`);
  }
}

/**
 * 从 JSON 迁移。
 *
 * 只在**库文件本来不存在**时做一次：那时 SQLite 里肯定是空的，而 `data/` 下可能还躺着
 * 老版本留下的 21 个 `.json`。读完不删、改名成 `.json.migrated` —— 用户万一要退回
 * `HOLYLIGHT_DB_ENGINE=json`，`store-json.ts` 认这个名字，数据还在。
 */
function migrateFromJson(current: DatabaseSync): void {
  let moved = 0;
  for (const [model, m] of Object.entries(MODELS)) {
    const file = path.join(dataDir(), `${tableName(m)}.json`);
    if (!fs.existsSync(file)) continue;
    let parsed: Row[] = [];
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      const data = text ? JSON.parse(text) : [];
      if (Array.isArray(data)) parsed = data;
    } catch (error) {
      /* 读不出来的那份就跳过：宁可少迁一张表，也不能让整个启动失败 */
      console.error(`[db] 迁移 ${model} 失败，跳过`, error);
      continue;
    }
    if (!parsed.length) continue;
    const cols = scalarFields(m);
    const sql = `INSERT OR REPLACE INTO ${quote(tableName(m))} (${cols
      .map((f) => quote(columnOf(f)))
      .concat(quote(REV_COLUMN))
      .join(', ')}) VALUES (${cols.map(() => '?').concat('?').join(', ')})`;
    const stmt = current.prepare(sql);
    current.exec('BEGIN');
    try {
      for (const raw of parsed) {
        const row: Row = {};
        for (const f of cols) row[f.name] = decode(f, raw[f.name]);
        stmt.run(...cols.map((f) => encode(f, row[f.name])), 1);
      }
      current.exec('COMMIT');
    } catch (error) {
      current.exec('ROLLBACK');
      console.error(`[db] 迁移 ${model} 写入失败，已回滚`, error);
      continue;
    }
    moved += 1;
    try {
      fs.renameSync(file, `${file}.migrated`);
    } catch {
      /* 改名失败不影响数据库已经写好的内容 */
    }
  }
  if (moved) console.log(`[db] 已从 JSON 迁移 ${moved} 张表到 SQLite（原文件保留为 *.json.migrated）`);
}

function open(): DatabaseSync {
  if (db) return db;
  const file = dbFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const created = !fs.existsSync(file);
  const current = new DatabaseSync(file);
  /*
   * WAL：读不阻塞写、写不阻塞读，崩溃时未提交的页不会污染主库文件。
   * synchronous=NORMAL 配 WAL 是桌面应用的标准档（掉电只丢最后一两个事务）。
   */
  current.exec('PRAGMA journal_mode = WAL');
  current.exec('PRAGMA synchronous = NORMAL');
  ensureSchema(current);
  if (created) migrateFromJson(current);
  db = current;
  return current;
}

function loadTable(model: string): Row[] {
  const m = MODELS[model];
  const cols = scalarFields(m);
  const current = open();
  const list = current
    .prepare(`SELECT ${cols.map((f) => quote(columnOf(f))).concat(quote(REV_COLUMN)).join(', ')} FROM ${quote(tableName(m))}`)
    .all();
  const out = list.map((raw) => {
    const row: Row = {};
    for (const f of cols) row[f.name] = decode(f, raw[columnOf(f)]);
    setRowRevision(row, typeof raw[REV_COLUMN] === 'number' ? (raw[REV_COLUMN] as number) : 1);
    return row;
  });
  cache.set(model, out);
  return out;
}

/**
 * 整表重写。
 *
 * 听着粗暴，但和 JSON 版是同一个量级（原来也是整文件重写），而且**正确性**更好：
 * 删除的行不用单独跟踪，事务一提交就是全表最新的样子。
 * 现在的量级是几千行、画布那几行 JSON 最大也就几 MB，一次重写是毫秒级。
 * 真到了慢的那天，正确做法是给 `markDirty` 记行号做 UPSERT，而不是在这里猜谁变了。
 */
function saveTable(model: string): void {
  const list = cache.get(model);
  if (!list) return;
  const m = MODELS[model];
  const cols = scalarFields(m);
  const current = open();
  const names = cols.map((f) => quote(columnOf(f))).concat(quote(REV_COLUMN));
  const stmt = current.prepare(
    `INSERT INTO ${quote(tableName(m))} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  );
  current.exec('BEGIN IMMEDIATE');
  try {
    current.exec(`DELETE FROM ${quote(tableName(m))}`);
    for (const row of list) {
      /* 修订号由 `engine.ts` 在真正改动一行时递增，这里只是把它带出去。 */
      stmt.run(...cols.map((f) => encode(f, row[f.name])), Math.max(1, Number(row['_rev'] ?? 1)));
    }
    current.exec('COMMIT');
  } catch (error) {
    try {
      current.exec('ROLLBACK');
    } catch {
      /* 回滚也失败就没办法了，把原错误抛出去 */
    }
    throw error;
  }
}

/**
 * 打开一次库（建表 + 必要时从 JSON 迁移）。
 *
 * 给 `store.ts` 在**选引擎时**用：能 import 这个模块只说明 Node 里有 `node:sqlite`，
 * 而目录只读、磁盘满、文件损坏都要到这里才见分晓。
 */
export function probe(): void {
  open();
}

export function rows(model: string): Row[] {
  const cached = cache.get(model);
  if (cached) return cached;
  return loadTable(model);
}

export function markDirty(model: string): void {
  dirty.add(model);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushSync();
  }, 200);
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
      saveTable(model);
    } catch (error) {
      console.error(`[db] 写入 ${model} 失败`, error);
    }
  }
  dirty.clear();
  checkpoint();
}

/**
 * 把 WAL 收进主库文件。
 *
 * ⚠️ 这一条是「换 SQLite 就是为了能一个文件拷走」的前提：开着 WAL 时，刚写的东西
 *    都在 `frame.db-wal` 里，主库文件可能只有 4KB —— 谁要是只拷了 `frame.db`，
 *    拿到的是一个**空的**库。每次 flush 之后收一次，主库文件就始终是完整的。
 *
 * 崩溃来不及收也没关系：下次打开时 SQLite 会自己从 WAL 里恢复，不会丢已提交的事务。
 */
function checkpoint(): void {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    console.error('[db] WAL 检查点失败', error);
  }
}
