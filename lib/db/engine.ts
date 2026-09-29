import { MODELS, type FieldMeta, type ModelMeta } from './schema';
import { rows, markDirty, type Row } from './store';
import { rowRevision, setRowRevision } from './row';
import { Prisma } from '@prisma/client';

/**
 * 一个够用的 Prisma 查询引擎替身。
 *
 * 上层 18 个文件（资产、项目、钱包、密钥、工作流草稿、对话产物……）全是
 * `db.asset.findMany({ where, select, orderBy })` 这种写法。要把它们从 PostgreSQL 迁到
 * 「userData 里的 JSON」，有两条路：改这 18 个文件，或者让 `db` 继续长成 Prisma 的样子。
 * 选后者 —— 调用点一个不动，差异全收在这一层，而且这份差异是**可以单独测**的。
 *
 * 实现范围刻意只覆盖真实用到的那些（先扫过全部调用点才动手）：
 *   操作    findUnique / findFirst / findMany / create / update / upsert /
 *           delete / deleteMany / updateMany / count / groupBy / $transaction
 *   where  等值、in、not、lt / lte / gt / gte、contains（含 insensitive）、OR / AND / NOT
 *   其它   select（含一层关联 select）、include、orderBy（含 nulls）、take / skip、
 *          嵌套 create、increment / decrement
 *
 * 没做的就是没用到的：聚合里的 _avg、深层嵌套、事务隔离。
 *
 * 无论是**漏实现的方法**还是**写错的模型名**，一律显式抛错（`Delegate` 上的 Proxy 拦一道），
 * 而不是悄悄返回错的结果 —— 静默的错误答案比崩溃难查得多。
 */
export type Query = Record<string, unknown>;
type Shape = Record<string, unknown>;

function meta(model: string): ModelMeta {
  const m = MODELS[model];
  if (!m) throw new Error(`[db] 没有这个模型：${model}`);
  return m;
}

/** `WalletEntry` -> `walletEntry`，与 Prisma Client 的属性命名保持一致。 */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function scalarFields(m: ModelMeta): FieldMeta[] {
  return m.fields.filter((f) => !f.relation);
}

/** 把 Date / ISO 字符串都拉成可比较的数字，字符串保持原样。 */
function comparable(v: unknown): unknown {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t) && /^\d{4}-\d{2}-\d{2}T/.test(v)) return t;
  }
  return v;
}

function eq(a: unknown, b: unknown, insensitive = false): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (insensitive && typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return comparable(a) === comparable(b);
}

const OPS = new Set([
  'equals',
  'not',
  'in',
  'notIn',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'startsWith',
  'endsWith',
  'mode',
  'is',
  'isNot',
  'some',
  'every',
  'none',
]);

