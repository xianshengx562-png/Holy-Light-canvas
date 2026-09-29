/*
 * 站点账号（中转站的网站账号）—— **客户端**这一侧的唯一入口（2026-09-26 改成共享 store）。
 *
 * ⚠️ 后端那一层在 `lib/providers/site.ts`，它 `import 'server-only'`，客户端组件 import
 *    不到它的运行时，所以形状在这里手写一份，两边靠字段名对齐。
 *
 * ## 为什么是「模块级 store」而不是每个组件各自 `useApi`
 *
 * 侧栏（每页都在）、页头余额、用户页、模型服务页都要读同一份站点账号 ——
 * 各自拉一次的话，光打开一个页面就会往站点打三趟（每趟 = 续期判断 + 账号信息 + 令牌清单）。
 * 而站点那边有「同一 IP、20 次 / 20 分钟」的 `CriticalRateLimit`，
 * 白打几趟是实打实的代价（2026-09-25 徐先就是这么被 429 拦在登录页外的）。
 * 所以这里只留一份缓存、同一时刻只有一个 in-flight。
 */
import { useEffect, useSyncExternalStore } from 'react';
import { apiGet } from '@/lib/client';

export type SiteAccountToken = {
  /** 站点令牌表里的 id。换完整密钥时要用它（列表里那把 key 是打码的）。 */
  id: number;
  name: string;
  group: string;
  /** new-api：1 = 启用，2 = 已禁用。`null` = 站点没报。 */
  status: number | null;
  /** **打码**的 key —— 只能给人看，填进接口一律 401。 */
  masked: string;
};

export type SiteAccountView = {
  loggedIn: boolean;
  baseUrl: string;
  /** 站点回的显示名。 */
  username: string;
  /** 登录用的用户名（换账号时回填到表单里）。 */
  loginName: string;
  group: string;
  quota: number | null;
  usedQuota: number | null;
  /** 后端算好的「还剩多少钱」（quota 已按 500000 = ¥1 折过）。 */
  remainingYuan: number | null;
  quotaPerYuan: number;
  tokens: SiteAccountToken[];
  /** 站点那一趟没走通时的原因（库里还有上次读到的余额，照样显示）。 */
  error: string;
  /** 撞上限流时：歇到这个时刻（epoch ms）为止，余额自动刷新先停。 */
  cooldownUntil: number | null;
  /** 每一跳的流水账，不含任何 key。 */
  trace: string[];
};

export const EMPTY_SITE: SiteAccountView = {
  loggedIn: false,
  baseUrl: '',
  username: '',
  loginName: '',
  group: '',
  quota: null,
  usedQuota: null,
  remainingYuan: null,
  quotaPerYuan: 500_000,
  tokens: [],
  error: '',
  cooldownUntil: null,
  trace: [],
};

/** 余额怎么显示。不到 100 元给两位小数，多了就取整 —— 四位数带小数只会让人看花。 */
export function formatYuan(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  /* 0 要先接住：走下面的 toFixed(4) 会变成「¥0.」（尾随零被削光，只剩一个点）。 */
  if (value <= 0) return '¥0';
  if (value >= 100) return `¥${value.toFixed(0)}`;
  if (value >= 1) return `¥${value.toFixed(2)}`;
  return `¥${value.toFixed(4).replace(/0+$/, '')}`;
}

