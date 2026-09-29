/**
 * 一行数据的形状，以及挂在它上面的**修订号**。
 *
 * 修订号（`_rev`）是给「乐观并发」用的：两个人（或两个窗口）同时改同一行时，
 * 后写的那一方要能知道自己拿到的是旧版本，而不是闷头覆盖掉别人的改动。
 *
 * ⚠️ 它刻意是**不可枚举**的隐藏属性：
 *   - `shape()` 按 `MODELS` 里的字段裁剪返回值，多出来的键会被丢掉，所以本来也带不出去；
 *   - 但 `JSON.stringify(row)` 会出现在报错信息里、也可能被上层拿去再写回库，
 *     隐藏掉可以让「行」在两种引擎（SQLite / JSON）下的可见内容完全一致。
 * 上层要拿到它必须显式 `select: { revision: true }`（见 `engine.ts`）。
 */

export type Row = Record<string, unknown>;

const REV = '_rev';

/** 没写过的行是 0；建出来/读出来之后至少是 1。 */
export function rowRevision(row: Row): number {
  const raw = row[REV];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

export function setRowRevision(row: Row, revision: number): void {
  Object.defineProperty(row, REV, {
    value: revision,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
