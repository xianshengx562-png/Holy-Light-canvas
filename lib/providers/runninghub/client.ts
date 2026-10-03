import 'server-only';
import { sharedKeyAllowed } from './config';
import { RUNNINGHUB_SITES } from './connection';
import { bytesDigest, readUploadCache, rememberUpload, uploadCacheKey } from './upload-cache';

/**
 * ⚠️ 2026-09-21：地址不再是**全局常量**了。
 *
 * RunningHub 有两个站（国内 runninghub.cn / 海外 runninghub.ai），打哪个站由
 * `User.runninghubSite` 决定（见 `connection.ts` 的 `resolveRunningHub`）。
 * 原来这里写死一个 `baseUrl`，海外站的 Key 也会被送到国内站 —— 症状是 401
 * 或者「工作流不存在」，而根因只是打错了站，这种错最难查。
 *
 * 所以每个函数末尾多一个 `baseUrl?`，不传才回落到国内站的默认值。
 * **所有调用点都要把 `resolveRunningHub()` 给的地址带过来**，别图省事不传。
 */
const DEFAULT_BASE_URL = process.env.RUNNINGHUB_API_BASE_URL || RUNNINGHUB_SITES.cn.defaultBaseUrl;

function endpoint(baseUrl?: string) {
  return baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

/**
 * ⚠️ 这里原本是「没传 key 就吃 env 里的站点 key」—— 等于绕开 `resolveApiKey()` 又兜了一次底，
 * 光在 `resolveApiKey` 里加开关根本拦不住。现在接同一个开关：共享关着的时候不传 key 就直接报错，
 * 绝不静默改用站点 key。生成 / 查询 / 上传三条链路都走这里，这正是开关要管住的地方。
 */
function bearer(apiKey?: string) {
  const key = apiKey?.trim() || (sharedKeyAllowed() ? process.env.RUNNINGHUB_API_KEY?.trim() : '');
  if (!key) throw new Error('尚未配置 RunningHub API Key，请在「设置 · 模型服务」中填写。');
  return `Bearer ${key}`;
}
function authHeaders(apiKey?: string) { return { 'content-type': 'application/json', authorization: bearer(apiKey) }; }
/**
 * 🔴 一律带超时（2026-10-03，N-112）：这一层原来**没有任何超时**，上游不回就一直挂着 ——
 * 而 `queryTask` 是轮询的心跳，挂一次整个节点就一直转圈，最后还只显示一句
 * 「服务暂时不可用」。查询 30 秒足够；提交（`/run/workflow`）给 60 秒，
 * 它要把整张节点图交上去，慢一些是正常的。
 */
const QUERY_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 60_000;

async function request(path: string, init: RequestInit, apiKey?: string, baseUrl?: string, timeoutMs = QUERY_TIMEOUT_MS) { const response = await fetch(`${endpoint(baseUrl)}${path}`, { ...init, headers: { ...authHeaders(apiKey), ...(init.headers || {}) }, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) }); const body = await response.json().catch(() => null); if (!response.ok) throw new Error(`RunningHub HTTP ${response.status}`); return body as RunningHubResponse; }
export type RunningHubResult = { url?: string; nodeId?: string; outputType?: string; text?: string | null };
export type RunningHubResponse = { taskId?: string; status?: string; errorCode?: string; errorMessage?: string; results?: RunningHubResult[] | null; [key: string]: unknown };
export async function submitWorkflow(input: { workflowId: string; nodeInfoList: unknown[]; instanceType?: string; usePersonalQueue?: boolean }, apiKey?: string, baseUrl?: string) { return request(`/run/workflow/${encodeURIComponent(input.workflowId)}`, { method: 'POST', body: JSON.stringify({ addMetadata: true, nodeInfoList: input.nodeInfoList, instanceType: input.instanceType || 'default', usePersonalQueue: input.usePersonalQueue ?? false }) }, apiKey, baseUrl, SUBMIT_TIMEOUT_MS); }
export async function queryTask(taskId: string, apiKey?: string, baseUrl?: string) { return request('/query', { method: 'POST', body: JSON.stringify({ taskId }) }, apiKey, baseUrl); }

/**
 * 上传给多少时间 —— **按体积算，不写死**（2026-10-03，N-113）。
 *
 * 原来这里是 `AbortSignal.timeout(120_000)` 一个死数，素材一大就必撞。
 * 徐先那次是 latent 中转递一份 mp4，日志写着「已跑 120609ms [超时]」——
 * 一秒不多不少，看着像上游挂了，其实是**我们自己的秒表到点了**。
 *
 * 依据（实测，不是拍脑袋）：本机到 RunningHub 约 **75 KB/s ≈ 13 秒/MB**
 * （发 174MB 的安装包花了 38 分钟）。所以给「每 MB 15 秒 + 90 秒兜底」，
 * 再封一档 30 分钟上限 —— 小文件不至于干等半小时，大文件也不会因为网慢被判死。
 *
 * ⚠️ 超时太长也有代价：真的传不动时用户要干等这么久才看到报错。
 *    所以下面那句报错必须**说清等了多少秒、多大的文件**，让人能据此换素材。
 */
