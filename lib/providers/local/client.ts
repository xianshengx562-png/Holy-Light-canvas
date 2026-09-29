import 'server-only';
import {
  LOCAL_HISTORY_PATH, LOCAL_PROBE_TIMEOUT_MS, LOCAL_PROMPT_PATH, LOCAL_QUERY_TIMEOUT_MS,
  LOCAL_STATS_PATH, LOCAL_SUBMIT_TIMEOUT_MS, LOCAL_UPLOAD_PATH, LOCAL_UPLOAD_TIMEOUT_MS, LOCAL_VIEW_PATH,
} from './config';
import type { LocalGraph } from './graph';

/**
 * 本机 ComfyUI 的客户端。只做四件事：**探活 / 提交 / 查历史 / 传输入**。
 *
 * 与别家 client 的几处不同，都是为了「对面是用户自己的机器」这件事：
 * - **没有 `assertConfigured()`**：本机没有「必须配的环境变量」，地址有默认值、密钥可以留空；
 * - 报错一律说成「本机 / ComfyUI」而不是「上游服务」—— 用户看到的第一个念头该是
 *   「我的 ComfyUI 起没起」，而不是「这个网站坏了」；
 * - 结果地址一律走 `/view?...`，**并且带上 `outputType`**：ComfyUI 的 `/view` URL 里没有扩展名，
 *   不带的话 `lib/media.ts` 认不出这是图还是视频。
 */

/**
 * 调 ComfyUI 真正用得到的就这两个；`comfyuiDir` 是**诊断**用的（服务没开时只读扫目录），
 * 发请求这条路不碰它，所以是可选的 —— `connection.ts` 里那份带 `enabled` / `graph` 的完整凭据
 * 也能直接传进来。
 */
export type LocalCredentials = { baseUrl: string; apiKey: string; comfyuiDir?: string };

/** `/history` 里一条输出文件的形状。`subfolder` / `type` 可能缺席（老版本 ComfyUI）。 */
type OutputFile = { filename?: string; subfolder?: string; type?: string; format?: string };

/** 归一化后的任务状态。**沿用 RunningHub 那套词汇**，好让 `/api/tasks/[id]` 共用一段映射。 */
export type LocalQueryResult = {
  status: 'SUCCESS' | 'FAILED' | 'QUEUED' | 'RUNNING';
  results?: { url: string; outputType: string }[];
  errorMessage?: string;
};

/** 显式标注成 `Record<string, string>`：不标的话两个分支会被推成 `{ authorization?: undefined }`，塞不进 fetch 的 headers。 */
export function authHeaders(credentials: LocalCredentials): Record<string, string> {
  const key = String(credentials?.apiKey || '').trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

/** 地址不对是最常见的一类错误，报的时候要把「现在用的是哪个地址」说进去。 */
function assertBaseUrl(credentials: LocalCredentials) {
  const base = String(credentials?.baseUrl || '').trim();
  if (!base) throw new Error('还没填本机 ComfyUI 的地址。到「设置 · ComfyUI 服务」填上，默认是 http://127.0.0.1:8188。');
  return base.replace(/\/+$/, '');
}

async function readError(response: Response, fallback: string) {
  const text = await response.text().catch(() => '');
  let message = '';
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
    message = parsed?.error?.message || parsed?.message || '';
  } catch { /* 不是 JSON 就用原文 */ }
  return message || text.slice(0, 200) || fallback;
}

/**
 * `/system_stats` 里我们真正会用的那部分。字段全设为可选：
 * 这是**别人家的接口**，老版本 ComfyUI 少几个字段太正常了，缺了就显示「—」，
 * 不能因为少一个 `torch_vram_free` 就把整块面板判成连不上。
 */
export type LocalDeviceInfo = {
  /** 显卡名，已经去掉 `cuda:0 ` 前缀 —— 那个前缀在界面上纯噪音。 */
  name: string;
  type: string;
  index: number;
  vramTotal: number;
  vramFree: number;
  torchVramTotal: number;
  torchVramFree: number;
};

