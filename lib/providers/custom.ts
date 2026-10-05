/**
 * 「自定义接口」—— 用户自己找的 OpenAI 兼容网关（2026-09-21，协议照 AIFISHER 的
 * `createCustomProviderStore` / `/custom-providers`）。
 *
 * ## 为什么是「一条接口下面挂多个模型」
 *
 * 同一个网关下往往有十几个模型，共用同一把 Key。若做成一个模型一条，用户得把同一个
 * Key 抄十几遍 —— 抄错一位的表现是「测试连不上」，而根因只是手滑，这类问题最难查。
 * 所以 `models` 是**一条记录里的数组**，每个模型带自己的 `kind`。
 *
 * ## 三个端点（与 AIFISHER 对齐）
 *
 * - `${baseUrl}/images/generations` —— 文生图（同步）
 * - `${baseUrl}/images/edits`       —— 图生图（同步，multipart）
 * - `${baseUrl}/chat/completions`   —— 多模态对话（提示词优化 / 看图描述）
 * - `${baseUrl}/models`             —— 拉模型清单（也是探活用的那个；地址怎么试见 probeCustomProvider）
 * - `${baseUrl}/videos/generations` —— 文生视频（提交拿任务号，异步轮询）
 *
 * 视频那条 AIFISHER 没走标准（它自家是同步的），这里是**按 OpenAI 风格异步**实现的，
 * 与 Holy Light画布的 `videoapi` 同一套「提交 → 轮询」节奏（见 `lib/providers/videoapi/client.ts`）。
 *
 * ⚠️ Key 一律**加密入库**（`encryptedApiKey`），明文只在这个模块内部出现，
 * 千万别把整行返回给界面 —— 掩码函数在 `secret.ts`。
 */
import 'server-only';
import { db } from '@/lib/db';
import { decryptSecret, encryptSecret, maskSecret } from '@/lib/providers/secret';
import { htmlEndpointMessage, htmlPageTitle, looksLikeHtml } from '@/lib/providers/custom/http';

/** 一个模型能干的事。决定它出现在哪个下拉里：**节点引擎**只看 image / video。 */
export type CustomModelKind = 'image' | 'video' | 'text';

/**
 * 一个模型的**用途是多选**（2026-09-23 改的）。
 *
 * 单选那版的毛病：中转站上同一个模型常常既能出图又能当文本用（徐先那条中转就是），
 * 而 `kind` 只有一个值 —— 按名字猜成「出图」之后，它就只出现在图片段，
 * 文本段与视频段永远是「这一段还没有兼容接口」，连勾的地方都没有。
 * 改成数组之后，一条模型可以同时是「出图 + 出视频 + 文本」。
 */
export type CustomModel = { id: string; name: string; kinds: CustomModelKind[] };

/**
 * 一条接口下面能挂多少个模型（2026-09-22）。
 *
 * 徐先的要求是「不限数量」—— 中转站一次能报出几百个模型，500 那条老上限会直接把
 * 拉下来的清单截断，表现为「明明拉到了，保存时说请求内容过长」。
 *
 * ⚠️ 这里**仍然留一个护栏**，只是把它放到「正常用什么都碰不到」的位置：
 * 完全没有上限的话，一个写坏的脚本能把整份画布 JSON 撑到几百 MB，而那时
 * 界面只是变卡，没人会想到是某条接口的模型清单炸了。
 */
export const CUSTOM_MODEL_LIMIT = 5000;

/** 模型清单那一列能有多大（字节）。按 5000 个模型 × 每条 ~60 字节再留一倍余量。 */
export const CUSTOM_MODEL_BODY_BYTES = 2 * 1024 * 1024;

export const CUSTOM_MODEL_KINDS: { value: CustomModelKind; label: string }[] = [
  { value: 'image', label: '出图' },
  { value: 'video', label: '出视频' },
  { value: 'text', label: '文本（提示词优化）' },
];

export const CUSTOM_MODEL_KIND_LABEL: Record<CustomModelKind, string> = {
  image: '出图',
  video: '出视频',
  text: '文本',
};

