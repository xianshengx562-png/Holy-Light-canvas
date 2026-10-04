import 'server-only';
import { sharedKeyAllowed } from './config';
import { RUNNINGHUB_SITES } from './connection';
import { runningHubSiteHost } from './urls';

/**
 * RunningHub **应用**（WebApp / AI App）这一条路。
 *
 * 和工作流（`client.ts`）是两套端点，**不共用 baseUrl 的后缀**：
 *   - 工作流那套在 `/openapi/v2` 下（`/run/workflow/<id>`、`/query`）；
 *   - 应用这套挂在**站点根**下（`/api/webapp/apiCallDemo`、`/task/openapi/ai-app/run`、
 *     `/task/openapi/outputs`）。
 *
 * 所以这里每个函数都先把 baseUrl 的 `/openapi/v2` 剥掉再拼路径 —— 少了这一步，
 * 请求会打到 `/openapi/v2/api/webapp/...`，拿回来的是一个「看起来像鉴权失败」的错，
 * 而根因只是前缀多了一层。
 */

const DEFAULT_BASE_URL = process.env.RUNNINGHUB_API_BASE_URL || RUNNINGHUB_SITES.cn.defaultBaseUrl;

/**
 * 站点根地址：剥掉 `/openapi/v2`（工作流那套用的前缀），再去掉末尾斜杠。
 * 实现在 `urls.ts` —— 2026-10-04 抽出去的：取消任务那条路（`client.ts` 的 `cancelTask`）
 * 也要同一个「剥前缀」规则，两份写迟早有一份忘了剥，症状就是上面说的那种
 * 「看着像鉴权失败、其实只是前缀多了一层」。
 */
function host(baseUrl?: string) {
  return runningHubSiteHost(baseUrl, DEFAULT_BASE_URL);
}

/** 与 `client.ts` 的 `bearer()` 同一条规矩：共享关着的时候不传 key 就直接报错。 */
function bearer(apiKey?: string) {
  const key = apiKey?.trim() || (sharedKeyAllowed() ? process.env.RUNNINGHUB_API_KEY?.trim() : '');
  if (!key) throw new Error('尚未配置 RunningHub API Key，请在「设置 · 模型服务」中填写。');
  return key;
}

type Envelope = { code?: number; msg?: string; message?: string; data?: unknown; [key: string]: unknown };

async function postJson(path: string, body: unknown, apiKey?: string, baseUrl?: string): Promise<Envelope> {
  const response = await fetch(`${host(baseUrl)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer(apiKey)}` },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null) as Envelope | null;
  if (!response.ok || !payload || typeof payload !== 'object') throw new Error(`RunningHub HTTP ${response.status}`);
  const code = payload.code;
  if (code !== undefined && code !== null && Number(code) !== 0) {
    throw new Error(`RunningHub：${payload.msg || payload.message || `错误码 ${code}`}`);
  }
  return payload;
}

/** 应用详情里我们只认这两样：公开的字段清单，以及它的名字（给新建的工作流当默认名）。 */
export type WebAppInfo = { nodeInfoList: unknown[]; appName: string };

/**
 * 拉一个应用对外公开的参数清单。
 *
 * 端点 `GET /api/webapp/apiCallDemo` —— 它是 RunningHub 给「API 调用示例」用的那个接口，
 * 返回体里带着一份完整的 `nodeInfoList`，是目前唯一能拿到应用字段的公开通道。
 *
 * ⚠️ 这里**故意不走** `client.ts` 的 `request()`：那个函数会把路径拼到 `/openapi/v2` 后面，
 * 而这个端点不在那儿（见文件头）。
 */