export type LocalSystemInfo = {
  comfyuiVersion: string;
  pythonVersion: string;
  pytorchVersion: string;
  os: string;
  ramTotal: number;
  ramFree: number;
  embeddedPython: boolean;
};

export type LocalStats = { devices: LocalDeviceInfo[]; system: LocalSystemInfo | null };

/** `/system_stats` 的原始形状（只列我们解析的字段）。 */
type RawStats = {
  devices?: {
    name?: unknown; type?: unknown; index?: unknown;
    vram_total?: unknown; vram_free?: unknown;
    torch_vram_total?: unknown; torch_vram_free?: unknown;
  }[];
  system?: {
    comfyui_version?: unknown; python_version?: unknown; pytorch_version?: unknown;
    os?: unknown; ram_total?: unknown; ram_free?: unknown; embedded_python?: unknown;
  };
};

/** 数值字段一律过这一层：接口给 `null` / 字符串 / 缺字段时都退成 0，别让 `NaN` 漏进 UI。 */
function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把 `/system_stats` 的原始响应归一化。**单独抽出来是为了能测**：
 * 探活那条路径要走网络，但这段纯函数可以在没有 ComfyUI 的情况下断言。
 */
export function parseLocalStats(body: unknown): LocalStats {
  const raw = (body ?? {}) as RawStats;
  const devices = (Array.isArray(raw.devices) ? raw.devices : []).map((device) => ({
    /* `cuda:0 NVIDIA GeForce RTX 5060 Laptop GPU : cudaMallocAsync` —— 前后那两截都不是卡名 */
    name: str(device?.name).replace(/^[a-z]+:\d+\s+/i, '').replace(/\s*:\s*[A-Za-z]+$/, '').trim(),
    type: str(device?.type),
    index: num(device?.index),
    vramTotal: num(device?.vram_total),
    vramFree: num(device?.vram_free),
    torchVramTotal: num(device?.torch_vram_total),
    torchVramFree: num(device?.torch_vram_free),
  }));
  const s = raw.system;
  const system: LocalSystemInfo | null = s && typeof s === 'object' ? {
    comfyuiVersion: str(s.comfyui_version),
    /* `3.13.6 (tags/v3.13.6:4e66535, Aug  6 2025, ...) [MSC v.1944 64 bit (AMD64)]` 只要最前面那个版本号 */
    pythonVersion: str(s.python_version).split(/\s+/)[0],
    pytorchVersion: str(s.pytorch_version),
    os: str(s.os),
    ramTotal: num(s.ram_total),
    ramFree: num(s.ram_free),
    embeddedPython: s.embedded_python === true,
  } : null;
  return { devices, system };
}

/**
 * 连不上的**原因分类**。
 *
 * 为什么非要分出来：原来不管出什么事都是一句「确认它已经启动、并且地址和端口没错」——
 * 这句话在「ComfyUI 真的没开」时是对的，但在「端口被别的软件占了」「请求被代理截走了」
 * 「ComfyUI 启了鉴权」这三种情况下完全是误导，用户会一遍遍重启一个本来就没问题的服务。
 *
 * 分类的判据只用**底层错误码**（`ECONNREFUSED` 等），不看消息文本 ——
 * 消息文本会随 Node 版本和语言环境变，错误码不会。
 */
export type LocalProbeReason =
  /** 端口上根本没有程序在听。ComfyUI 没开，或者它跑在别的端口。 */
  | 'refused'
  /** 一直没回应。地址写错、主机不可达、或者被防火墙静默丢弃。 */
  | 'timeout'
  /** 主机名解析不出来。地址写错了。 */
  | 'dns'
  /** 要鉴权（401 / 403）。本机 ComfyUI 一般不会，多半是前面挂了层反代。 */
  | 'unauthorized'
  /** 答了话、但答的是错误状态码。 */
  | 'http'
  /** 有程序在答话，可它不是 ComfyUI —— 端口被别的软件占了，或者请求被代理截走了。 */
  | 'not-comfyui'
  /** 说不清。宁可说不知道，也不要编一个方向。 */
  | 'unknown';