export function uploadTimeoutMs(bytes: number) {
  const mb = Math.max(1, Math.ceil((Number(bytes) || 0) / 1048576));
  return Math.min(30 * 60_000, 90_000 + mb * 15_000);
}

export async function uploadMedia(file: File, apiKey?: string, baseUrl?: string) {
  const form = new FormData();
  form.set('file', file);
  const response = await fetch(`${endpoint(baseUrl)}/media/upload/binary`, {
    method: 'POST', headers: { authorization: bearer(apiKey) }, body: form,
    signal: AbortSignal.timeout(uploadTimeoutMs(file.size)),
  });
  const body = await response.json().catch(() => null);
  /*
   * 🔴 失败原因要**带出去**：原来只有一句「RunningHub 上传失败。」，HTTP 状态码与上游的原话
   * 全丢了，界面上（被 `api()` 兜成 500）更是只剩一句「服务暂时不可用」——
   * 2026-10-02 徐先点超清就是这种局面：谁都看不出是 413 还是 401。
   */
  if (!response.ok || !body || body.code !== 0 || !body.data?.fileName) {
    const detail = String(body?.errorMessage || body?.msg || '').trim()
      || (body && body.code !== undefined ? `code ${body.code}` : '');
    throw new Error(`RunningHub 上传失败（HTTP ${response.status}${detail ? ' · ' + detail : ''}）`);
  }
  return { fileName: String(body.data.fileName), url: String(body.data.download_url || ''), uploadedAt: new Date().toISOString() };
}

/**
 * `uploadMedia` with a "same bytes → same upstream file name" cache in front of it.
 *
 * A run has to get its latents and reference images onto RunningHub *before* the task
 * exists, and it does that serially: 徐先's two latents (13.5 MB + 31.6 MB) at this
 * machine's ~75 KB/s upstream meant the canvas sat on "运行中" for minutes while the cloud
 * had not even started — the wait was our upload, not their queue. The *same* latent is
 * re-sent on every run of a chain, so most of that was pure repetition.
 *
 * Everything that pushes a file to RunningHub should go through here. The cache key is
 * (host + account + sha256 of the bytes), so a renamed or re-generated copy of the same
 * file hits too.
 *
 * ⚠️ On a cache miss we upload the bytes we already read — not the original `File` — so the
 * hash and the upload are guaranteed to be about the same content.
 */
export async function uploadMediaCached(file: File, apiKey?: string, baseUrl?: string) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const key = uploadCacheKey({ baseUrl, apiKey, digest: bytesDigest(bytes) });
  const hit = await readUploadCache(key);
  if (hit) return { ...hit, uploadedAt: new Date().toISOString() };
  const fresh = await uploadMedia(new File([bytes], file.name || 'file', { type: file.type }), apiKey, baseUrl);
  await rememberUpload(key, fresh, bytes.length);
  return fresh;
}

/**
 * 获取工作流 Json（节点图）。返回 `data.prompt` —— 一个 ComfyUI 工作流图的 JSON 字符串，
 * 形如 `{ "3": { "class_type": "KSampler", "inputs": { "steps": 20, ... } }, ... }`。
 *
 * 配置页「输入工作流 ID 自动拉取节点字段」就靠它：把每个节点的 `inputs` 摊平成可编辑字段。
 *
 * ⚠️ 这个端点在 `www.runninghub.cn/api/openapi/getJsonApiFormat`，**不在** run/query 用的
 * `/openapi/v2` 前缀下，所以 host 要从 `baseUrl` 里把 `/openapi/v2` 剥掉再拼。
 * 请求体里也要带 `apiKey`（和 Authorization 头各一份，RunningHub 两边都认）。
 *
 * ⚠️ 这里的 env 回退是**故意**不走 `sharedKeyAllowed()` 的：拉节点图是站长自己在「设置 ·
 * 工作流配置」里配工作流的**站点级**功能，不是「把站点 key 给别的账号用」。生成 / 查询 / 上传
 * 那三条链路走 `bearer()`，那才是开关要管的地方 —— 别把这处也焊死，否则站长自己配不了工作流。
 */
export async function getWorkflowJson(workflowId: string, apiKey?: string, baseUrl?: string) {
  const key = apiKey?.trim() || process.env.RUNNINGHUB_API_KEY?.trim();
  if (!key) throw new Error('尚未配置 RunningHub API Key，请在「设置 · 模型服务」中填写。');
  const host = endpoint(baseUrl).replace(/\/openapi\/v2\/?$/, '');
  const response = await fetch(`${host}/api/openapi/getJsonApiFormat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ apiKey: key, workflowId }),
    cache: 'no-store',
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== 'object') throw new Error(`RunningHub HTTP ${response.status}`);
  const code = (body as { code?: number }).code;
  if (code !== 0) throw new Error(`RunningHub：${(body as { msg?: string }).msg || `错误码 ${code}`}`);
  const prompt = (body as { data?: { prompt?: unknown } }).data?.prompt;
  if (typeof prompt !== 'string') throw new Error('RunningHub 返回的工作流结构异常。');
  return prompt;
}
