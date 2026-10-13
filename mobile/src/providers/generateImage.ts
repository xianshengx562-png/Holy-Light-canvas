/**
 * 自定义（OpenAI 兼容）接口的客户端 —— **只留文生图这一支**（2026-10-12）。
 *
 * 来源：桌面端 `E:\codex网站开发\本地\studio\lib\providers\custom\client.ts`。
 * 搬的时候做了三处删减，其余原样：
 *   1. 删掉图生图（`input.images` / multipart）—— 第一版不做（见规格 A3）；
 *   2. 删掉视频那一整段（提交 / 轮询 / `normalizeStatus`）—— 手机端不做；
 *   3. `IMAGE2_SIZE_AUTO` 不再从 `@/lib/workflows/image2Params` 引（那是桌面端的模块），
 *      在这里就地定义成同一个记号 `'auto'`。
 * 另外**多出**一个 `fetchCustomModels`（拉模型清单），桌面端那份在
 * `lib/providers/custom.ts`，这里照它的候选规则自己写了一份。
 *
 * ## 地址怎么拼（2026-09-23）
 *
 * 一律走 `customHttp.ts` 的 `endpointCandidates` + `requestFirstJson`：
 * 中转站（New API 那类）把**后台首页挂在根路径上**，`<base>/images/generations`
 * 会回 200 + 一整页 HTML，而真端点在 `<base>/v1/images/generations`。
 * 网页也是 200，所以「连不上 / 失败」这种判断根本不会触发 —— 症状是
 * 「任务成功但没有图」，用户看不出是地址少了一段 `/v1`。
 *
 * ## 响应解析：一律「宽容取值」
 *
 * 各家返回的 JSON 长得差很远（`data[0].b64_json` / `data[0].url` / `url` / `output.url`…）。
 * 所以每个字段都在一串候选位置上依次找，**找不到就明确报错** ——
 * 绝不拿一个空值当成功，那是「任务成功但没有图」的唯一来源。
 */
import { endpointCandidates, requestFirstJson } from './customHttp';
import { send } from '../http/capacitorHttp';

/**
 * 桌面端那个「交给上游决定尺寸」的记号。
 *
 * 🔴 它不是上游认得的枚举：发过去要么被当非法值 400，要么被当「没指定」
 * 按它自己的默认出图 —— 那就是「选了 4K 出来的却是 1K」。所以遇到它**整个字段不发**。
 */
const IMAGE2_SIZE_AUTO = 'auto';

/**
 * 单个候选地址的超时（2026-09-29）。
 *
 * 同步出图一般几秒到几十秒 —— 一档地址 90 秒还不回，基本就是这档地址不对
 * 或者上游在排队，再等下去用户只会以为软件卡死了。
 */
const SUBMIT_TIMEOUT_MS = 90_000;
/**
 * 一次提交的**总预算**（两个候选地址加起来）。
 *
 * 两个候选各 120 秒时最坏要等 4 分钟 —— 徐先报的「有时候会卡住」就是这一段。
 * 整次压到 150 秒，第二个候选只拿剩下的时间（见 `remainMs`）。
 */
const SUBMIT_BUDGET_MS = 150_000;
/** 拉模型清单是轻量请求，别让它占着 90 秒。 */
const MODELS_TIMEOUT_MS = 20_000;

/** 这一整次提交还剩多少毫秒（最少 5 秒，别给个已经过期的 0）。 */
function remainMs(deadline: number) {
  return Math.max(5_000, deadline - Date.now());
}

export type CustomCredentials = { baseUrl: string; apiKey: string };

export type CustomMediaResult = { b64?: string; url?: string };

export type CustomGenerateResult = {
  status: 'SUCCESS' | 'FAILED';
  results: CustomMediaResult[];
  errorMessage: string;
};

function authHeaders(creds: CustomCredentials) {
  return { authorization: `Bearer ${creds.apiKey}` };
}

