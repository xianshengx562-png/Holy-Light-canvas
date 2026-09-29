/*
 * 中转站（new-api / one-api 系）的**网站账号**（2026-09-25）。
 *
 * 这一层只干三件事：登录、读账号（余额 / 分组）、列这个账号已有的密钥。
 * ⚠️ **不建令牌** —— 徐先明确说「也不用自动创建了，直接拉取登录账号密钥」。
 *   站点上有什么就用什么：用户自己在网站上建的那些令牌，本来就是他知道自己想要哪一把。
 *
 * 三个绕不开的事实（都是对着 `myvigna.top` = New API v1.0.0-rc.40 实测出来的）：
 *
 *  1. **JWT 只打得开 `/api/*`**，调 `/v1/*` 得用令牌表里那把 `sk-`。
 *  2. **列表接口给的是打码的 key**（`buildMaskedTokenResponses`）：`sk-AB**********xyzw`。
 *     填进 Holy Light画布一律 401，而且界面上看着像填好了 —— 比留空更难查。
 *     所以「添加」某一把时，必须再打一次 `POST /api/token/<id>/key` 拿完整密钥。
 *  3. **分组清单要打 `/api/user/self/groups`**；`/api/group/` 挂 `AdminAuth`，非管理员 403。
 *
 * ⚠️ 登录之后的写操作（取完整密钥）**必须带 `Authorization: Bearer <JWT>`**：
 *    2026-09-25 真机就是漏了这个头，`POST /api/token/17/key` 一直 401。
 */
import { db } from '@/lib/db';
import { encryptSecret, decryptSecret } from './secret';
import { createCustomProvider } from './custom';
import { probeCustomProvider } from './custom';
import type { CustomModelKind } from './custom';
import { QUOTA_PER_YUAN, remainingYuanOf } from './site-quota';
import {
  classifyStep, pickFailureReason, rateLimitCooldownUntil, retryDelayMs,
  shouldRetryStep, shouldTryNextPath,
  type SiteStep, type SiteStepKind,
} from './site-errors';
import { jwtLifetimeMs, shouldRenew } from './site-session';

/** 换算规则搬去 `./site-quota` 了（那边能单独编出来跑断言）。这里 re-export 是为了不动已有引用。 */
export { QUOTA_PER_YUAN };

const TIMEOUT_MS = 15_000;
/*
 * 「提前多久续期」不再是一个固定值 —— 见 `./site-session`。
 * 短寿命的 JWT 用固定的 1 小时会导致**每一趟都先重登一次**，而余额是每 2 分钟刷的，
 * 那等于自己把站点那条限流吃光。
 */

const LOGIN_PATHS = ['/api/user/login', '/api/auth/login', '/api/login'];
const SELF_PATHS = ['/api/user/self', '/api/user/me', '/api/user/info'];
const TOKEN_PATHS = ['/api/token/', '/api/tokens/'];

export type SiteToken = {
  /** 站点令牌表里的 id。取完整密钥时要用它。 */
  id: number;
  name: string;
  group: string;
  status: number | null;
  /** 列表里那把**打码**的 key —— 只能给人看，不能用。 */
  masked: string;
};

export type SiteView = {
  loggedIn: boolean;
  baseUrl: string;
  /** 站点回的显示名。 */
  username: string;
  /** 登录用的用户名（换账号时要回填到表单里）。 */
  loginName: string;
  group: string;
  quota: number | null;
  usedQuota: number | null;
  /** 算好的「还剩多少钱」。界面上直接显示这个，别让前端再算一遍。 */
  remainingYuan: number | null;
  quotaPerYuan: number;
  tokens: SiteToken[];
  error: string;
  /** 撞上限流时：歇到这个时刻（epoch ms）为止，自动轮询先停。没撞上就是 null。 */
  cooldownUntil: number | null;
  /** 每一跳的流水账（不含任何 key）—— 排查用。 */
  trace: string[];
};

const EMPTY: SiteView = {
  loggedIn: false, baseUrl: '', username: '', loginName: '', group: '',
  quota: null, usedQuota: null, remainingYuan: null, quotaPerYuan: QUOTA_PER_YUAN,
  tokens: [], error: '', cooldownUntil: null, trace: [],
};

