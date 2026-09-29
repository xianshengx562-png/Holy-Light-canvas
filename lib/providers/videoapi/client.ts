import {
  assertVideoApiConfigured,
  videoApiBaseUrl,
  videoApiKey,
  videoApiModel,
  videoApiQueryPath,
  videoApiSubmitPath,
} from './config';

/**
 * 通用视频网关的客户端 —— 只做两件事：**提交任务** 与 **查任务状态**。
 *
 * 设计上刻意「不认任何一家」：
 * - 端点路径全部来自 `.env`（`config.ts`）；
 * - 请求体的字段名集中在下面 `BODY_FIELDS` 一处，**要改只改那里**；
 * - 响应解析走「宽容取值」：各家返回的 JSON 结构差得很远（`id` / `task_id` / `requestId`，
 *   结果在 `url` / `output.url` / `data.results[0].url` …），所以每个字段都按一串候选位置依次找，
 *   找不到就明确报错 —— **绝不猜一个空值当成功**，那是「任务成功但没视频」的来源。
 *
 * ⚠️ 与图片侧同步出图那条的差别：那边是同步的，这里是**异步**的（提交拿号 → 轮询），
 * 所以 `queryVideoApi` 返回的状态用的是 RunningHub 那一套词汇（`SUCCESS` / `FAILED` / `QUEUED` / `RUNNING`），
 * 这样 `GET /api/tasks/[id]` 里那段状态映射不用为它再写一分支。
 */

/**
 * 发给上游的请求体字段名。
 *
 * 这是**唯一需要按网关改的地方**。换成别的网关时，如果它对不上，改这里的字符串即可，
 * 不用动下面的拼装逻辑。
 */
export const BODY_FIELDS = {
  model: 'model',
  prompt: 'prompt',
  duration: 'duration',
  aspectRatio: 'aspect_ratio',
  resolution: 'resolution',
  /** 图生视频的首帧图：走 JSON 时的字段名。 */
  imageUrl: 'image_url',
  /** 图生视频的首帧图：走 multipart 时的字段名。 */
  imageFile: 'image',
} as const;

/** 轮询查询的超时。比提交短得多 —— 一次查询卡住不该拖垮整个轮询循环。 */
const QUERY_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 120_000;

export type VideoApiSubmitInput = {
  prompt: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
  /** 留空则用 `.env` 里配的模型（那个也留空就整个字段不发）。 */
  model?: string;
  /**
   * 首帧图。**给了就走图生视频**，两种形态：
   * - `{ url }`：网关能直接下载的地址（多数是上游自己那边的地址，24 小时内有效）；
   * - `{ file }`：服务端已经取好的字节（本地资产走这条，网关下不到我们的 `/api/assets/...`）。
   */
  image?: { url: string } | { file: File };
};

export type VideoApiSubmitResult = { externalId: string };

/** 归一化之后的任务状态，直接用 RunningHub 那套词汇，好让轮询那条路共用一段映射。 */
export type VideoApiQueryResult = {
  status: 'SUCCESS' | 'FAILED' | 'QUEUED' | 'RUNNING';
  results?: { url: string }[];
  errorMessage?: string;
};

function authHeaders(credentials?: { apiKey?: string; baseUrl?: string }) {
  return { authorization: `Bearer ${credentials?.apiKey?.trim() || videoApiKey()}` };
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

/**
 * 把各家五花八门的状态词收成四种。
 *
 * 认不出的**按 running 处理**而不是按失败 —— 轮询会继续跑，下一轮再问一次；
 * 若按失败处理，一个我们没见过的中间态会把一次本来能成的生成直接判死。
 */
function normalizeStatus(raw: string): VideoApiQueryResult['status'] {
  const value = raw.trim().toLowerCase();
  if (!value) return 'RUNNING';
  if (['succeeded', 'success', 'successful', 'completed', 'complete', 'done', 'finished'].includes(value)) return 'SUCCESS';
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'timeout', 'timed_out'].includes(value)) return 'FAILED';
  if (['queued', 'queue', 'pending', 'waiting', 'submitted', 'created'].includes(value)) return 'QUEUED';
  return 'RUNNING';
}

/**
 * 从查询响应里把视频地址抠出来。
 *
 * 候选位置按「最可能的在前」排；一个都找不到时**返回空数组**，由调用方决定是「还没好」还是「失败」。
 */
