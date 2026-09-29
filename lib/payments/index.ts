import { configuredProviderName, mockPaymentsAllowed } from './guard';
import { alipayProvider } from './providers/alipay';
import { mockProvider } from './providers/mock';
import { wechatPayProvider } from './providers/wechat';
import type { PaymentProvider } from './types';

/**
 * 渠道注册表。**这个文件不引 `@/lib/api`、不碰数据库**，所以它能在裸 node 里被加载来测：
 * `activeProvider()` 返回的是判别式结果而不是抛异常，HTTP 状态码由调用方决定 ——
 * 把「用哪个渠道、能不能用」的判断和「怎么回 HTTP」分开，是这里唯一值得坚持的事。
 */

const REGISTRY: Record<string, PaymentProvider> = {
  mock: mockProvider,
  wechat: wechatPayProvider,
  alipay: alipayProvider,
};

export type ActiveProviderResult =
  | { ok: true; provider: PaymentProvider }
  | { ok: false; reason: string };

/**
 * 当前该用哪个渠道。
 *
 * **任何一个「拿不准」的情况都返回 ok:false，绝不回退到别的渠道。** 静默回退是本项目里
 * 最不能接受的一种「方便」：用户以为在付钱给微信，实际走了假网关，而订单看起来完全正常。
 */
export function activeProvider(): ActiveProviderResult {
  const name = configuredProviderName();
  if (!name) {
    return { ok: false, reason: '尚未配置支付渠道（服务端缺少 PAYMENT_PROVIDER）。' };
  }
  const provider = REGISTRY[name];
  if (!provider) {
    return { ok: false, reason: `未知的支付渠道「${name}」，可选：${Object.keys(REGISTRY).join(' / ')}。` };
  }
  if (!provider.available()) {
    return { ok: false, reason: provider.unavailableReason() };
  }
  return { ok: true, provider };
}

/** 按名字取渠道，给回调路由用（回调地址里带着渠道名，不能改成「当前生效的那个」）。 */
export function providerByName(name: string): PaymentProvider | null {
  const provider = REGISTRY[name.trim().toLowerCase()];
  if (!provider) return null;
  if (name.trim().toLowerCase() === 'mock' && !mockPaymentsAllowed()) return null;
  return provider;
}

/** 当前真正可用的渠道列表。给计费页显示「现在能用什么」，避免用户对着一个点不动的按钮猜。 */
export function enabledProviderNames(): string[] {
  return Object.values(REGISTRY).filter(provider => provider.available()).map(provider => provider.name);
}

export { configuredProviderName, mockPaymentsAllowed };