function root(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

/** 回包是不是「业务上失败」—— 站点用 `success:false` + `message` 报「密码错了」那类。 */
function failMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const one = body as Record<string, unknown>;
  if (one.success === false) return String(one.message ?? '站点拒绝了这次请求。');
  const data = one.data;
  if (data && typeof data === 'object' && (data as Record<string, unknown>).success === false) {
    return String((data as Record<string, unknown>).message ?? '站点拒绝了这次请求。');
  }
  return null;
}

/**
 * 一跳的结果。
 *
 * `kind` 决定两件事：**还要不要试下一条路径**，以及**全试完之后该说哪一句**。
 * 规矩在 `./site-errors`：404 只说明「这条路不通」，它不是失败的原因。
 */
type Step = { body: unknown; note: string | null; status: number; kind: SiteStepKind };

/** 连不上 / 超时那句人话。 */
function unreachableNote(error: unknown): string {
  return error instanceof Error && /timed out|abort/i.test(error.message)
    ? '响应超时（15 秒）。'
    : '连不上。';
}

/**
 * 网络抖了一下（连不上 / 超时）就**同一个地址再试一次**。
 *
 * ⚠️ 只重试「根本没拿到响应」那一类（规矩见 `site-errors.ts` 的 `shouldRetryStep`）：
 *    被拒绝、401、404、429 都不重试 —— 再问一百次还是同一个答案，
 *    还会把站点那点限流额度白吃掉。
 * ⚠️ 重试的是**同一个地址**，不是「换下一条路径」—— 那是 `shouldTryNextPath` 的事。
 */
async function withRetry(run: () => Promise<Step>, trace: string[], what: string): Promise<Step> {
  let step = await run();
  let failed = 0;
  while (shouldRetryStep(step.kind)) {
    const delay = retryDelayMs(failed + 1);
    if (delay === null) break;
    failed += 1;
    trace.push(`${what} → ${step.note || '没拿到响应'}，${delay} 毫秒后再试一次`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    step = await run();
  }
  return step;
}

async function postJson(url: string, payload: unknown, token?: string): Promise<Step> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    if (looksLikeHtml(text)) {
      return {
        body: null, note: `${url} 回的是网页不是接口（站点地址填成后台首页了？）。`,
        status: response.status, kind: 'bad-shape',
      };
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        body: null, note: `${url} 返回的不是 JSON（HTTP ${response.status}）。`,
        status: response.status, kind: 'bad-shape',
      };
    }
    /*
     * 站点明说了原因（密码错、人机校验没过…）—— 这比状态码有用。
     * ⚠️ 但**不能**顺手把它定死成「你填错了」：限流的回包也是 success:false，
     *    429 + 「请求太频繁」说的是「等一会儿」，不是「你不对」——
     *    归类的活统一交给 classifyStep，那边的顺序就是为这种回包排的。
     */
    const failed = failMessage(body);
    if (failed || !response.ok) {
      return {
        body: null, note: failed || `${url} 返回 HTTP ${response.status}。`,
        status: response.status,
        kind: classifyStep({ ok: response.ok, status: response.status, businessMessage: failed }),
      };
    }
    if (!response.ok) {
      return {
        body: null, note: `${url} 返回 HTTP ${response.status}。`, status: response.status,
        kind: classifyStep({ ok: false, status: response.status }),
      };
    }
    return { body, note: null, status: response.status, kind: 'ok' };
  } catch (error) {
    return { body: null, note: unreachableNote(error), status: 0, kind: 'unreachable' };
  }
}

