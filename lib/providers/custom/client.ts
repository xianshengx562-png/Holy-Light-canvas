/**
 * 自定义接口的客户端（2026-09-21；2026-09-23 端点改走 `http.ts` 的候选地址）。
 *
 * 只认 **OpenAI 兼容** 那套端点，因为这是市面上第三方网关的事实标准
 * （AIFISHER 的自定义接口也是这三个）：
 *   - `POST ${baseUrl}/images/generations`  文生图（同步）
 *   - `POST ${baseUrl}/images/edits`        图生图（同步，multipart）
 *   - `POST ${baseUrl}/videos/generations`  文生 / 图生视频（**异步**：提交拿号 → 轮询）
 *   - `GET  ${baseUrl}/videos/generations/{id}` 查视频任务
 *   - `GET  ${baseUrl}/models`              模型清单（探活也用它，见 `custom.ts`）
 *
 * ## 地址怎么拼（2026-09-23）
 *
 * 一律走 `http.ts` 的 `endpointCandidates` + `requestFirstJson`：
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
 *
 * ⚠️ 视频那条 AIFISHER 没有可参考的协议（它自家是同步的），这里是**按 OpenAI 风格异步**
 * 定的：提交拿 `id`，再 `GET .../generations/{id}` 轮询。选异步而不是同步，是因为视频生成
 * 普遍要几分钟，同步请求会在网关 / 反向代理那层先超时，那时候用户看到的是 504 而不是进度。
 */
import { endpointCandidates, requestFirstJson } from './http';
import { IMAGE2_SIZE_AUTO } from '@/lib/workflows/image2Params';

/**
 * 单个候选地址的超时（2026-09-29）。
 *
 * 同步出图一般几秒到几十秒 —— 一档地址 120 秒还不回，基本就是这档地址不对
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
const QUERY_TIMEOUT_MS = 30_000;

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

export type CustomVideoStatus = 'SUCCESS' | 'FAILED' | 'QUEUED' | 'RUNNING';

export type CustomVideoQuery = {
  status: CustomVideoStatus;
  results?: { url: string }[];
  errorMessage?: string;
};

function authHeaders(creds: CustomCredentials) {
  return { authorization: `Bearer ${creds.apiKey}` };
}

/** 在一串候选路径上依次取值，取到第一个像样的字符串就返回。 */
function pickString(source: unknown, paths: string[][]): string {
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

/** 各家五花八门的状态词收成四种。认不出的按 RUNNING —— 下一轮再问一次，别把能成的生成判死。 */
function normalizeStatus(raw: string): CustomVideoStatus {
  const value = raw.trim().toLowerCase();
  if (!value) return 'RUNNING';
  if (['succeeded', 'success', 'successful', 'completed', 'complete', 'done', 'finished'].includes(value)) return 'SUCCESS';
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'timeout', 'timed_out'].includes(value)) return 'FAILED';
  if (['queued', 'queue', 'pending', 'waiting', 'submitted', 'created'].includes(value)) return 'QUEUED';
  return 'RUNNING';
}

function pickErrorMessage(body: unknown): string {
  return pickString(body, [
    ['error', 'message'],
    ['error'],
    ['message'],
    ['msg'],
    ['data', 'error', 'message'],
    ['data', 'error'],
  ]);
}

/** 把 `data[]` 里的每一项变成「可以落盘的东西」：base64 或地址，至少有一个。 */
function readMediaResults(body: unknown): CustomMediaResult[] {
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
  /** 图生图的输入图字节。**有它才走 `/images/edits`**。 */
  images?: File[];
  /** 其余各家自定义字段（比例、种子、步数…）原样塞进请求体。 */
  extra?: Record<string, unknown>;
};

