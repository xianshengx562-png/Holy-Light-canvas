/**
 * 支付渠道的开关判断。**纯函数、不引 server-only、不碰数据库**，方便回归脚本直接加载来测 ——
 * 而这个文件里的每一条判断都值得单独测：判错的代价是「假网关在生产环境可用」，
 * 也就是一个能把任意订单标成已付、白送积分的后门。
 */

export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * 假网关能不能用。
 *
 * 默认「非生产环境可用」，可以用 `PAYMENTS_ALLOW_MOCK=0/1` 显式覆盖。
 * 覆盖的用途有两个，都很实际：
 *   1. 生产环境想彻底焊死后门（默认已经关了，但显式写一句 `PAYMENTS_ALLOW_MOCK=0` 更放心）；
 *   2. 回归脚本要在一个**开着** mock 的服务器上验正常链路，同时要另一个**关掉** mock
 *      的场景来验「关掉之后真的进不来」—— 两种都得测，所以需要一个能被测到的开关。
 *
 * 注意判断读的是**调用时的** `process.env`，不是模块加载时的快照。
 */
export function mockPaymentsAllowed() {
  const flag = process.env.PAYMENTS_ALLOW_MOCK?.trim().toLowerCase();
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  return !isProduction();
}

/**
 * 当前生效的渠道名。
 *
 * 生产环境**没有默认值**：没配 `PAYMENT_PROVIDER` 就返回空串，由调用方明确报错。
 * 这一点不能松 —— 如果生产默认回退到 mock，那「忘了配」的后果不是收不到钱，
 * 而是页面上一键就能自己给自己发积分。
 */
export function configuredProviderName() {
  const explicit = process.env.PAYMENT_PROVIDER?.trim().toLowerCase();
  if (explicit) return explicit;
  return isProduction() ? '' : 'mock';
}

/** 回调地址。渠道方要能直接 POST 到这个地址，所以必须是外网可达的绝对地址。 */
export function notifyUrlFor(requestUrl: string, provider: string) {
  const base = process.env.APP_URL?.trim() || new URL(requestUrl).origin;
  return `${base.replace(/\/$/, '')}/api/payments/notify/${provider}`;
}

export function returnUrlFor(requestUrl: string) {
  const base = process.env.APP_URL?.trim() || new URL(requestUrl).origin;
  return `${base.replace(/\/$/, '')}/settings/billing`;
}
