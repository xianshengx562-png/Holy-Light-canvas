/**
 * 调「大语言模型」—— 目前只有一处用途：**提示词优化**（见 `lib/promptAssistant.ts`）。
 *
 * 六家官方厂商（豆包 / DeepSeek / 智谱 / Kimi / MiniMax / OpenAI 兼容）**全部是
 * OpenAI 兼容的 `/chat/completions`**，所以这里只有一份实现，差别只是各家默认的
 * 接口地址与模型名（在 `registry.ts` 的 `text` 字段里）。
 *
 * ⚠️ 别为某一家单独开一条分支：那家的地址 / 模型会变，而分支会留下来变成
 * 「为什么这家走的是另一套代码」这种没人敢删的历史。要改默认值去 registry。
 *
 * 「用哪一家」的优先级（与 `resolveTextCredentials` 一致，界面上要照这个顺序解释）：
 *   1. 用户在设置里**指定**的那家（含自定义接口的文本模型、以及**本地模型** ——
 *      本地那一档只在显式选中时才走，见下面 `credentialsFromLocal()`）；
 *   2. 否则按 `TEXT_PROVIDER_IDS` 的顺序挑第一家**配了 Key** 的（池子优先于环境变量）；
 *   3. 一家都没有 → 返回 null，由调用方报「请先配置」（错误码照 AIFISHER 的
 *      `AI_CONFIGURATION_REQUIRED`，文案见 `promptAssistant.ts`）。
 */
import 'server-only';
import { db } from '@/lib/db';
import { pickKey } from '@/lib/providers/keys';
import { providerLabel, TEXT_PROVIDER_IDS, providerMeta, isTextProviderId } from '@/lib/providers/registry';
import { listCustomProviders, readCustomCredentials, type CustomModelKind } from '@/lib/providers/custom';
import { endpointCandidates, requestFirstJson } from '@/lib/providers/custom/http';
import { localTextTarget } from '@/lib/local-llm';

/**
 * 「优化提示词走本地」（2026-09-27）。
 *
 * `baseUrl` 指向本机 llama-server 的 `/v1`，Key 是空串 —— llama-server 默认不校验
 * （它只监听 127.0.0.1）。真正干活的是 `lib/local-llm.ts`：那个模块负责装载与卸载，
 * 这里只负责告诉调用方「往哪儿发」。
 *
 * ⚠️ 本地这一档**不参加「自动挑一家」**：自动挑到本地意味着每次优化都要先把模型
 * 装进显存（几秒到几十秒），而用户对「点一下优化」的预期是立刻出结果。
 * 想用本地就在设置页或节点上显式选它。
 */
function credentialsFromLocal(): TextCredentials {
  const target = localTextTarget();
  return {
    providerId: 'local',
    label: target.label,
    baseUrl: target.baseUrl,
    model: target.model,
    apiKey: '',
    keyId: '',
  };
}

/** 这个来源是不是「本地模型」（节点上选过、或者设置里设过）。 */
export function isLocalTextProvider(id: string | undefined | null): boolean {
  return String(id ?? '').trim() === 'local';
}

export type TextCredentials = {
  /** `glm` / `deepseek` … 或 `custom:<providerId>`；本地是 `local`。 */
  providerId: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 来自密钥池时是那把 key 的 id；走环境变量时是空串。 */
  keyId: string;
};

function credentialsFromPool(
  providerId: string,
  picked: { id: string; apiKey: string; baseUrl: string; model: string },
): TextCredentials {
  const meta = providerMeta(providerId);
  return {
    providerId,
    label: meta?.label ?? providerId,
    baseUrl: picked.baseUrl || meta?.text?.defaultBaseUrl || '',
    model: picked.model || meta?.text?.defaultModel || '',
    apiKey: picked.apiKey,
    keyId: picked.id,
  };
}

/** 环境变量兜底那把。只有真的配了才返回 —— 没配返回 null，让调用方继续找下一家。 */
function credentialsFromEnv(providerId: string): TextCredentials | null {
  const meta = providerMeta(providerId);
  if (!meta) return null;
  const apiKey = process.env[meta.envKeyName]?.trim();
  if (!apiKey) return null;
  return {
    providerId,
    label: meta.label,
    baseUrl: meta.text?.defaultBaseUrl ?? '',
    model: meta.text?.defaultModel ?? '',
    apiKey,
    keyId: '',
  };
}

