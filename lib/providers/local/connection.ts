import 'server-only';
/** 注意是值导入而不是 `import type`：下面要用 `Prisma.DbNull` 这个哨兵（Json 列的显式空值）。 */
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { decryptSecret, encryptSecret, maskSecret } from '@/lib/providers/secret';
import { DEFAULT_LOCAL_BASE_URL, localApiKeyFallback, localBaseUrlFallback, localComfyuiDirFallback } from './config';
import { describeComfyuiDir, validateComfyuiDir, type ComfyuiDirView } from './directory';
import { localGraphNodeIds, parseLocalGraph, type LocalGraph } from './graph';

/**
 * 本地模式的连接读写。**与 `runninghub/connection.ts` 同构**（userId 唯一 + 密钥加密 + 界面只回掩码），
 * 差别只有两点：地址有默认值，以及多了一份节点图。
 *
 * 「账户级优先、`.env` 兜底」这条规矩与别家保持一致 —— 用户在设置里填了地址却一直连到
 * `.env` 那个，是这类配置里最难查的一类 bug。
 *
 * 第三项配置是 **ComfyUI 目录**（`comfyuiDir`）：它和地址是两回事 —— 地址是「服务开在哪」，
 * 目录是「它装在哪」。配了目录，**服务没开也能查**「这个节点装没装、这个模型有没有」
 * （见 `directory.ts`，只读扫描）；服务开着的时候依然以 `/object_info` 为准。
 */

export type LocalConnectionView = {
  enabled: boolean;
  /** 实际生效的地址（已经把 `.env` 和默认值算进去了）。 */
  baseUrl: string;
  baseUrlSource: 'user' | 'env' | 'default';
  hasKey: boolean;
  masked: string | null;
  /** ComfyUI 的安装目录。空串 = 还没配，服务没开时就查不了缺什么。 */
  comfyuiDir: string;
  /** 目录扫出来是什么样。没配 / 扫不动就是 null。 */
  dir: ComfyuiDirView | null;
  hasGraph: boolean;
  graphNodes: number;
  /** 前几个节点编号，给设置页显示「这份图的节点长什么样」，方便和 RunningHub 那份对编号。 */
  nodeIds: string[];
  status: string;
  lastCheckedAt: string | null;
  updatedAt: string | null;
};

export type LocalCredentials = {
  enabled: boolean;
  baseUrl: string;
  /** 空串 = 本机不鉴权，发请求时不带 Authorization 头。 */
  apiKey: string;
  graph: LocalGraph | null;
  /** ComfyUI 安装目录；没配是空串。 */
  comfyuiDir: string;
};

function storedGraph(raw: unknown): LocalGraph | null {
  if (!raw) return null;
  try {
    return parseLocalGraph(raw);
  } catch {
    /** 库里存了一份认不出的图：当没配处理，生成时会明确报「还没贴图」，而不是在提交那一刻炸掉。 */
    return null;
  }
}

/**
 * 读取生效中的本地凭据。**拿不到地址就给默认值**，因为对本地模式来说
 * 「还没填」和「填的是默认端口」是同一件事，没必要逼用户打一遍。
 */
export async function readLocalCredentials(userId: string): Promise<LocalCredentials> {
  const row = await db.localConnection.findUnique({
    where: { userId },
    select: { baseUrl: true, encryptedApiKey: true, graph: true, comfyuiDir: true, enabled: true },
  });
  const apiKey = row?.encryptedApiKey ? (decryptSecret(row.encryptedApiKey) || '') : '';
  return {
    enabled: Boolean(row?.enabled),
    baseUrl: (row?.baseUrl || '').trim() || localBaseUrlFallback() || DEFAULT_LOCAL_BASE_URL,
    apiKey: apiKey || localApiKeyFallback(),
    graph: storedGraph(row?.graph),
    comfyuiDir: (row?.comfyuiDir || '').trim() || localComfyuiDirFallback(),
  };
}