async function getJson(url: string, token: string): Promise<Step> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    if (looksLikeHtml(text)) {
      return {
        body: null, note: `${url} 回的是网页（站点地址填成后台首页了？）。`,
        status: response.status, kind: 'bad-shape',
      };
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        body: null, note: `${url} 返回的不是 JSON（HTTP ${response.status}）。`,
        status: response.status, kind: 'bad-shape',
      };
    }
    if (!response.ok) {
      return {
        body: null, note: `${url} 返回 HTTP ${response.status}。`, status: response.status,
        kind: classifyStep({ ok: false, status: response.status }),
      };
    }
    return { body, note: null, status: response.status, kind: 'ok' };
  } catch (error) {
    return { body: null, note: unreachableNote(error), status: 0, kind: 'unreachable' };
  }
}

/**
 * 站点把后台首页挂在根路径上：路径猜错的请求一律 200 + 一整页 HTML。
 * 不判这一下的话，后面 `JSON.parse` 会在一个 HTML 上炸，报出来的错跟真正的原因差着十万八千里。
 */
function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 200).trim().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<script');
}

function pickString(body: unknown, key: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const one = body as Record<string, unknown>;
  const data = (one.data && typeof one.data === 'object' ? one.data : {}) as Record<string, unknown>;
  const hit = data[key] ?? one[key];
  return typeof hit === 'string' && hit.trim() ? hit.trim() : null;
}

function pickNumber(body: unknown, key: string): number | null {
  if (!body || typeof body !== 'object') return null;
  const one = body as Record<string, unknown>;
  const data = (one.data && typeof one.data === 'object' ? one.data : {}) as Record<string, unknown>;
  const hit = data[key] ?? one[key];
  return typeof hit === 'number' && Number.isFinite(hit) ? hit : null;
}

/**
 * 登录：换 JWT + 它的过期时间（`access_expires_at`，没有就按 12 小时算）。
 *
 * `steps` 会把每一跳的**分类**带出去，调用方拿它挑一句最有用的给人看。
 *
 * ⚠️ 站点明说了原因（密码错、人机校验没过）就**停下**：继续往下试只会拿到一串 404，
 *    而以前报的是最后一条 —— 于是「密码错了」被显示成「HTTP 404」（见 `site-errors.ts`）。
 */
async function login(base: string, username: string, password: string, trace: string[], steps: SiteStep[] = []) {
  for (const path of LOGIN_PATHS) {
    const step = await withRetry(
      () => postJson(`${base}${path}`, { username, password }),
      trace, `登录 ${base}${path}`,
    );
    const record: SiteStep = { kind: step.kind, what: '登录', path, detail: step.note ?? '' };
    steps.push(record);
    trace.push(`登录 ${base}${path} → HTTP ${step.status}${step.note ? `：${step.note}` : ''}`);
    if (step.kind === 'ok') {
      const token = pickString(step.body, 'access_token') ?? pickString(step.body, 'token');
      /* 回了 200 却没给令牌 —— 换下一条路径再试，这条不算「站点拒绝了」。 */
      if (!token) continue;
      const expires = pickNumber(step.body, 'access_expires_at');
      const at = expires && expires > 0 ? new Date(expires * 1000) : new Date(Date.now() + 12 * 3600 * 1000);
      return { token, expiresAt: at };
    }
    if (!shouldTryNextPath(record)) break;
  }
  return null;
}

async function loadSelf(base: string, token: string, trace: string[], steps: SiteStep[] = []) {
  for (const path of SELF_PATHS) {
    const step = await withRetry(() => getJson(`${base}${path}`, token), trace, `账号信息 ${base}${path}`);
    const record: SiteStep = { kind: step.kind, what: '账号信息', path, detail: step.note ?? '' };
    steps.push(record);
    trace.push(`账号信息 ${base}${path} → HTTP ${step.status}${step.note ? `：${step.note}` : ''}`);
    if (step.kind === 'ok' && step.body) {
      return {
        username: pickString(step.body, 'display_name') ?? pickString(step.body, 'username') ?? '',
        group: pickString(step.body, 'group') ?? '',
        quota: pickNumber(step.body, 'quota'),
        usedQuota: pickNumber(step.body, 'used_quota'),
      };
    }
    if (!shouldTryNextPath(record)) break;
  }
  return null;
}

/** `data.items` / `data` 两种形状都认，摊平成一行一行。 */
function tokenRows(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== 'object') return [];
  const one = body as Record<string, unknown>;
  const data = (one.data && typeof one.data === 'object' ? one.data : one) as Record<string, unknown>;
  const list = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
  return list.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
}