/** 在一串候选路径上依次取值，取到第一个像样的字符串就返回。 */
export function pickString(source: unknown, paths: string[][]): string {
  if (!source || typeof source !== 'object') return '';
  for (const path of paths) {
    let cursor: unknown = source;
    for (const key of path) {
      if (!cursor || typeof cursor !== 'object') { cursor = undefined; break; }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (typeof cursor === 'string' && cursor.trim()) return cursor.trim();
    if (typeof cursor === 'number' && Number.isFinite(cursor)) return String(cursor);
  }
  return '';
}

function pickArray(source: unknown, paths: string[][]): unknown[] {
  if (!source || typeof source !== 'object') return [];
  for (const path of paths) {
    let cursor: unknown = source;
    for (const key of path) {
      if (!cursor || typeof cursor !== 'object') { cursor = undefined; break; }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (Array.isArray(cursor)) return cursor;
  }
  return [];
}

export function pickErrorMessage(body: unknown): string {
  return pickString(body, [
    ['error', 'message'],
    ['error'],
    ['message'],
    ['msg'],
    ['data', 'error', 'message'],
    ['data', 'error'],
  ]);
}

/** 把 `data[]` 里的每一项变成「可以显示 / 落盘的东西」：base64 或地址，至少有一个。 */
export function readMediaResults(body: unknown): CustomMediaResult[] {
  const list = pickArray(body, [['data'], ['results'], ['output', 'images'], ['images']]);
  const out: CustomMediaResult[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const b64 = pickString(item, [['b64_json'], ['b64'], ['base64']]);
    const url = pickString(item, [['url'], ['image_url'], ['download_url']]);
    if (b64 || url) out.push({ ...(b64 ? { b64 } : {}), ...(url ? { url } : {}) });
  }
  if (out.length) return out;
  /* 有些网关不走 `data[]`，直接给一个裸地址。 */
  const single = pickString(body, [['url'], ['output', 'url'], ['data', 'url']]);
  return single ? [{ url: single }] : [];
}

export type CustomImageInput = {
  model: string;
  prompt: string;
  /** OpenAI 风格是 `"1024x1024"` 这种字符串。留空就整个字段不发。 */
  size?: string;
  /** 其余各家自定义字段（比例、种子、步数…）原样塞进请求体。 */
  extra?: Record<string, unknown>;
};

/** 同步出图。返回结构是 `{ status, results, errorMessage }`。 */
export async function generateCustomImage(
  creds: CustomCredentials,
  input: CustomImageInput,
): Promise<CustomGenerateResult> {
  if (!creds.baseUrl || !creds.apiKey) {
    return { status: 'FAILED', results: [], errorMessage: '还没填站点地址或令牌 —— 先去设置页填。' };
  }
  if (!input.model) {
    return { status: 'FAILED', results: [], errorMessage: '还没选模型 —— 回设置页点「测试连接」拉一次清单。' };
  }
  const payload: Record<string, unknown> = { model: input.model, prompt: input.prompt };
  if (input.size && input.size !== IMAGE2_SIZE_AUTO) payload.size = input.size;
  if (input.extra) Object.assign(payload, input.extra);
  /** 整次提交的时间预算：两个候选地址分着用，加起来不超过 `SUBMIT_BUDGET_MS`。 */
  const deadline = Date.now() + SUBMIT_BUDGET_MS;

  const attempt = await requestFirstJson(
    endpointCandidates(creds.baseUrl, '/images/generations'),
    url => {
      const timeoutMs = Math.min(SUBMIT_TIMEOUT_MS, remainMs(deadline));
      /*
       * 与桌面端唯一的差别：超时用 `timeoutMs` 传（不用 `AbortSignal`），
       * 因为 `CapacitorHttp` 不吃 `AbortSignal` —— 见 `http/capacitorHttp.ts` 的头注释。
       */
      return send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(creds) },
        body: JSON.stringify(payload),
        timeoutMs,
      });
    },
    pickErrorMessage,
  );
  if (!attempt.ok) return { status: 'FAILED', results: [], errorMessage: attempt.message };
  const results = readMediaResults(attempt.body);
  if (!results.length) {
    return {
      status: 'FAILED',
      results: [],
      errorMessage: '接口返回成功了，但没有拿到任何图片（返回体里没有 data[].b64_json 或 url）。',
    };
  }
  return { status: 'SUCCESS', results, errorMessage: '' };
}

export type CustomModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; message: string };

/**
 * 拉模型清单（`GET /models`），也是「测试连接」那一颗按钮走的路。
 *
 * 地址同样走 `endpointCandidates`（`<base>/v1/models` 与 `<base>/models` 都试），
 * 因为不带 `/v1` 的那个打到的是后台首页（200 + 一整页 HTML）。
 */
export async function fetchCustomModels(creds: CustomCredentials): Promise<CustomModelsResult> {
  if (!creds.baseUrl || !creds.apiKey) {
    return { ok: false, message: '还没填站点地址或令牌。' };
  }
  const attempt = await requestFirstJson(
    endpointCandidates(creds.baseUrl, '/models'),
    url => send(url, {
      method: 'GET',
      headers: authHeaders(creds),
      timeoutMs: MODELS_TIMEOUT_MS,
    }),
    pickErrorMessage,
  );
  if (!attempt.ok) return { ok: false, message: attempt.message };
  const rows = pickArray(attempt.body, [['data'], ['models'], ['results']]);
  const models: string[] = [];
  for (const row of rows) {
    if (typeof row === 'string' && row.trim()) {
      if (!models.includes(row.trim())) models.push(row.trim());
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const id = pickString(row, [['id'], ['name'], ['model']]);
    if (id && !models.includes(id)) models.push(id);
  }
  if (!models.length) {
    return { ok: false, message: '拿到了响应，但里面没有模型清单（data[] 是空的，或者令牌没有可见的模型）。' };
  }
  return { ok: true, models };
}