export async function describeLocalConnection(userId: string): Promise<LocalConnectionView> {
  const row = await db.localConnection.findUnique({
    where: { userId },
    select: {
      baseUrl: true, encryptedApiKey: true, graph: true, comfyuiDir: true,
      enabled: true, status: true, lastCheckedAt: true, updatedAt: true,
    },
  });
  const own = (row?.baseUrl || '').trim();
  const env = localBaseUrlFallback();
  const baseUrl = own || env || DEFAULT_LOCAL_BASE_URL;
  const apiKey = row?.encryptedApiKey ? (decryptSecret(row.encryptedApiKey) || '') : '';
  const key = apiKey || localApiKeyFallback();
  const graph = storedGraph(row?.graph);
  const comfyuiDir = (row?.comfyuiDir || '').trim() || localComfyuiDirFallback();
  return {
    enabled: Boolean(row?.enabled),
    baseUrl,
    baseUrlSource: own ? 'user' : env ? 'env' : 'default',
    hasKey: Boolean(key),
    masked: key ? maskSecret(key) : null,
    comfyuiDir,
    /* 目录扫描有 5 分钟缓存，所以这里可以每次都给界面带一份最新概览。 */
    dir: await describeComfyuiDir(comfyuiDir),
    hasGraph: Boolean(graph),
    graphNodes: graph ? Object.keys(graph).length : 0,
    nodeIds: graph ? localGraphNodeIds(graph).slice(0, 12) : [],
    status: row?.status || 'unverified',
    lastCheckedAt: row?.lastCheckedAt?.toISOString() || null,
    updatedAt: row?.updatedAt?.toISOString() || null,
  };
}

export type LocalConnectionInput = {
  baseUrl?: string;
  apiKey?: string;
  /** 传 `null` 表示清空这份图。 */
  graph?: unknown;
  /** ComfyUI 安装目录。传空串表示「不配」（服务没开就查不了）。 */
  comfyuiDir?: string;
  enabled?: boolean;
};

/**
 * 保存本地连接。**部分更新**：传什么改什么，不传的保持原样。
 *
 * 唯一硬拦的一条：**没有图就不许开开关**。开着却没有图，点生成的后果是每次都报
 * 「找不到节点」—— 与其让它开着等人撞，不如在保存这一刻就说明白为什么开不了。
 */
export async function saveLocalConnection(userId: string, input: LocalConnectionInput) {
  const current = await db.localConnection.findUnique({
    where: { userId },
    select: { baseUrl: true, encryptedApiKey: true, graph: true, comfyuiDir: true, enabled: true },
  });

  /*
   * 图的类型要在这一层就收成 Prisma 认的 `InputJsonValue`：库里读出来是 `JsonValue`（含 null），
   * 而写回去的口子只收 `InputJsonValue`。`null` 也不能直接塞进去 —— Json 列的显式空值
   * 得用 `Prisma.DbNull` 这个哨兵，直接给 `null` 会在编译期就被挡下。
   */
  let nextGraph: Prisma.InputJsonValue | null = (current?.graph ?? null) as Prisma.InputJsonValue | null;
  if (input.graph !== undefined) {
    nextGraph = input.graph === null ? null : (parseLocalGraph(input.graph) as unknown as Prisma.InputJsonValue);
  }

  let nextEnabled = input.enabled === undefined ? Boolean(current?.enabled) : input.enabled;
  if (nextEnabled && !nextGraph) {
    throw new Error('还缺一份工作流图 —— 先粘贴 ComfyUI「导出（API）」出来的那份 JSON，才能打开本地模式。');
  }
  /** 图被清掉了就把开关一起关掉：留着一个「开着但不能跑」的开关没有意义。 */
  if (!nextGraph) nextEnabled = false;

  const baseUrl = input.baseUrl === undefined ? (current?.baseUrl ?? '') : input.baseUrl.trim();
  const encryptedApiKey = input.apiKey === undefined
    ? (current?.encryptedApiKey ?? '')
    : (input.apiKey.trim() ? encryptSecret(input.apiKey.trim()) : '');

  /*
   * 目录在这一刻就验证：填错的后果不是「存不进去」，而是之后每次检查都按空清单比对 ——
   * 于是每个节点都被报成「没装」，看着像 ComfyUI 什么都没装，其实只是路径填错了一层。
   */
  const comfyuiDir = input.comfyuiDir === undefined ? (current?.comfyuiDir ?? '') : input.comfyuiDir.trim();
  if (input.comfyuiDir !== undefined) await validateComfyuiDir(comfyuiDir);

  await db.localConnection.upsert({
    where: { userId },
    create: {
      userId, baseUrl, encryptedApiKey,
      graph: nextGraph ?? undefined, comfyuiDir, enabled: nextEnabled,
    },
    update: {
      baseUrl, encryptedApiKey,
      graph: nextGraph ?? Prisma.DbNull, comfyuiDir, enabled: nextEnabled, status: 'unverified',
    },
  });
  return describeLocalConnection(userId);
}

export async function clearLocalConnection(userId: string) {
  await db.localConnection.deleteMany({ where: { userId } });
  return describeLocalConnection(userId);
}

export async function markLocalStatus(userId: string, status: 'verified' | 'failed') {
  const row = await db.localConnection.findUnique({ where: { userId }, select: { id: true } });
  if (!row) return;
  await db.localConnection.update({ where: { userId }, data: { status, lastCheckedAt: new Date() } });
}
