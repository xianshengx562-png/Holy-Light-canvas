/*
 * 站点请求的**进程内守门**（2026-10-13）。
 *
 * ## 为什么要有这一层
 *
 * 徐先现在有网页 / 手机 / 桌面三个客户端，**共用同一个后端**；而站点那条限流是
 * 「同一 IP、20 次 / 20 分钟」—— **按出口 IP 算，不看账号、不看客户端**。
 * 于是「几个客户端」直接变成乘数：
 *
 *   每 2 分钟刷一次余额 × 3 个客户端 = 每 20 分钟 30 次请求，光这一项就撞穿限流。
 *
 * 之前每个客户端各自持一份密码、各自维持一份会话，谁也不知道别人刚问过。
 * 这一层把两件事收到后端一处：
 *
 *  1. **登录**：同一用户同一时刻只允许一趟登录在飞，别的等着复用结果；
 *     刚登过的那把 JWT 在窗口内直接复用 —— 连问都不问站点。
 *  2. **余额**：客户端照旧每 2 分钟问后端，但**后端按自己的节奏去问站点**。
 *     站点侧的请求数与客户端数量脱钩，界面上「准实时」的观感一点没变。
 *
 * 🔴 为什么不做成「每个客户端自己少问点」：客户端数量是我们控制不了的
 *    （他随时能再加一个）。节流放在后端才收得住，放在客户端等于没做。
 *
 * ## 边界（别拿它当跨实例的全局配额）
 *
 * ⚠️ 这里是**进程内** Map：重启即失效，多实例部署各算各的。它守的是
 *    「同一进程里的重复」，不是「这个 IP 还剩多少次」。后者得靠站点那边，
 *    或者真上一个共享缓存（Redis 之类）—— 目前没必要。
 *
 * ⚠️ 所以 `loadSiteBalance` 里那个间隔是**按 userId** 记的：同一个后端的两个不同
 *    用户各走各的额度，仍会叠加。这是已知边界，先不做全局闸门 ——
 *    真到「一个后端几十个用户」那天再说，现在加了只会让单用户体验变钝。
 */
import { jwtLifetimeMs, shouldRenew } from './site-session';

/** 一把登录态：令牌 + 它的过期时刻（epoch ms）。 */
export type SiteSession = { token: string; expiresAt: number };

/**
 * 刚登过这么久之内，哪怕判「该续了」也直接复用。
 *
 * 防的是抖动：三个客户端同时进来，第一个刚登完，后两个如果各自再判一次
 * 「离过期不到 3.75 分钟」就会各登一次 —— 而它们要的那把令牌，其实就在眼前。
 */
const LOGIN_REUSE_MS = 30_000;

/**
 * 登录失败后这么久之内**不再试**。
 *
 * 🔴 这条最省额度：令牌过期 + 密码不对（或站点抽风）时，以前是每 2 分钟
 *    白打一趟登录。站点回的话不会因为多问一次就变，重试只是纯消耗。
 */
const LOGIN_FAIL_COOLDOWN_MS = 60_000;

/**
 * 后端侧去问站点余额的**最短间隔**。
 *
 * 客户端数量不该影响它 —— 这正是这一层存在的意义。3 分钟是这么来的：
 *  20 分钟里 6.7 趟余额 + 约 1.7 趟续期登录 ≈ 8.4 次，离 20 那条线还有一倍余量，
 *  够再开两三个客户端，也够生成结束那几趟额外的。
 * 真要改可以设 `SITE_BALANCE_MIN_GAP_MS`（毫秒）。
 */
const DEFAULT_BALANCE_MIN_GAP_MS = 180_000;