function pickResultUrls(body: unknown): { url: string }[] {
  const single = pickString(body, [
    ['output', 'url'],
    ['data', 'output', 'url'],
    ['url'],
    ['data', 'url'],
    ['video_url'],
    ['data', 'video_url'],
    ['output', 'video_url'],
    ['result', 'url'],
    ['data', 'result', 'url'],
  ]);
  if (single) return [{ url: single }];

  const list = pickArray(body, [['results'], ['data', 'results'], ['output', 'videos'], ['data', 'videos']]);
  const urls = list
    .map(item => (item && typeof item === 'object' ? String((item as { url?: unknown }).url ?? '').trim() : ''))
    .filter(Boolean);
  return urls.map(url => ({ url }));
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

async function readError(response: Response, fallback: string) {
  const text = await response.text().catch(() => '');
  const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();
  const message = parsed ? pickErrorMessage(parsed) : '';
  return message || text.slice(0, 200) || fallback;
}

/** 提交一次生成。返回网关那边的任务号，后面靠它轮询。 */
export async function submitVideoApi(input: VideoApiSubmitInput, credentials?: { apiKey?: string; baseUrl?: string }): Promise<VideoApiSubmitResult> {
  assertVideoApiConfigured();
  const base = credentials?.baseUrl?.trim() || videoApiBaseUrl();
  const url = `${base}${videoApiSubmitPath()}`;
  const model = String(input.model || '').trim() || videoApiModel();

  const payload: Record<string, unknown> = {
    [BODY_FIELDS.prompt]: input.prompt,
    [BODY_FIELDS.duration]: input.duration,
    [BODY_FIELDS.aspectRatio]: input.aspectRatio,
    [BODY_FIELDS.resolution]: input.resolution,
  };
  /** 模型名留空就整个字段不发 —— 猜一个它不认的模型名只会直接 400。 */
  if (model) payload[BODY_FIELDS.model] = model;

  let response: Response;
  const imageFile = input.image && 'file' in input.image ? input.image.file : undefined;
  const imageUrl = input.image && 'url' in input.image ? input.image.url : '';

  if (imageFile) {
    /*
     * 有本地字节 → multipart。**boundary 交给 fetch 自己拼**，手写必错。
     * 图生视频时比例由输入图决定（几家网关的共同行为），所以这种情形下 `aspect_ratio` 也一起带上无妨，
     * 但真被忽略时不要当成出错 —— 轮询只看有没有拿到视频。
     */
    const form = new FormData();
    for (const [key, value] of Object.entries(payload)) form.set(key, String(value));
    form.set(BODY_FIELDS.imageFile, imageFile);
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(credentials),
      body: form,
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
  } else {
    if (imageUrl) payload[BODY_FIELDS.imageUrl] = imageUrl;
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(credentials) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw new Error(`视频网关提交失败：${await readError(response, `HTTP ${response.status}`)}`);
  }
  const externalId = pickString(body, [
    ['id'],
    ['task_id'],
    ['taskId'],
    ['requestId'],
    ['request_id'],
    ['data', 'id'],
    ['data', 'task_id'],
    ['data', 'taskId'],
    ['data', 'requestId'],
  ]);
  /*
   * 拿不到任务号必须**立刻报错**，不能当成提交成功。
   * 那会造成一次「永远轮询不到」的幽灵任务：积分已经扣了，任务永远停在 running，
   * 而界面上除了一个转圈什么都不说。
   */
  if (!externalId) throw new Error('视频网关没有返回任务号，无法查询生成进度。请检查接口地址与返回格式。');
  return { externalId };
}

/** 查一次任务状态。返回归一化后的状态与结果地址。 */
export async function queryVideoApi(externalId: string, credentials?: { apiKey?: string; baseUrl?: string }): Promise<VideoApiQueryResult> {
  assertVideoApiConfigured();
  const base = credentials?.baseUrl?.trim() || videoApiBaseUrl();
  const path = videoApiQueryPath().replace('{id}', encodeURIComponent(externalId));
  const response = await fetch(`${base}${path}`, {
    method: 'GET',
    headers: authHeaders(credentials),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw new Error(`视频网关查询失败：${await readError(response, `HTTP ${response.status}`)}`);
  }
  const status = normalizeStatus(pickString(body, [['status'], ['data', 'status'], ['state'], ['data', 'state']]));
  const results = pickResultUrls(body);
  const errorMessage = pickErrorMessage(body);
  return { status, results, errorMessage };
}
