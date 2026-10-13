/**
 * 中转站**站点账号**那套接口（2026-10-13 从桌面端搬到手机端）。
 *
 * 来源：`E:\codex网站开发\本地\studio\lib\providers\site.ts`（`sendSiteEmailCode` /
 * `registerSite` / `createSiteToken` / `provisionSiteProviders`）。
 * 桌面端那份是**服务端**代码（跑完要落库），这里是**直连**版：请求一律走 `send()`
 * （原生层 `CapacitorHttp`，绕过 WebView 的 CORS），结果直接返回给界面。
 *
 * 🔴 下面这几条是逐条实测出来的（花钱 / 花额度试出来的），**不要照「一般 REST 的常识」改**：
 *
 * 1. **JWT 只打得开 `/api/\*`**，调 `/v1/\*` 出图得用令牌表里那把 key（**不是 JWT**）。
 * 2. 🔴🔴 **建令牌必须带 `unlimited_quota: true`** —— 只给 `name` 建出来的是**额度 0 的废令牌**：
 *    它 `/v1/models` 照样 200、清单照样给，一真调用就报额度不足（2026-10-12 实测）。
 * 3. **建令牌的回包不给 id**（只有 `{"success":true}`）→ 建完必须**列清单按名字找回**。
 * 4. **列表接口给的 key 是打码的**（`sk-AB**********xyzw`）→ 要取完整密钥得再打
 *    `/api/token/<id>/key`，而且**必须带 JWT**（漏了就是 401）。
 * 5. 发验证码是 **`GET /api/verification?email=...`**，`POST` 同路径是 404。
 *    站点**对不存在的邮箱也回 `success:true`** —— 所以界面不能写「已发送」。
 * 6. 注册是 `POST /api/user/register`，验证码字段名 **`verification_code`**
 *    （写成 `code` 会被静默当成没给，只回「请输入邮箱和验证码」）。
 * 7. **故意不绑分组**：实测不绑分组的令牌能拿到 12 个模型（含 `gpt-image-2` 等），
 *    绑了 `default` 一样 12 个，而他自那把绑过组的只有 3 个 —— 绑死是自找窄路。
 * 8. `/api/tokens/`（复数）是 404，只有 `/api/token/` 这一个可用。
 */
import { send } from '../http/capacitorHttp';
import { looksLikeHtml } from './customHttp';
import { fetchCustomModels } from './generateImage';
import { checkGuard, clearFailure, noteFailure, withSiteGuard } from './siteGuard';

const TIMEOUT_MS = 20_000;

/** 桌面端给自动开通那把令牌起的名字 —— 沿用同一个名字，站点上已经有的就复用，不重复建。 */
export const SITE_TOKEN_NAME = 'Holy Light画布';

const LOGIN_PATHS = ['/api/user/login', '/api/auth/login', '/api/login'];
const SELF_PATHS = ['/api/user/self', '/api/user/me', '/api/user/info'];
const TOKEN_PATHS = ['/api/token/', '/api/tokens/'];

/** 去末尾斜杠。站点接口是 `${base}/api/...`，不是 OpenAI 那套 `/v1/...`（所以不用 `endpointCandidates`）。 */
function root(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

type Step = {
  body: unknown;
  /** 失败原因。成功是 null。 */
  note: string | null;
  status: number;
  ok: boolean;
};

/** 一句话把事故归类，界面据此决定要不要再试下一个候选路径。 */
function noteOf(status: number, body: unknown, text: string): string {
  if (status === 429) return '站点限流了（同一 IP 20 次 / 20 分钟），过一会儿再试。';
  const message = failMessage(body);
  if (message) return message;
  if (status === 401 || status === 403) return '站点不认这个凭据（登录态过期了？重新登录一次）。';
  if (status === 404) return `${text} 这条路径不存在（HTTP 404）。`;
  if (!status) return `${text} 连不上。`;
  return `${text} 返回 HTTP ${status}。`;
}

function failMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const one = body as Record<string, unknown>;
  const data = one.data && typeof one.data === 'object' ? (one.data as Record<string, unknown>) : null;
  for (const source of [one, data]) {
    if (!source) continue;
    if (source.success === false) {
      const message = pickString(source, 'message') || pickString(source, 'msg');
      if (message) return humanizeSiteMessage(message);
    }
  }
  return '';
}

