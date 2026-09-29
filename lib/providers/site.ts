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

/** 换算规则搬去 `./site-quota` 了（那边能单独编出来跑断言）。这里 re-export 是为了不动已有引用。 */
export { QUOTA_PER_YUAN };

const TIMEOUT_MS = 15_000;
/** 令牌提前 1 小时续期：别等真过期了才发现，那时候余额已经不刷新了。 */
const RENEW_BEFORE_MS = 60 * 60 * 1000;

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
  /** 每一跳的流水账（不含任何 key）—— 排查用。 */
  trace: string[];
};

const EMPTY: SiteView = {
  loggedIn: false, baseUrl: '', username: '', loginName: '', group: '',
  quota: null, usedQuota: null, remainingYuan: null, quotaPerYuan: QUOTA_PER_YUAN,
  tokens: [], error: '', trace: [],
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

type Step = { body: unknown; note: string | null; status: number };

async function postJson(url: string, payload: unknown, token?: string): Promise<Step> {
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
    return { body: null, note: `${url} 回的是网页不是接口。`, status: response.status };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return { body: null, note: `${url} 返回的不是 JSON（HTTP ${response.status}）。`, status: response.status };
  }
  const failed = failMessage(body);
  if (failed) return { body: null, note: failed, status: response.status };
  if (!response.ok) return { body: null, note: `${url} 返回 HTTP ${response.status}。`, status: response.status };
  return { body, note: null, status: response.status };
}

async function getJson(url: string, token: string): Promise<Step> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text().catch(() => '');
  if (looksLikeHtml(text)) return { body: null, note: `${url} 回的是网页。`, status: response.status };
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return { body: null, note: `${url} 返回的不是 JSON（HTTP ${response.status}）。`, status: response.status };
  }
  if (!response.ok) return { body: null, note: `${url} 返回 HTTP ${response.status}。`, status: response.status };
  return { body, note: null, status: response.status };
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

/** 登录：换 JWT + 它的过期时间（`access_expires_at`，没有就按 12 小时算）。 */
async function login(base: string, username: string, password: string, trace: string[]) {
  for (const path of LOGIN_PATHS) {
    let step: Step;
    try {
      step = await postJson(`${base}${path}`, { username, password });
    } catch (error) {
      const why = error instanceof Error && /timed out|abort/i.test(error.message) ? '响应超时' : '连不上';
      trace.push(`登录 ${base}${path} → ${why}`);
      continue;
    }
    trace.push(`登录 ${base}${path} → HTTP ${step.status}${step.note ? `：${step.note}` : ''}`);
    if (step.note) continue;
    const token = pickString(step.body, 'access_token') ?? pickString(step.body, 'token');
    if (!token) continue;
    const expires = pickNumber(step.body, 'access_expires_at');
    const at = expires && expires > 0 ? new Date(expires * 1000) : new Date(Date.now() + 12 * 3600 * 1000);
    return { token, expiresAt: at };
  }
  return null;
}

