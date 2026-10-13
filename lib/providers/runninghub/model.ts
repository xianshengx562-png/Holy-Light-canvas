import 'server-only';
import { rhModelSpecOf } from '@/lib/workflows/rhModelParams';
import { endpoint, queryTask, uploadMediaCached } from './client';

/**
 * RunningHub **标准模型 API** 的客户端（2026-10-11 徐先）。
 *
 * 与 `./client.ts`（工作流 API）是**同一家、两套东西**，别混着用：
 *   - 工作流那套是「提交一份节点图」：`/run/workflow/<id>`，参数是 `nodeInfoList`；
 *   - 这一套是「点名一个模型」：`/openapi/v2/<模型路径>`，参数是 `prompt / duration / ratio …`。
 * 连**能用的 Key 都不是同一把** —— 模型 API 只认**企业级-共享 Key**，
 * 消费级-会员那把打过来是 `1014 Access Denied`（实测）。所以凭据单独一个槽位（见 `connection.ts`）。
 *
 * ## 响应结构（🔴 这一层最大的坑，照抄工作流那套会全废）
 *
 * 提交与查询回来的都是**顶层** `taskId` / `status` / `errorCode` / `errorMessage` / `results`
 * —— **没有 `data` 层，也没有 `code`**。判定成功只能看**顶层 `taskId` 是不是非空**：
 *
 *   - `errorCode` 是**空串**代表没出错，别拿 `Number('')` 去判（会得到 0，看着像成功码）；
 *   - HTTP 一律 200，连「模型路径不存在」（`1001`）也是 200，所以**必须读 `errorCode`**，
 *     只看 `response.ok` 会把所有失败都当成成功，然后拿着一个空 `taskId` 去轮询。
 *
 * ## 参考素材怎么给
 *
 * 上游只吃 **URL / Base64 / asset ID**（实测：`Invalid image format. Must be a valid URL,
 * Base64 string, or asset ID (asset-xxx)`），**不认 RunningHub 自己的文件名**
 * （工作流里那个 `remoteFile` 在这里没有意义），更下不到我们机器上的 `/api/assets/...`。
 * 所以本机素材一律**先上传、拿它的 `download_url`** 再塞进请求体 —— 走 `uploadMediaCached`
 * 还顺带拿到「同一份字节不重传」的缓存。
 *
 * 🔴 **这是「把画布上的地址取成字节」的第六处**，但目标不一样（见记忆）：
 *    另外五处要的是字节或工作流文件名，这一处要的是**上游能下载的 URL**。
 *    改任何一处都要问一句「其余几份跟上了吗」。
 */

/** 提交给多久。它只是几个字段的 JSON，比交一整张节点图快得多。 */
const SUBMIT_TIMEOUT_MS = 60_000;

export type RhModelCredentials = { apiKey: string; baseUrl: string };

export type RhModelSubmitInput = {
  /** 模型路径（`/openapi/v2/` 后面那一段）。**必须是 `RH_MODELS` 里的一档**。 */
  model: string;
  prompt: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
  /** 加 AIGC 水印。默认 false —— 自己出的片不额外盖章。 */
  watermark?: boolean;
  /**
   * 参考素材，**已经按这一档模型的规格裁好**（数量与类型）。
   * 值是上游能下载的地址；本机素材在调用前已转成 `download_url`。
   */
  imageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
  /** 首帧 / 尾帧（`i2va` 那两档）。与 `imageUrls` 互斥 —— 同一档只会用其中一套。 */
  firstFrameUrl?: string;
  lastFrameUrl?: string;
};

export type RhModelQueryResult = {
  status: 'SUCCESS' | 'FAILED' | 'QUEUED' | 'RUNNING';
  results?: { url: string }[];
  errorMessage?: string;
};

/**
 * 上游的错误码 → 人话。**认不出的原样带出去**，别吞成一句「提交失败」——
 * 排查时唯一有用的就是上游那句原话。
 */
function upstreamMessage(body: { errorCode?: unknown; errorMessage?: unknown }, fallback: string) {
  const code = String(body?.errorCode ?? '').trim();
  const message = String(body?.errorMessage ?? '').trim();
  if (!code && !message) return fallback;
  return code ? `${message || fallback}（上游错误码 ${code}）` : (message || fallback);
}

/**
 * 提交一次模型直调。返回上游的任务号，后面靠它轮询。
 *
 * 🔴 拿不到任务号必须**立刻抛错**，不能当成功（与 `videoapi/client.ts` 同一条规矩）：
 *    那会造出一个「永远轮询不到」的幽灵任务 —— 积分已经扣了，卡片永远转圈。
 */