/** 站点那句英文翻成人话（从桌面端原样搬）。 */
export function humanizeSiteMessage(message: string): string {
  const text = String(message || '').trim();
  if (!text) return '';
  if (/verification code is incorrect or has expired/i.test(text)) return '验证码不对，或者已经过期了。';
  if (/^user already exists|username already/i.test(text)) return '这个用户名已经被占了。';
  if (/invalid parameters/i.test(text)) return '站点说参数不对（多半是用户名或密码不合它的规矩）。';
  return text;
}

function pickString(source: unknown, key: string): string {
  if (!source || typeof source !== 'object') return '';
  const one = source as Record<string, unknown>;
  const data = one.data && typeof one.data === 'object' ? (one.data as Record<string, unknown>) : one;
  const hit = (data as Record<string, unknown>)[key] ?? one[key];
  return typeof hit === 'string' && hit.trim() ? hit.trim() : '';
}

function pickNumber(source: unknown, key: string): number | null {
  if (!source || typeof source !== 'object') return null;
  const one = source as Record<string, unknown>;
  const data = one.data && typeof one.data === 'object' ? (one.data as Record<string, unknown>) : one;
  const hit = (data as Record<string, unknown>)[key] ?? one[key];
  return typeof hit === 'number' && Number.isFinite(hit) ? hit : null;
}

async function postJson(url: string, payload: unknown, token = ''): Promise<Step> {
  try {
    const response = await send(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      timeoutMs: TIMEOUT_MS,
    });
    const text = await response.text().catch(() => '');
    if (looksLikeHtml(text)) {
      return { body: null, note: `${url} 回的是网页不是接口（站点地址填成后台首页了？）。`, status: response.status, ok: false };
    }
    let body: unknown = null;
    try { body = JSON.parse(text); } catch {
      return { body: null, note: `${url} 返回的不是 JSON（HTTP ${response.status}）。`, status: response.status, ok: false };
    }
    if (!response.ok) return { body: null, note: noteOf(response.status, body, url), status: response.status, ok: false };
    /* HTTP 200 + success:false 的部署：这也算失败，而且它带着真正的原因。 */
    const failed = failMessage(body);
    if (failed) return { body: null, note: failed, status: response.status, ok: false };
    return { body, note: null, status: response.status, ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { body: null, note: /timed out|timeout|abort/i.test(reason) ? `${url} 响应超时。` : `${url} 连不上：${reason}`, status: 0, ok: false };
  }
}