async function loadSelf(base: string, token: string, trace: string[]) {
  for (const path of SELF_PATHS) {
    try {
      const step = await getJson(`${base}${path}`, token);
      if (!step.body) {
        trace.push(`账号信息 ${base}${path} → HTTP ${step.status}${step.note ? `：${step.note}` : ''}`);
        continue;
      }
      trace.push(`账号信息 ${base}${path} → HTTP ${step.status}`);
      return {
        username: pickString(step.body, 'display_name') ?? pickString(step.body, 'username') ?? '',
        group: pickString(step.body, 'group') ?? '',
        quota: pickNumber(step.body, 'quota'),
        usedQuota: pickNumber(step.body, 'used_quota'),
      };
    } catch (error) {
      trace.push(`账号信息 ${base}${path} → ${error instanceof Error ? error.message.slice(0, 60) : '失败'}`);
    }
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

async function listTokens(base: string, token: string, trace: string[]): Promise<SiteToken[]> {
  for (const path of TOKEN_PATHS) {
    try {
      const step = await getJson(`${base}${path}?p=0&size=50`, token);
      if (!step.body) {
        trace.push(`令牌清单 ${base}${path} → HTTP ${step.status}${step.note ? `：${step.note}` : ''}`);
        continue;
      }
      const rows = tokenRows(step.body);
      trace.push(`令牌清单 ${base}${path} → HTTP ${step.status}，${rows.length} 把`);
      return rows.map((row) => ({
        id: Number(row.id ?? 0) || 0,
        name: String(row.name ?? ''),
        group: String(row.group ?? ''),
        status: typeof row.status === 'number' ? row.status : null,
        masked: String(row.key ?? ''),
      })).filter((row) => row.id > 0);
    } catch (error) {
      trace.push(`令牌清单 ${base}${path} → ${error instanceof Error ? error.message.slice(0, 60) : '失败'}`);
    }
  }
  return [];
}

/** 完整密钥。列表里那把是打码的，只有这个接口给真的。 */
export async function fetchFullKey(base: string, token: string, id: number, trace: string[] = []): Promise<string | null> {
  for (const method of ['post'] as const) {
    try {
      const step = await postJson(`${base}/api/token/${id}/key`, {}, token);
      trace.push(`取完整密钥 POST ${base}/api/token/${id}/key → HTTP ${step.status}${step.note ? `：${step.note}` : ''}`);
      const key = pickString(step.body, 'key');
      if (key && !key.includes('*')) return key;
      if (key) trace.push('站点给的是打码的密钥，不能用。');
    } catch (error) {
      trace.push(`取完整密钥 → ${error instanceof Error ? error.message.slice(0, 60) : '失败'}`);
    }
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

function toView(row: Row | null, tokens: SiteToken[], trace: string[], error = ''): SiteView {
  if (!row) return { ...EMPTY, trace, error };
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
  const base = root(row.baseUrl);
  let token = row.encryptedToken ? decryptSecret(row.encryptedToken) : null;
  const expires = row.tokenExpiresAt ? new Date(row.tokenExpiresAt).getTime() : 0;
  const stale = !token || !expires || expires - Date.now() < RENEW_BEFORE_MS;

  if (stale) {
    const password = row.encryptedPassword ? decryptSecret(row.encryptedPassword) : null;
    if (!password) {
      return toView(row, [], trace, '存的登录状态过期了，而且没记住密码 —— 重新登录一次。');
    }
    const fresh = await login(base, row.username, password, trace);
    if (!fresh) {
      await db.siteAccount.update({
        where: { id: row.id },
        data: { lastError: '重新登录失败（站点地址或密码变了？）。' },
      });
      return toView(row, [], trace, '重新登录失败 —— 站点地址或密码变了？');
    }
    token = fresh.token;
    await db.siteAccount.update({
      where: { id: row.id },
      data: { encryptedToken: encryptSecret(fresh.token), tokenExpiresAt: fresh.expiresAt, lastError: '' },
    });
    trace.push('令牌已续期（用记住的密码重新登录）');
  }

  const self = await loadSelf(base, token as string, trace);
  const tokens = await listTokens(base, token as string, trace);
  if (!self) {
    const why = '读不到账号信息（站点可能改版了）。';
    await db.siteAccount.update({ where: { id: row.id }, data: { lastError: why } });
    return toView(row, tokens, trace, why);
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

  const session = await login(base, input.username, input.password, trace);
  if (!session) throw new Error(trace.length ? trace[trace.length - 1] : '登录失败，检查一下地址、用户名和密码。');

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
  const key = await fetchFullKey(base, jwt, tokenId, trace);
  if (!key) throw new Error('拿不到这把令牌的完整密钥（站点只给了打码的，或者不让你看这把）。');

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
};

function toBalance(row: Row | null, error = ''): SiteBalanceView {
  if (!row) {
    return {
      loggedIn: false, baseUrl: '', username: '', loginName: '', group: '',
      quota: null, usedQuota: null, remainingYuan: null, quotaPerYuan: QUOTA_PER_YUAN, error,
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
  const base = root(row.baseUrl);
  let token = row.encryptedToken ? decryptSecret(row.encryptedToken) : null;
  const expires = row.tokenExpiresAt ? new Date(row.tokenExpiresAt).getTime() : 0;
  const stale = !token || !expires || expires - Date.now() < RENEW_BEFORE_MS;

  if (stale) {
    const password = row.encryptedPassword ? decryptSecret(row.encryptedPassword) : null;
    if (!password) return toBalance(row, '存的登录状态过期了，而且没记住密码 —— 重新登录一次。');
    const fresh = await login(base, row.username, password, trace);
    if (!fresh) {
      await db.siteAccount.update({
        where: { id: row.id },
        data: { lastError: '重新登录失败（站点地址或密码变了？）。' },
      });
      return toBalance(row, '重新登录失败 —— 站点地址或密码变了？');
    }
    token = fresh.token;
    await db.siteAccount.update({
      where: { id: row.id },
      data: { encryptedToken: encryptSecret(fresh.token), tokenExpiresAt: fresh.expiresAt, lastError: '' },
    });
  }

  const self = await loadSelf(base, token as string, trace);
  if (!self) {
    const why = '读不到账号信息（站点可能改版了）。';
    await db.siteAccount.update({ where: { id: row.id }, data: { lastError: why } });
    return toBalance(row, why);
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
