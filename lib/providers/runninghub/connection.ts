import 'server-only';
import { db } from '@/lib/db';
import { decryptSecret, encryptSecret, maskSecret } from '@/lib/providers/secret';
import { pickKey } from '@/lib/providers/keys';
import { sharedKeyAllowed } from './config';

/**
 * `shared-disabled` 是「站点有 key，但没开共享」—— 和 `none`（压根没配）要分开报，
 * 因为用户能做的事不一样：前者是「去填你自己的」，后者是「找站长配站点」。
 */
export type KeySource = 'user' | 'env' | 'shared-disabled' | 'none';
export type ConnectionView = {
  hasKey: boolean;
  source: KeySource;
  masked: string | null;
  status: string;
  lastCheckedAt: string | null;
  updatedAt: string | null;
  baseUrl: string | null;
};

/**
 * RunningHub 有两个站，**独立账号、独立 Key**（2026-09-21）。
 *
 * 这不是「同一个服务的两个镜像」：国内站（runninghub.cn）与海外站（runninghub.ai）
 * 的账号体系、余额、工作流 ID 都是各算各的。用国内站的 Key 去打海外站，报的错是
 * 「工作流不存在」—— 一个完全指不到根因的说法，用户会以为是自己工作流填错了。
 * 所以两个站在界面上是**两段**，且当前用哪个站是 `User.runninghubSite` 里的一档。
 */
export type RunningHubSite = 'cn' | 'ai';

export const RUNNINGHUB_SITES: Record<RunningHubSite, {
  id: RunningHubSite;
  label: string;
  host: string;
  defaultBaseUrl: string;
  envKeyName: string;
  envBaseName: string;
}> = {
  cn: {
    id: 'cn',
    label: 'RunningHub 国内站',
    host: 'runninghub.cn',
    defaultBaseUrl: 'https://www.runninghub.cn/openapi/v2',
    envKeyName: 'RUNNINGHUB_API_KEY',
    envBaseName: 'RUNNINGHUB_API_BASE_URL',
  },
  ai: {
    id: 'ai',
    label: 'RunningHub 海外站',
    host: 'runninghub.ai',
    defaultBaseUrl: 'https://www.runninghub.ai/openapi/v2',
    envKeyName: 'RUNNINGHUB_AI_API_KEY',
    envBaseName: 'RUNNINGHUB_AI_API_BASE_URL',
  },
};

export function isRunningHubSite(value: unknown): value is RunningHubSite {
  return value === 'cn' || value === 'ai';
}

/** 当前用哪个站。读不到（老库没这一列）就按国内站 —— 那是加这一档之前唯一的一种。 */
export async function readRunningHubSite(userId: string): Promise<RunningHubSite> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { runninghubSite: true } });
  return isRunningHubSite(row?.runninghubSite) ? row.runninghubSite : 'cn';
}

export async function setRunningHubSite(userId: string, site: RunningHubSite) {
  await db.user.update({ where: { id: userId }, data: { runninghubSite: site } });
  return site;
}

function envBaseUrl(site: RunningHubSite) {
  const value = process.env[RUNNINGHUB_SITES[site].envBaseName]?.trim();
  return value ? value.replace(/\/+$/, '') : RUNNINGHUB_SITES[site].defaultBaseUrl;
}

/** 带站点的那一版。**别和下面导出的 `keyMissingMessage` 同名** —— 同名会互相覆盖。 */
function siteKeyMissingMessage(site: RunningHubSite, source: KeySource) {
  const label = RUNNINGHUB_SITES[site].label;
  if (source === 'shared-disabled') {
    return `${label}：这个账号还没有填自己的 API Key。站点没有开启共享密钥，请在「设置 · 模型服务」里填你自己的 key。`;
  }
  if (site === 'ai') {
    return `还没配置${label}（${RUNNINGHUB_SITES.ai.host}）的 API Key。两个站是独立账号，国内站的 Key 在海外站用不了 —— 请在「设置 · 模型服务」里单独填。`;
  }
  return `尚未配置${label} API Key，请在「设置 · 模型服务」中填写。`;
}

export type ResolvedKey = { apiKey: string | null; source: KeySource; message: string | null };

export type ResolvedRunningHub = ResolvedKey & {
  site: RunningHubSite;
  /** 打哪个地址。**跟着站走**：海外站的 Key 打到国内站必然 401。 */
  baseUrl: string;
  /** 用了池子里哪一把（走环境变量时是空串），回填健康状态用。 */
  keyId: string;
};

