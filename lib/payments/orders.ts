import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PaymentOrder } from '@prisma/client';
import { db } from '@/lib/db';
import { WALLET_REASON, clawbackWallet, getBalance } from '@/lib/wallet';
import { notifyUrlFor, returnUrlFor } from './guard';
import { activeProvider } from './index';
import { formatFen, resolvePlan } from './plans';

/**
 * 订单的建立、过期与退款。
 *
 * 这里所有对外的返回值都走 `publicOrder()` 过一遍 —— 订单行里有 `raw`（渠道原文）
 * 这类不该出站的东西，逐处手写 `select` 迟早会漏，不如统一一道闸。
 */

/** 订单有效期。太短会让用户扫到一半就过期，太长会让一堆待付单堆在库里。 */
export const ORDER_TTL_MS = 15 * 60 * 1000;

/**
 * 对外单号。前 14 位是下单时间（人工排查时一眼能看出是哪天哪一刻的），
 * 后面 10 位随机（防猜 —— 单号会出现在 URL 里，不能让它可枚举）。
 */
export function newOrderNo(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `F${stamp}${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

export type PublicOrder = {
  orderNo: string;
  provider: string;
  kind: string;
  planId: string;
  planLabel: string;
  amountFen: number;
  amountLabel: string;
  grantedFen: number;
  status: string;
  paidAt: string | null;
  expiresAt: string;
  createdAt: string;
};

export function publicOrder(order: PaymentOrder): PublicOrder {
  const plan = resolvePlan(order.planId);
  return {
    orderNo: order.orderNo,
    provider: order.provider,
    kind: order.kind,
    planId: order.planId,
    // 套餐可能已经下架，这时退回显示 planId —— 不要编一个假名字出来。
    planLabel: plan?.label ?? order.planId,
    amountFen: order.amountFen,
    amountLabel: formatFen(order.amountFen),
    grantedFen: order.grantedFen,
    status: order.status,
    paidAt: order.paidAt?.toISOString() ?? null,
    expiresAt: order.expiresAt.toISOString(),
    createdAt: order.createdAt.toISOString(),
  };
}

/**
 * 惰性过期：列出订单前顺手把超时的待付单置为 expired。
 *
 * 又是「不引 cron」的同一套取舍。顺带说明为什么过期不是可选的：
 * 一份永远停在 pending 的订单，用户看不懂（「我到底付没付？」），
 * 而且下次他想重新下单时会被自己这条卡住。
 */
export async function expireStaleOrders(userId?: string) {
  const result = await db.paymentOrder.updateMany({
    where: { status: 'pending', expiresAt: { lt: new Date() }, ...(userId ? { userId } : {}) },
    data: { status: 'expired' },
  });
  return result.count;
}

export type CreateOrderResult =
  | {
      ok: true;
      order: PublicOrder;
      provider: string;
      payload: unknown;
      /** 给渠道后台配置用；也方便本地用 curl 手工造回调 */
      notifyUrl: string;
    }
  | { ok: false; reason: string };

/**
 * 下单。**只接受 planId** —— 金额和积分数一律由服务端的定价表算出，
 * 请求里带 amount / credits 一律当没看见（这是支付系统最经典的一个洞）。
 */
export async function createOrder(input: { userId: string; planId: string; requestUrl: string }): Promise<CreateOrderResult> {
  const plan = resolvePlan(String(input.planId || '').trim());
  if (!plan) return { ok: false, reason: '没有这个套餐。' };

  const active = activeProvider();
  if (!active.ok) return { ok: false, reason: active.reason };

  const notifyUrl = notifyUrlFor(input.requestUrl, active.provider.name);
  const orderNo = newOrderNo();
  const order = await db.paymentOrder.create({
    data: {
      orderNo,
      userId: input.userId,
      provider: active.provider.name,
      kind: plan.kind,
      planId: plan.id,
      amountFen: plan.amountFen,
      grantedFen: plan.fen,
      expiresAt: new Date(Date.now() + ORDER_TTL_MS),
    },
  });

  try {
    const charge = await active.provider.createCharge({
      orderNo,
      amountFen: plan.amountFen,
      subject: `Holy Light画布 ${plan.label}`,
      notifyUrl,
      returnUrl: returnUrlFor(input.requestUrl),
    });
    return { ok: true, order: publicOrder(order), provider: active.provider.name, payload: charge.payload, notifyUrl };
  } catch (error) {
    /*
     * 下单失败（渠道不通、密钥有问题）就把订单置为 failed，别留一条永远 pending 的垃圾 ——
     * 那会让用户在订单列表里看到一笔「等待支付」但根本没有支付入口的单子。
     */
    await db.paymentOrder.update({ where: { id: order.id }, data: { status: 'failed' } }).catch(() => {});
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[payments] 下单失败 orderNo=${orderNo}: ${reason}`);
    return { ok: false, reason };
  }
}