/** 每个原因对应的**一句可执行的动作**。界面上原样显示，别在那一层再改写一遍。 */
export const LOCAL_PROBE_REASON_TEXT: Record<LocalProbeReason, string> = {
  refused: '这个端口上没有任何程序在听 —— ComfyUI 没启动，或者它跑在别的端口上。',
  timeout: '连这个地址一直没回应 —— 地址或端口写错了，也可能是被防火墙拦下了。',
  dns: '这个主机名解析不出来 —— 地址写错了。',
  unauthorized: '对面要求鉴权（401 / 403）—— 到「设置 · ComfyUI 服务」把它的 API Key 填上。',
  http: 'ComfyUI 在，但它回了一个错误状态码。',
  'not-comfyui': '这个端口上有程序在答话，可它不是 ComfyUI —— 端口被别的软件占了，或者请求被代理截走了。',
  unknown: '连不上，原因暂时判断不出来。',
};

/**
 * 顺着 `cause` 链往里找错误码。
 *
 * Node 的 fetch 把真正的错误裹了两层（`TypeError: fetch failed` → `AggregateError` →
 * `Error: connect ECONNREFUSED`），只看最外层永远是 `undefined` —— 这是「分类分不出来」
 * 最常见的原因。设了层数上限，免得遇上自引用的 cause 转不出来。
 */
function errorCodeOf(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const node = current as { code?: unknown; cause?: unknown } | null;
    if (typeof node?.code === 'string') return node.code.toUpperCase();
    current = node?.cause;
  }
  return '';
}

export function classifyProbeError(error: unknown): LocalProbeReason {
  const name = error instanceof Error ? error.name : '';
  /** 超时在两个地方表现不同：undici 抛 `TimeoutError`，被上层包过之后只剩 `AbortError`。 */
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const code = errorCodeOf(error);
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EHOSTUNREACH'
    || code === 'ENETUNREACH' || code === 'EHOSTDOWN') return 'timeout';
  return 'unknown';
}

export type LocalTestResult = { ok: boolean; message: string; stats?: LocalStats; reason?: LocalProbeReason };

/** 探活。打 `/system_stats` —— 比 `/prompt` 轻，也不会真的开始跑一次生成。 */
export async function testLocalConnection(credentials: LocalCredentials): Promise<LocalTestResult> {
  const base = assertBaseUrl(credentials);
  try {
    const response = await fetch(`${base}${LOCAL_STATS_PATH}`, {
      method: 'GET',
      headers: authHeaders(credentials),
      signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, message: `连不上本机 ComfyUI（${base}）：HTTP ${response.status}。确认它已经启动、并且地址和端口没错。` };
    }
    const body = await response.json().catch(() => null);
    const stats = parseLocalStats(body);
    const device = stats.devices[0]?.name;
    const version = stats.system?.comfyuiVersion;
    const suffix = version ? ` · ComfyUI ${version}` : '';
    return {
      ok: true,
      stats,
      message: device ? `已连上本机 ComfyUI（${device}${suffix}）。` : `已连上本机 ComfyUI（${base}${suffix}）。`,
    };
  } catch (error) {
    /*
     * 原来这里一律说「确认它已经启动」—— 在端口被别的软件占了、请求被代理截走、
     * 对面启了鉴权这三种情况下，这句话会把人往错的方向带。
     * 分出原因后各说各的：能让用户**下一步做对**的报错才算报错。
     */
    const reason = classifyProbeError(error);
    const detail = error instanceof Error ? error.message : '请求失败';
    return {
      ok: false,
      reason,
      message: `连不上本机 ComfyUI（${base}）：${LOCAL_PROBE_REASON_TEXT[reason]}（${detail}）`,
    };
  }
}

export type LocalSubmitInput = { graph: LocalGraph; clientId: string };

