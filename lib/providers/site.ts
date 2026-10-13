/*
 * 中转站（new-api / one-api 系）的**网站账号**（2026-09-25）。
 *
 * 这一层干四件事：应用内注册（走邮箱验证码）、登录、读账号（余额 / 分组）、
 * 建令牌并把它加成 Holy Light画布的兼容接口。
 *
 * ⚠️ 「建不建令牌」这条口径 **2026-10-12 翻过一次**：
 *    2026-09-25 徐先的原话是「也不用自动创建了，直接拉取登录账号密钥」；
 *    2026-10-12 他要的是「不用用户到网页端去创建密钥」→ 注册完由应用自己建一把。
 *    🔴 老口径那条路（`useSiteToken`：列站点上已有的令牌、挑一把加进来）**保留没删** ——
 *       站点上本来就有好几把的场景照样得靠它。两条路并存，不是替换。
 *
 * 四个绕不开的事实（都是对着 `myvigna.top` = New API v1.0.0-rc.41 实测出来的）：
 *
 *  1. **JWT 只打得开 `/api/*`**，调 `/v1/*` 得用令牌表里那把 key（不是 JWT）。
 *  2. **列表接口给的是打码的 key**（`buildMaskedTokenResponses`）：`sk-AB**********xyzw`。
 *     填进 Holy Light画布一律 401，而且界面上看着像填好了 —— 比留空更难查。
 *     所以「添加」某一把时，必须再打一次 `POST /api/token/<id>/key` 拿完整密钥。
 *  3. **分组清单要打 `/api/user/self/groups`**；`/api/group/` 挂 `AdminAuth`，非管理员 403。
 *  4. 🔴 **建令牌 `POST /api/token/` 的回包不给 id**（只有 `{"success":true,"message":""}`）
 *     → 建完必须**列一次清单按名字找回**，没有别的办法拿到 id。
 *
 * ⚠️ 登录之后的写操作（建令牌、取完整密钥）**必须带 `Authorization: Bearer <JWT>`**：
 *    2026-09-25 真机就是漏了这个头，`POST /api/token/17/key` 一直 401。
 *
 * ## 注册那一路（2026-10-12 逐条实测）
 *
 *  · 发验证码是 **`GET /api/verification?email=...`** —— **GET 带 query**，
 *    `POST /api/verification` 是 404（同一路径换方法就换了个接口，别照登录那套写）。
 *  · 注册是 `POST /api/user/register`，验证码的字段名是 **`verification_code`**，
 *    🔴 写成 `code` 会被**静默当成没给**，只回一句「请输入邮箱和验证码」——
 *       看着像用户没填，其实是字段名错了。
 *  · 站点开了 `email_verification` 才要验证码；关掉的话这一步整个可以省。
 *  · `username` 有长度上限（21 字符被 `max` tag 拒，16 字符放行）—— 只把站点的原话翻出来，
 *    不自己定一个数字去限：站点改了规矩我们跟着变，写死就会拦住本来能用的名字。
 *
 * ⚠️ 站点有「同一 IP、20 次 / 20 分钟」的限流（2026-10-12 探站点时真撞上过 429）。
 *    所以注册这条链**一次都不自动重试** —— 重试只会把额度吃光，还拿不到新信息。
 */
import { db } from '@/lib/db';
import { encryptSecret, decryptSecret } from './secret';
import { CUSTOM_MODEL_KIND_LABEL, createCustomProvider, listCustomProviders } from './custom';
import { probeCustomProvider } from './custom';
import type { CustomModelKind } from './custom';
import { QUOTA_PER_YUAN, remainingYuanOf } from './site-quota';
import {
  classifyStep, pickFailureReason, rateLimitCooldownUntil, retryDelayMs,
  shouldRetryStep, shouldTryNextPath,
  type SiteStep, type SiteStepKind,
} from './site-errors';
import {
  balanceMinGapMs, forgetSite, loginBlockedUntil, peekBalance, planSession,
  rememberBalance, rememberLoginFailure, rememberSession, withSiteLogin,
} from './site-guard';

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