/**
 * 退款结果。
 * `kind` 是给调用方映射 HTTP 状态码用的 —— 库这一层不该知道 HTTP，但调用方需要能区分
 * 「找不到」「状态不允许」「渠道那边没成功」。靠匹配错误文案来区分的那种写法，
 * 改一次文案就崩，所以宁可在这里多一个字段。
 */
export type RefundResult =
  | { ok: true; grantedFen: number; balance: number | null }
  | { ok: false; kind: 'not_found' | 'not_refundable' | 'provider_failed'; reason: string };

/**
 * 退款。**只有站长能调**（路由层把关），且只能对已支付的订单退。
 *
 * 顺序是：先向渠道申请退款 → 成功了再改本地状态 + 扣回积分。
 * 反过来（先改本地）一旦渠道退款失败，就成了「积分扣了、钱没退」，
 * 那比「钱退了、积分还在」更糟 —— 用户会来投诉一笔他没收到的退款。
 */
export async function refundOrder(input: { orderNo: string }): Promise<RefundResult> {
  const orderNo = String(input.orderNo || '').trim();
  const order = await db.paymentOrder.findUnique({ where: { orderNo } });
  if (!order) return { ok: false, kind: 'not_found', reason: '订单不存在。' };
  if (order.status === 'refunded') return { ok: false, kind: 'not_refundable', reason: '这笔订单已经退过款了。' };
  if (order.status !== 'paid') {
    return { ok: false, kind: 'not_refundable', reason: `只有已支付的订单能退款，当前状态是 ${order.status}。` };
  }

  const provider = activeProvider();
  if (provider.ok && provider.provider.name === order.provider && provider.provider.refund) {
    const outcome = await provider.provider.refund({
      orderNo, amountFen: order.amountFen, externalTradeNo: order.externalTradeNo ?? undefined,
    });
    if (!outcome.ok) {
      console.error(`[payments] 渠道退款失败 orderNo=${orderNo}: ${outcome.note || '未说明原因'}`);
      return { ok: false, kind: 'provider_failed', reason: `渠道退款未成功：${outcome.note || '未说明原因'}` };
    }
  } else if (order.provider !== 'mock') {
    /*
     * 真渠道但适配器不支持退款时，**绝不假装退成功**：钱还在我们这儿，
     * 把订单标成 refunded 会让账面以为钱已经出去了。让操作者去渠道后台手工退。
     */
    return {
      ok: false, kind: 'provider_failed',
      reason: `当前渠道「${order.provider}」不支持自助退款，请到渠道后台手工处理后再来标记。`,
    };
  }

  const balance = await db.$transaction(async tx => {
    await tx.paymentOrder.update({ where: { id: order.id }, data: { status: 'refunded', refundedAt: new Date() } });
    // 订阅单退款要把订阅一并取消，否则用户白拿下一期的额度。
    if (order.subscriptionId) {
      await tx.subscription.updateMany({ where: { id: order.subscriptionId }, data: { status: 'cancelled' } });
    }
    /*
     * 扣回积分用 clawback（允许扣成负数）：用户很可能已经把充值的积分花掉了，
     * 这时候拒绝回扣只会让账本和事实脱节。负余额是真相。
     */
    await clawbackWallet({
      userId: order.userId, amount: order.grantedFen, reason: WALLET_REASON.rechargeRefund,
      note: `退款回扣（订单 ${orderNo}）`, refKey: order.id,
    }, tx);
    return getBalance(order.userId, tx);
  });

  return { ok: true, grantedFen: order.grantedFen, balance };
}

/** 查单用的归属校验：**别人的订单一律当作不存在**，不要回 403（403 等于确认单号存在）。 */
export async function findOrderForUser(orderNo: string, userId: string) {
  return db.paymentOrder.findFirst({ where: { orderNo, userId } });
}