export type CustomProviderView = {
  id: string;
  name: string;
  baseUrl: string;
  /** 只有尾缀。明文从不出库。 */
  masked: string;
  hasKey: boolean;
  models: CustomModel[];
  enabled: boolean;
  status: string;
  errorMessage: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const VIEW_SELECT = {
  id: true,
  userId: true,
  name: true,
  baseUrl: true,
  encryptedApiKey: true,
  models: true,
  enabled: true,
  status: true,
  errorMessage: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * 把库里 `models` 那一列变成 `CustomModel[]`。
 *
 * 防御写得重是因为这一列是**用户可控的 JSON**：SQLite 里可能存成字符串（老行、手工改库），
 * 也可能是数组；数组元素可能是字符串（只有 id）也可能是对象。`readModels` 只保证
 * 输出一定是合法数组，**不保证** kind 猜得对 —— 猜错的代价由 UI 的手动改档位兜住。
 */
export function readModels(raw: unknown): CustomModel[] {
  let list: unknown = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list.map((item: unknown): CustomModel => {
    if (typeof item === 'string') return { id: item, name: item, kinds: [guessModelKind(item)] };
    if (!item || typeof item !== 'object') return { id: '', name: '', kinds: ['image'] };
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? '').trim();
    return { id, name: String(row.name ?? id).trim() || id, kinds: readKinds(row, id) };
  }).filter(item => item.id);
}

/**
 * 读一条模型的用途：`kinds`（多选，新写的行）优先，`kind`（单选，老行）兜底，
 * 都没有才按 id 猜 —— **老数据不用迁移**，以前存的行读出来就是单元素数组。
 *
 * `kinds` 里可能有脏值（手工改库、别的脚本写的），只认三个合法值并去重。
 */
export function readKinds(row: Record<string, unknown>, id: string): CustomModelKind[] {
  const isKind = (value: unknown): value is CustomModelKind =>
    value === 'image' || value === 'video' || value === 'text';
  if (Array.isArray(row.kinds)) {
    const out: CustomModelKind[] = [];
    for (const value of row.kinds) if (isKind(value) && !out.includes(value)) out.push(value);
    if (out.length) return out;
  }
  if (isKind(row.kind)) return [row.kind];
  return [guessModelKind(id)];
}

/** 用途数组落库前的收敛：去重、只留合法值，**空了回落到「出图」**（界面上也不许全取消）。 */
export function normalizeKinds(value: unknown, fallback: CustomModelKind = 'image'): CustomModelKind[] {
  const out: CustomModelKind[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if ((item === 'image' || item === 'video' || item === 'text') && !out.includes(item)) out.push(item);
    }
  }
  return out.length ? out : [fallback];
}

/**
 * 按模型 id 猜它是干什么的。
 *
 * 这是**猜**，所以只在「用户还没指定」时生效，且 UI 上可以改。猜错的后果是模型出现在
 * 错误的下拉里（比如把视频模型列出图），用户一点就发现；反过来若不给默认值，
 * 新加的接口会一个模型都不显示，那才是死局。
 */
const VIDEO_MODEL_RE = /(video|kling|hailuo|wan[-\d]|wan2|seedance|sora|vidu|pika|luma|runway|animate|i2v|t2v|首尾帧|文生视频|图生视频)/;
const IMAGE_MODEL_RE = /(image|flux|sdxl|stable-diffusion|sd[-_]?\d|seedream|qwen-image|dall|midjourney|nano[- ]?banana|recraft|imagen|kolors|hidream)/;
const TEXT_MODEL_RE = /(glm|gpt|chat|claude|deepseek|doubao|kimi|moonshot|minimax|qwen(?!-image)|llama|ernie|hunyuan)/;

/**
 * 按 id 猜用途，**认不出来就返回 null**。
 *
 * 与 `guessModelKind` 只差这一点，而这一点决定了「在某一段点拉取」会不会毁掉别的段：
 * 一条中转站上往往同时有出图、出视频、文本三种模型，若因为「在图片段点的拉取」
 * 就把 `kling-*` 也标成出图，视频节点上一个模型都选不到 ——
 * 界面上还没有任何地方会说「你的视频模型被归档成出图了」。
 */