async function listTokens(base: string, token: string, trace: string[], steps: SiteStep[] = []): Promise<SiteToken[]> {
  for (const path of TOKEN_PATHS) {
    const step = await withRetry(
      () => getJson(`${base}${path}?p=0&size=50`, token),
      trace, `令牌清单 ${base}${path}`,
    );
    const record: SiteStep = { kind: step.kind, what: '令牌清单', path, detail: step.note ?? '' };
    steps.push(record);
    trace.push(`令牌清单 ${base}${path} → HTTP ${step.status}${step.note ? `：${step.note}` : ''}`);
    if (step.kind === 'ok' && step.body) {
      const rows = tokenRows(step.body);
      trace.push(`令牌清单 ${base}${path} → ${rows.length} 把`);
      return rows.map((row) => ({
        id: Number(row.id ?? 0) || 0,
        name: String(row.name ?? ''),
        group: String(row.group ?? ''),
        status: typeof row.status === 'number' ? row.status : null,
        masked: String(row.key ?? ''),
      })).filter((row) => row.id > 0);
    }
    if (!shouldTryNextPath(record)) break;
  }
  return [];
}

/**
 * 候选写法。new-api 是 `POST /api/token/<id>/key`；有别的部署把同一件事挂在 GET 上，
 * 所以两个都试 —— **但 404 只说明「这条不通」，换下一条，不是原因**（见 `site-errors.ts`）。
 */
const KEY_CANDIDATES: { method: 'post' | 'get'; path: (id: number) => string }[] = [
  { method: 'post', path: (id) => `/api/token/${id}/key` },
  { method: 'get', path: (id) => `/api/token/${id}/key` },
];

/** 完整密钥。列表里那把是打码的，只有这个接口给真的。 */
export async function fetchFullKey(
  base: string, token: string, id: number, trace: string[] = [], steps: SiteStep[] = [],
): Promise<string | null> {
  for (const candidate of KEY_CANDIDATES) {
    const path = candidate.path(id);
    const url = `${base}${path}`;
    const step = await withRetry(
      () => (candidate.method === 'post' ? postJson(url, {}, token) : getJson(url, token)),
      trace, `取完整密钥 ${candidate.method.toUpperCase()} ${url}`,
    );
    const record: SiteStep = { kind: step.kind, what: '取完整密钥', path, detail: step.note ?? '' };
    steps.push(record);
    trace.push(`取完整密钥 ${candidate.method.toUpperCase()} ${url} → HTTP ${step.status}${step.note ? `：${step.note}` : ''}`);
    if (step.kind === 'ok') {
      const key = pickString(step.body, 'key');
      if (key && !key.includes('*')) return key;
      /* 给了但仍然是打码的 —— 站点就是不让你看这把，换一种写法也不会变。 */
      if (key) {
        trace.push('站点给的是打码的密钥，不能用。');
        steps.push({ kind: 'rejected', what: '取完整密钥', path, detail: '站点只给了打码的密钥（这把它可能不让你看）。' });
        break;
      }
      continue;
    }
    if (!shouldTryNextPath(record)) break;
  }
  return null;
}

type Row = {
  id: string;
  baseUrl: string;
  username: string;
  encryptedPassword: string;
  encryptedToken: string;
  tokenExpiresAt: Date | string | null;
  siteUsername: string;
  group: string;
  quota: number | null;
  usedQuota: number | null;
  lastError: string;
};

function toView(
  row: Row | null, tokens: SiteToken[], trace: string[], error = '',
  cooldownUntil: number | null = null,
): SiteView {
  if (!row) return { ...EMPTY, trace, error, cooldownUntil };
  /* 站点回的 `quota` 本身就是「还剩多少」；`usedQuota` 只是累计流水，不参与（见 site-quota.ts）。 */
  const remaining = row.quota;
  return {
    loggedIn: true,
    baseUrl: row.baseUrl,
    username: row.siteUsername || row.username,
    loginName: row.username,
    group: row.group,
    quota: row.quota,
    usedQuota: row.usedQuota,
    remainingYuan: remainingYuanOf(remaining, row.usedQuota),
    quotaPerYuan: QUOTA_PER_YUAN,
    tokens,
    error,
    cooldownUntil,
    trace,
  };
}

