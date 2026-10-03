import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { db } from '@/lib/db';
import { latentRoot, resolveStoredPath } from '@/lib/output-dir';
import { isMediaResult } from '@/lib/media';
import { latentUploadName } from '@/lib/latent-name';

export const latentAssetPrefix = 'asset:';
export type LatentKind = 'coarse' | 'fine';
export type LatentRecord = {
  id: string;
  sequence: string;
  kind: LatentKind;
  size: number;
  createdAt: string;
  sourceTaskId: string | null;
};

const maxBytes = 2 * 1024 * 1024 * 1024;

const kindLabel: Record<LatentKind, string> = { coarse: '粗采样', fine: '精采样' };

function kindOf(item: { outputType?: string; nodeId?: string }, index: number): LatentKind {
  const hint = `${item.outputType || ''} ${item.nodeId || ''}`.toLowerCase();
  if (/fine|refine|detail|精/.test(hint) || item.nodeId === '278') return 'fine';
  if (/coarse|base|draft|粗/.test(hint) || item.nodeId === '210') return 'coarse';
  return index === 0 ? 'coarse' : 'fine';
}

async function store(projectId: string, fileName: string, data: Buffer) {
  /* 同 `lib/media.ts`：根目录运行时现取（用户在设置里换了产出目录就跟着变）。 */
  const dir = path.join(await latentRoot(), projectId);
  await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  await writeFile(/*turbopackIgnore: true*/ path.join(dir, fileName), data);
  return path.join(dir, fileName);
}

export async function listProjectLatents(projectId: string): Promise<LatentRecord[]> {
  const rows = await db.asset.findMany({
    where: { projectId, type: 'latent' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, metadata: true, createdAt: true, sourceTaskId: true },
  });
  return rows.map(row => {
    const meta = (row.metadata || {}) as { sequence?: string; kind?: string; size?: number };
    return {
      id: row.id,
      sequence: meta.sequence || 'L000',
      kind: meta.kind === 'fine' ? 'fine' : 'coarse',
      size: Number(meta.size || 0),
      createdAt: row.createdAt.toISOString(),
      sourceTaskId: row.sourceTaskId,
    };
  });
}

export async function archiveTaskLatents(input: {
  userId: string;
  projectId: string;
  taskId: string;
  results: unknown;
}): Promise<LatentRecord[]> {
  if (!Array.isArray(input.results)) return [];
  const items = input.results.filter((item): item is { url?: string; outputType?: string; nodeId?: string } =>
    Boolean(item) && typeof item === 'object' && 'url' in item && Boolean((item as { url?: string }).url),
  ).filter(item => !isMediaResult(item));
  if (!items.length) return [];

  const existing = await db.asset.count({ where: { projectId: input.projectId, type: 'latent', sourceTaskId: input.taskId } });
  if (existing > 0) return listProjectLatents(input.projectId);

  const groups = await db.asset.groupBy({ by: ['sourceTaskId'], where: { projectId: input.projectId, type: 'latent' } });
  const sequence = `L${String(groups.length + 1).padStart(3, '0')}`;

  for (const [index, item] of items.entries()) {
    try {
      const response = await fetch(String(item.url), { signal: AbortSignal.timeout(300_000) });
      if (!response.ok) continue;
      const raw = Buffer.from(await response.arrayBuffer());
      if (!raw.length || raw.length > maxBytes) continue;
      const kind = kindOf(item, index);
      const packed = gzipSync(raw);
      const fileName = `${sequence}-${kind}.latent.gz`;
      const stored = await store(input.projectId, `${input.taskId}-${fileName}`, packed);
      /*
       * 先定 id 再插记录，**一步到位**（latent 的文件名是 `<taskId>-<编号>-<粗/精>.latent.gz`，
       * 本来就不含资产 id，所以这里不需要像 `lib/media.ts` 那样先定 id 再写文件）。
       *
       * 不要退回「先 create 一条 url 是 `/api/assets/pending` 的记录、再 update 回真实地址」：
       * 回写失败就会留下一条指向占位地址的行，资产库把它渲染成坏图并打出 405。
       * 这样写最坏只是留一个孤儿文件（看得见、也能清）。
       */
      const id = randomUUID();
      await db.asset.create({
        data: {
          id,
          userId: input.userId,
          projectId: input.projectId,
          name: `${sequence} · ${kindLabel[kind]}`,
          type: 'latent',
          url: `/api/assets/${id}/download`,
          sourceTaskId: input.taskId,
          metadata: { sequence, kind, size: raw.length, packedSize: packed.length, originalUrl: String(item.url), path: stored, outputType: item.outputType || null },
        },
      });
    } catch {
      continue;
    }
  }
  return listProjectLatents(input.projectId);
}

