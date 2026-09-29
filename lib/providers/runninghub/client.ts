import 'server-only';
import { sharedKeyAllowed } from './config';
import { RUNNINGHUB_SITES } from './connection';

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
async function request(path: string, init: RequestInit, apiKey?: string, baseUrl?: string) { const response = await fetch(`${endpoint(baseUrl)}${path}`, { ...init, headers: { ...authHeaders(apiKey), ...(init.headers || {}) }, cache: 'no-store' }); const body = await response.json().catch(() => null); if (!response.ok) throw new Error(`RunningHub HTTP ${response.status}`); return body as RunningHubResponse; }
export type RunningHubResult = { url?: string; nodeId?: string; outputType?: string; text?: string | null };
export type RunningHubResponse = { taskId?: string; status?: string; errorCode?: string; errorMessage?: string; results?: RunningHubResult[] | null; [key: string]: unknown };
export async function submitWorkflow(input: { workflowId: string; nodeInfoList: unknown[]; instanceType?: string; usePersonalQueue?: boolean }, apiKey?: string, baseUrl?: string) { return request(`/run/workflow/${encodeURIComponent(input.workflowId)}`, { method: 'POST', body: JSON.stringify({ addMetadata: true, nodeInfoList: input.nodeInfoList, instanceType: input.instanceType || 'default', usePersonalQueue: input.usePersonalQueue ?? false }) }, apiKey, baseUrl); }
export async function queryTask(taskId: string, apiKey?: string, baseUrl?: string) { return request('/query', { method: 'POST', body: JSON.stringify({ taskId }) }, apiKey, baseUrl); }

export async function uploadMedia(file: File, apiKey?: string, baseUrl?: string) {
  const form = new FormData();
  form.set('file', file);
  const response = await fetch(`${endpoint(baseUrl)}/media/upload/binary`, {
    method: 'POST', headers: { authorization: bearer(apiKey) }, body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.code !== 0 || !body.data?.fileName) throw new Error('RunningHub 上传失败。');
  return { fileName: String(body.data.fileName), url: String(body.data.download_url || ''), uploadedAt: new Date().toISOString() };
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