async function readRow(userId: string): Promise<Row | null> {
  return await db.siteAccount.findFirst({
    where: { userId },
    select: {
      id: true, baseUrl: true, username: true, encryptedPassword: true, encryptedToken: true,
      tokenExpiresAt: true, siteUsername: true, group: true, quota: true, usedQuota: true, lastError: true,
    },
  }) as Row | null;
}

/**
 * 读一次账号（余额 + 令牌清单）。
 *
 * JWT 快过期就**用存的密码重新登一次** —— 这就是「记住登录」能一直生效的原因。
 * 站点那一趟失败不算崩：库里还有上次读到的余额，照样显示，只是把原因带回去。
 */
export async function loadSiteAccount(userId: string): Promise<SiteView> {
  const row = await readRow(userId);
  if (!row) return { ...EMPTY };

  const trace: string[] = [];
  const steps: SiteStep[] = [];
  const base = root(row.baseUrl);
  let token = row.encryptedToken ? decryptSecret(row.encryptedToken) : null;
  const expires = row.tokenExpiresAt ? new Date(row.tokenExpiresAt).getTime() : 0;
  /* 阈值跟着这把 JWT 自己的寿命走（短寿命的不能每次都重登，见 `./site-session`）。 */
  const stale = !token || shouldRenew(expires, Date.now(), jwtLifetimeMs(token));

  if (stale) {
    const password = row.encryptedPassword ? decryptSecret(row.encryptedPassword) : null;
    if (!password) {
      return toView(row, [], trace, '存的登录状态过期了，而且没记住密码 —— 重新登录一次。');
    }
    const fresh = await login(base, row.username, password, trace, steps);
    if (!fresh) {
      /* 说站点真正说的那句（密码错了？地址不对？），不是最后一条 404。 */
      const why = pickFailureReason(steps, '重新登录失败 —— 站点地址或密码变了？');
      await db.siteAccount.update({ where: { id: row.id }, data: { lastError: why } });
      return toView(row, [], trace, why, rateLimitCooldownUntil(steps, Date.now()));
    }
    token = fresh.token;
    await db.siteAccount.update({
      where: { id: row.id },
      data: { encryptedToken: encryptSecret(fresh.token), tokenExpiresAt: fresh.expiresAt, lastError: '' },
    });
    trace.push('令牌已续期（用记住的密码重新登录）');
  }

  const self = await loadSelf(base, token as string, trace, steps);
  const tokens = await listTokens(base, token as string, trace, steps);
  if (!self) {
    const why = pickFailureReason(steps, '读不到账号信息（站点可能改版了）。');
    await db.siteAccount.update({ where: { id: row.id }, data: { lastError: why } });
    return toView(row, tokens, trace, why, rateLimitCooldownUntil(steps, Date.now()));
  }

  await db.siteAccount.update({
    where: { id: row.id },
    data: {
      siteUsername: self.username,
      group: self.group,
      quota: self.quota,
      usedQuota: self.usedQuota,
      lastError: '',
    },
  });
  return toView({ ...row, siteUsername: self.username, group: self.group, quota: self.quota, usedQuota: self.usedQuota }, tokens, trace);
}

