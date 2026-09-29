import 'server-only';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { WALLET_REASON, getBalance, grantWallet } from '@/lib/wallet';
import { resolvePlan } from './plans';
import { activateSubscription } from './subscriptions';

/**
 * 结算：把一个「渠道确认已付款」的订单落成事实 —— 标记已付 + 发余额，**在同一个事务里**。
 *
 * 为什么必须是同一个事务：这两件事分开做，中间失败就会留下
 * 「订单显示已支付、但积分没到账」，而这恰好是最难被用户接受、也最难事后修的一种状态
 * （客服看到订单是已付的，却说不清为什么余额没变）。
 *
 * 四条不许破的规矩：
 * 1. **金额核对在任何写入之前**。渠道回执金额与订单不一致就拒绝 —— 这是防「改金额」的最后一道闸。
 * 2. **不看 `expiresAt`**。任何渠道确认已付款的通知都要入账，哪怕本地已经把它判成过期。
 *    钱是真的；本地过期只是我们自己的超时估计，拿它去吞掉用户付出的钱是最不能接受的错。
 *    「不许对过期订单发起支付」是下单端的职责（前端 + 假网关的 pay 端点），不是这里的。
 * 3. **已退款（refunded）的订单拒绝再次入账**。钱已经退回去了。这种情况要人来看，不能自动处理。
 * 4. **重复回调返回成功而不是错误**。渠道重试是正常行为，回错误会让它一直重试；
 *    幂等命中就按成功回，同时 `duplicate: true` 让日志里能看出是重复。
 */

export type SettleInput = {
  orderNo: string;
  /** 渠道回执里的金额，单位「分」。 */
  amountFen: number;
  externalTradeNo?: string;
  /** 渠道原文，落库留证。 */
  raw?: unknown;
};

export type SettleResult =
  | {
      ok: true;
      duplicate: boolean;
      fen: number;
      balance: number | null;
      subscriptionId: string | null;
    }
  | { ok: false; reason: string };

/** 落库的回调原文要限长：它是排查用的，不是数据存储，别让一条畸形回调把行撑爆。 */
const RAW_LIMIT = 8 * 1024;

function safeRaw(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return undefined;
    if (text.length <= RAW_LIMIT) return JSON.parse(text) as Prisma.InputJsonValue;
    return { truncated: true, preview: text.slice(0, RAW_LIMIT) };
  } catch {
    return { truncated: true, preview: String(value).slice(0, 512) };
  }
}

/** 出问题时要看得见。`api()` 会把异常统一糊成一句「服务暂时不可用」，支付不能那样。 */
function complain(orderNo: string, reason: string) {
  console.error(`[payments] 结算被拒绝 orderNo=${orderNo}: ${reason}`);
}

export async function settleOrder(input: SettleInput): Promise<SettleResult> {
  const orderNo = String(input.orderNo || '').trim();
  if (!orderNo) return { ok: false, reason: '渠道回执缺少订单号' };
  if (!Number.isInteger(input.amountFen) || input.amountFen <= 0) {
    return { ok: false, reason: '渠道回执金额不合法（必须是正整数分）' };
  }

  try {
    return await db.$transaction(async tx => {
      const order = await tx.paymentOrder.findUnique({ where: { orderNo } });
      if (!order) {
        const reason = '订单不存在';
        complain(orderNo, reason);
        return { ok: false as const, reason };
      }

      if (order.status === 'paid') {
        return {
          ok: true as const, duplicate: true, fen: order.grantedFen,
          balance: await getBalance(order.userId, tx), subscriptionId: order.subscriptionId,
        };
      }
      if (order.status === 'refunded') {
        const reason = '订单已退款，拒绝再次入账（需人工核对）';
        complain(orderNo, reason);
        return { ok: false as const, reason };
      }
      if (input.amountFen !== order.amountFen) {
        const reason = `金额不符：渠道回执 ${input.amountFen} 分，订单 ${order.amountFen} 分`;
        complain(orderNo, reason);
        return { ok: false as const, reason };
      }

      await tx.paymentOrder.update({
        where: { id: order.id },
        data: {
          status: 'paid',
          paidAt: new Date(),
          externalTradeNo: input.externalTradeNo || order.externalTradeNo || null,
          raw: safeRaw(input.raw),
        },
      });

      let subscriptionId: string | null = order.subscriptionId;
      if (order.kind === 'subscription') {
        const plan = resolvePlan(order.planId);
        if (!plan || plan.kind !== 'subscription') {
          // 套餐下架/改名之后老订单又来了 —— 宁可整笔回滚并告警，也不能「收了钱什么都不发」。
          throw new Error(`订阅套餐「${order.planId}」已不在定价表里，无法发放周期余额`);
        }
        const activation = await activateSubscription({
          userId: order.userId, planId: plan.id, days: plan.days ?? 30,
          fenPerPeriod: order.grantedFen, orderNo,
        }, tx);
        subscriptionId = activation.subscriptionId;
        await tx.paymentOrder.update({ where: { id: order.id }, data: { subscriptionId } });
      } else {
        await grantWallet({
          userId: order.userId, amount: order.grantedFen, reason: WALLET_REASON.recharge,
          note: `充值 ${order.planId}（订单 ${orderNo}）`, refKey: order.id,
        }, tx);
      }

      return {
        ok: true as const, duplicate: false, fen: order.grantedFen,
        balance: await getBalance(order.userId, tx), subscriptionId,
      };
    });
  } catch (error) {
    /*
     * P2002 = WalletEntry 的 (reason, refKey) 唯一键冲突，说明另一个并发回调已经入过账了。
     * 事务已回滚，这次什么都没留下 —— 对调用方来说这就是「重复回调」，按成功回。
     */
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const order = await db.paymentOrder.findUnique({ where: { orderNo } });
      if (order) {
        return { ok: true, duplicate: true, fen: order.grantedFen, balance: await getBalance(order.userId), subscriptionId: order.subscriptionId };
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    complain(orderNo, `结算过程抛错：${reason}`);
    return { ok: false, reason: `结算失败：${reason}` };
  }
}