function scalarMatch(value: unknown, filter: unknown): boolean {
  if (filter === undefined) return true;
  if (filter === null) return value === null || value === undefined;
  if (filter instanceof Date) return eq(value, filter);
  if (Array.isArray(filter)) return filter.some((f) => eq(value, f));
  if (typeof filter !== 'object') return eq(value, filter);

  const f = filter as Record<string, unknown>;
  const insensitive = f.mode === 'insensitive';
  for (const [op, operand] of Object.entries(f)) {
    if (op === 'mode') continue;
    let ok = true;
    switch (op) {
      case 'equals':
        ok = eq(value, operand, insensitive);
        break;
      case 'not':
        ok = !eq(value, operand, insensitive);
        break;
      case 'in':
        ok = Array.isArray(operand) && operand.some((o) => eq(value, o, insensitive));
        break;
      case 'notIn':
        ok = Array.isArray(operand) && !operand.some((o) => eq(value, o, insensitive));
        break;
      case 'lt':
        ok = cmp(value, operand) < 0;
        break;
      case 'lte':
        ok = cmp(value, operand) <= 0;
        break;
      case 'gt':
        ok = cmp(value, operand) > 0;
        break;
      case 'gte':
        ok = cmp(value, operand) >= 0;
        break;
      case 'contains':
        ok = str(value).toLowerCase().includes(str(operand).toLowerCase());
        break;
      case 'startsWith':
        ok = str(value).toLowerCase().startsWith(str(operand).toLowerCase());
        break;
      case 'endsWith':
        ok = str(value).toLowerCase().endsWith(str(operand).toLowerCase());
        break;
      default:
        throw new Error(`[db] 暂不支持的查询操作符：${op}（用到了就在这里补，别让它静默不生效）`);
    }
    if (!ok) return false;
  }
  return true;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function cmp(a: unknown, b: unknown): number {
  const x = comparable(a);
  const y = comparable(b);
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return str(x).localeCompare(str(y));
}

/** 找到「另一侧持有指向本模型外键」的那个字段，用来解析一对多 / 一对一反向关联。 */
function reverseField(model: string, other: string): { field: FieldMeta; model: string } | null {
  const m = MODELS[other];
  if (!m) return null;
  for (const f of m.fields) {
    if (f.relation && f.relation.model === model && f.relation.fk) return { field: f, model: other };
  }
  return null;
}

function relatedRows(model: string, row: Row, field: FieldMeta): { model: string; list: Row[] } {
  const target = field.relation!.model;
  if (field.relation!.fk) {
    // belongsTo：外键在本侧
    const ref = field.relation!.ref || 'id';
    const fkValue = row[field.relation!.fk];
    const list = rows(target).filter((r) => eq(r[ref], fkValue));
    return { model: target, list };
  }
  // hasOne / hasMany：外键在对方
  const rev = reverseField(model, target);
  if (!rev) return { model: target, list: [] };
  const keyValue = row[MODELS[model].id];
  const list = rows(target).filter((r) => eq(r[rev.field.relation!.fk as string], keyValue));
  return { model: target, list };
}

function matchWhere(model: string, row: Row, where: unknown): boolean {
  if (!where || typeof where !== 'object') return true;
  const m = meta(model);
  for (const [key, filter] of Object.entries(where as Query)) {
    if (key === 'OR') {
      if (!Array.isArray(filter) || !filter.some((w) => matchWhere(model, row, w))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!Array.isArray(filter) || !filter.every((w) => matchWhere(model, row, w))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matchWhere(model, row, filter)) return false;
      continue;
    }
    const field = m.fields.find((f) => f.name === key);
    if (field?.relation) {
      const { model: tModel, list } = relatedRows(model, row, field);
      if (filter === null) {
        if (list.length !== 0) return false;
        continue;
      }
      const f = (filter ?? {}) as Record<string, unknown>;
      const inner = (f.is ?? f) as unknown;
      if (f.isNot !== undefined && list.some((r) => matchWhere(tModel, r, f.isNot))) return false;
      if (!list.some((r) => matchWhere(tModel, r, inner))) return false;
      continue;
    }
    /*
     * **复合唯一键**：`where: { userId_workflowId: { userId, workflowId } }`。
     *
     * 这个名字是 Prisma 按 `@@unique([userId, workflowId])` 拼出来的（schema 里登记在
     * `uniques` 上），**不是一个字段** —— 而这里在没有同名字段时会把 `filter` 当成
     * 一堆查询操作符去解析，于是抛「暂不支持的查询操作符：userId」。
     * 后果是提交生成整条链路 500：那一支第一步就是按复合唯一键查一次工作流草稿
     * （`Workflow` 那条 `provider_workflowId` 同理，它在生成登记时也会撞上）。
     */
    if (!field) {
      const unique = (m.uniques ?? []).find((u) => u.join('_') === key);
      if (unique) {
        const parts = (filter ?? {}) as Shape;
        if (!unique.every((f) => scalarMatch(row[f], parts[f]))) return false;
        continue;
      }
    }
    if (!scalarMatch(row[key], filter)) return false;
  }
  return true;
}

/**
 * 拆 `include: { user: { select: { id: true } } }` 里 **关联那一层**的规格。
 *
 * ⚠️ 以前这里直接把 `{ select: {...} }` 当成 select 规格往下传，于是 `shape()` 会去
 * 目标模型的字段表里找一个叫 `select` 的字段 —— 当然找不到，循环 `continue`，
 * 最后 `user` 是个**空对象**。这个坑安静得可怕：不抛异常、不打日志，
 * 只是「关联对象里一个字段都没有」，要到渲染层拿 `user.name` 当字符串用时才炸。
 * （2026-09-25 就是这么撞上的：桌面版登录后 `/api/auth/me` 回 `{}`，
 * 头像组件 `name.trim()` 抛 TypeError，整页白屏。）
 *
 * 三种写法：`true`（全字段）、`{ select: ... }`、`{ include: ... }`，
 * 剩下的（比如直接给一个字段表）按 select 处理，与 Prisma 一致。
 */
function subShape(spec: unknown): { select: Shape | null; include: Shape | null } {
  if (spec === true || spec === undefined || spec === null) return { select: null, include: null };
  if (typeof spec === 'object') {
    const s = spec as Shape;
    if (s.select !== undefined || s.include !== undefined) {
      return { select: (s.select ?? null) as Shape | null, include: (s.include ?? null) as Shape | null };
    }
    /* 空对象＝「没指定」，按全字段处理（Prisma 里 `include: { user: {} }` 也是这个意思）。 */
    if (Object.keys(s).length === 0) return { select: null, include: null };
  }
  return { select: (spec ?? null) as Shape | null, include: null };
}

/** 按 select / include 裁剪一行（含一层关联）。 */
function shape(model: string, row: Row, select?: unknown, include?: unknown): Row {
  const m = meta(model);
  if (select && typeof select === 'object') {
    const out: Row = {};
    for (const [key, spec] of Object.entries(select as Shape)) {
      if (spec === false) continue;
      /*
       * 修订号不在 schema 里（它是存储层维护的隐藏属性，见 `row.ts`），
       * 所以只有显式 `select: { revision: true }` 才会带出去 ——
       * 默认返回值里多一个键，等于让上层有可能把它当成字段又写回库里。
       */
      if (key === 'revision') {
        out.revision = rowRevision(row);
        continue;
      }
      /* `_count: { select: { messages: true } }` —— 会话列表要显示「这条有几条消息」 */
      if (key === '_count' && spec && typeof spec === 'object') {
        const wanted = ((spec as Shape).select ?? {}) as Shape;
        const counted: Row = {};
        for (const relName of Object.keys(wanted)) {
          const field = m.fields.find((f) => f.name === relName);
          if (!field?.relation) continue;
          counted[relName] = relatedRows(model, row, field).list.length;
        }
        out._count = counted;
        continue;
      }
      const field = m.fields.find((f) => f.name === key);
      if (!field) continue;
      if (field.relation) {
        const { model: tModel, list } = relatedRows(model, row, field);
        const sub = subShape(spec);
        if (field.relation!.many) {
          out[key] = list.map((r) => shape(tModel, r, sub.select, sub.include));
        } else {
          out[key] = list.length ? shape(tModel, list[0], sub.select, sub.include) : null;
        }
      } else {
        out[key] = row[key] ?? null;
      }
    }
    return out;
  }
  const out: Row = {};
  for (const f of scalarFields(m)) out[f.name] = row[f.name] ?? null;
  if (include && typeof include === 'object') {
    for (const [key, spec] of Object.entries(include as Shape)) {
      if (spec === false) continue;
      const field = m.fields.find((f) => f.name === key);
      if (!field?.relation) continue;
      const { model: tModel, list } = relatedRows(model, row, field);
      const sub = subShape(spec);
      if (field.relation!.many) {
        out[key] = list.map((r) => shape(tModel, r, sub.select, sub.include));
      } else {
        out[key] = list.length ? shape(tModel, list[0], sub.select, sub.include) : null;
      }
    }
  }
  return out;
}

/** 排序：支持 `orderBy: { a: 'desc' }`、`[{ a: { sort, nulls } }]`。 */
function sortRows(model: string, list: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return list;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  const out = [...list];
  out.sort((a, b) => {
    for (const raw of specs) {
      if (!raw || typeof raw !== 'object') continue;
      for (const [key, dir] of Object.entries(raw as Shape)) {
        if (key === '_count' || key === '_max' || key === '_min' || key === '_sum') {
          continue; // groupBy 自己的排序在 groupBy 里处理
        }
        const desc = dir === 'desc' || (dir as Shape)?.sort === 'desc';
        const nulls = (dir as Shape)?.nulls;
        const av = a[key];
        const bv = b[key];
        const an = av === null || av === undefined;
        const bn = bv === null || bv === undefined;
        if (an || bn) {
          if (an && bn) continue;
          if (nulls === 'first') return an ? -1 : 1;
          if (nulls === 'last') return an ? 1 : -1;
          return an ? 1 : -1;
        }
        const c = cmp(av, bv);
        if (c !== 0) return desc ? -c : c;
      }
    }
    return 0;
  });
  return out;
}

let seq = 0;
/** cuid 的替身：本地单机不需要全局唯一，只要在这个库里不撞。 */
function cuid(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `c${Date.now().toString(36)}${(seq++).toString(36)}${rand}`;
}

function defaultFor(field: FieldMeta): unknown {
  const d = field.default;
  if (d.type === 'cuid') return cuid();
  if (d.type === 'now') return new Date();
  if (d.type === 'literal') {
    if (field.kind === 'json' && typeof d.value === 'string') {
      try {
        return JSON.parse(d.value);
      } catch {
        return d.value;
      }
    }
    return d.value;
  }
  if (field.kind === 'datetime' && !field.optional) return new Date();
  return field.optional ? null : null;
}

/** 写入时对某个字段求值：处理 `{ increment: n }` / `{ decrement: n }` / `{ set: v }`。 */
/** `Prisma.DbNull` / `Prisma.JsonNull` 的判定：见 electron/shims/prisma-client.ts。 */
function isNullSentinel(v: unknown): boolean {
  return !!v && typeof v === 'object' && ('__frameDbNull' in v || '__frameJsonNull' in v);
}

function writeValue(current: unknown, input: unknown): unknown {
  if (input === undefined) return current;
  if (input === null) return null;
  if (isNullSentinel(input)) return null;
  if (input instanceof Date) return input;
  if (typeof input === 'object' && !Array.isArray(input)) {
    const ops = input as Record<string, unknown>;
    const keys = Object.keys(ops);
    if (keys.length && keys.every((k) => k === 'increment' || k === 'decrement' || k === 'set')) {
      if ('set' in ops) return ops.set;
      const base = typeof current === 'number' ? current : Number(current ?? 0) || 0;
      const inc = Number(ops.increment ?? 0) || 0;
      const dec = Number(ops.decrement ?? 0) || 0;
      return base + inc - dec;
    }
  }
  return input;
}

/**
 * 撞了唯一键时抛的错。
 *
 * ⚠️ 必须抛 `Prisma.PrismaClientKnownRequestError` **这个类本身**，不能自己 `new Error()`
 * 再挂个 `code` —— 上游四处都写成
 * `if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')`
 * （`lib/api.ts`、`lib/wallet.ts`、`lib/payments/settle.ts`、工作流配置那条 PATCH），
 * `instanceof` 只认真正的那个构造函数，手挂的 `code` 永远匹配不上。
 *
 * 桌面版的 `@prisma/client` 由 `electron/shims/prisma-client.ts` 顶上
 * （见 `electron.vite.config.ts` 的 alias），那份替身的注释里写明它就是
 * 「给 `lib/api.ts` 用来把唯一键冲突翻成 409」的，所以这里用它是对的路子。
 */
function uniqueViolation(model: string, unique: string[], row: Row): Error {
  const fields = unique.map((f) => `${f}=${String(row[f])}`).join(', ');
  return new Prisma.PrismaClientKnownRequestError(
    `[db] ${model} 唯一键冲突：${fields}`,
    { code: 'P2002' },
  ) as unknown as Error;
}

/**
 * 造一行之前，把 schema 里声明的 `uniques` 挨个查一遍。
 *
 * **为什么非做不可**：真实 Prisma 靠数据库的唯一索引来兜这件事，而这个替身引擎底下
 * 是 `store-sqlite.ts` —— 它自己写明「这一层不做查询」，**刻意一个索引都不建**
 * （`frame.db` 里 `sqlite_master` 的 index 计数实测是 0）。两头都不挡的结果，
 * 就是唯一约束在桌面版**完全不存在**：
 *
 *   - `PATCH /api/workflows/<id>/config` 带 `version: -1` 走的是 `db.workflowDraft.create()`，
 *     于是每次「新建」都真的多插一行。实测库里出现了同一个
 *     `(2099453228814529999, runninghub)` 两行，画布下拉里同一份工作流列了两遍。
 *   - 上面那条 409 分支（`P2002`）因此永远不触发 —— 并发保存**静默**互相覆盖/堆叠。
 *   - 影响面不止工作流：`User.email`、`Wallet.userId` 这些带 `uniques` 的模型同理。
 *
 * 判据只看**声明的唯一键**、且只在 `create` 这条路上生效（`upsert` 先 find 再 update，
 * 正常路径不会走到这里）。同一个唯一键里只要有**任意一列是 null / undefined 就跳过** ——
 * 那是 Prisma 与 SQL 的通行语义（`NULL` 不等于 `NULL`，唯一索引不拦多行 NULL），
 * 这里跟着照做，免得把本来合法的「多个可空值」判成冲突。
 */
function assertUnique(model: string, uniques: string[][] | undefined, row: Row, others: Row[]): void {
  for (const unique of uniques ?? []) {
    if (!unique.length) continue;
    /* 单列唯一键就是「普通唯一列」，同样要挡（`id` 这种由引擎生成、不会撞，但照查不误）。 */
    const hasNull = unique.some((f) => row[f] === null || row[f] === undefined);
    if (hasNull) continue;
    const clash = others.some((other) => unique.every((f) => scalarMatch(other[f], row[f])));
    if (clash) throw uniqueViolation(model, unique, row);
  }
}

class Delegate {
  readonly model: string;

  /*
   * ⚠️ 构造函数返回 Proxy，**把「没实现就显式抛错」这条承诺兑现**。
   *
   * 不加这层时，调用点拿不到某个方法会得到一个 `TypeError: db.xxx.yyy is not a function`；
   * 这个异常会一路抛到 `lib/api.ts` 的 `api()` 兜底，而那里在桌面版会把异常统一渲染成
   * 「数据库尚未连接」的 503（桌面版压根没有 `DATABASE_URL`）—— 真错误连一行日志都不留。
   * 画布一直显示「保存失败」就是这么来的（`findUniqueOrThrow` 漏实现）。
   * 显式列出「谁不支持什么、支持哪些」之后，这类问题第一次调用就炸出来。
   *
   * 同理也覆盖模型名写错的情况 —— `lowerFirst` 那边已经双注册了大小写，但收益于此的多一层保险。
   */
  constructor(model: string) {
    this.model = model;
    return new Proxy<Delegate>(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
        const known = Object.getOwnPropertyNames(Object.getPrototypeOf(target))
          .filter((n) => n !== 'constructor' && !n.startsWith('_'))
          .sort();
        throw new Error(
          `[db] ${target.model} 不支持 ${String(prop)}。替身引擎只实现了：${known.join('、')}`,
        );
      },
    });
  }

  private all(): Row[] {
    return rows(this.model);
  }

  private match(where: unknown): Row[] {
    return this.all().filter((r) => matchWhere(this.model, r, where));
  }

  async findMany(args: Query = {}): Promise<Row[]> {
    let list = this.match(args.where);
    list = sortRows(this.model, list, args.orderBy);
    if (typeof args.skip === 'number') list = list.slice(args.skip);
    if (typeof args.take === 'number') list = list.slice(0, args.take);
    return list.map((r) => shape(this.model, r, args.select, args.include));
  }

  async findFirst(args: Query = {}): Promise<Row | null> {
    const [one] = await this.findMany({ ...args, take: 1 });
    return one ?? null;
  }

  async findUnique(args: Query = {}): Promise<Row | null> {
    return this.findFirst(args);
  }

  /**
   * `…OrThrow` 这一族。**必须实现**，哪怕看着像用不上的边角。
   *
   * 缺它的代价很隐蔽：调用点拿到的是 `TypeError: db.canvas.findUniqueOrThrow is not a function`，
   * 这个异常一路抛到 `lib/api.ts` 的 `api()` 兜底 —— 而那里在桌面版会把异常统一渲染成
   * 「数据库尚未连接」的 503（桌面版没有 `DATABASE_URL`），真错误一行日志都不留。
   * 画布保存一直显示「保存失败」就是这么来的。
   */
  async findFirstOrThrow(args: Query = {}): Promise<Row> {
    const row = await this.findFirst(args);
    if (!row) throw new Error(`[db] findFirstOrThrow 找不到目标：${this.model} ${JSON.stringify(args.where ?? {})}`);
    return row;
  }

  async findUniqueOrThrow(args: Query = {}): Promise<Row> {
    const row = await this.findFirst(args);
    if (!row) throw new Error(`[db] findUniqueOrThrow 找不到目标：${this.model} ${JSON.stringify(args.where ?? {})}`);
    return row;
  }

  async create(args: Query = {}): Promise<Row> {
    const m = meta(this.model);
    const data = (args.data ?? {}) as Shape;
    const row: Row = {};
    /*
     * `@updatedAt` 的列在真实 Prisma 里由数据库填。这里没有数据库，
     * 只在 create 里认 `@default(now())` 是不够的 —— 一个既有 `createdAt @default(now())`
     * 又有 `updatedAt @updatedAt` 的模型（Project 就是），
     * `updatedAt` 的 default 是 `none`，写进去就**不是 Date 而是 null**。
     * 后果不是「显示空」那么轻：`listProjects` 的 `orderBy: { updatedAt: 'desc' }` 排到它、
     * 新项目排不到第一；更难看的是 JSON.stringify 落盘后这一列永远补不回来。
     */
    for (const f of scalarFields(m)) {
      row[f.name] = f.name in data
        ? writeValue(undefined, data[f.name])
        : f.updatedAt
          ? new Date()
          : defaultFor(f);
    }
    setRowRevision(row, 1);
    /*
     * 落库之前先过唯一键（见 `assertUnique` 那段：SQLite 层刻意不建索引，
     * 不在这里挡就等于没有唯一约束）。必须在 `push` **之前** —— 先 push 再查，
     * 行已经在数组里了，抛错也退不回去（这里没有回滚）。
     */
    assertUnique(this.model, m.uniques, row, this.all());
    this.all().push(row);
    markDirty(this.model);
    // 嵌套 create：外键在对方那一侧（如 Project 的 canvas）
    for (const f of m.fields) {
      if (!f.relation) continue;
      const spec = data[f.name];
      if (!spec || typeof spec !== 'object') continue;
      const nested = (spec as Shape).create;
      if (!nested) continue;
      const target = f.relation.model;
      const rev = reverseField(this.model, target);
      if (!rev) throw new Error(`[db] ${this.model}.${f.name} 无法嵌套创建：${target} 没有指回来的外键`);
      const child = await new Delegate(target).create({
        data: {
          ...(nested as Shape),
          [rev.field.relation!.fk as string]: row[m.id],
        },
      });
      if (!f.relation.many) row[f.name] = child;
    }
    return shape(this.model, row, args.select, args.include);
  }

  /**
   * 更新一行。
   *
   * `where` 里带 `revision` 时表示**乐观并发**：调用方手里有一份它读出来的数据，
   * 只有库里这行**还是那个版本**才允许写（写完版本号 +1）。这一条是给「两个窗口
   * 同时保存同一张画布」这类场景留的 —— 覆盖之前先发现冲突，比闷头覆盖掉别人的改动、
   * 事后才发现东西没了要好得多。
   *
   * 冲突时抛出的 Error 带 `code === 'REVISION_CONFLICT'`，上层要认就认这个码，
   * 别去匹配中文文案。
   */
  async update(args: Query = {}): Promise<Row> {
    const m = meta(this.model);
    const where = { ...((args.where ?? {}) as Shape) };
    let expectedRevision: number | null = null;
    if (typeof where.revision === 'number') {
      expectedRevision = where.revision;
      delete where.revision;
    }
    const found = this.match(where)[0];
    if (!found) throw new Error(`[db] update 找不到目标：${this.model} ${JSON.stringify(args.where)}`);
    if (expectedRevision !== null && rowRevision(found) !== expectedRevision) {
      const conflict = new Error(
        `[db] ${this.model} 版本冲突：传进来的是 revision=${expectedRevision}，库里已经是 ${rowRevision(found)}`,
      ) as Error & { code?: string };
      conflict.code = 'REVISION_CONFLICT';
      throw conflict;
    }
    const data = (args.data ?? {}) as Shape;
    for (const [key, value] of Object.entries(data)) {
      const field = m.fields.find((f) => f.name === key);
      if (field?.relation) {
        // 嵌套写：只支持一对一 / 一对多的 update 与 upsert（用到的就这些）
        const spec = (value ?? {}) as Shape;
        if (spec.create) {
          const target = field.relation.model;
          const rev = reverseField(this.model, target);
          if (rev) {
            await new Delegate(target).create({
              data: { ...(spec.create as Shape), [rev.field.relation!.fk as string]: found[m.id] },
            });
          }
        }
        if (spec.update) {
          const { model: tModel, list } = relatedRows(this.model, found, field);
          for (const child of list) {
            await new Delegate(tModel).update({
              where: { [MODELS[tModel].id]: child[MODELS[tModel].id] },
              data: spec.update as Shape,
            });
          }
        }
        continue;
      }
      found[key] = writeValue(found[key], value);
    }
    for (const f of scalarFields(m)) {
      if (f.updatedAt) found[f.name] = new Date();
    }
    /* 真的改了才推进版本号 —— 落盘时是按这个号写的（见 `store-sqlite.ts` 的 saveTable）。 */
    setRowRevision(found, rowRevision(found) + 1);
    markDirty(this.model);
    return shape(this.model, found, args.select, args.include);
  }

  /**
   * `upsert`。
   *
   * ⚠️ **Prisma 的 upsert 是 `{ where, create, update }`，而 `update()` 收的是 `{ where, data }`** ——
   * 更新分支要写的数据在 `update` 这个键上，不在 `data` 上。
   * 早先这一行写成 `this.update(args)`，于是 `args.data` 恒为 `undefined`：
   * 命中已有行时**一个字段都没写**，只把 `@updatedAt` 顶了一下，然后回 200。
   *
   * 症状是那种最难查的一类：接口没报错、界面显示「已保存」，只有重新读一次才发现值还是旧的
   * —— 本机 ComfyUI 的地址存不进去就是这么发现的（第一次能存进去，因为走的是 create 分支）。
   * 同一条路径上还压着钱包充值/扣费的 `increment / decrement`（余额永远停在初始值）
   * 和登录限流的 `count: { increment: 1 }`（限流形同虚设）。
   */
  async upsert(args: Query = {}): Promise<Row> {
    const found = this.match(args.where)[0];
    if (found) {
      return this.update({
        where: args.where,
        data: (args.update ?? {}) as Shape,
        select: args.select,
        include: args.include,
      });
    }
    return this.create({ data: args.create, select: args.select, include: args.include });
  }

  async delete(args: Query = {}): Promise<Row> {
    const list = this.all();
    const found = this.match(args.where)[0];
    if (!found) throw new Error(`[db] delete 找不到目标：${this.model} ${JSON.stringify(args.where)}`);
    list.splice(list.indexOf(found), 1);
    markDirty(this.model);
    return shape(this.model, found, args.select, args.include);
  }

  async deleteMany(args: Query = {}): Promise<{ count: number }> {
    const list = this.all();
    const hit = this.match(args.where);
    for (const row of hit) list.splice(list.indexOf(row), 1);
    markDirty(this.model);
    return { count: hit.length };
  }

  async updateMany(args: Query = {}): Promise<{ count: number }> {
    const m = meta(this.model);
    const hit = this.match(args.where);
    const data = (args.data ?? {}) as Shape;
    for (const row of hit) {
      for (const [key, value] of Object.entries(data)) {
        const field = m.fields.find((f) => f.name === key);
        if (field?.relation) continue;
        row[key] = writeValue(row[key], value);
      }
      for (const f of scalarFields(m)) {
        if (f.updatedAt) row[f.name] = new Date();
      }
    }
    markDirty(this.model);
    return { count: hit.length };
  }

  async count(args: Query = {}): Promise<number> {
    return this.match(args.where).length;
  }

  async groupBy(args: Query = {}): Promise<Row[]> {
    const by = (args.by ?? []) as string[];
    const hit = this.match(args.where);
    const buckets = new Map<string, { key: Row; list: Row[] }>();
    for (const row of hit) {
      const key: Row = {};
      for (const b of by) key[b] = row[b] ?? null;
      const id = JSON.stringify(key);
      const bucket = buckets.get(id) ?? { key, list: [] };
      bucket.list.push(row);
      buckets.set(id, bucket);
    }
    let out = [...buckets.values()].map(({ key, list }) => {
      const row: Row = { ...key };
      const count = args._count as Shape | undefined;
      if (count) {
        const c: Row = {};
        for (const [k, v] of Object.entries(count)) {
          if (k === '_all') c._all = list.length;
          else c[k] = list.filter((r) => r[k] !== null && r[k] !== undefined).length;
        }
        row._count = c;
      }
      for (const agg of ['_max', '_min', '_sum'] as const) {
        const spec = args[agg] as Shape | undefined;
        if (!spec) continue;
        const acc: Row = {};
        for (const k of Object.keys(spec)) {
          const values = list.map((r) => comparable(r[k])).filter((v): v is number => typeof v === 'number');
          if (!values.length) {
            acc[k] = null;
            continue;
          }
          acc[k] = agg === '_max' ? Math.max(...values) : agg === '_min' ? Math.min(...values) : values.reduce((a, b) => a + b, 0);
        }
        row[agg] = acc;
      }
      return row;
    });
    // groupBy 的排序写在聚合结果上（`orderBy: { _max: { createdAt: 'desc' } }`）
    const ob = args.orderBy as Shape | undefined;
    if (ob && typeof ob === 'object') {
      out.sort((a, b) => {
        for (const [agg, spec] of Object.entries(ob)) {
          for (const [k, dir] of Object.entries((spec ?? {}) as Shape)) {
            const av = (a[agg] as Row)?.[k];
            const bv = (b[agg] as Row)?.[k];
            const c = cmp(av, bv);
            if (c !== 0) return dir === 'desc' ? -c : c;
          }
        }
        return 0;
      });
    }
    if (typeof args.skip === 'number') out = out.slice(args.skip);
    if (typeof args.take === 'number') out = out.slice(0, args.take);
    return out;
  }
}