/**
 * 提交一次生成。返回 `prompt_id` —— 后面靠它查 `/history`。
 *
 * 两个必须当场拦下的坑：
 * 1. 拿不到 `prompt_id` 却当成成功 → 一次永远轮询不到的幽灵任务；
 * 2. `node_errors` 非空却当成成功 → ComfyUI 收下了图但根本不会跑，界面上只会一直转圈。
 */
export async function submitLocalPrompt(input: LocalSubmitInput, credentials: LocalCredentials): Promise<{ externalId: string }> {
  const base = assertBaseUrl(credentials);
  let response: Response;
  try {
    response = await fetch(`${base}${LOCAL_PROMPT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(credentials) },
      body: JSON.stringify({ prompt: input.graph, client_id: input.clientId }),
      signal: AbortSignal.timeout(LOCAL_SUBMIT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`投不进本机 ComfyUI（${base}）：${error instanceof Error ? error.message : '请求失败'}。`);
  }
  const body = await response.json().catch(() => null) as { prompt_id?: string; node_errors?: Record<string, unknown> } | null;
  if (!response.ok || !body) {
    throw new Error(`本机 ComfyUI 拒绝了这次生成：${await readError(response, `HTTP ${response.status}`)}`);
  }
  const nodeErrors = body.node_errors ? Object.keys(body.node_errors) : [];
  if (nodeErrors.length) {
    throw new Error(`本机 ComfyUI 说节点 ${nodeErrors.join('、')} 有问题（node_errors）。多半是缺模型或缺少自定义节点 —— 去 ComfyUI 里手动跑一次这份图就能看到完整报错。`);
  }
  const promptId = String(body.prompt_id || '').trim();
  if (!promptId) throw new Error('本机 ComfyUI 没有返回 prompt_id，查不到进度。请确认它是最新的 ComfyUI。');
  return { externalId: promptId };
}

function asFileList(value: unknown): OutputFile[] {
  return Array.isArray(value) ? (value as OutputFile[]) : [];
}

/**
 * 从一条输出里挑出真正要落盘的那批文件。
 *
 * 一个视频节点可能同时吐 `gifs`（视频）和 `images`（封面），全收会落两份、画布上冒出两个结果；
 * 所以**按节点先挑一类**：有 `videos` / `gifs` 就只收它们，没有才收 `images`。
 */
function pickFromNode(node: Record<string, unknown>): { files: OutputFile[]; hint: string } {
  const videos = [...asFileList(node.videos), ...asFileList(node.gifs)];
  if (videos.length) return { files: videos, hint: 'video' };
  const images = asFileList(node.images);
  if (images.length) return { files: images, hint: 'image' };
  return { files: [], hint: '' };
}

/** 结果地址。`/view` 对图片和视频都有效（VHS 的视频也走它）。 */
export function localViewUrl(file: OutputFile, credentials: LocalCredentials) {
  const base = assertBaseUrl(credentials);
  const params = new URLSearchParams({
    filename: String(file.filename || ''),
    subfolder: String(file.subfolder || ''),
    type: String(file.type || 'output'),
  });
  return `${base}${LOCAL_VIEW_PATH}?${params.toString()}`;
}

/**
 * 这个文件是图还是视频。**先用扩展名，再用来源键名** ——
 * VHS 有时把动图（webp/gif）放在 `gifs` 里，只看键名会把它当视频落盘。
 */
function outputTypeOf(file: OutputFile, hint: string) {
  const name = String(file.filename || '').toLowerCase();
  if (/\.(mp4|webm|mov|avi|mkv|m4v)$/.test(name)) return 'video';
  if (/\.(png|jpe?g|webp|gif|avif|bmp)$/.test(name)) return 'image';
  return hint || 'image';
}

export async function queryLocalHistory(promptId: string, credentials: LocalCredentials): Promise<LocalQueryResult> {
  const base = assertBaseUrl(credentials);
  const response = await fetch(`${base}${LOCAL_HISTORY_PATH}/${encodeURIComponent(promptId)}`, {
    method: 'GET',
    headers: authHeaders(credentials),
    signal: AbortSignal.timeout(LOCAL_QUERY_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null) as Record<string, {
    status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
    outputs?: Record<string, Record<string, unknown>>;
  }> | null;
  if (!response.ok || !body) {
    throw new Error(`查不到本机 ComfyUI 的任务进度：${await readError(response, `HTTP ${response.status}`)}`);
  }
  /** 还没跑完时 `/history/<id>` 返回的是 `{}` —— 这不是失败，是「还在排队 / 正在跑」。 */
  const entry = body[promptId];
  if (!entry) return { status: 'RUNNING' };

  if (entry.status?.status_str === 'error') {
    return { status: 'FAILED', errorMessage: composeErrorMessage(entry.status.messages) };
  }
  const outputs = entry.outputs || {};
  const results: { url: string; outputType: string }[] = [];
  for (const node of Object.values(outputs)) {
    const { files, hint } = pickFromNode(node || {});
    for (const file of files) {
      if (!file?.filename) continue;
      results.push({ url: localViewUrl(file, credentials), outputType: outputTypeOf(file, hint) });
    }
  }
  if (!results.length) return { status: 'RUNNING' };
  return { status: 'SUCCESS', results };
}

/**
 * 把 ComfyUI 那串 `[ [ 'execution.error', { node_id, exception_message, ... } ], ... ]` 收成一句话。
 * 结构不认得时退回「去 ComfyUI 里看」—— 与其编一句错的，不如指一条真正能看到原因的路。
 */
function composeErrorMessage(messages: unknown[] | undefined): string {
  if (!Array.isArray(messages)) return '本机 ComfyUI 跑这次生成时报错了。去 ComfyUI 的界面里能看到完整原因。';
  for (const item of messages) {
    if (!Array.isArray(item)) continue;
    const payload = item[1] as { exception_message?: string; node_id?: string; node_type?: string } | undefined;
    if (payload?.exception_message) {
      const where = payload.node_type ? `节点 ${payload.node_id ?? '?'}（${payload.node_type}）` : `节点 ${payload.node_id ?? '?'}`;
      return `本机 ComfyUI 在${where}报错：${String(payload.exception_message).slice(0, 300)}`;
    }
  }
  return '本机 ComfyUI 跑这次生成时报错了。去 ComfyUI 的界面里能看到完整原因。';
}

/**
 * 把一份输入（参考图 / 视频 / 音频）传到本机 ComfyUI 的 `input` 目录，返回文件名。
 *
 * 一律走 `/upload/image`：ComfyUI 只有这一个上传端点，它并不校验是不是图，只是把文件放进
 * `input` 目录 —— 而 VHS 的 Load Video / Load Audio 读的正是同一个目录。
 *
 * `overwrite=true` 是为了不让同名文件被自动改名成 `xxx_00001_.png`：
 * 改了名之后画布那边的记录就对不上了，而每次生成都留一份新副本只会把 input 目录撑爆。
 */
export async function uploadLocalMedia(file: File, credentials: LocalCredentials): Promise<string> {
  const base = assertBaseUrl(credentials);
  const form = new FormData();
  form.set('image', file);
  form.set('overwrite', 'true');
  form.set('type', 'input');
  let response: Response;
  try {
    response = await fetch(`${base}${LOCAL_UPLOAD_PATH}`, {
      method: 'POST',
      headers: authHeaders(credentials),
      body: form,
      signal: AbortSignal.timeout(LOCAL_UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`传不到本机 ComfyUI（${base}）：${error instanceof Error ? error.message : '请求失败'}。`);
  }
  const body = await response.json().catch(() => null) as { name?: string } | null;
  if (!response.ok || !body?.name) {
    throw new Error(`本机 ComfyUI 收不下这份输入：${await readError(response, `HTTP ${response.status}`)}`);
  }
  return body.name;
}
