import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

/**
 * 钱包：站长的 key 是公共资源，用它生成按次扣费；用户填了自己的 key 就不走这套，随便刷。
 *
 * 余额只有一个权威来源 —— Wallet.balance（单位「分」，整数）。WalletEntry 是账本，
 * 每次加减都写一行，出问题可以照着流水把账对回来。所有写操作都走本文件，别在别处直接 increment。
 *
 * 为什么是「分」而不是「元」：浮点做钱迟早差一分，而差一分就意味着对账永远对不上。
 * 界面显示时才用 `formatFen` 拼成「¥12.34」。
 */

/** 可以在 .env 里覆盖，改数字不用动代码。值都是「分」。 */
const DEFAULTS = {
  onSignup: 200, // 注册赠送 ¥2.00
  perGeneration: 10, // 每次生成扣 ¥0.10
};

function readCount(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** 每次生成扣的余额（分）。真实成本上线前按 provider 实际报价改这个值即可。 */
export function costPerGenerationFen() {
  return readCount('COST_PER_GENERATION_FEN', DEFAULTS.perGeneration);
}

/** 注册赠送的余额（分）。 */
export function signupBonusFen() {
  return readCount('SIGNUP_BONUS_FEN', DEFAULTS.onSignup);
}

/**
 * 白名单账号不受扣费限制 —— 站长自己用公共 key 不该被自己扣费。
 * 默认值是当前站点主人的账号，需要加人就在 .env 里写 `WALLET_UNLIMITED_EMAILS=a@x.com,b@y.com`。
 */
const DEFAULT_UNLIMITED = ['abc198168_2271410@qq.com'];

export function unlimitedEmails(): string[] {
  const raw = process.env.WALLET_UNLIMITED_EMAILS;
  const list = raw ? raw.split(',') : DEFAULT_UNLIMITED;
  return list.map(item => item.trim().toLowerCase()).filter(Boolean);
}

export function isUnlimited(email: string | null | undefined) {
  return Boolean(email) && unlimitedEmails().includes(email!.trim().toLowerCase());
}

export const WALLET_REASON = {
  /** 新账号赠送 */
  signup: 'signup_grant',
  /** 用公共 key 生成，扣费 */
  generation: 'generation',
  /** 生成失败退回 */
  refund: 'refund',
  /** 人工调整（后台改额、数据修复） */
  manual: 'manual',
  /** 充值到账（支付订单已付） */
  recharge: 'recharge',
  /**
   * 充值退款，把已经到账的余额扣回。
   * **刻意与 `refund` 分开**：那个是「生成失败把扣的费还回去」，这个是「钱退给用户、余额收回」，
   * 两者方向相同但语义相反，混用一个 reason 之后对账时再也分不清钱和费的来路。
   */
  rechargeRefund: 'recharge_refund',
} as const;

type Db = typeof db | Prisma.TransactionClient;

export type ChargeResult =
  | { ok: true; balance: number; duplicate: boolean }
  | { ok: false; balance: number };

export async function getBalance(userId: string, client: Db = db) {
  const account = await client.wallet.findUnique({ where: { userId }, select: { balance: true } });
  return account?.balance ?? 0;
}

/**
 * 一次入账。账户不存在就顺势建出来。
 * refKey 已经有同 reason 的记录时返回 null（幂等，不重复入账）。
 */
export async function grantWallet(
  input: { userId: string; amount: number; reason: string; note?: string; refKey?: string },
  client: Db = db,
): Promise<number | null> {
  const amount = Math.max(0, Math.floor(input.amount));
  if (amount === 0) return getBalance(input.userId, client);
  const existing = await findEntry(input.userId, input.reason, input.refKey, client);
  if (existing) return null;
  const account = await client.wallet.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, balance: amount },
    update: { balance: { increment: amount } },
    select: { balance: true },
  });
  await client.walletEntry.create({ data: {
    userId: input.userId, delta: amount, balanceAfter: account.balance,
    reason: input.reason, note: input.note, refKey: input.refKey,
  } });
  return account.balance;
}

/**
 * 扣费。扣不动（余额不足）时返回 ok:false —— 注意此时**没有**任何写入。
 *
 * 整段跑在一个事务里，不是为了「余额判断和扣减要原子」（那一条 UPDATE 本身就够了），
 * 而是为了让写进账本的 `balanceAfter` 准确：如果扣减和读余额分成两条独立语句，
 * 并发的另一个请求可能挤在中间再扣一次，账本上就会出现两行相同的 `balanceAfter`
 * （实测过：余额 3 并发扣三次会记成 1,1,0）。事务持有行锁到提交，这段窗口就没了。
 *
 * 余额判断用 `where balance >= amount`，靠行锁串行化，所以并发下不会扣成负数。
 * refKey 是第二道闸，防重复提交。
 */