export function guessModelKindStrict(id: string): CustomModelKind | null {
  const value = id.toLowerCase();
  if (VIDEO_MODEL_RE.test(value)) return 'video';
  if (IMAGE_MODEL_RE.test(value)) return 'image';
  if (TEXT_MODEL_RE.test(value)) return 'text';
  return null;
}

export function guessModelKind(id: string): CustomModelKind {
  return guessModelKindStrict(id) ?? 'image';
}

function toView(row: {
  id: string; name: string; baseUrl: string; encryptedApiKey: string; models: unknown;
  enabled: boolean; status: string; errorMessage: string; lastCheckedAt: Date | null;
  createdAt: Date; updatedAt: Date;
}): CustomProviderView {
  const plain = decryptSecret(row.encryptedApiKey);
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    masked: plain ? maskSecret(plain) : '（无法解密）',
    hasKey: Boolean(plain),
    models: readModels(row.models),
    enabled: row.enabled,
    status: row.status,
    errorMessage: row.errorMessage,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCustomProviders(userId: string): Promise<CustomProviderView[]> {
  const rows = await db.customProvider.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }],
    select: VIEW_SELECT,
  });
  return rows.map(toView);
}

export async function readCustomProvider(userId: string, id: string): Promise<CustomProviderView | null> {
  const row = await db.customProvider.findFirst({ where: { id, userId }, select: VIEW_SELECT });
  return row ? toView(row) : null;
}

/**
 * 取明文去打上游。**这个模块里唯一能拿到明文的地方** —— 与 `keys.ts` 同一条规矩：
 * 「有几处能读到明文」一旦变多，就没法回答「钥匙到底漏没漏」。
 */
export async function readCustomCredentials(userId: string, id: string) {
  const row = await db.customProvider.findFirst({
    where: { id, userId },
    select: { id: true, name: true, baseUrl: true, encryptedApiKey: true, models: true },
  });
  if (!row) return null;
  const apiKey = decryptSecret(row.encryptedApiKey);
  /** 解不开等于没配：拿空 Key 去请求上游只会换来一句看不懂的 401。 */
  if (!apiKey) return null;
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl.replace(/\/+$/, ''),
    apiKey,
    models: readModels(row.models),
  };
}

export type CustomProviderInput = {
  name: string;
  baseUrl: string;
  apiKey: string;
  models?: CustomModel[];
  enabled?: boolean;
};

/** 名字是**同一用户下唯一的**（schema 的 `@@unique([userId, name])`），重名直接报给人改。 */
async function assertNameFree(userId: string, name: string, exceptId?: string) {
  const clash = await db.customProvider.findFirst({ where: { userId, name }, select: { id: true } });
  if (clash && clash.id !== exceptId) throw new Error(`已经有一个叫「${name}」的接口了，换个名字。`);
}

export async function createCustomProvider(userId: string, input: CustomProviderInput) {
  const name = input.name.trim();
  await assertNameFree(userId, name);
  const row = await db.customProvider.create({
    data: {
      userId,
      name,
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
      encryptedApiKey: encryptSecret(input.apiKey.trim()),
      models: input.models ?? [],
      enabled: input.enabled ?? true,
    },
    select: VIEW_SELECT,
  });
  return toView(row);
}

export async function updateCustomProvider(
  userId: string,
  id: string,
  patch: { name?: string; baseUrl?: string; apiKey?: string; models?: CustomModel[]; enabled?: boolean },
) {
  const current = await db.customProvider.findFirst({ where: { id, userId }, select: { id: true, name: true } });
  if (!current) return null;
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name !== current.name) await assertNameFree(userId, name, id);
  }
  await db.customProvider.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl.trim().replace(/\/+$/, '') } : {}),
      /* 只有真的传了非空 Key 才覆盖：编辑表单里那格留空 = 「沿用原来那把」。
         否则每次改名都会把 Key 清成空串 —— 界面上还显示着「已配置」，一跑就 401。 */
      ...(patch.apiKey ? { encryptedApiKey: encryptSecret(patch.apiKey.trim()) } : {}),
      ...(patch.models !== undefined ? { models: patch.models } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    },
  });
  return readCustomProvider(userId, id);
}