export async function submitRhModel(
  input: RhModelSubmitInput,
  credentials: RhModelCredentials,
): Promise<{ externalId: string }> {
  const spec = rhModelSpecOf(input.model);
  if (!spec) throw new Error(`模型「${input.model}」不是这一档引擎可选的模型，提交已拦下。`);

  /*
   * 🔴 比例的**字段名两档不一样**（`ratio` vs `aspectRatio`），水印更是有的档根本不认。
   * 写死一个的后果不是报错，是**被静默忽略** —— 上游返回成功、出的片子却不是你要的比例。
   * 所以这两处都从这一档的规格里取。
   */
  const payload: Record<string, unknown> = {
    prompt: input.prompt,
    resolution: input.resolution,
    duration: input.duration,
    [spec.ratioField]: input.aspectRatio,
  };
  if (spec.watermark) payload.aigc_watermark = input.watermark ?? false;

  /* 首尾帧：两个字段各填各的，少一张就少一个（只给首帧是合法的）。 */
  if (spec.frames) {
    if (input.firstFrameUrl) payload[spec.frames.first] = input.firstFrameUrl;
    if (input.lastFrameUrl) payload[spec.frames.last] = input.lastFrameUrl;
  }

  /*
   * 素材字段按这一档的规格填：字段名与上限**逐档不同**（`firstFrameUrl` 单值 vs
   * `imageUrls` 数组），所以这里读 `RH_MODELS` 而不是写死三个 if。
   *
   * ⚠️ 这一档**不收**的那一类素材**一个都不塞** —— 塞了上游会静默忽略，
   * 于是「连了参考图、任务成功、画面跟图无关」这种零报错的坏结果就来了。
   */
  const lists: { kind: 'image' | 'video' | 'audio'; urls?: string[] }[] = [
    { kind: 'image', urls: input.imageUrls },
    { kind: 'video', urls: input.videoUrls },
    { kind: 'audio', urls: input.audioUrls },
  ];
  for (const { kind, urls } of lists) {
    const slot = spec[kind];
    if (!slot || !urls?.length) continue;
    const capped = urls.filter(Boolean).slice(0, slot.max);
    if (!capped.length) continue;
    payload[slot.field] = slot.array ? capped : capped[0];
  }

  const response = await fetch(`${endpoint(credentials.baseUrl)}/${input.model}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.apiKey}` },
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null) as
    { taskId?: string; errorCode?: string; errorMessage?: string } | null;

  if (!response.ok || !body) {
    throw new Error(`RunningHub 模型提交失败（HTTP ${response.status}）`);
  }
  /* 上游的错误码走 `errorCode`（HTTP 仍是 200），所以这一步不能省。 */
  const taskId = String(body.taskId ?? '').trim();
  if (!taskId) {
    throw new Error(upstreamMessage(body, 'RunningHub 模型提交没有返回任务号'));
  }
  return { externalId: taskId };
}

/**
 * 查一次任务状态。
 *
 * 状态词**直接用 RunningHub 那一套**（`SUCCESS` / `FAILED` / `QUEUED` / `RUNNING`），
 * 好让 `lib/taskQuery.ts` 里那段映射与归档不用为它再写一分支（`taskRemote.ts` 认的就是这套）。
 */
export async function queryRhModel(
  externalId: string,
  credentials: RhModelCredentials,
): Promise<RhModelQueryResult> {
  const body = await queryTask(externalId, credentials.apiKey, credentials.baseUrl);
  const status = String(body?.status ?? '').trim().toUpperCase();
  const results = Array.isArray(body?.results)
    ? body.results
      .map(item => (item && typeof item === 'object' ? String((item as { url?: unknown }).url ?? '').trim() : ''))
      .filter(Boolean)
      .map(url => ({ url }))
    : [];
  const errorMessage = String(body?.errorMessage ?? '').trim() || undefined;
  return {
    status: status === 'SUCCESS' || status === 'FAILED' || status === 'QUEUED'
      ? status as RhModelQueryResult['status']
      : 'RUNNING',
    results,
    errorMessage,
  };
}

/**
 * 把画布上的素材地址变成**上游能下载的 URL**。
 *
 * 已经是 `http(s)://` 的原样返回（多半是上一次上传拿到的 `download_url`，
 * 或者是用户自己填的外链）；本机落盘的那两种（资产 / 画布素材）先读成字节、上传、拿下载链接。
 *
 * @throws 读不到字节 / 上传失败时抛错 —— **绝不静默跳过**：
 *         那样会得到「任务成功，但这一份素材根本没交上去」的静默坏结果。
 */
export async function rhModelMediaUrl(
  source: string,
  userId: string,
  credentials: RhModelCredentials,
): Promise<string> {
  const value = String(source ?? '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;

  const { readFirstFrame } = await import('@/lib/providers/videoapi/reference');
  const media = await readFirstFrame(value, userId);
  /*
   * `readFirstFrame` 在失败路径上**一律抛错**（认不出地址 / 文件不在盘上 / 超过 20MB），
   * 只在「传进来是空串」时返回 `undefined`。这里再兜一道是为了不留下一条静默分支 ——
   * 返回空串会让调用方 `if (url)` 一判就跳过，正是上面说的那种零报错坏结果。
   */
  if (!media) throw new Error(`参考素材「${value}」取不到内容 —— 请重新上传一次。`);
  if ('url' in media) return media.url;
  const uploaded = await uploadMediaCached(media.file, credentials.apiKey, credentials.baseUrl);
  if (!uploaded?.url) {
    throw new Error(`素材「${media.file.name}」上传不到 RunningHub（没拿到下载地址）—— 这一份不会参与生成，请重新上传一次。`);
  }
  return uploaded.url;
}
