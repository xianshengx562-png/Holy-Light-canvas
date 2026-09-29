import 'server-only';
import { db } from '@/lib/db';
import { decryptSecret, encryptSecret, maskSecret } from '@/lib/providers/secret';
import { EXPIRY_WARNING_DAYS, FAILURE_LIMIT, isProviderId, type ProviderId } from './registry';

export type ProviderKeyInput = {
  provider: string;
  label?: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  expiresAt?: Date | null;
};

export type ProviderKeyView = {
  id: string;
  provider: ProviderId;
  label: string;
  /** 只有尾缀，明文不出库。 */
  masked: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  status: string;
  consecutiveFailures: number;
  errorMessage: string;
  expiresAt: string | null;
  /** 还有几天到期。负数 = 已经过期。 */
  daysToExpiry: number | null;
  /** 到期警示等级。界面据此染色，别在整个项目里重复算一遍。 */
  expiryLevel: 'none' | 'warn' | 'expired';
  lastCheckedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 取出明文，读不出来返回 null。
 *
 * 最常见的失败原因是 `ENCRYPTION_KEY` 换过：历史密文解不开，但行还在、界面上也看得见。
 * 这种情况**必须让用户看见** —— 静默显示一串占位符等于把故障藏起来，他会以为 key 还好好的。
 */
function plainKey(payload: string) {
  return decryptSecret(payload) || null;
}

function daysUntil(expiresAt: Date | null) {
  if (!expiresAt) return null;
  return Math.round((expiresAt.getTime() - Date.now()) / DAY_MS);
}

function toView(row: {
  id: string;
  provider: string;
  label: string;
  encryptedApiKey: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  status: string;
  consecutiveFailures: number;
  errorMessage: string;
  expiresAt: Date | null;
  lastCheckedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}): ProviderKeyView {
  const days = daysUntil(row.expiresAt);
  const plain = plainKey(row.encryptedApiKey);
  return {
    id: row.id,
    provider: row.provider as ProviderId,
    label: row.label,
    masked: plain ? maskSecret(plain) : '（无法解密）',
    baseUrl: row.baseUrl,
    model: row.model,
    enabled: row.enabled,
    status: row.status,
    consecutiveFailures: row.consecutiveFailures,
    errorMessage: row.errorMessage,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    daysToExpiry: days,
    expiryLevel: days === null ? 'none' : days < 0 ? 'expired' : days <= EXPIRY_WARNING_DAYS ? 'warn' : 'none',
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const VIEW_SELECT = {
  id: true,
  provider: true,
  label: true,
  encryptedApiKey: true,
  baseUrl: true,
  model: true,
  enabled: true,
  status: true,
  consecutiveFailures: true,
  errorMessage: true,
  expiresAt: true,
  lastCheckedAt: true,
  lastUsedAt: true,
  createdAt: true,
} as const;

export async function listKeys(userId: string, provider?: string) {
  const rows = await db.providerKey.findMany({
    where: { userId, ...(provider ? { provider } : {}) },
    orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }],
    select: VIEW_SELECT,
  });
  return rows.map(toView);
}

/** 越权读不到就是读不到 —— 返回 null 而不是抛错，让调用方按 404 回（照资产那套的惯例）。 */
export async function readKey(userId: string, id: string) {
  const row = await db.providerKey.findFirst({ where: { id, userId }, select: VIEW_SELECT });
  return row ? toView(row) : null;
}

/**
 * 取明文去打上游。**整个模块只有这一条路能把明文交出去**，别再开第二处 ——
 * 「有几处能读到明文」这件事一旦变多，就没法回答「钥匙到底漏没漏」了。
 * 解密失败同样按「读不到」处理（多半是 ENCRYPTION_KEY 换过）。
 */
export async function readPlainCredentials(userId: string, id: string) {
  const row = await db.providerKey.findFirst({
    where: { id, userId },
    select: { id: true, provider: true, encryptedApiKey: true, baseUrl: true },
  });
  if (!row) return null;
  const plain = plainKey(row.encryptedApiKey);
  if (!plain) return null;
  return { id: row.id, provider: row.provider as ProviderId, apiKey: plain, baseUrl: row.baseUrl };
}

export async function createKey(userId: string, input: ProviderKeyInput) {
  if (!isProviderId(input.provider)) throw new Error(`未知的服务商：${input.provider}`);
  const row = await db.providerKey.create({
    data: {
      userId,
      provider: input.provider,
      label: (input.label ?? '').trim(),
      encryptedApiKey: encryptSecret(input.apiKey.trim()),
      baseUrl: (input.baseUrl ?? '').trim(),
      model: (input.model ?? '').trim(),
      expiresAt: input.expiresAt ?? null,
    },
    select: VIEW_SELECT,
  });
  return toView(row);
}

export async function updateKey(
  userId: string,
  id: string,
  patch: { label?: string; baseUrl?: string; model?: string; enabled?: boolean; expiresAt?: Date | null },
) {
  /** updateMany 带 userId 条件：改不到 0 行就是「不是你的或不存在」，比先查再改少一次往返。 */
  const result = await db.providerKey.updateMany({
    where: { id, userId },
    data: {
      ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl.trim() } : {}),
      ...(patch.model !== undefined ? { model: patch.model.trim() } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
    },
  });
  return result.count > 0 ? readKey(userId, id) : null;
}