export async function deleteCustomProvider(userId: string, id: string) {
  const result = await db.customProvider.deleteMany({ where: { id, userId } });
  return result.count > 0;
}

/** 手动改某个模型的用途（猜错的、要多用途的，都靠它）。传进来的是**一整份**新用途。 */
export async function setCustomModelKinds(userId: string, id: string, modelId: string, kinds: CustomModelKind[]) {
  const row = await db.customProvider.findFirst({ where: { id, userId }, select: { models: true } });
  if (!row) return null;
  const next = normalizeKinds(kinds);
  const models = readModels(row.models).map(item => (item.id === modelId ? { ...item, kinds: next } : item));
  await db.customProvider.update({ where: { id }, data: { models } });
  return readCustomProvider(userId, id);
}

async function markStatus(id: string, ok: boolean, errorMessage = '') {
  await db.customProvider.update({
    where: { id },
    data: {
      status: ok ? 'verified' : 'failed',
      errorMessage: ok ? '' : errorMessage.slice(0, 300),
      lastCheckedAt: new Date(),
    },
  });
}

export type CustomProbeResult = {
  ok: boolean;
  /** 模型清单（探活成功才有）。 */
  models: CustomModel[];
  /** 失败原因，直接给人看的中文。 */
  message: string;
  /** 用了多少毫秒。 */
  latencyMs: number;
  /** 真正拉到清单的那个地址。排查「为什么拉不到」时它是唯一有用的线索。 */
  endpoint?: string;
};

/** 一次尝试的结果。`outcome` 决定最后给用户看哪句话。 */
type ProbeAttempt = {
  url: string;
  status: number;
  outcome: 'models' | 'empty' | 'html' | 'not-json' | 'http-error' | 'network';
  models: string[];
  detail: string;
};

/** 见 `custom/http.ts`：识别「后台首页被当成接口返回」那件事，拉模型与对话两条路共用。 */

export { looksLikeHtml };

/**
 * 模型清单的候选地址，按顺序试。
 *
 * 各家网关的写法不统一：
 * - OpenAI 官方风格 —— base 是 `https://x/v1`，清单在 `<base>/models`；
 * - New API / One API 这类 —— base 只有域名，`<base>/v1/models` 才是清单，
 *   `<base>/models` 是后台首页（回 HTML）。
 *
 * 所以两个都试，**谁先给出一份带模型的 JSON 就用谁**。base 自己已经带 `/v1` 时
 * 不再往上拼第二个 v1（`/v1/v1/models` 谁都不认）。
 */
export function modelEndpointCandidates(base: string): string[] {
  const root = base.replace(/\/+$/, '');
  const out: string[] = [];
  const add = (url: string) => { if (!out.includes(url)) out.push(url); };
  const versioned = /\/v\d+(?:\.\d+)?$/i.test(root);
  if (versioned) {
    add(`${root}/models`);
    const stripped = root.replace(/\/v\d+(?:\.\d+)?$/i, '');
    add(`${stripped}/v1/models`);
    add(`${stripped}/models`);
  } else {
    add(`${root}/v1/models`);
    add(`${root}/models`);
  }
  return out;
}