/** 登录并记住。`password` 会加密落盘 —— 不存的话第二天 JWT 过期就连不上了。 */
export async function connectSite(
  userId: string,
  input: { baseUrl: string; username: string; password: string },
): Promise<SiteView> {
  const base = root(input.baseUrl);
  const trace: string[] = [];
  if (!/^https?:\/\//i.test(base)) throw new Error('站点地址要以 http:// 或 https:// 开头。');

  const steps: SiteStep[] = [];
  const session = await login(base, input.username, input.password, trace, steps);
  if (!session) {
    /*
     * ⚠️ 以前这里抛的是 `trace` 的**最后一条** —— 也就是最后那个候选路径的 404，
     *    而真正的原因（第一个路径回的「用户名或密码错误」）被它冲掉了。
     *    现在按有用程度挑：站点说过的话优先，404 只在没别的线索时才说。
     */
    throw new Error(pickFailureReason(steps, '登录失败，检查一下地址、用户名和密码。'));
  }

  const existing = await readRow(userId);
  const data = {
    userId,
    baseUrl: base,
    username: input.username,
    encryptedPassword: encryptSecret(input.password),
    encryptedToken: encryptSecret(session.token),
    tokenExpiresAt: session.expiresAt,
    siteUsername: '',
    group: '',
    quota: null,
    usedQuota: null,
    lastError: '',
  };
  if (existing) await db.siteAccount.update({ where: { id: existing.id }, data });
  else await db.siteAccount.create({ data });

  return await loadSiteAccount(userId);
}

/** 换账号 / 退出：整行删掉（连密码一起），不留任何凭据。 */
export async function clearSite(userId: string): Promise<void> {
  await db.siteAccount.deleteMany({ where: { userId } });
}

/**
 * 把站点上**已有**的某一把密钥加成 Holy Light画布的兼容接口。
 *
 * 关键一步：列表里那把 key 是打码的，必须先换完整密钥才能用。
 * 名字取「站点域名 · 令牌名」—— 站点上有好几把的时候，一眼能认出加的是哪一把。
 */
export async function useSiteToken(
  userId: string,
  tokenId: number,
  kind: CustomModelKind,
): Promise<{ id: string; name: string; baseUrl: string; models: number }> {
  /* 先读一次账号：它顺手把快过期的 JWT 续上，下面取完整密钥才不会 401。 */
  const view = await loadSiteAccount(userId);
  if (!view.loggedIn) throw new Error('还没有登录站点。');

  const fresh = await readRow(userId);
  if (!fresh) throw new Error('还没有登录站点。');
  const base = root(fresh.baseUrl);
  const jwt = decryptSecret(fresh.encryptedToken);
  if (!jwt) throw new Error('登录状态没了，重新登录一次。');

  const trace: string[] = [];
  const steps: SiteStep[] = [];
  const key = await fetchFullKey(base, jwt, tokenId, trace, steps);
  if (!key) {
    /* 同上：说站点真正回的那句（不让你看 / 这条路径不存在 / 登录态没了），别含糊成一句。 */
    throw new Error(pickFailureReason(steps, '拿不到这把令牌的完整密钥（站点只给了打码的，或者不让你看这把）。'));
  }

  const picked = view.tokens.find((item) => item.id === tokenId);
  const host = base.replace(/^https?:\/\//i, '');
  const name = `${host} · ${picked?.name || '令牌'}${picked?.group ? `(${picked.group})` : ''}`;

  /*
   * 顺手探一次模型清单：加完就能在节点里选模型，不用再去点「拉取模型」。
   * 探不到也算成功 —— 接口照样建，只是模型清单是空的（用户可以之后自己拉）。
   */
  let models: { id: string; name: string; kinds: CustomModelKind[] }[] = [];
  try {
    const probe = await probeCustomProvider({ baseUrl: base, apiKey: key, defaultKind: kind });
    if (probe.ok && probe.models?.length) {
      models = probe.models.map((item: { id: string; name?: string }) => ({
        id: item.id, name: item.name || item.id, kinds: [kind],
      }));
    }
  } catch {
    /* 探不到就空着，不影响建接口 */
  }

  const created = await createCustomProvider(userId, { name, baseUrl: base, apiKey: key, models });
  return { id: created.id, name: created.name, baseUrl: created.baseUrl, models: models.length };
}

/* ---------------- 余额刷新（2026-09-28） ---------------- */

/** `SiteView` 里**只跟余额有关**的那一半。刷新接口回的就是它 —— 令牌清单不在其中。 */
export type SiteBalanceView = {
  loggedIn: boolean;
  baseUrl: string;
  username: string;
  loginName: string;
  group: string;
  quota: number | null;
  usedQuota: number | null;
  remainingYuan: number | null;
  quotaPerYuan: number;
  error: string;
  /** 同上：撞上限流时歇到这个时刻（epoch ms），余额自动刷新按它退避。 */
  cooldownUntil: number | null;
};

function toBalance(row: Row | null, error = '', cooldownUntil: number | null = null): SiteBalanceView {
  if (!row) {
    return {
      loggedIn: false, baseUrl: '', username: '', loginName: '', group: '',
      quota: null, usedQuota: null, remainingYuan: null, quotaPerYuan: QUOTA_PER_YUAN, error,
      cooldownUntil,
    };
  }
  /* 同上：`quota` 就是剩余额度。 */
  const remaining = row.quota;
  return {
    loggedIn: true,
    baseUrl: row.baseUrl,
    username: row.siteUsername || row.username,
    loginName: row.username,
    group: row.group,
    quota: row.quota,
    usedQuota: row.usedQuota,
    remainingYuan: remainingYuanOf(remaining, row.usedQuota),
    quotaPerYuan: QUOTA_PER_YUAN,
    error,
    cooldownUntil,
  };
}

/**
 * 只刷余额：打站点的 `/api/user/self` **一次**，**不列令牌清单**。
 *
 * 跟 `loadSiteAccount` 就差这一步，但差的正是关键那一步：站点那边有
 * 「同一 IP、20 次 / 20 分钟」的 `CriticalRateLimit`，而余额是**定时**去问的
 * （前端每 2 分钟一趟 + 每次生成结束时一趟）。每趟省掉一半请求，
 * 才谈得上「准实时」这四个字 —— 否则刷几次就被 429 拦在门外。
 *
 * 续期那段与 `loadSiteAccount` 一致：JWT 快过期就用记住的密码重新登一次。
 * 站点那一趟失败不算崩：库里还留着上次读到的余额，照样显示，只是把原因带回去。
 */
export async function loadSiteBalance(userId: string): Promise<SiteBalanceView> {
  const row = await readRow(userId);
  if (!row) return toBalance(null);

  const trace: string[] = [];
  const steps: SiteStep[] = [];
  const base = root(row.baseUrl);
  let token = row.encryptedToken ? decryptSecret(row.encryptedToken) : null;
  const expires = row.tokenExpiresAt ? new Date(row.tokenExpiresAt).getTime() : 0;
  /* 同上：余额是定时刷的，这里的阈值更不能写死。 */
  const stale = !token || shouldRenew(expires, Date.now(), jwtLifetimeMs(token));

  if (stale) {
    const password = row.encryptedPassword ? decryptSecret(row.encryptedPassword) : null;
    if (!password) return toBalance(row, '存的登录状态过期了，而且没记住密码 —— 重新登录一次。');
    const fresh = await login(base, row.username, password, trace, steps);
    if (!fresh) {
      const why = pickFailureReason(steps, '重新登录失败 —— 站点地址或密码变了？');
      await db.siteAccount.update({ where: { id: row.id }, data: { lastError: why } });
      return toBalance(row, why, rateLimitCooldownUntil(steps, Date.now()));
    }
    token = fresh.token;
    await db.siteAccount.update({
      where: { id: row.id },
      data: { encryptedToken: encryptSecret(fresh.token), tokenExpiresAt: fresh.expiresAt, lastError: '' },
    });
  }

  const self = await loadSelf(base, token as string, trace, steps);
  if (!self) {
    const why = pickFailureReason(steps, '读不到账号信息（站点可能改版了）。');
    await db.siteAccount.update({ where: { id: row.id }, data: { lastError: why } });
    return toBalance(row, why, rateLimitCooldownUntil(steps, Date.now()));
  }

  await db.siteAccount.update({
    where: { id: row.id },
    data: {
      siteUsername: self.username,
      group: self.group,
      quota: self.quota,
      usedQuota: self.usedQuota,
      lastError: '',
    },
  });
  return toBalance({ ...row, siteUsername: self.username, group: self.group, quota: self.quota, usedQuota: self.usedQuota });
}