export async function deleteKey(userId: string, id: string) {
  const result = await db.providerKey.deleteMany({ where: { id, userId } });
  return result.count > 0;
}

export type PickedKey = { id: string; apiKey: string; baseUrl: string; model: string };

/**
 * 轮询选出一把能用的 key。
 *
 * 排序的关键是 `nulls: 'first'` —— Postgres 里 ASC 默认 **NULLS LAST**，不加这句的话
 * 「从没用过的那把」永远排最后，新加的主力 key 会被晾着。
 *
 * 排除三类：手动停用的、连续失败到上限的、已经过期的。过期要真的排掉，不然用户以为换过钥匙了
 * 结果一直在敲一把废的。
 *
 * ⚠️ 并发下两步之间没加锁：同一瞬间两个请求可能拿到同一把。这是有意接受的取舍 ——
 * 换 key 这件事重复一次只浪费一次轮转，而加锁要付的是每个请求都多一次等待。
 */
export async function pickKey(userId: string, provider: ProviderId): Promise<PickedKey | null> {
  const candidates = await db.providerKey.findMany({
    where: {
      userId,
      provider,
      enabled: true,
      status: { not: 'failed' },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: 1,
    select: { id: true, encryptedApiKey: true, baseUrl: true, model: true },
  });
  const picked = candidates[0];
  if (!picked) return null;
  const plain = plainKey(picked.encryptedApiKey);
  /** 解不开的那把等于不能用 —— 当作没配，让调用方回落到环境变量，别拿空 key 去请求上游。 */
  if (!plain) return null;
  await db.providerKey.update({ where: { id: picked.id }, data: { lastUsedAt: new Date() } });
  return {
    id: picked.id,
    apiKey: plain,
    baseUrl: picked.baseUrl,
    model: picked.model,
  };
}

/**
 * 一次真实调用的结果回填。
 *
 * 「成功」也算一次健康检查 —— 能跑通就说明 key 是活的，没必要再单独探一次。
 * 失败则累计，到 FAILURE_LIMIT 直接停用：与其每次请求都先撞一把坏 key，不如明确标出来让人去处理。
 */
export async function markKeyOutcome(keyId: string, ok: boolean, errorMessage = '') {
  if (ok) {
    await db.providerKey.update({
      where: { id: keyId },
      data: { consecutiveFailures: 0, errorMessage: '', status: 'verified', lastCheckedAt: new Date() },
    });
    return;
  }
  const row = await db.providerKey.update({
    where: { id: keyId },
    data: { consecutiveFailures: { increment: 1 }, errorMessage, lastCheckedAt: new Date() },
    select: { consecutiveFailures: true },
  });
  if (row.consecutiveFailures >= FAILURE_LIMIT) {
    await db.providerKey.update({ where: { id: keyId }, data: { enabled: false, status: 'failed' } });
  }
}

/** 健康检查专用：只更新状态，不动失败计数（探活失败不等于这次业务调用失败）。 */
export async function markKeyChecked(keyId: string, ok: boolean, errorMessage = '') {
  await db.providerKey.update({
    where: { id: keyId },
    data: {
      status: ok ? 'verified' : 'failed',
      errorMessage: ok ? '' : errorMessage,
      lastCheckedAt: new Date(),
      ...(ok ? { consecutiveFailures: 0 } : {}),
    },
  });
}

export async function recordCall(input: {
  userId: string;
  provider: ProviderId;
  keyId?: string;
  ok: boolean;
  errorMessage?: string;
  latencyMs?: number;
}) {
  await db.providerCall.create({
    data: {
      userId: input.userId,
      provider: input.provider,
      keyId: input.keyId ?? '',
      ok: input.ok,
      errorMessage: (input.errorMessage ?? '').slice(0, 300),
      latencyMs: Math.max(0, Math.round(input.latencyMs ?? 0)),
    },
  });
}

export type UsageSummary = {
  provider: ProviderId;
  total: number;
  failed: number;
  successRate: number;
  lastCalledAt: string | null;
};

/**
 * 最近 N 天的用量摘要。
 *
 * 按服务商聚合而不是按 key —— 用户真正想知道的是「这家这个月跑了几次、成不成」，
 * 哪把 key 跑的多半是排查时才关心，那时候看流水更快。
 */
export async function usageSummary(userId: string, days = 30): Promise<UsageSummary[]> {
  const since = new Date(Date.now() - days * DAY_MS);
  const rows = await db.providerCall.groupBy({
    by: ['provider'],
    where: { userId, createdAt: { gte: since } },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const failedRows = await db.providerCall.groupBy({
    by: ['provider'],
    where: { userId, createdAt: { gte: since }, ok: false },
    _count: { _all: true },
  });
  /* 显式标注 Map 的键值类型：JSON 引擎的返回值在编译期没有形状，
     不写的话 TS 会把 `new Map(any)` 推成 `Map<unknown, unknown>`，
     下面 `failed / total` 的除法就报「右操作数必须是 number」。 */
  const failedBy = new Map<string, number>(failedRows.map(row => [row.provider as string, row._count._all as number]));
  return rows.map(row => {
    const failed = failedBy.get(row.provider) ?? 0;
    return {
      provider: row.provider as ProviderId,
      total: row._count._all,
      failed,
      successRate: row._count._all ? Math.round(((row._count._all - failed) / row._count._all) * 100) : 100,
      lastCalledAt: row._max.createdAt ? row._max.createdAt.toISOString() : null,
    };
  });
}