/**
 * 解析出这一次的 RunningHub 凭据：用哪个站、打哪个地址、拿哪把 Key。
 *
 * 国内站走**历史连接表**（`RunningHubConnection`，userId 唯一、单把），
 * 海外站走**密钥池**（`runninghub-ai`，可以多把、可轮询）——
 * 前者是老数据，动它会波及一大片；后者是新加的，没必要再铺一张单把的表。
 *
 * `message` 是拿不到 key 时直接能抛给用户的人话 —— 让调用点不必各自拼文案，
 * 也免得同一个状态在不同接口里说法不一。有 key 时它是 null。
 */
export async function resolveRunningHub(userId: string, site?: RunningHubSite): Promise<ResolvedRunningHub> {
  const target = site ?? await readRunningHubSite(userId);
  if (target === 'ai') {
    const picked = await pickKey(userId, 'runninghub-ai');
    if (picked) {
      return {
        site: 'ai',
        apiKey: picked.apiKey,
        baseUrl: picked.baseUrl || envBaseUrl('ai'),
        source: 'user',
        message: null,
        keyId: picked.id,
      };
    }
    const fallback = process.env[RUNNINGHUB_SITES.ai.envKeyName]?.trim();
    if (!fallback) {
      return { site: 'ai', apiKey: null, baseUrl: envBaseUrl('ai'), source: 'none', message: siteKeyMissingMessage('ai', 'none'), keyId: '' };
    }
    /** 站点兜底默认关，理由见 `sharedKeyAllowed()`。关着的时候绝不静默改用站点 key。 */
    if (!sharedKeyAllowed()) {
      return { site: 'ai', apiKey: null, baseUrl: envBaseUrl('ai'), source: 'shared-disabled', message: siteKeyMissingMessage('ai', 'shared-disabled'), keyId: '' };
    }
    return { site: 'ai', apiKey: fallback, baseUrl: envBaseUrl('ai'), source: 'env', message: null, keyId: '' };
  }
  const row = await db.runningHubConnection.findUnique({ where: { userId }, select: { encryptedApiKey: true } });
  const stored = row?.encryptedApiKey ? decryptSecret(row.encryptedApiKey) : null;
  if (stored) {
    return { site: 'cn', apiKey: stored, baseUrl: envBaseUrl('cn'), source: 'user', message: null, keyId: '' };
  }
  const fallback = process.env[RUNNINGHUB_SITES.cn.envKeyName]?.trim();
  if (!fallback) {
    return { site: 'cn', apiKey: null, baseUrl: envBaseUrl('cn'), source: 'none', message: siteKeyMissingMessage('cn', 'none'), keyId: '' };
  }
  if (!sharedKeyAllowed()) {
    return { site: 'cn', apiKey: null, baseUrl: envBaseUrl('cn'), source: 'shared-disabled', message: siteKeyMissingMessage('cn', 'shared-disabled'), keyId: '' };
  }
  return { site: 'cn', apiKey: fallback, baseUrl: envBaseUrl('cn'), source: 'env', message: null, keyId: '' };
}

/**
 * 只要 Key（不带地址）的旧签名。**保留它是为了不动已有的四处调用点**，
 * 但它们必须尽快换成 `resolveRunningHub` —— 只拿 Key 不拿地址，等于默认打国内站，
 * 海外站的账号会拿到一个「工作流不存在」的假象。
 */
export async function resolveApiKey(userId: string): Promise<ResolvedKey> {
  const resolved = await resolveRunningHub(userId);
  return { apiKey: resolved.apiKey, source: resolved.source, message: resolved.message };
}

/** 拿不到 key 时统一的人话。各处直接复用，免得同一个状态在不同接口里说法不一。 */
export function keyMissingMessage(source: KeySource) {
  return siteKeyMissingMessage('cn', source);
}