/** 自定义接口的文本模型：`custom:<id>`（可再带 `:<modelId>` 指定模型）。 */
async function credentialsFromCustom(userId: string, spec: string): Promise<TextCredentials | null> {
  const [, providerId, modelId] = spec.split(':');
  if (!providerId) return null;
  const creds = await readCustomCredentials(userId, providerId);
  if (!creds) return null;
  const picked = modelId
    ? creds.models.find(item => item.id === modelId)
    : creds.models.find(item => item.kinds.includes('text')) ?? creds.models[0];
  if (!picked) return null;
  return {
    providerId: `custom:${providerId}`,
    label: `${creds.name} · ${picked.name}`,
    baseUrl: creds.baseUrl,
    model: picked.id,
    apiKey: creds.apiKey,
    keyId: '',
  };
}

/**
 * 找出一套能用的文本凭据。
 *
 * `preferred` 一般来自 `User.promptProvider`：空串 = 自动，否则只认指定的那一家 ——
 * **指定了一家却没有 Key 时报「没配」而不是悄悄换一家**。
 * 悄悄换家的后果是「用户以为自己在用 DeepSeek 优化，实际走的是别的模型」，
 * 而这种差异没有任何界面会告诉他。
 */
export async function resolveTextCredentials(userId: string, preferred?: string): Promise<TextCredentials | null> {
  const wanted = preferred && preferred.trim() ? preferred.trim() : await readPreferred(userId);
  if (isLocalTextProvider(wanted)) return credentialsFromLocal();
  if (wanted.startsWith('custom:')) return credentialsFromCustom(userId, wanted);
  if (wanted && isTextProviderId(wanted)) {
    const picked = await pickKey(userId, wanted);
    if (picked) return credentialsFromPool(wanted, picked);
    return credentialsFromEnv(wanted);
  }
  for (const id of TEXT_PROVIDER_IDS) {
    const picked = await pickKey(userId, id);
    if (picked) return credentialsFromPool(id, picked);
    const env = credentialsFromEnv(id);
    if (env) return env;
  }
  /** 官方六家都没有 → 退到自定义接口里的文本模型。 */
  const providers = await listCustomProviders(userId);
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const text = provider.models.find(item => item.kinds.includes('text'));
    if (!text) continue;
    const creds = await readCustomCredentials(userId, provider.id);
    if (!creds) continue;
    return {
      providerId: `custom:${provider.id}`,
      label: `${creds.name} · ${text.name}`,
      baseUrl: creds.baseUrl,
      model: text.id,
      apiKey: creds.apiKey,
      keyId: '',
    };
  }
  return null;
}

async function readPreferred(userId: string) {
  const row = await db.user.findUnique({ where: { id: userId }, select: { promptProvider: true } });
  return String(row?.promptProvider ?? '').trim();
}

/** 有没有任何一家能用来做文本（界面据此显示「未配置」还是「已配置」）。 */
export async function hasAnyTextProvider(userId: string) {
  const creds = await resolveTextCredentials(userId);
  return creds !== null;
}

/**
 * 拼出 chat 端点。
 *
 * 用户可能填 `https://x.com/v1` 也可能填完整的 `https://x.com/v1/chat/completions`
 * （各家文档给法不一，抄哪个的都有），这里两种都认 —— 不认的后果是请求打到
 * `/v1/chat/completions/chat/completions`，报 404，而用户看不懂为什么。
 */
/**
 * 对话端点的候选地址（2026-09-23）。
 *
 * 与「拉模型」同一个坑：中转站把后台首页挂在根路径上，`<base>/chat/completions`
 * 会回 200 + 一整页 HTML，而真的对话端点在 `<base>/v1/chat/completions`。
 * 所以两个都试（顺序见 `endpointCandidates`）。
 */