export async function chargeWallet(
  input: { userId: string; amount: number; note?: string; refKey: string },
): Promise<ChargeResult> {
  const amount = Math.max(0, Math.floor(input.amount));
  if (amount === 0) return { ok: true, balance: await getBalance(input.userId), duplicate: false };
  try {
    return await db.$transaction(async tx => {
      const duplicate = await findEntry(input.userId, WALLET_REASON.generation, input.refKey, tx);
      if (duplicate) return { ok: true as const, balance: await getBalance(input.userId, tx), duplicate: true };
      const updated = await tx.wallet.updateMany({
        where: { userId: input.userId, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      const balance = await getBalance(input.userId, tx);
      if (!updated.count) return { ok: false as const, balance };
      await tx.walletEntry.create({ data: {
        userId: input.userId, delta: -amount, balanceAfter: balance,
        reason: WALLET_REASON.generation, note: input.note, refKey: input.refKey,
      } });
      return { ok: true as const, balance, duplicate: false };
    });
  } catch (error) {
    // 唯一键冲突说明另一个并发请求已经记过账了。事务已回滚，这次扣减没留下痕迹。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { ok: true, balance: await getBalance(input.userId), duplicate: true };
    }
    throw error;
  }
}

/** 生成失败时把扣掉的费用退回去。同一个 refKey 只退一次。 */
export async function refundGeneration(userId: string, refKey: string, client: Db = db) {
  const charge = await client.walletEntry.findFirst({
    where: { userId, reason: WALLET_REASON.generation, refKey },
    select: { delta: true },
  });
  if (!charge || charge.delta >= 0) return null;
  return grantWallet({ userId, amount: -charge.delta, reason: WALLET_REASON.refund, refKey, note: '生成失败，退回余额' }, client);
}

/**
 * 把已经发出去的余额扣回来 —— 退款走这条。
 *
 * **允许把余额扣成负数，这是刻意的。** 用户完全可能已经把充值的余额花掉了，
 * 这时候如果拒绝回扣，账本上就变成「钱退了、费还在」，和事实对不上；
 * 而下一次他再充值就白得一份额度。负余额才是真相，界面上如实显示即可。
 *
 * 与 `chargeWallet` 唯一的、也是本质的区别就在这里：那个带 `balance >= amount`
 * 条件（消费不许透支），这个不带（回扣必须成功）。**别把两个合并成一个函数**——
 * 合并之后必然要加一个 `allowNegative` 开关，而那种开关迟早会被传错值。
 *
 * refKey 语义与 `grantWallet` 一致：同一个 reason + refKey 只生效一次（退款幂等）。
 */
export async function clawbackWallet(
  input: { userId: string; amount: number; reason: string; note?: string; refKey?: string },
  client: Db = db,
): Promise<number | null> {
  const amount = Math.max(0, Math.floor(input.amount));
  if (amount === 0) return getBalance(input.userId, client);
  const existing = await findEntry(input.userId, input.reason, input.refKey, client);
  if (existing) return null;
  const account = await client.wallet.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, balance: -amount },
    update: { balance: { decrement: amount } },
    select: { balance: true },
  });
  await client.walletEntry.create({ data: {
    userId: input.userId, delta: -amount, balanceAfter: account.balance,
    reason: input.reason, note: input.note, refKey: input.refKey,
  } });
  return account.balance;
}

/** 新账号赠送。注册事务里调，账户和流水跟着用户一起提交或一起回滚。 */
export async function grantSignupWallet(userId: string, client: Db = db) {
  const amount = signupBonusFen();
  if (amount <= 0) return null;
  return grantWallet({ userId, amount, reason: WALLET_REASON.signup, note: `注册赠送 ¥${(amount / 100).toFixed(2)}` }, client);
}

async function findEntry(userId: string, reason: string, refKey: string | undefined, client: Db) {
  if (!refKey) return null;
  return client.walletEntry.findFirst({ where: { userId, reason, refKey }, select: { id: true } });
}

export type WalletOverview = {
  balance: number;
  unlimited: boolean;
  costPerGenerationFen: number;
  signupBonusFen: number;
};

export async function walletOverview(user: { id: string; email: string }): Promise<WalletOverview> {
  return {
    balance: await getBalance(user.id),
    unlimited: isUnlimited(user.email),
    costPerGenerationFen: costPerGenerationFen(),
    signupBonusFen: signupBonusFen(),
  };
}