export async function describeConnection(userId: string): Promise<ConnectionView> {
  const row = await db.runningHubConnection.findUnique({
    where: { userId },
    select: { encryptedApiKey: true, status: true, lastCheckedAt: true, updatedAt: true },
  });
  const stored = row?.encryptedApiKey ? decryptSecret(row.encryptedApiKey) : null;
  const fallback = process.env[RUNNINGHUB_SITES.cn.envKeyName]?.trim();
  /** 设置页要显示「站点没开共享」而不是「已连接」—— 显示已连接但一生成就报错，是最糟的体验。 */
  const shared = fallback && sharedKeyAllowed() ? fallback : null;
  const key = stored || shared || null;
  return {
    hasKey: Boolean(key),
    source: stored ? 'user' : shared ? 'env' : fallback ? 'shared-disabled' : 'none',
    masked: key ? maskSecret(key) : null,
    status: row?.status || (key ? 'unverified' : 'missing'),
    lastCheckedAt: row?.lastCheckedAt?.toISOString() || null,
    updatedAt: row?.updatedAt?.toISOString() || null,
    baseUrl: process.env[RUNNINGHUB_SITES.cn.envBaseName]?.trim()?.replace(/\/+$/, '') || null,
  };
}

/**
 * 「模型服务」页要的两个站的状态（2026-09-21）。
 *
 * 一次性把两段都算出来：页面需要同时显示「国内站已连、海外站没填」这种对照，
 * 分开两个接口取反而容易在刷新时看到两个不同时刻的状态。
 */
export async function describeRunningHubSites(userId: string) {
  const cn = await describeConnection(userId);
  const aiKeys = await db.providerKey.findMany({
    where: { userId, provider: 'runninghub-ai' },
    orderBy: [{ createdAt: 'asc' }],
    select: { id: true, label: true, encryptedApiKey: true, baseUrl: true, enabled: true, status: true, lastCheckedAt: true },
  });
  const aiEnv = process.env[RUNNINGHUB_SITES.ai.envKeyName]?.trim();
  const maskedOf = (payload: string) => {
    const plain = decryptSecret(payload);
    return plain ? maskSecret(plain) : '（无法解密）';
  };
  return {
    active: await readRunningHubSite(userId),
    cn: {
      id: 'cn' as RunningHubSite,
      label: RUNNINGHUB_SITES.cn.label,
      host: RUNNINGHUB_SITES.cn.host,
      baseUrl: cn.baseUrl || RUNNINGHUB_SITES.cn.defaultBaseUrl,
      hasKey: cn.hasKey,
      source: cn.source,
      masked: cn.masked,
      status: cn.status,
      lastCheckedAt: cn.lastCheckedAt,
      /** 国内站是历史单把连接，没有「多把」这回事 —— 页面据此决定显不显示「添加」按钮。 */
      supportsMultiple: false,
      keys: [] as { id: string; label: string; masked: string; baseUrl: string; enabled: boolean; status: string }[],
    },
    ai: {
      id: 'ai' as RunningHubSite,
      label: RUNNINGHUB_SITES.ai.label,
      host: RUNNINGHUB_SITES.ai.host,
      baseUrl: aiKeys[0]?.baseUrl || (process.env[RUNNINGHUB_SITES.ai.envBaseName]?.trim() || RUNNINGHUB_SITES.ai.defaultBaseUrl),
      hasKey: aiKeys.some(item => item.enabled) || Boolean(aiEnv),
      source: (aiKeys.some(item => item.enabled) ? 'user' : aiEnv ? 'env' : 'none') as KeySource,
      masked: aiKeys[0] ? maskedOf(aiKeys[0].encryptedApiKey) : aiEnv ? maskSecret(aiEnv) : null,
      status: aiKeys[0]?.status || (aiKeys.length || aiEnv ? 'unverified' : 'missing'),
      lastCheckedAt: aiKeys[0]?.lastCheckedAt?.toISOString() || null,
      supportsMultiple: true,
      keys: aiKeys.map(item => ({
        id: item.id,
        label: item.label,
        masked: maskedOf(item.encryptedApiKey),
        baseUrl: item.baseUrl || RUNNINGHUB_SITES.ai.defaultBaseUrl,
        enabled: item.enabled,
        status: item.status,
      })),
    },
  };
}

export async function saveApiKey(userId: string, apiKey: string) {
  const encrypted = encryptSecret(apiKey);
  await db.runningHubConnection.upsert({
    where: { userId },
    create: { userId, provider: 'runninghub', encryptedApiKey: encrypted, status: 'unverified' },
    update: { encryptedApiKey: encrypted, status: 'unverified' },
  });
}

export async function clearApiKey(userId: string) {
  await db.runningHubConnection.deleteMany({ where: { userId } });
}

export async function markConnectionStatus(userId: string, status: 'verified' | 'failed') {
  const row = await db.runningHubConnection.findUnique({ where: { userId }, select: { id: true } });
  if (!row) return;
  await db.runningHubConnection.update({ where: { userId }, data: { status, lastCheckedAt: new Date() } });
}