export function balanceMinGapMs(): number {
  const raw = Number(process.env.SITE_BALANCE_MIN_GAP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BALANCE_MIN_GAP_MS;
}

type SessionEntry = { session: SiteSession; at: number };
type BalanceEntry = { view: unknown; at: number };

/** 正在飞的登录（按用户）。 */
const inflight = new Map<string, Promise<SiteSession | null>>();
/** 上次登成功的那把。 */
const sessions = new Map<string, SessionEntry>();
/** 上次登录失败的时刻。 */
const failures = new Map<string, number>();
/** 上次问站点拿到的余额。 */
const balances = new Map<string, BalanceEntry>();

/** 上次登成功的那把（没有就是 null）。`at` 是登成功的时刻，用来算「刚登过」。 */
export function peekSession(userId: string): SessionEntry | null {
  return sessions.get(userId) ?? null;
}

/**
 * 记下这把登录态。
 *
 * `at` 是**登成功的时刻**，用来算「刚登过」。🔴 从库里回填那一把要传 `0` ——
 * 它不是这一进程登的，不该享受那个复用窗口（否则进程一重启，库里那把已经快过期的
 * 令牌会被当成「刚登过」，白撑 30 秒不去续，结果就是 401）。
 */
export function rememberSession(userId: string, session: SiteSession, at = Date.now()): void {
  sessions.set(userId, { session, at });
  failures.delete(userId);
}

export function rememberLoginFailure(userId: string, at = Date.now()): void {
  failures.set(userId, at);
}

/** 登出 / 换号：这一路缓存整个作废，否则会把上一个账号的余额回给下一个账号。 */
export function forgetSite(userId: string): void {
  sessions.delete(userId);
  failures.delete(userId);
  balances.delete(userId);
}

/** 登录失败冷却到什么时候（epoch ms）。没失败过就是 0。 */
export function loginBlockedUntil(userId: string): number {
  const at = failures.get(userId);
  return at ? at + LOGIN_FAIL_COOLDOWN_MS : 0;
}

/**
 * 同一用户的登录**串行化**：已经有在飞的那一个，后来者直接复用它的结果。
 *
 * 这就是「三个客户端同时进来只登一次」的那一半 —— 另一半是 `peekSession` 的复用窗口。
 */
export async function withSiteLogin(
  userId: string,
  run: () => Promise<SiteSession | null>,
): Promise<SiteSession | null> {
  const pending = inflight.get(userId);
  if (pending) return await pending;
  const task = (async () => {
    try {
      return await run();
    } finally {
      inflight.delete(userId);
    }
  })();
  inflight.set(userId, task);
  return await task;
}

/**
 * 这趟要不要真去登一次。
 *
 * - `reuse`  → 缓存里那把还能用（刚登过，或者还没进续期窗口），别打站点；
 * - `login`  → 真得去登（缓存没有 / 进了续期窗口）；
 * - `blocked`→ 刚失败过，冷却中，这一趟**整个省掉**。
 */
export function planSession(
  userId: string,
  now: number,
): { kind: 'reuse'; token: string } | { kind: 'login' } | { kind: 'blocked' } {
  const hit = sessions.get(userId);
  if (hit) {
    const justLoggedIn = now - hit.at < LOGIN_REUSE_MS;
    const stillFine = !shouldRenew(hit.session.expiresAt, now, jwtLifetimeMs(hit.session.token));
    if (justLoggedIn || stillFine) return { kind: 'reuse', token: hit.session.token };
  }
  if (now < loginBlockedUntil(userId)) return { kind: 'blocked' };
  return { kind: 'login' };
}

/**
 * 上次问站点拿到的余额（含它的年纪，毫秒）。没有就是 null。
 *
 * `now` 可以注入是为了能**离线推演**「几个客户端 × 多久刷一次 = 站点那边几趟」
 * —— 那笔账是这一层存在的理由，不能只靠肉估。
 */
export function peekBalance<T>(userId: string, now = Date.now()): { view: T; age: number } | null {
  const hit = balances.get(userId);
  if (!hit) return null;
  return { view: hit.view as T, age: now - hit.at };
}

export function rememberBalance(userId: string, view: unknown, at = Date.now()): void {
  balances.set(userId, { view, at });
}
