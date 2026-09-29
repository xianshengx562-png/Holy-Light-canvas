/**
 * `@prisma/client` 的最小替身（只给主进程用）。
 *
 * 桌面版不用 Prisma 了 —— `lib/db` 换成了 userData 里的 JSON 存储。但上层有 8 个文件
 * 还从 `@prisma/client` 拿东西（`Prisma.DbNull`、`Prisma.TransactionClient`、
 * 两个错误类型、几个行类型）。把它们一个个改掉会牵出一大片无意义的 diff，
 * 这里给一份语义等价的替身，`lib/` 就**一行都不用动**。
 *
 * 唯一有真实行为的两个成员：
 *  - `DbNull`：写进 Json 列表示「存成 SQL NULL」而不是 JSON 的 `null`。
 *    查询引擎认这个对象（`writeValue` 里特判）。
 *  - 两个错误类：`lib/api.ts` 靠它们把「唯一键冲突」翻译成 409。
 */
export namespace Prisma {
  export type JsonValue = unknown;
  export type InputJsonValue = unknown;
  export type AssetWhereInput = Record<string, unknown>;
  export type TransactionClient = unknown;

  /** 写进 Json 列 = 存 SQL NULL。必须是**同一个对象**，查询引擎按引用比较。 */
  export const DbNull: { readonly __frameDbNull: true } = { __frameDbNull: true } as const;
  /** 写进 Json 列 = 存 JSON 的 `null`（与 DbNull 相对）。 */
  export const JsonNull: { readonly __frameJsonNull: true } = { __frameJsonNull: true } as const;

  export class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, options: { code: string }) {
      super(message);
      this.name = 'PrismaClientKnownRequestError';
      this.code = options.code;
    }
  }

  export class PrismaClientInitializationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PrismaClientInitializationError';
    }
  }
}

export { Prisma as default };

/** `lib/payments/orders.ts` 用它标注行类型。字段按 schema 列，宽松到 unknown 以免误报。 */
export type PaymentOrder = {
  id: string;
  orderNo: string;
  userId: string;
  provider: string;
  kind: string;
  planId: string;
  amountFen: number;
  grantedFen: number;
  status: string;
  externalTradeNo: string | null;
  paidAt: Date | null;
  expiresAt: Date;
  refundedAt: Date | null;
  raw: unknown;
  subscriptionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type Subscription = {
  id: string;
  userId: string;
  planId: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  autoRenew: boolean;
  amountPerPeriodFen: number;
  createdAt: Date;
  updatedAt: Date;
};

/** 保留这个名字只是为了让 `import { PrismaClient }` 不至于编译不过；真用它应该报错。 */
export class PrismaClient {
  constructor(_options?: unknown) {
    throw new Error('桌面版不再使用 PrismaClient，请用 @/lib/db');
  }
}