export async function getWebAppInfo(webAppId: string, apiKey?: string, baseUrl?: string): Promise<WebAppInfo> {
  const key = bearer(apiKey);
  const url = new URL(`${host(baseUrl)}/api/webapp/apiCallDemo`);
  url.searchParams.set('apiKey', key);
  url.searchParams.set('webappId', webAppId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null) as Envelope | null;
  if (!response.ok || !payload || typeof payload !== 'object') throw new Error(`RunningHub HTTP ${response.status}`);
  if (payload.code !== undefined && payload.code !== null && Number(payload.code) !== 0) {
    throw new Error(`RunningHub：${payload.msg || payload.message || `错误码 ${payload.code}`}`);
  }
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('RunningHub 没有返回这个应用的字段。');
  const row = data as { nodeInfoList?: unknown; name?: unknown; appName?: unknown; webappName?: unknown; title?: unknown };
  const nodeInfoList = Array.isArray(row.nodeInfoList) ? row.nodeInfoList : [];
  return {
    nodeInfoList,
    appName: String(row.appName ?? row.webappName ?? row.name ?? row.title ?? '').trim().slice(0, 120),
  };
}

/** 提交一次应用运行。返回形状和 `client.ts` 的 `submitWorkflow` 对齐，好让调用方不用分叉。 */
export async function submitWebApp(input: {
  webAppId: string;
  nodeInfoList: unknown[];
  instanceType?: string;
}, apiKey?: string, baseUrl?: string): Promise<{
  taskId?: string;
  status?: string;
  errorMessage?: string;
  results?: { url?: string; outputType?: string }[];
}> {
  const payload = await postJson('/task/openapi/ai-app/run', {
    webappId: input.webAppId,
    nodeInfoList: input.nodeInfoList,
    instanceType: input.instanceType || 'default',
  }, apiKey, baseUrl);
  const data = (payload.data || {}) as { taskId?: unknown; taskStatus?: unknown; status?: unknown };
  return {
    taskId: data.taskId ? String(data.taskId) : undefined,
    status: String(data.taskStatus ?? data.status ?? 'QUEUED').toUpperCase(),
  };
}

/**
 * 取一次应用运行的结果。
 *
 * 端点 `POST /task/openapi/outputs`，返回的 `data` 有两种形状 —— 成功时可能直接是**数组**，
 * 也可能还是 `{ taskStatus, outputs }` 那个对象；两种都得认，否则任务会永远停在 running。
 *
 * 结果归一化成工作流那套 `{ url, outputType }`：落盘、写库、退款那一整套下游代码
 * 只认这个形状（见 `server/api/tasks/[id]/route.ts`）。
 */
export async function queryWebAppOutputs(
  taskId: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<{ status: string; results?: { url: string; outputType?: string }[]; errorMessage?: string; failedReason?: unknown }> {
  const payload = await postJson('/task/openapi/outputs', { taskId }, apiKey, baseUrl);
  const data = payload.data;
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { outputs?: unknown } | null)?.outputs) ? (data as { outputs: unknown[] }).outputs : [];
  const raw = Array.isArray(data)
    ? undefined
    : (data as { taskStatus?: unknown; status?: unknown; failedReason?: unknown; errorMessage?: unknown } | null | undefined);
  const status = String(raw?.taskStatus ?? raw?.status ?? (list.length ? 'SUCCESS' : 'RUNNING')).toUpperCase();
  const failed = status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED' || status === 'CANCELED' || Boolean(raw?.failedReason);
  const results = list.map(item => {
    const row = (item || {}) as { fileUrl?: unknown; url?: unknown; fileType?: unknown; outputType?: unknown };
    const url = String(row.fileUrl ?? row.url ?? '').trim();
    return { url, outputType: String(row.fileType ?? row.outputType ?? '').trim() || undefined };
  }).filter(item => item.url);
  return {
    status: failed ? 'FAILED' : (status || 'RUNNING'),
    results: results.length ? results : undefined,
    /*
     * ⚠️ 这里**不能**直接 `String(failedReason)`：工作流那条给的是对象，String() 出来是
     * "[object Object]"，比没有还糟。详细原因交给 `failureDetailOf()` 归一化，这里只留一句兜底。
     */
    errorMessage: failed
      ? String(typeof raw?.failedReason === 'string' && raw.failedReason ? raw.failedReason : raw?.errorMessage || '应用运行失败。')
      : undefined,
    failedReason: raw?.failedReason,
  };
}