export function chatEndpointCandidates(baseUrl: string): string[] {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return [];
  /** 用户填的已经是完整端点（各家文档给法不一，抄哪个的都有）—— 那就只有这一个候选。 */
  if (/\/chat\/completions$/i.test(base)) return [base];
  return endpointCandidates(base, '/chat/completions');
}

/** 首选地址（给界面显示「会打到哪儿」用）。 */
export function chatEndpoint(baseUrl: string) {
  return chatEndpointCandidates(baseUrl)[0] ?? '';
}

export type ChatResult = { text: string; latencyMs: number };

/**
 * 一次 chat 调用。
 *
 * 只传 `messages` 这几个各家都认的字段（`temperature` / `max_tokens` 各家默认值不同，
 * 显式给是为了同一句话在不同厂商下结果稳定些）。**不传** `response_format` 之类
 * 只有部分家支持的字段 —— 不支持的那家会直接 400。
 */
export async function chatText(
  creds: TextCredentials,
  input: { system: string; user: string; temperature?: number; maxTokens?: number },
): Promise<ChatResult> {
  const urls = chatEndpointCandidates(creds.baseUrl);
  if (!urls.length) throw new Error(`${creds.label} 的接口地址是空的，请到「设置 · 模型服务」里补上。`);
  if (!creds.model) throw new Error(`${creds.label} 的模型名是空的，请到「设置 · 模型服务」里补上。`);
  const started = Date.now();
  const attempt = await requestFirstJson(
    urls,
    url => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${creds.apiKey}` },
      body: JSON.stringify({
        model: creds.model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        temperature: input.temperature ?? 0.7,
        ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
        /*
         * 本地（llama.cpp）那一档必须**关掉思考**（2026-09-26）。
         *
         * Qwen3.5 这类思考模型开着 thinking 时会把额度全花在 `<think>` 里：
         * 实测同一句话 11.3 秒、2048 token 全部是思考过程，`content` 是空的 ——
         * 于是优化提示词永远报「没有返回内容」，而关掉之后 0.6 秒就出 108 字。
         *
         * `chat_template_kwargs` 是 llama.cpp 自己的扩展，不是 OpenAI 的标准字段 ——
         * 云端那几家我们不敢乱塞（有的网关会直接 400），所以**只给本地**。
         */
        ...(isLocalTextProvider(creds.providerId)
          ? { chat_template_kwargs: { enable_thinking: false } }
          : {}),
      }),
      signal: AbortSignal.timeout(60_000),
      cache: 'no-store',
    }),
    /** 上游真正的报错（400「这个模型不支持对话」之类）比「回的是网页」有用得多。 */
    body => String((body as { error?: { message?: string } } | null)?.error?.message ?? '').trim(),
  );
  if (!attempt.ok) throw new Error(`${creds.label}：${attempt.message}`);
  const text = String(
    (attempt.body as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content ?? '',
  ).trim();
  if (!text) {
    /*
     * 内容全在「思考」里 —— 这种情况必须单独说一句。
     * 只回「没有返回内容」，用户会以为是模型坏了或者 Key 有问题，
     * 而真正的原因（思考吃光额度 / 提示词没被当成正文吐出来）一句都没提到。
     */
    const reasoned = String(
      (attempt.body as { choices?: { message?: { reasoning_content?: unknown } }[] } | null)
        ?.choices?.[0]?.message?.reasoning_content ?? '',
    ).trim();
    if (reasoned) {
      throw new Error(
        `${creds.label} 把整段回答都写进了「思考」里（${reasoned.length} 字），正文一个字都没有：`
        + '换一个非思考模型试试（或者到设置里把「最大 token」调大一点）。',
      );
    }
    throw new Error(`${creds.label} 没有返回内容。`);
  }
  return { text, latencyMs: Date.now() - started };
}

/** 给界面用的一句话说明：现在到底在用哪家。 */
export function describeTextCredentials(creds: TextCredentials | null) {
  if (!creds) return '还没配置任何文本模型';
  if (creds.providerId.startsWith('custom:')) return `自定义接口 · ${creds.label}`;
  return `${providerLabel(creds.providerId)} · ${creds.model}`;
}

export type { CustomModelKind };