/** `token` 可以为空 —— 发验证码那条路不需要登录；带上空 `Bearer ` 反而会被判成没凭据。 */
async function getJson(url: string, token = ''): Promise<Step> {
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await send(url, { method: 'GET', headers, timeoutMs: TIMEOUT_MS });
    const text = await response.text().catch(() => '');
    if (looksLikeHtml(text)) {
      return { body: null, note: `${url} 回的是网页（站点地址填成后台首页了？）。`, status: response.status, ok: false };
    }
    let body: unknown = null;
    try { body = JSON.parse(text); } catch {
      return { body: null, note: `${url} 返回的不是 JSON（HTTP ${response.status}）。`, status: response.status, ok: false };
    }
    if (!response.ok) return { body: null, note: noteOf(response.status, body, url), status: response.status, ok: false };
    return { body, note: null, status: response.status, ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { body: null, note: /timed out|timeout|abort/i.test(reason) ? `${url} 响应超时。` : `${url} 连不上：${reason}`, status: 0, ok: false };
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

/** 多个候选路径都试过之后，挑**最有用的那句**给人看（404 只在没别的线索时才说）。 */
function pickReason(notes: string[], fallback: string): string {
  const meaningful = notes.find(note => note && !/HTTP 404|这条路径不存在/.test(note));
  return meaningful || notes.find(note => note) || fallback;
}

/* ---------------- 站点开关 ---------------- */

export type SiteStatus = { registerEnabled: boolean; emailVerification: boolean };

/** `/api/status`：看站点开没开放注册、要不要邮箱验证码。 */
export async function fetchSiteStatus(baseUrl: string): Promise<SiteStatus> {
  try {
    const step = await getJson(`${root(baseUrl)}/api/status`);
    if (!step.ok || !step.body) return { registerEnabled: true, emailVerification: true };
    const body = step.body as Record<string, unknown>;
    const data = body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : body;
    return {
      registerEnabled: data.register_enabled === undefined ? true : Boolean(data.register_enabled),
      emailVerification: data.email_verification === undefined ? true : Boolean(data.email_verification),
    };
  } catch {
    /* 探不到就按「都开着」处理 —— 界面照常给按钮，真不能用时站点自己会说话。 */
    return { registerEnabled: true, emailVerification: true };
  }
}

/* ---------------- 注册 ---------------- */

/**
 * 发验证码。**🔴 是 GET**，而且站点对不存在的邮箱也回成功 ——
 * 所以这里的返回值只能表示「站点说它发这一步通过了」，不代表邮件真的到了。
 */
export async function sendSiteEmailCode(baseUrl: string, email: string): Promise<Result<true>> {
  const base = root(baseUrl);
  if (!/^https?:\/\//i.test(base)) return { ok: false, message: '站点地址要以 http:// 或 https:// 开头。' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return { ok: false, message: '邮箱格式不对。' };

  const guarded = checkGuard();
  if (guarded) return { ok: false, message: guarded.message };

  return await withSiteGuard('code', async () => {
    const url = `${base}/api/verification?email=${encodeURIComponent(email.trim())}`;
    const step = await getJson(url);
    if (!step.ok) {
      const message = step.note || '连不上站点，验证码没发出去。';
      noteFailure(message, step.status);
      return { ok: false, message };
    }
    clearFailure();
    return { ok: true, value: true };
  });
}

export async function registerSite(input: {
  baseUrl: string; username: string; password: string; email: string; code: string;
}): Promise<Result<true>> {
  const base = root(input.baseUrl);
  if (!/^https?:\/\//i.test(base)) return { ok: false, message: '站点地址要以 http:// 或 https:// 开头。' };
  if (input.username.trim().length < 3) return { ok: false, message: '用户名至少 3 个字符。' };
  if (input.password.length < 8) return { ok: false, message: '密码至少 8 位（站点那边的要求）。' };

  const guarded = checkGuard();
  if (guarded) return { ok: false, message: guarded.message };

  return await withSiteGuard('register', async () => {
    const step = await postJson(`${base}/api/user/register`, {
      username: input.username.trim(),
      password: input.password,
      email: input.email.trim(),
      /* 🔴 字段名是 verification_code，写成 code 会被静默忽略。 */
      verification_code: input.code.trim(),
    });
    if (!step.ok) {
      const message = step.note || '注册没成功。';
      /* 用户名被占 / 验证码不对这类不冷却 —— 用户改一下输入就能重试（见 siteGuard 文件头）。 */
      noteFailure(message, step.status);
      return { ok: false, message };
    }
    clearFailure();
    return { ok: true, value: true };
  });
}

/* ---------------- 登录 ---------------- */

export type SiteSession = { jwt: string; expiresAt: number };

/**
 * 登录换 JWT。三条候选路径依次试；站点说了人话（密码错）就停，不继续试出 404。
 *
 * 🔴 外面套了 `siteGuard` 两层：先问「在不在冷却里」，再走 `withSiteGuard` 去重。
 *    为什么必须去重：一趟登录最多打 3 条路径，紧接着的开通还要再打 5~6 次 ——
 *    按钮点两下就是 18 次请求，站点那条「20 次 / 20 分钟」一轮见底。
 */
export async function loginSite(baseUrl: string, username: string, password: string): Promise<Result<SiteSession>> {
  const base = root(baseUrl);
  if (!/^https?:\/\//i.test(base)) return { ok: false, message: '站点地址要以 http:// 或 https:// 开头。' };
  if (!username.trim()) return { ok: false, message: '还没填用户名。' };
  if (!password) return { ok: false, message: '还没填密码。' };

  const guarded = checkGuard();
  if (guarded) return { ok: false, message: guarded.message };

  return await withSiteGuard('login', async () => {
    const notes: string[] = [];
    let lastStatus = 0;
    for (const path of LOGIN_PATHS) {
      const step = await postJson(`${base}${path}`, { username: username.trim(), password });
      lastStatus = step.status;
      if (step.ok) {
        const jwt = pickString(step.body, 'access_token') || pickString(step.body, 'token');
        /* 回了 200 却没给令牌 = 这条路径不是登录口，换下一条（不算「被拒绝」）。 */
        if (!jwt) continue;
        const expires = pickNumber(step.body, 'access_expires_at');
        clearFailure();
        return { ok: true, value: { jwt, expiresAt: expires && expires > 0 ? expires * 1000 : Date.now() + 12 * 3600_000 } };
      }
      notes.push(step.note || '');
      /* 站点明说了原因就停下 —— 继续试只会再拿一串 404，把真正的原因冲掉。 */
      if (step.status && step.status !== 404) break;
    }
    const message = pickReason(notes, '登录失败，检查一下地址、用户名和密码。');
    noteFailure(message, lastStatus);
    return { ok: false, message };
  });
}

/** 登录账号的名字 / 分组 / 余额。 */
export async function loadSelfInfo(baseUrl: string, jwt: string): Promise<{ username: string; quota: number | null }> {
  const base = root(baseUrl);
  for (const path of SELF_PATHS) {
    const step = await getJson(`${base}${path}`, jwt);
    if (step.ok) {
      return {
        username: pickString(step.body, 'display_name') || pickString(step.body, 'username'),
        quota: pickNumber(step.body, 'quota'),
      };
    }
    if (step.status && step.status !== 404) break;
  }
  return { username: '', quota: null };
}

/* ---------------- 令牌 ---------------- */

type TokenRow = { id: number; name: string };

async function listTokens(base: string, jwt: string): Promise<{ rows: TokenRow[]; note: string }> {
  for (const path of TOKEN_PATHS) {
    const step = await getJson(`${base}${path}?p=0&size=50`, jwt);
    if (step.ok) {
      const body = (step.body ?? {}) as Record<string, unknown>;
      const data = body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : body;
      const list = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
      const rows = list
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map(row => ({ id: Number(row.id ?? 0) || 0, name: String(row.name ?? '') }))
        .filter(row => row.id > 0);
      return { rows, note: '' };
    }
    if (step.status && step.status !== 404) return { rows: [], note: step.note || '' };
  }
  return { rows: [], note: '' };
}

/** 列表里的 key 是打码的，只有这个接口给真的。 */
async function fetchFullKey(base: string, jwt: string, id: number): Promise<Result<string>> {
  const notes: string[] = [];
  for (const method of ['post', 'get'] as const) {
    const url = `${base}/api/token/${id}/key`;
    const step = method === 'post' ? await postJson(url, {}, jwt) : await getJson(url, jwt);
    if (step.ok) {
      const key = pickString(step.body, 'key');
      /* 给了但还是打码的 —— 换一种写法也不会变，别白试。 */
      if (key && !key.includes('*')) return { ok: true, value: key };
      if (key) return { ok: false, message: '站点只给了打码的密钥（这把令牌它可能不让你看）。' };
      notes.push(`${method.toUpperCase()} ${url} 没返回密钥。`);
      continue;
    }
    notes.push(step.note || '');
    if (step.status && step.status !== 404) break;
  }
  return { ok: false, message: pickReason(notes, '拿不到这把令牌的完整密钥。') };
}

/* ---------------- 开通：把站点账号变成一把能出图的 key ---------------- */

export type Provisioned = { apiKey: string; models: string[]; tokenId: number; reused: boolean };

/**
 * 登录后把账号变成一把能出图的 key：**复用 / 建令牌 → 取完整密钥 → 拉模型清单**。
 *
 * `TOKEN_NAME` 那把已经存在就直接复用 —— 不然每登录一次站点上就多一把孤儿令牌。
 */
export async function provisionApiKey(baseUrl: string, jwt: string): Promise<Result<Provisioned>> {
  const base = root(baseUrl);

  /* 同上：开通一趟要打 5~6 次站点，连点两下就够把限流吃光。 */
  return await withSiteGuard('provision', async () => {
    const out = await provisionApiKeyNow(base, jwt);
    if (out.ok) {
      clearFailure();
      return out;
    }
    /*
     * 传 `null` 不是偷懒：开通这条链上拿不到状态码，只有一句话。
     * 传 `0` 会被当成「连不上」，把「站点不让建令牌」也锁上 —— 见 siteGuard 那条注。
     */
    noteFailure(out.message, null);
    return out;
  });
}

async function provisionApiKeyNow(base: string, jwt: string): Promise<Result<Provisioned>> {
  const existing = await listTokens(base, jwt);
  if (existing.note) return { ok: false, message: existing.note };

  let token = existing.rows.find(row => row.name === SITE_TOKEN_NAME) ?? null;
  let reused = true;
  if (!token) {
    /* 🔴🔴 unlimited_quota 必须 true —— 否则建出来的是额度 0 的废令牌。 */
    const step = await postJson(`${base}/api/token/`, {
      name: SITE_TOKEN_NAME,
      unlimited_quota: true,
      remain_quota: 0,
      expired_time: -1,
    }, jwt);
    if (!step.ok) return { ok: false, message: step.note || '站点不让这个账号建令牌（可能没权限）。' };
    /* 建完必须再列一次清单：回包不给 id，只能按名字找回。 */
    const after = await listTokens(base, jwt);
    token = after.rows.find(row => row.name === SITE_TOKEN_NAME) ?? null;
    reused = false;
    if (!token) return { ok: false, message: '令牌建出来了，但清单里找不到它（列清单那一步失败了）。' };
  }

  const key = await fetchFullKey(base, jwt, token.id);
  if (!key.ok) return { ok: false, message: key.message };

  const models = await fetchCustomModels({ baseUrl: base, apiKey: key.value });
  if (!models.ok) return { ok: false, message: `令牌拿到了，但模型清单没拉下来：${models.message}` };

  return { ok: true, value: { apiKey: key.value, models: models.models, tokenId: token.id, reused } };
}

/** 注册 → 登录 → 开通，一条龙。注册成功但开通失败时，账号已经建好了（不回滚）。 */
export async function registerAndProvision(input: {
  baseUrl: string; username: string; password: string; email: string; code: string;
}): Promise<Result<{ session: SiteSession; provisioned: Provisioned }>> {
  const registered = await registerSite(input);
  if (!registered.ok) return registered;

  const session = await loginSite(input.baseUrl, input.username, input.password);
  if (!session.ok) {
    /* 账号建好了，只是这趟没登进去 —— 让用户手点一次登录就行，别让他再注册一遍。 */
    return { ok: false, message: `注册成功了，但自动登录没成：${session.message}（账号已经建好，回登录页用同样的账号密码登一次。）` };
  }
  const provisioned = await provisionApiKey(input.baseUrl, session.value.jwt);
  if (!provisioned.ok) return { ok: false, message: `注册并登录成功了，但自动开通没成：${provisioned.message}` };
  return { ok: true, value: { session: session.value, provisioned: provisioned.value } };
}