/** 同步出图。返回结构是 `{ status, results, errorMessage }`，好让落盘那段代码共用。 */
export async function generateCustomImage(
  creds: CustomCredentials,
  input: CustomImageInput,
): Promise<CustomGenerateResult> {
  const payload: Record<string, unknown> = { model: input.model, prompt: input.prompt };
  /*
   * 尺寸是我们自己那个「交给上游」的记号时，**整个字段不发**（2026-09-29）。
   *
   * `'auto'` 不是上游认得的枚举：发过去要么被当非法值 400，要么被当「没指定」
   * 按它自己的默认出图 —— 那就是「选了 4K 出来的却是 1K」。不发 = 清清楚楚交给上游。
   */
  if (input.size && input.size !== IMAGE2_SIZE_AUTO) payload.size = input.size;
  if (input.extra) Object.assign(payload, input.extra);
  const edit = Boolean(input.images?.length);
  /** 整次提交的时间预算：两个候选地址分着用，加起来不超过 `SUBMIT_BUDGET_MS`。 */
  const deadline = Date.now() + SUBMIT_BUDGET_MS;

  const attempt = await requestFirstJson(
    endpointCandidates(creds.baseUrl, edit ? '/images/edits' : '/images/generations'),
    url => {
      if (edit) {
        /*
         * 图生图走 multipart。**boundary 交给 fetch 自己拼**，手写必错。
         * 多家网关的字段名是 `image[]`（OpenAI 是 `image`，单张），两个都塞一份是为了兼容：
         * 只认其中一个的那家会忽略另一个，不会报错。
         *
         * ⚠️ 每个候选地址都**重新拼一份 FormData**：请求体是一次性的流，
         * 拿同一份去打第二个地址，那边的 body 会是空的。
         */
        const form = new FormData();
        for (const [key, value] of Object.entries(payload)) form.set(key, String(value));
        (input.images || []).forEach((file, index) => {
          form.set('image', file);
          form.set(`image[${index}]`, file);
        });
        return fetch(url, {
          method: 'POST',
          headers: authHeaders(creds),
          body: form,
          signal: AbortSignal.timeout(Math.min(SUBMIT_TIMEOUT_MS, remainMs(deadline))),
        });
      }
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(creds) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.min(SUBMIT_TIMEOUT_MS, remainMs(deadline))),
      });
    },
    pickErrorMessage,
  );
  if (!attempt.ok) return { status: 'FAILED', results: [], errorMessage: attempt.message };
  const results = readMediaResults(attempt.body);
  if (!results.length) {
    return { status: 'FAILED', results: [], errorMessage: '接口返回成功了，但没有拿到任何图片（返回体里没有 data[].b64_json 或 url）。' };
  }
  return { status: 'SUCCESS', results, errorMessage: '' };
}

export type CustomVideoInput = {
  model: string;
  prompt: string;
  /** 秒。OpenAI 风格那几家用的是 `seconds`，也一并给 `duration` 兜一下。 */
  seconds?: number;
  size?: string;
  /** 图生视频的首帧图字节。 */
  image?: File;
  extra?: Record<string, unknown>;
};

/** 提交一次视频生成。**拿不到任务号立刻报错** —— 那会变成一次永远轮询不到的幽灵任务。 */
export async function submitCustomVideo(creds: CustomCredentials, input: CustomVideoInput): Promise<{ externalId: string }> {
  const payload: Record<string, unknown> = { model: input.model, prompt: input.prompt };
  if (input.seconds) { payload.seconds = input.seconds; payload.duration = input.seconds; }
  if (input.size) payload.size = input.size;
  if (input.extra) Object.assign(payload, input.extra);

  const attempt = await requestFirstJson(
    endpointCandidates(creds.baseUrl, '/videos/generations'),
    url => {
      if (input.image) {
        const form = new FormData();
        for (const [key, value] of Object.entries(payload)) form.set(key, String(value));
        form.set('image', input.image);
        return fetch(url, {
          method: 'POST', headers: authHeaders(creds), body: form, signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
        });
      }
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(creds) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      });
    },
    pickErrorMessage,
  );
  if (!attempt.ok) throw new Error(`自定义接口提交失败：${attempt.message}`);
  const externalId = pickString(attempt.body, [
    ['id'], ['task_id'], ['taskId'], ['requestId'], ['request_id'],
    ['data', 'id'], ['data', 'task_id'], ['data', 'taskId'], ['data', 'requestId'],
  ]);
  if (!externalId) throw new Error('自定义接口没有返回任务号，无法查询生成进度。请确认它支持 POST /videos/generations 并返回 id。');
  return { externalId };
}

/** 查一次视频任务。状态词用 RunningHub 那一套，好让 `GET /api/tasks/[id]` 共用同一段映射。 */
export async function queryCustomVideo(creds: CustomCredentials, externalId: string): Promise<CustomVideoQuery> {
  const attempt = await requestFirstJson(
    endpointCandidates(creds.baseUrl, `/videos/generations/${encodeURIComponent(externalId)}`),
    url => fetch(url, {
      method: 'GET',
      headers: authHeaders(creds),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    }),
    pickErrorMessage,
  );
  if (!attempt.ok) throw new Error(`自定义接口查询失败：${attempt.message}`);
  const status = normalizeStatus(pickString(attempt.body, [['status'], ['data', 'status'], ['state'], ['data', 'state']]));
  const urls = readMediaResults(attempt.body).map(item => item.url).filter((url): url is string => Boolean(url));
  return {
    status,
    results: urls.length ? urls.map(url => ({ url })) : undefined,
    errorMessage: pickErrorMessage(attempt.body) || undefined,
  };
}