/**
 * 客户端类型。
 *
 * ⚠️ 这里是 `any`，是被迫的、也是诚实的：Prisma 能从 schema 生成出每个模型的行类型，
 * 而 JSON 存储在编译期不知道任何形状 —— 强行保留 `Record<string, Delegate>` 只会换来
 * 上百条「'row.id' is of type 'unknown'」的假错误（它们全在 `lib/` 里，本来就跑在主进程）。
 *
 * 另一个更硬的原因：上层有 `client: Pick<typeof db, 'asset'> = db` 这种写法。
 * 索引签名（`Record<string, Delegate>`）**不满足**「必须有一个叫 asset 的属性」，
 * 只有 `any` 能让这类 Pick 继续成立，否则 18 个数据文件要逐个改签名。
 */
export type Db = any;

function build(): Db {
  const client = {} as Record<string, any>;
  /*
   * `MODELS` 的键是 Prisma schema 里的**模型名**（`User`、`WalletEntry`），
   * 而上层的调用点写的是 Prisma Client 生成的**属性名** —— 首字母小写（`db.user`、
   * `db.walletEntry`）。两种都注册，省得全库去改大小写。
   * 只写小写会漏掉 `MODELS[name]` 内部的反查；只写原名则会让 `db.user.findUnique`
   * 直接是 undefined（第一版就是这么炸的）。
   */
  for (const name of Object.keys(MODELS)) {
    const d = new Delegate(name);
    client[name] = d;
    client[lowerFirst(name)] = d;
  }
  /*
   * 事务：单进程单用户，所有写都在内存里同步完成，所以这里就是「把同一个 client 交给回调」。
   * 没有回滚 —— 回调中途抛错前面已经改掉的行不会自动还原。
   * 当前用到事务的只有钱包（先改余额再记流水），钱包那侧自己保证「余额和流水一起写」，
   * 真要严格回滚得在这里加快照；先把这个缺口写清楚，别假装它是真的 ACID。
   */
  client.$transaction = async function $transaction<T>(fn: (c: Db) => Promise<T>): Promise<T> {
    return fn(client as Db);
  };
  return client as Db;
}

export const db = build();
export { Delegate };
