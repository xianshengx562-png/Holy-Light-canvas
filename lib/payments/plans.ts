/**
 * 定价表 —— **金额与到账余额的唯一来源**。
 *
 * 下单接口只接受一个 `planId`，金额和到账余额都从这里查出来。**绝不要让客户端传金额**：
 * 「请求体里带个 amount，服务端照着建单」是支付系统最经典的一个洞，改个数字就能一分钱买一万块。
 *
 * 订单存的是**成交时的快照**（`amountFen` / `grantedFen` 两列），所以改这里的价格
 * 不会动到任何历史订单 —— 这是刻意留的，别把订单的金额改成「每次去查定价表」。
 *
 * ⚠️ 下面的价格是**占位值**，上线前必须按真实成本改一遍（改这一个文件就够）。
 */

export type TopUpPlan = {
  id: string;
  label: string;
  /** 充值金额，单位「分」。人民币一律存整数分，不用浮点。 */
  amountFen: number;
  note?: string;
  highlight?: boolean;
};

export type SubscriptionPlan = {
  id: string;
  label: string;
  /** 每个周期发放的余额（分） */
  amountPerPeriodFen: number;
  /** 一个周期多少天 */
  days: number;
  note?: string;
  highlight?: boolean;
};

/** 一次性充值。1:1：充 ¥X 到账 ¥X，没有隐性加价。 */
export const TOPUP_PLANS: TopUpPlan[] = [
  { id: 'topup-10', label: '充值 ¥10', amountFen: 1000, note: '到账 ¥10.00', highlight: true },
  { id: 'topup-30', label: '充值 ¥30', amountFen: 3000, note: '到账 ¥30.00' },
  { id: 'topup-100', label: '充值 ¥100', amountFen: 10000, note: '到账 ¥100.00' },
  { id: 'topup-300', label: '充值 ¥300', amountFen: 30000, note: '到账 ¥300.00' },
];

/**
 * 订阅套餐。**按周期发余额**，不是「订阅期间免扣费」。
 *
 * 为什么不做成免扣费：那会绕开 `chargeWallet` 的并发安全与账本，等于给同一条链路
 * 养出第二套计费路径 —— 这类 bug 是静默的，只体现在某个月的账单对不上。
 *
 * **不自动扣款**：真自动续费要签约代扣（微信「委托扣款」/ 支付宝「周期扣款」），
 * 那是另一套资质。到期后需要用户手动续费，续期时 `currentPeriodEnd` 顺延而不是从当天重算。
 */
export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  { id: 'monthly-basic', label: '包月 · 基础', amountPerPeriodFen: 4900, days: 30, note: '每月到账 ¥49.00', highlight: true },
  { id: 'monthly-pro', label: '包月 · 进阶', amountPerPeriodFen: 12900, days: 30, note: '每月到账 ¥129.00' },
];

export type PlanKind = 'topup' | 'subscription';

export type ResolvedPlan = {
  kind: PlanKind;
  id: string;
  label: string;
  amountFen: number;
  /** 支付成功后应到账的余额（分） */
  fen: number;
  days?: number;
};

/** 按 id 查出「这一单该收多少钱、该到账多少余额」。查不到返回 null，调用方一律按 400 处理。 */
export function resolvePlan(planId: string): ResolvedPlan | null {
  const topup = TOPUP_PLANS.find(plan => plan.id === planId);
  if (topup) {
    return { kind: 'topup', id: topup.id, label: topup.label, amountFen: topup.amountFen, fen: topup.amountFen };
  }
  const subscription = SUBSCRIPTION_PLANS.find(plan => plan.id === planId);
  if (subscription) {
    return {
      kind: 'subscription', id: subscription.id, label: subscription.label,
      amountFen: subscription.amountPerPeriodFen, fen: subscription.amountPerPeriodFen, days: subscription.days,
    };
  }
  return null;
}

/** 只用来显示（"¥39.00"）。**任何参与计算的金额都必须是分**，别拿它的返回值去算钱。 */
export function formatFen(fen: number) {
  const sign = fen < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(fen));
  return `${sign}¥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * 定价表自检。给回归脚本用 —— 定价表是「配置」，而配置错误不会有编译期报错：
 * 两个档位共用一个 id、价格写成 0、到账余额写成负数，全都会安安静静地生效，
 * 直到有人真花了钱才发现。返回空数组表示没问题。
 */
export function planProblems(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const check = (kind: string, id: string, amountFen: number, fen: number, days?: number) => {
    if (seen.has(id)) problems.push(`id 重复：${id}`);
    seen.add(id);
    if (!id.trim()) problems.push(`${kind} 有空 id`);
    if (!Number.isInteger(amountFen) || amountFen <= 0) problems.push(`${id} 的价格不是正整数分：${amountFen}`);
    if (!Number.isInteger(fen) || fen <= 0) problems.push(`${id} 的到账余额不是正整数分：${fen}`);
    if (days !== undefined && (!Number.isInteger(days) || days <= 0)) problems.push(`${id} 的周期天数不合法：${days}`);
  };
  for (const plan of TOPUP_PLANS) check('充值', plan.id, plan.amountFen, plan.amountFen);
  for (const plan of SUBSCRIPTION_PLANS) check('订阅', plan.id, plan.amountPerPeriodFen, plan.amountPerPeriodFen, plan.days);
  return problems;
}