/**
 * `token` 可以为空 —— 发邮箱验证码那条路是**不需要登录**的（2026-10-12）。
 * 空的时候干脆别带 `Authorization` 头：带一个空的 `Bearer ` 一样会被站点判成没凭据，
 * 而报错会写成「登录态没了」，把人往完全错误的方向带。
 */
async function getJson(url: string, token?: string): Promise<Step> {
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, {
      headers,
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
 * 一把能用的 JWT，或者「这一趟别打站点」的理由。
 *
 * `ok:false` 有两种：真失败了（密码不对 / 连不上），以及**刚失败过还在冷却中** ——
 * 后者不算新失败，只是这一趟整个省掉（见 `./site-guard`）。
 */
type TokenPlan =
  | { ok: true; token: string }
  | { ok: false; why: string; cooldownUntil: number | null };

/**
 * 拿一把能用的 JWT —— **先过 `site-guard` 那道闸**（2026-10-13）。
 *
 * 为什么不再各自读库、各自判「该不该续」：徐先有网页 / 手机 / 桌面三个客户端共用
 * 同一个后端，而站点限流是「同一 IP、20 次 / 20 分钟」—— 按 IP 算，不看客户端。
 * 三个客户端各自判一次「该续了」就是三趟登录，谁也不知道别人刚登过。
 *
 * 现在顺序是：
 *   1. 进程缓存里那把还能用 → 直接用，**一趟站点都不打**；
 *   2. 刚登录失败过（冷却中）→ 这一趟整个省掉，不重试；
 *   3. 真要登 → 走 `withSiteLogin`，同一时刻只飞一趟，后来者复用结果。
 *
 * 🔴 进程刚起来时缓存是空的，**先用库里那把把它填上** —— 不然每次重启都白登一次。
 *    回填时 `at` 传 0：那把不是这一进程登的，不占「刚登过」那个复用窗口。
 */
async function ensureSiteToken(
  userId: string, row: Row, base: string, trace: string[], steps: SiteStep[],
): Promise<TokenPlan> {
  const now = Date.now();
  const stored = row.encryptedToken ? decryptSecret(row.encryptedToken) : null;
  const storedExpires = row.tokenExpiresAt ? new Date(row.tokenExpiresAt).getTime() : 0;
  if (stored && storedExpires > 0) {
    rememberSession(userId, { token: stored, expiresAt: storedExpires }, 0);
  }

  const plan = planSession(userId, now);
  if (plan.kind === 'reuse') {
    trace.push('复用后端缓存的登录态（别的客户端刚登过，这一趟不打扰站点）');
    return { ok: true, token: plan.token };
  }
  if (plan.kind === 'blocked') {
    const left = Math.ceil((loginBlockedUntil(userId) - now) / 1000);
    trace.push(`上一次登录没成功，${left} 秒内不再重试（不重复打站点）`);
    return { ok: false, why: '上一次登录没成功，稍等一会儿会自动重试。', cooldownUntil: loginBlockedUntil(userId) };
  }

  const password = row.encryptedPassword ? decryptSecret(row.encryptedPassword) : null;
  if (!password) {
    return { ok: false, why: '存的登录状态过期了，而且没记住密码 —— 重新登录一次。', cooldownUntil: null };
  }

  /* 同一时刻只飞一趟登录：三个客户端同时进来也只登一次。 */
  const fresh = await withSiteLogin(userId, async () => {
    const got = await login(base, row.username, password, trace, steps);
    if (!got) {
      rememberLoginFailure(userId);
      return null;
    }
    const session = { token: got.token, expiresAt: got.expiresAt.getTime() };
    rememberSession(userId, session);
    await db.siteAccount.update({
      where: { id: row.id },
      data: { encryptedToken: encryptSecret(got.token), tokenExpiresAt: got.expiresAt, lastError: '' },
    });
    trace.push('令牌已续期（用记住的密码重新登录）');
    return session;
  });

  if (!fresh) {
    /* 说站点真正说的那句（密码错了？地址不对？），不是最后一条 404。 */
    const why = pickFailureReason(steps, '重新登录失败 —— 站点地址或密码变了？');
    await db.siteAccount.update({ where: { id: row.id }, data: { lastError: why } });
    return { ok: false, why, cooldownUntil: rateLimitCooldownUntil(steps, Date.now()) };
  }
  return { ok: true, token: fresh.token };
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
  const plan = await ensureSiteToken(userId, row, base, trace, steps);
  if (!plan.ok) return toView(row, [], trace, plan.why, plan.cooldownUntil);
  const token = plan.token;

  const self = await loadSelf(base, token, trace, steps);
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

  /*
   * 换号了：上一个账号的会话 / 余额缓存整个作废 —— 不然「退出再登另一个号」之后，
   * 页头上会先闪一下上一个号的余额（`peekBalance` 那份是按 userId 记的）。
   * 再把刚登出来的这把放进去，末尾那趟 `loadSiteAccount` 就不用再判一次「该不该续」。
   */
  forgetSite(userId);
  rememberSession(userId, { token: session.token, expiresAt: session.expiresAt.getTime() });

  return await loadSiteAccount(userId);
}

/** 换账号 / 退出：整行删掉（连密码一起），不留任何凭据。 */
export async function clearSite(userId: string): Promise<void> {
  forgetSite(userId);
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
 * 🔴 2026-10-13 再加一层：**客户端问后端，后端按自己的节奏问站点**。
 *    前端那 2 分钟一趟照旧（问的是自己的后端，不花站点额度），
 *    但后端最短 `balanceMinGapMs()` 才真去打一次站点 ——
 *    于是站点侧的请求数与「有几个客户端」脱钩（见 `./site-guard`）。
 *
 * 续期那段与 `loadSiteAccount` 一致：JWT 快过期就用记住的密码重新登一次。
 * 站点那一趟失败不算崩：库里还留着上次读到的余额，照样显示，只是把原因带回去。
 */
export async function loadSiteBalance(userId: string, force = false): Promise<SiteBalanceView> {
  const row = await readRow(userId);
  if (!row) return toBalance(null);

  /*
   * 刚问过就别再问 —— 这一句就是「三个客户端不等于三倍请求」的全部。
   * 🔴 缓存里放的是**上一次的回包**，不是「假装成功」：余额本来就是几十秒精度的东西，
   *    客户端看到的数字最多旧 3 分钟，而它换来的是站点那边省掉三分之二的量。
   *
   * `force` 是留给「刚跑完一次生成，想立刻看花了多少」的：定时轮询走闸门，
   *   生成结束 / 手动点刷新走 force。少了这个口子，「刚花完钱余额不动」就成了新毛病
   *   —— 而那恰恰是用户唯一会盯着余额看的时刻。
   */
  if (!force) {
    const cached = peekBalance<SiteBalanceView>(userId);
    if (cached && cached.age < balanceMinGapMs()) return cached.view;
  }

  const trace: string[] = [];
  const steps: SiteStep[] = [];
  const base = root(row.baseUrl);
  const plan = await ensureSiteToken(userId, row, base, trace, steps);
  if (!plan.ok) return toBalance(row, plan.why, plan.cooldownUntil);

  const self = await loadSelf(base, plan.token, trace, steps);
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
  const view = toBalance({ ...row, siteUsername: self.username, group: self.group, quota: self.quota, usedQuota: self.usedQuota });
  rememberBalance(userId, view);
  return view;
}

/* ---------------- 应用内注册 + 自动开通（2026-10-12） ---------------- */

/**
 * 应用自动建的那把令牌叫什么。
 *
 * 🔴 复用判定**只看这个名字**（站点建令牌的回包不给 id，只能按名字找回来）——
 *    改这个常量等于「下次开通再建一把新的」，老的那把会变成孤儿。
 */
export const SITE_TOKEN_NAME = 'Holy Light画布';

/**
 * 自动开通时把一条令牌拆成几条接口（按用途）。
 *
 * 🔴 **不做视频**：徐先 2026-10-12 说「我还没对接视频模型，图和文本就行」。
 *    以后接了视频，往这个数组里加一个 `'video'` 就够了。
 */
export const SITE_PROVISION_KINDS: CustomModelKind[] = ['image', 'text'];

/**
 * 站点那句英文翻成人话。
 *
 * 为什么要翻：下面这几句是**注册流程里最常见**的回话，而它们说的都是「你的输入不对」，
 * 把英文原样糊到界面上，用户只会以为应用坏了。
 * 🔴 认不出来的**原样返回** —— 编一句比不翻更糟（编的那句是错的，还查不到）。
 */
export function humanizeSiteMessage(message: string): string {
  const text = String(message || '').trim();
  if (!text) return '';
  if (/verification code is incorrect or has expired/i.test(text)) return '验证码不对，或者已经过期了。';
  if (/email verification is enabled/i.test(text)) return '这个站点要求邮箱验证 —— 填邮箱，再把收到的验证码填进来。';
  if (/username.*already.*exist|already.*taken/i.test(text)) return '这个用户名已经被注册了，换一个。';
  if (/email.*already.*exist|email.*been.*used/i.test(text)) return '这个邮箱已经注册过了，直接登录就行。';
  if (/failed on the 'max' tag/i.test(text)) return '站点不接受这么长的名字 —— 换短一点的。';
  if (/failed on the 'min' tag/i.test(text)) return '站点嫌这个名字 / 密码太短 —— 再长一点。';
  if (/invalid parameters/i.test(text)) return '站点说参数不对（多半是用户名或密码不合它的规矩）。';
  return text;
}

export type SiteCodeResult = { sent: boolean; error: string; trace: string[] };

/**
 * 发一封带验证码的邮件（注册第一步）。
 *
 * 🔴 是 `GET` 不是 `POST`（见文件头），而且**不需要登录**。
 * 🔴 站点即使**不认识这个邮箱**也回 `success:true` —— 所以「回成功」**不等于**邮件到了，
 *    界面上不能写成「已发送」，只能说「如果邮箱没错，验证码应该已经在路上了」。
 */
export async function sendSiteEmailCode(baseUrl: string, email: string): Promise<SiteCodeResult> {
  const base = root(baseUrl);
  const trace: string[] = [];
  if (!/^https?:\/\//i.test(base)) return { sent: false, error: '站点地址要以 http:// 或 https:// 开头。', trace };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return { sent: false, error: '邮箱格式不对。', trace };

  const url = `${base}/api/verification?email=${encodeURIComponent(email.trim())}`;
  const step = await getJson(url);
  trace.push(`发验证码 GET ${url} → HTTP ${step.status}${step.note ? `：${step.note}` : ''}`);
  if (step.kind !== 'ok') return { sent: false, error: step.note || '连不上站点，验证码没发出去。', trace };

  const body = (step.body && typeof step.body === 'object' ? step.body : {}) as Record<string, unknown>;
  if (body.success === false) {
    return { sent: false, error: humanizeSiteMessage(String(body.message ?? '站点没把验证码发出去。')), trace };
  }
  return { sent: true, error: '', trace };
}

export type SiteRegisterInput = {
  baseUrl: string;
  username: string;
  password: string;
  email: string;
  /** 邮箱里收到的那个验证码。站点没开 `email_verification` 时给空串即可。 */
  code: string;
};

/**
 * 在站点上注册一个账号（注册第二步）。
 *
 * 🔴 字段名是 `verification_code`，**不是 `code`** —— 写成 `code` 会被静默忽略（见文件头）。
 * 🔴 这一趟**不重试**：站点限流是「同一 IP、20 次 / 20 分钟」，注册本来就是一次性动作，
 *    重试只会把额度吃光，还拿不到新信息（`withRetry` 只重试「根本没拿到响应」那一类，
 *    所以这里最多也就是网络抖一下再问一次）。
 */
export async function registerSite(input: SiteRegisterInput): Promise<{ ok: boolean; error: string; trace: string[] }> {
  const base = root(input.baseUrl);
  const trace: string[] = [];
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: '站点地址要以 http:// 或 https:// 开头。', trace };

  const step = await withRetry(
    () => postJson(`${base}/api/user/register`, {
      username: input.username.trim(),
      password: input.password,
      email: input.email.trim(),
      verification_code: input.code.trim(),
    }),
    trace, `注册 ${base}/api/user/register`,
  );
  trace.push(`注册 → HTTP ${step.status}${step.note ? `：${step.note}` : ''}`);
  if (step.kind !== 'ok') return { ok: false, error: humanizeSiteMessage(step.note || '注册没成功。'), trace };

  /*
   * HTTP 200 但 `success:false` 的那一路 `postJson` 已经归到非 ok 了；
   * 这里再判一次是为了接住「200 + success:true 但其实是拒绝」的部署。
   */
  const body = (step.body && typeof step.body === 'object' ? step.body : {}) as Record<string, unknown>;
  if (body.success === false) {
    return { ok: false, error: humanizeSiteMessage(String(body.message ?? '站点拒绝了这次注册。')), trace };
  }
  return { ok: true, error: '', trace };
}

/**
 * 建一把**能用的**专用令牌。
 *
 * 🔴🔴 只给 `name` 建出来的是 **额度 0 的废令牌**（`unlimited_quota=false`、`remain_quota=0`）：
 *    它 `/v1/models` 照样回 200、模型清单照样给，一真调用就报额度不足 ——
 *    界面上看着是「开通成功了」，实际一步都跑不动。所以必须带 `unlimited_quota: true`。
 *    （2026-10-12 实测：只给 name 建的令牌 remain_quota=0、unlimited_quota=false。）
 * 🔴 回包**不给 id** → 建完列一次清单按名字找回。
 * ⚠️ 不绑分组：实测不绑分组的令牌 `/v1/models` 给 12 个模型（含 `gpt-image-2` 等生图模型），
 *    反而比绑到某个专用分组的（3 个）覆盖更全 —— 绑死分组是自找窄路。
 */
export async function createSiteToken(
  base: string, jwt: string, name: string, trace: string[], steps: SiteStep[] = [],
): Promise<SiteToken | null> {
  const url = `${base}/api/token/`;
  const step = await postJson(url, {
    name,
    /* 不给额度 = 建的令牌一分钱都没有。 */
    unlimited_quota: true,
    remain_quota: 0,
    /* -1 = 永不过期（站点默认值也是它，写上是免得哪天站点改了默认）。 */
    expired_time: -1,
  }, jwt);
  steps.push({ kind: step.kind, what: '建令牌', path: '/api/token/', detail: step.note ?? '' });
  trace.push(`建令牌 POST ${url} → HTTP ${step.status}${step.note ? `：${step.note}` : ''}`);
  if (step.kind !== 'ok') return null;

  const rows = await listTokens(base, jwt, trace, steps);
  return rows.find((row) => row.name === name) ?? null;
}

export type SiteProvisionResult = {
  /** 用上的那把站点令牌（新建的或复用的）id。 */
  tokenId: number;
  /** 这次真建出来的接口。已经建过的用途不会重复建。 */
  created: { id: string; name: string; kind: CustomModelKind; models: number }[];
  /** 没建的用途（已经有了 / 这份清单里没有这类模型）。 */
  skipped: { kind: CustomModelKind; why: string }[];
  trace: string[];
};

/**
 * 「自动拉取 + 自动分组」：拿一把能用的令牌，按用途建成几条接口。
 *
 * 三步：确保登录态 → 有就复用、没有就建令牌 → 取完整密钥 → 探一次模型清单 → 按用途拆。
 *
 * 🔴 只探**一次**模型清单（`probeCustomProvider` 自己会按 id 猜每个模型的用途），
 *    然后在这儿按用途切成几条 —— 不是每个用途各探一次：那会往站点打 N 趟，
 *    而站点限流是 20 次 / 20 分钟，一轮就吃光。
 */
export async function provisionSiteProviders(
  userId: string,
  kinds: CustomModelKind[] = SITE_PROVISION_KINDS,
): Promise<SiteProvisionResult> {
  const trace: string[] = [];
  /* 先读一次账号：它顺手把快过期的 JWT 续上，后面建令牌才不会 401。 */
  const view = await loadSiteAccount(userId);
  if (!view.loggedIn) throw new Error('还没有登录站点。');

  const row = await readRow(userId);
  if (!row) throw new Error('还没有登录站点。');
  const base = root(row.baseUrl);
  const jwt = decryptSecret(row.encryptedToken);
  if (!jwt) throw new Error('登录状态没了，重新登录一次。');

  /* 建过就复用 —— 不然每点一次「开通」站点上就多一把孤儿令牌。 */
  let token = view.tokens.find((item) => item.name === SITE_TOKEN_NAME) ?? null;
  if (token) {
    trace.push(`复用已有的令牌「${SITE_TOKEN_NAME}」（id=${token.id}）`);
  } else {
    const steps: SiteStep[] = [];
    token = await createSiteToken(base, jwt, SITE_TOKEN_NAME, trace, steps);
    if (!token) throw new Error(pickFailureReason(steps, '站点不让我们建令牌（这个账号可能没建令牌的权限）。'));
    trace.push(`建了令牌「${SITE_TOKEN_NAME}」（id=${token.id}）`);
  }

  const steps: SiteStep[] = [];
  const key = await fetchFullKey(base, jwt, token.id, trace, steps);
  if (!key) throw new Error(pickFailureReason(steps, '拿不到这把令牌的完整密钥（站点只给了打码的）。'));

  const probe = await probeCustomProvider({ baseUrl: base, apiKey: key, defaultKind: kinds[0] });
  if (!probe.ok || !probe.models.length) {
    throw new Error(probe.message || '连上了站点，但一个模型都没拉到。');
  }
  trace.push(`拉到 ${probe.models.length} 个模型`);

  const host = base.replace(/^https?:\/\//i, '');
  /* 名字重复的判断按**建出来的名字**来：`createCustomProvider` 撞名会直接抛。 */
  const taken = new Set((await listCustomProviders(userId)).map((item) => item.name));
  const created: SiteProvisionResult['created'] = [];
  const skipped: SiteProvisionResult['skipped'] = [];

  for (const kind of kinds) {
    const models = probe.models.filter((item) => item.kinds.includes(kind));
    const label = CUSTOM_MODEL_KIND_LABEL[kind];
    if (!models.length) {
      skipped.push({ kind, why: '这份模型清单里没有这一类' });
      trace.push(`${label}：清单里没有，跳过`);
      continue;
    }
    const name = `${host} · ${SITE_TOKEN_NAME}（${label}）`;
    if (taken.has(name)) {
      skipped.push({ kind, why: '已经建过了' });
      trace.push(`${label}：已经建过「${name}」，跳过`);
      continue;
    }
    const made = await createCustomProvider(userId, {
      name,
      baseUrl: base,
      apiKey: key,
      models: models.map((item) => ({ id: item.id, name: item.name, kinds: [kind] })),
    });
    taken.add(name);
    created.push({ id: made.id, name: made.name, kind, models: models.length });
    trace.push(`${label}：建成「${name}」${models.length} 个模型`);
  }

  return { tokenId: token.id, created, skipped, trace };
}

export type SiteRegisterResult = {
  site: SiteView;
  provision: SiteProvisionResult | null;
  /** 注册成功但开通没成时，原因放这里 —— 账号已经建好了，不该整个回滚。 */
  provisionError: string;
};

/**
 * 注册 → 登录 → 自动开通，一气呵成。
 *
 * 🔴 开通失败**不算注册失败**：账号已经在站点上建好了，把原因带回去让人重试就行。
 *    反过来把它俩绑成「一起成功才成功」，用户就会在站点上建出一串同名账号。
 */
export async function registerAndProvision(userId: string, input: SiteRegisterInput): Promise<SiteRegisterResult> {
  const registered = await registerSite(input);
  if (!registered.ok) throw new Error(registered.error);

  const site = await connectSite(userId, {
    baseUrl: input.baseUrl, username: input.username.trim(), password: input.password,
  });

  try {
    return { site, provision: await provisionSiteProviders(userId), provisionError: '' };
  } catch (error) {
    return {
      site,
      provision: null,
      provisionError: error instanceof Error ? error.message : '自动开通没跑完。',
    };
  }
}
