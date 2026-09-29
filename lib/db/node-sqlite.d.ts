/**
 * `node:sqlite` 的最小类型声明。
 *
 * 工程里装的是 `@types/node@20`，那一版还没有 `node:sqlite`（它是 Node 22.5 之后才有的），
 * 直接 `import { DatabaseSync } from 'node:sqlite'` 会报「找不到模块」。
 * 而 Electron 44 内置的 Node 是 24，运行时**确实有** —— 缺的只是编译期的类型。
 *
 * 所以这里只声明真正用到的那几个方法（`exec` / `prepare` / `run` / `all` / `close`），
 * 不追求覆盖全部 API。等 @types/node 升到 22+ 之后这份文件可以直接删掉。
 */

declare module 'node:sqlite' {
  export type DatabaseSyncOptions = {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
  };

  export type RunResult = {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };

  export interface StatementSync {
    /** 绑定参数只能是 null / number / bigint / string / Uint8Array，布尔要自己转成 0/1。 */
    run(...params: unknown[]): RunResult;
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
