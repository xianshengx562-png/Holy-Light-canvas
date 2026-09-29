/**
 * 站点令牌（JWT）**什么时候该续**（2026-09-29）。
 *
 * ## 为什么要单独算
 *
 * 原来是「距离过期不到 1 小时就重新登录一次」。这条对 new-api 默认那种
 * 「一天寿命」的 JWT 挺好，但对**短寿命**的令牌是灾难：
 *
 *   JWT 只有 30 分钟 → 剩下多少都小于 1 小时 → **每一趟都先重登一次**。
 *
 * 而余额是**定时**刷的（前端每 2 分钟一趟 + 每次生成结束一趟）。于是每 2 分钟
 * 白搭一趟登录，十几分钟就把站点那条「同一 IP、20 次 / 20 分钟」的限流吃光 ——
 * 吃光之后的表现是「什么都失败」，看着跟软件坏了没两样。
 *
 * 所以阈值要跟着**这把令牌自己的寿命**走：寿命长的照旧提前 1 小时，
 * 寿命短的只提前它自己寿命的一小截。
 *
 * ## 寿命从哪来
 *
 * JWT 的载荷（中间那段 base64）里就写着 `exp` 与 `iat`，不必再去问站点。
 * 解不出来（自定义格式 / 不透明令牌）就按老规矩（1 小时）走 ——
 * 猜不出来的时候退回**以前的行为**永远比换一套新的安全。
 *
 * ⚠️ 不引 `server-only`：渲染进程与回归脚本都要能加载它。
 */

/** 解不出寿命时的老规矩：提前 1 小时续。 */
export const DEFAULT_RENEW_BEFORE_MS = 60 * 60 * 1000;

/** 再短也得留这么多提前量 —— 太贴着过期时间续，稍微慢一点就已经过期了。 */
const MIN_RENEW_BEFORE_MS = 60 * 1000;

/** 寿命的几分之一就开始准备续期。 */
const RENEW_RATIO = 4;

/**
 * 从 JWT 里读寿命（毫秒）。**解不出来返回 null** —— 调用方退回默认值。
 *
 * JWT 形如 `hhhh.pppp.ssss`：只解中间那段（载荷），不验签 ——
 * 验签是站点的事，我们只是想提前知道自己什么时候该去换一把新的。
 */
export function jwtLifetimeMs(token: string): number | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const payload = decodeBase64Url(parts[1]);
  if (!payload) return null;
  let body: unknown = null;
  try {
    body = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const row = body as Record<string, unknown>;
  const exp = toSeconds(row.exp);
  const iat = toSeconds(row.iat);
  /*
   * 只有 `exp` 没有 `iat` 时也算不出来寿命 —— 不知道它是什么时候发的。
   * 硬猜一个（比如「现在」）会把寿命算成 0，那反而更糟。
   */
  if (exp === null || iat === null) return null;
  const life = (exp - iat) * 1000;
  return life > 0 ? life : null;
}

function toSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** base64url → 字符串。Node 与浏览器都有 `atob`，但别指望它在每个运行时里都有。 */
function decodeBase64Url(text: string): string {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/');
    const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4);
    if (typeof atob === 'function') {
      /* 中文 / 非拉丁字符要按字节还原，不然 JSON.parse 会炸。 */
      const raw = atob(withPad);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return Buffer.from(withPad, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 距离过期还有多久就该续。
 *
 * - 解不出寿命 → 老规矩 1 小时；
 * - 寿命长（≥ 4 小时）→ 1 小时；
 * - 寿命短 → 它自己寿命的 1/4，**但不短于 1 分钟**。
 */
export function renewBeforeMs(lifetimeMs: number | null): number {
  if (lifetimeMs === null || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) return DEFAULT_RENEW_BEFORE_MS;
  return Math.max(MIN_RENEW_BEFORE_MS, Math.min(DEFAULT_RENEW_BEFORE_MS, Math.round(lifetimeMs / RENEW_RATIO)));
}

/**
 * 这把令牌现在算不算「该续了」。
 *
 * `expiresAtMs` 是过期时刻（毫秒）；传 0 / NaN 表示「不知道」——
 * 不知道就当该续，那是以前的行为。
 */
export function shouldRenew(expiresAtMs: number, now: number, lifetimeMs: number | null): boolean {
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return true;
  return expiresAtMs - now < renewBeforeMs(lifetimeMs);
}