/**
 * 用户从自己电脑上挑一份 .latent —— **先存进本站的 latent 库，不直传 RunningHub**。
 *
 * 为什么和参考图走同一套路子：把文件放进画布是「输入」，要不要另一家平台的 Key
 * 跟用户此刻在干什么无关 —— 没配 Key 就弹「尚未配置 RunningHub API Key」，节点直接废掉，
 * 而那份文件从头到尾都还在他自己电脑上。存下来返回 `asset:<id>`，
 * 等真到提交生成那一步，`resolveLatentValues()` 会读盘重传（参考图走的就是这条）。
 *
 * 存法必须和 `archiveTaskLatents` 一致（gzip + `metadata.path`）：`readLatentFile()`
 * 那边只会 gunzip，这里不压的话那头解不开。
 */
export async function archiveUserLatent(input: {
  userId: string;
  projectId: string;
  file: File;
}): Promise<{ id: string; value: string }> {
  const raw = Buffer.from(await input.file.arrayBuffer());
  if (!raw.length) throw new Error('这个文件是空的。');
  if (raw.length > maxBytes) throw new Error('这个文件太大了（上限 2 GB）。');

  const groups = await db.asset.groupBy({ by: ['sourceTaskId'], where: { projectId: input.projectId, type: 'latent' } });
  const sequence = `L${String(groups.length + 1).padStart(3, '0')}`;
  const id = randomUUID();
  const packed = gzipSync(raw);
  const stored = await store(input.projectId, `${id}.latent.gz`, packed);
  await db.asset.create({
    data: {
      id,
      userId: input.userId,
      projectId: input.projectId,
      name: `${sequence} · 上传的 latent`,
      type: 'latent',
      url: `/api/assets/${id}/download`,
      metadata: {
        sequence,
        kind: 'coarse',
        size: raw.length,
        packedSize: packed.length,
        path: stored,
        source: 'upload',
      },
    },
  });
  return { id, value: `${latentAssetPrefix}${id}` };
}

export async function readLatentFile(assetId: string, userId: string) {
  const asset = await db.asset.findFirst({ where: { id: assetId, userId, type: 'latent' } });
  if (!asset) throw new Error('latent 不存在或无权访问。');
  const meta = (asset.metadata || {}) as { path?: string; sequence?: string; kind?: string };
  if (!meta.path) throw new Error('该 latent 未落盘，无法用于接续。');
  const packed = await readFile(/*turbopackIgnore: true*/ await resolveStoredPath(meta.path));
  return {
    buffer: gunzipSync(packed),
    /*
     * 🔴 上传时用的名字**必须以 `.safetensors` 结尾**（2026-10-03 徐先报的那次 500）：
     * 上游那个 `Yuan_H3MotionContextLoadLatent` 节点按后缀判类型，原来这里给的是
     * `.latent`，于是任务跑完一轮才报「手动上传仅支持 .safetensors 文件」。
     * 内容一直是 safetensors（读回来就是上游给的那份字节），错的只是名字。
     * 判据只有一处：`lib/latent-name.ts`（零依赖、另有单测锁着）。
     */
    fileName: latentUploadName(meta.sequence, meta.kind),
    name: asset.name,
  };
}
