import 'server-only';
import type { Prisma, Subscription } from '@prisma/client';
import { db } from '@/lib/db';
import { WALLET_REASON, grantWallet } from '@/lib/wallet';
import { SUBSCRIPTION_PLANS } from './plans';

/**
 * 订阅的生命周期。三条设计取舍，都是刻意的：
 *
 * 1. **按周期发余额，不是「订阅期间免扣费」。** 后者会绕开 `chargeWallet` 的并发安全与账本，
 *    等于给同一条链路养出第二套计费路径 —— 那种 bug 是静默的，只会体现在某个月的账对不上。
 * 2. **惰性过期，不靠 cron。** 读取时顺手判定 `currentPeriodEnd`，过期就地改状态。
 *    定时任务在这个项目里是纯负债：多一个必须常驻的进程，少一个就永远没人发现。
 * 3. **不自动扣款。** 真自动续费要签约代扣（微信「委托扣款」/ 支付宝「周期扣款」），
 *    是另一套资质与协议。`autoRenew` 当前只表达用户意愿，续期仍需手动支付。
 */

type Db = typeof db | Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 取当前订阅。**已到期就地置为 expired** —— 所以调用方拿到的状态一定是当下有效的，
 * 不需要自己再比一次时间（比两次时间就会有两处判断，迟早有一处忘了改）。
 */
export async function currentSubscription(userId: string, client: Db = db): Promise<Subscription | null> {
  const subscription = await client.subscription.findUnique({ where: { userId } });
  if (!subscription) return null;
  if (subscription.status === 'active' && subscription.currentPeriodEnd.getTime() <= Date.now()) {
    return client.subscription.update({ where: { id: subscription.id }, data: { status: 'expired' } });
  }
  return subscription;
}

export type ActivationResult = {
  subscriptionId: string;
  periodStart: Date;
  periodEnd: Date;
  /** 这一期余额是否真的入账了（false = 幂等命中，之前已经发过） */
  granted: boolean;
};

/**
 * 订阅订单支付成功后：建立或顺延订阅，并发放这一期的积分。
 *
 * **续期是「顺延」不是「从今天重算」**：提前续费不该亏掉剩余天数。
 * 所以新周期的起点 = `max(当前周期结束, 现在)`，而不是 `now`。
 *
 * 幂等有两层：
 *   - `settleOrder` 保证一笔订单只会走到这里一次；
 *   - 积分流水的 `refKey = <订阅 id>:<周期起点>` —— 万一真的重入，
 *     `CreditEntry` 的 `@@unique([reason, refKey])` 也会挡住第二次发放。
 *     这一层不能省：它防的是「同一段时间被两个订单重复覆盖」这种设计外的情况。
 */
export async function activateSubscription(
  input: { userId: string; planId: string; days: number; fenPerPeriod: number; orderNo: string },
  client: Db,
): Promise<ActivationResult> {
  const now = new Date();
  const existing = await client.subscription.findUnique({ where: { userId: input.userId } });

  let subscriptionId: string;
  let periodStart: Date;
  let periodEnd: Date;

  if (existing) {
    const stillRunning = existing.currentPeriodEnd.getTime() > now.getTime();
    // 还在有效期内就从原结束时间往后接，已经过期了就从现在起算。
    const base = stillRunning ? existing.currentPeriodEnd : now;
    periodStart = base;
    periodEnd = new Date(base.getTime() + input.days * DAY_MS);
    const updated = await client.subscription.update({
      where: { id: existing.id },
      data: {
        planId: input.planId,
        status: 'active',
        // 顺延时把「当前周期」整体挪到新的一段，跟 periodEnd 保持一致，免得界面上出现
        // 一个起点比终点还晚的周期。
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        amountPerPeriodFen: input.fenPerPeriod,
      },
    });
    subscriptionId = updated.id;
  } else {
    periodStart = now;
    periodEnd = new Date(now.getTime() + input.days * DAY_MS);
    const created = await client.subscription.create({
      data: {
        userId: input.userId,
        planId: input.planId,
        status: 'active',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        amountPerPeriodFen: input.fenPerPeriod,
      },
    });
    subscriptionId = created.id;
  }

  const refKey = `${subscriptionId}:${periodStart.toISOString()}`;
  const balance = await grantWallet({
    userId: input.userId,
    amount: input.fenPerPeriod,
    reason: WALLET_REASON.recharge,
    note: `订阅 ${input.planId} 周期余额（订单 ${input.orderNo}）`,
    refKey,
  }, client);

  return { subscriptionId, periodStart, periodEnd, granted: balance !== null };
}

export type SubscriptionSummary = {
  planId: string;
  planLabel: string;
  status: string;
  active: boolean;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  amountPerPeriodFen: number;
  autoRenew: boolean;
  /** 剩余天数（向上取整）。已过期为 0。界面直接显示，不用客户端再算一次（时区会不一致）。 */
  daysLeft: number;
};

/** 给页面/接口用的序列化形状。同样不让 `Subscription` 的原始行直接出站。 */
export function subscriptionSummary(subscription: Subscription | null): SubscriptionSummary | null {
  if (!subscription) return null;
  const plan = SUBSCRIPTION_PLANS.find(item => item.id === subscription.planId);
  const leftMs = subscription.currentPeriodEnd.getTime() - Date.now();
  return {
    planId: subscription.planId,
    planLabel: plan?.label ?? subscription.planId,
    status: subscription.status,
    active: subscription.status === 'active' && leftMs > 0,
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    amountPerPeriodFen: subscription.amountPerPeriodFen,
    autoRenew: subscription.autoRenew,
    daysLeft: leftMs > 0 ? Math.ceil(leftMs / DAY_MS) : 0,
  };
}