/** `https://www.myvigna.top` → `myvigna.top`。侧栏 / 账号那一行只放得下主机名。 */
export function siteHost(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** 一行说清「现在用的是哪个网站账号」。没登录返回空串，调用方自己决定怎么退化。 */
export function siteAccountLabel(site: SiteAccountView | null): string {
  if (!site?.loggedIn) return '';
  const who = site.username || site.loginName;
  const host = siteHost(site.baseUrl);
  if (who && host) return `${who} @ ${host}`;
  return who || host;
}

export type SiteAccountSnapshot = {
  site: SiteAccountView | null;
  loading: boolean;
  /** 读取失败的原因（站点连不上 / 未登录）。界面上通常不需要显示。 */
  error: string;
};

let snapshot: SiteAccountSnapshot = { site: null, loading: false, error: '' };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function put(next: SiteAccountSnapshot) {
  snapshot = next;
  emit();
}

/**
 * 接口刚回的那一份直接写进缓存。
 *
 * 登录 / 换账号的返回值里本来就带着最新的账号信息，走这条路**不会再打一趟站点** ——
 * 那正是限流最容易被撞上的地方。
 */
export function applySiteAccount(site: SiteAccountView | null) {
  put({ site, loading: false, error: '' });
}

/* ---------------- 余额静默刷新（2026-09-28） ---------------- */

/** 刷新回来的那一份：只有余额，**没有 tokens**（那一趟不打站点的令牌清单）。 */
export type SiteBalanceView = Omit<SiteAccountView, 'tokens' | 'trace'>;

/** 两次刷新之间至少隔这么久 —— 批量跑一轮会连着落十几个终态，一个一个真打出去必被限流。 */
const REFRESH_MIN_GAP_MS = 8000;

let refreshAt = 0;
/**
 * 撞上限流之后歇到什么时候（epoch ms，0 = 没在歇）。
 *
 * 站点说「慢点」是**对我们说的**，不只是对用户说的：界面上刚弹出「等两三分钟」，
 * 余额这边还每 2 分钟去撞一次的话，等于自己把自己按在限流里出不来
 * （那边是同一 IP、20 次 / 20 分钟，光余额这一项就够吃光）。
 */
let cooldownUntil = 0;

/** 页头余额排下一趟时问「该等多久」用的。 */
export function siteCooldownUntil(): number {
  return cooldownUntil;
}
/**
 * 排队中的那一次。
 *
 * 节流窗口里来的请求**只留最后一次**（不是「来一个丢一个」）：批量跑完最后一个节点
 * 落终态时那次一定要真发出去，否则「刚生成完余额没动」就成了新毛病。
 */
let refreshTimer: number | null = null;
let refreshing: Promise<void> | null = null;

function runRefresh(): Promise<void> {
  if (refreshing) return refreshing;
  refreshAt = Date.now();
  refreshing = apiGet<{ balance: SiteBalanceView }>('/api/site-account/refresh')
    .then((out) => {
      /* 站点说「慢点」就真慢下来：撞上限流时后端会把「歇到什么时候」带回来。 */
      cooldownUntil = Number(out.balance.cooldownUntil || 0);
      /* 期间登出 / 换号了就别把上一个账号的余额写回去。 */
      const latest = snapshot.site;
      if (!latest?.loggedIn) return;
      put({
        site: { ...latest, ...out.balance, tokens: latest.tokens, trace: latest.trace },
        loading: false,
        error: '',
      });
    })
    .catch(() => {
      /* 刷不到不算事：页头上还挂着上一次读到的那份，等下一趟。 */
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/**
 * 静默刷一次余额。
 *
 * 三个时机都会调它：生成落终态（画布 / 图片工作室）、窗口回前台、页面开着时每 2 分钟一趟。
 * 三条纪律：
 *  1. **不置 loading** —— 页头上那行数字不能因为刷新闪一下。
 *  2. **失败不报错** —— 站点抖一下不该在界面上升级成错误。
 *  3. **8 秒内不重复打，但不丢最后一次** —— 批量跑十几个节点会连着落十几个终态，
 *     真打十几趟站点，一轮就能撞掉 20 次 / 20 分钟的限流。
 */
export function refreshSiteAccount(): Promise<void> {
  /* 全量那趟正在飞的时候不用再刷 —— 它带回来的就是最新的。 */
  if (inflight) return inflight;
  if (!snapshot.site?.loggedIn) return Promise.resolve();
  /* 冷却中：站点刚说过「慢点」，这一趟整个省掉（用户自己点刷新不走这里）。 */
  if (Date.now() < cooldownUntil) return Promise.resolve();
  const wait = REFRESH_MIN_GAP_MS - (Date.now() - refreshAt);
  if (wait > 0) {
    if (refreshTimer === null) {
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void runRefresh();
      }, wait);
    }
    return Promise.resolve();
  }
  return runRefresh();
}

/**
 * 读一次站点账号。`force` 为真时忽略缓存（「刷新密钥」那个按钮）。
 * 同一时刻只会有一个请求在飞，后到的调用者拿到的是同一个 Promise。
 */
export function fetchSiteAccount(force = false): Promise<void> {
  if (inflight) return inflight;
  if (snapshot.site && !force) return Promise.resolve();
  put({ ...snapshot, loading: true });
  inflight = apiGet<{ site: SiteAccountView }>('/api/site-account')
    .then((out) => {
      /* 全量那一趟也可能撞上限流（换号 / 手动刷新），冷却照样认。 */
      cooldownUntil = Number(out.site.cooldownUntil || 0);
      put({ site: out.site, loading: false, error: '' });
    })
    .catch((error: unknown) => {
      /* 读不到（没登录 / 站点连不上）不是错误状态 —— 界面上就是「没登录」那一态。 */
      put({ site: null, loading: false, error: error instanceof Error ? error.message : '' });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 组件里读站点账号。第一次用到它的人顺手把数据拉回来（全站只会拉一趟）。 */
export function useSiteAccount(): SiteAccountSnapshot {
  useEffect(() => {
    void fetchSiteAccount();
  }, []);
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