/** 从响应体里掏出模型行：包在 data / models / result 里、直接是数组、或者再套一层，都认。 */
function pickModelRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  const row = body as Record<string, unknown>;
  for (const key of ['data', 'models', 'result', 'results', 'items', 'list']) {
    const value = row[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = pickModelRows(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

/** 模型行 → id 列表。行可能是字符串，也可能是对象，id 字段名各家也不统一。 */
export function parseModelIds(body: unknown): string[] {
  const ids: string[] = [];
  for (const item of pickModelRows(body)) {
    let id = '';
    if (typeof item === 'string') {
      id = item.trim();
    } else if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      id = String(row.id ?? row.name ?? row.model ?? row.model_id ?? row.modelId ?? '').trim();
    }
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, CUSTOM_MODEL_LIMIT);
}

/** 打一个候选地址，把这次尝试的结果整条带回来（成功与否都带）。 */
async function tryFetchModels(url: string, apiKey: string): Promise<ProbeAttempt> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
    const text = await response.text();
    const isHtml = looksLikeHtml(text);
    let body: unknown = null;
    if (!isHtml) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    if (!response.ok) {
      /* 回网页时 `detail` 放的是那页的标题，好让下面那句话能说清「回的是什么」。 */
      if (isHtml) return { url, status: response.status, outcome: 'html', models: [], detail: htmlPageTitle(text) };
      const detail = String((body as { error?: { message?: string } } | null)?.error?.message ?? '').trim();
      return { url, status: response.status, outcome: 'http-error', models: [], detail };
    }
    if (isHtml) return { url, status: response.status, outcome: 'html', models: [], detail: htmlPageTitle(text) };
    if (body === null) {
      return { url, status: response.status, outcome: 'not-json', models: [], detail: text.slice(0, 80).trim() };
    }
    const models = parseModelIds(body);
    return { url, status: response.status, outcome: models.length ? 'models' : 'empty', models, detail: '' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { url, status: 0, outcome: 'network', models: [], detail: reason };
  }
}

/**
 * 全都拉不到时，挑一句**最有用**的失败原因给人看。
 *
 * 顺序按「用户最可能踩的坑」排：钥匙错 > HTTP 报错 > 回的是网页 > 不是 JSON > 空清单 > 连不上。
 */
function probeFailureMessage(attempts: ProbeAttempt[]): string {
  const auth = attempts.find(item => item.outcome === 'http-error' && (item.status === 401 || item.status === 403));
  if (auth) return `接口返回 ${auth.status}：Key 不对，或者这个 Key 没有查看模型列表的权限。`;
  const httpError = attempts.find(item => item.outcome === 'http-error');
  if (httpError) return `接口返回 ${httpError.status}${httpError.detail ? `：${httpError.detail}` : ''}`;
  const html = attempts.find(item => item.outcome === 'html');
  /* 同一句「回的是网页」的两副面孔，见 `htmlEndpointMessage`：地址里已经有 /v1 就别再叫人加。 */
  if (html) return htmlEndpointMessage(html.url, html.status, html.detail);
  const notJson = attempts.find(item => item.outcome === 'not-json');
  if (notJson) return `接口返回的不是 JSON（HTTP ${notJson.status}）：${notJson.detail}`;
  const empty = attempts.find(item => item.outcome === 'empty');
  if (empty) return '连上了，但这个接口没返回任何模型（模型清单是空的）。';
  const network = attempts.find(item => item.outcome === 'network');
  if (network) {
    return /timed out|abort/i.test(network.detail)
      ? '连接超时（15 秒），检查一下地址能不能访问。'
      : `连不上：${network.detail}`;
  }
  return '没拉到模型清单。';
}

/**
 * 探活：拉一次模型清单（`/v1/models`，拿不到再试 `/models`）。
 *
 * 顺带把模型清单带回来 —— 探活和拉清单是同一个请求，没必要让用户点两次。
 * 拉到了就**写回** `models`（保留用户手动改过的 kind，只补新增的）。
 *
 * ⚠️ **任何失败路径都要写状态**：以前「连上了但没模型」那一支不写，
 * 表现为接口卡片长期停在「未验证」，用户以为是自己没点成功，其实是一直在失败。
 */
export async function probeCustomProvider(input: {
  userId?: string;
  id?: string;
  baseUrl: string;
  apiKey: string;
  /** 在「图片 / 视频 / 文本」哪一段里发起的拉取 —— **认不出来**的模型默认就是这个用途。 */
  defaultKind?: CustomModelKind;
}): Promise<CustomProbeResult> {
  const started = Date.now();
  const fail = async (message: string): Promise<CustomProbeResult> => {
    if (input.id) await markStatus(input.id, false, message);
    return { ok: false, models: [], message, latencyMs: Date.now() - started };
  };
  const base = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return fail('接口地址还没填。');
  if (!/^https?:\/\//i.test(base)) {
    return fail('接口地址要以 http:// 或 https:// 开头。');
  }
  const key = String(input.apiKey || '').trim();
  if (!key) return fail('API Key 还没填。');

  const attempts: ProbeAttempt[] = [];
  for (const url of modelEndpointCandidates(base)) {
    const attempt = await tryFetchModels(url, key);
    attempts.push(attempt);
    if (attempt.outcome === 'models') break;
  }
  const hit = attempts.find(item => item.outcome === 'models');
  if (!hit) return fail(probeFailureMessage(attempts));

  /**
   * 认得出来的按猜的走；认不出来的才用「这一段是什么用途」。
   *
   * 顺序反过来的代价见 `guessModelKindStrict`：那会把整条接口的所有模型都归到一段。
   */
  const kindOf = (id: string) => guessModelKindStrict(id) ?? input.defaultKind ?? 'image';
  /*
   * **认得出来的按名字走，认不出来的才用「这一段是什么用途」**（2026-09-23）。
   *
   * 试过反过来做 —— 在某一段点「拉取」就把这一段也并上去：那等于把整条接口的模型
   * 全标上这一段的用途，在图片段拉一次 `kling-*` 也变成「出图」，图片节点的下拉里
   * 混进视频模型，「用途档位」这个开关就没关了（e2e 的 D-4 当场抓到）。
   * 想让一个模型同时干几件事，在清单里勾 —— 那是**明确**的动作；
   * 猜不出来就不替他决定，代价只是「这一段暂时是空的」，而那种空看得见、改得动。
   */
  const kindsFor = (id: string, existing?: CustomModelKind[]) =>
    (existing && existing.length ? existing : [kindOf(id)]);
  if (input.id && input.userId) {
    /* 保留已有用途：用户手动勾掉的档位不能被一次探活冲掉。 */
    const current = await db.customProvider.findFirst({ where: { id: input.id, userId: input.userId }, select: { models: true } });
    const kindsById = new Map(readModels(current?.models).map(item => [item.id, item.kinds]));
    const models: CustomModel[] = hit.models.map(id => ({ id, name: id, kinds: kindsFor(id, kindsById.get(id)) }));
    await db.customProvider.update({ where: { id: input.id }, data: { models } });
    await markStatus(input.id, true);
    return {
      ok: true, models, message: `连上了，拿到 ${models.length} 个模型。`,
      latencyMs: Date.now() - started, endpoint: hit.url,
    };
  }
  const models: CustomModel[] = hit.models.map(id => ({ id, name: id, kinds: kindsFor(id) }));
  return {
    ok: true, models, message: `连上了，拿到 ${models.length} 个模型。`,
    latencyMs: Date.now() - started, endpoint: hit.url,
  };
}

/** 给节点的模型下拉用：把每条接口的模型摊平，带上它属于哪条接口。 */
export type CustomModelOption = {
  /** `<providerId>::<modelId>`，一个字符串就能定位到「哪条接口的哪个模型」。 */
  value: string;
  label: string;
  providerId: string;
  providerName: string;
  modelId: string;
  /** 这条模型能干的事（可能多项）。 */
  kinds: CustomModelKind[];
};

export async function listCustomModelOptions(userId: string, kind?: CustomModelKind): Promise<CustomModelOption[]> {
  const providers = await listCustomProviders(userId);
  const out: CustomModelOption[] = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      if (kind && !model.kinds.includes(kind)) continue;
      out.push({
        value: `${provider.id}::${model.id}`,
        label: `${model.name}（${provider.name}）`,
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        kinds: model.kinds,
      });
    }
  }
  return out;
}

/** 节点要不要多显示一个「自定义接口」引擎 —— 只看有没有对应用途的可用模型。 */
export async function hasCustomProviderFor(userId: string, kind: CustomModelKind) {
  const options = await listCustomModelOptions(userId, kind);
  return options.length > 0;
}

/** 拆 `<providerId>::<modelId>`。格式不对返回 null（不要抛 —— 这是读节点存的值）。 */
export function splitCustomModelValue(value: unknown): { providerId: string; modelId: string } | null {
  const text = String(value ?? '').trim();
  const at = text.indexOf('::');
  if (at <= 0 || at === text.length - 2) return null;
  return { providerId: text.slice(0, at), modelId: text.slice(at + 2) };
}
