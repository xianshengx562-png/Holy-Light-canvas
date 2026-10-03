import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { db } from '@/lib/db';
import { latentRoot, resolveStoredPath } from '@/lib/output-dir';
import { isMediaResult } from '@/lib/media';
import { latentStoreName, latentUploadName } from '@/lib/latent-name';

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

/*
 * Archives written before 2026-10-03 were gzipped (`.latent.gz`); newer ones are
 * plain safetensors. Detection goes by the gzip magic bytes, never by the file name —
 * an old record still points at its old `.latent.gz` path through `metadata.path`.
 */
function isGzip(data: Buffer): boolean {
  return data.length > 2 && data[0] === 0x1f && data[1] === 0x8b;
}

async function store(projectId: string, fileName: string, data: Buffer) {
  /* Same as `lib/media.ts`: the root is resolved at runtime (it follows the output
   * directory the user picked in Settings). */
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
      /*
       * Stored **as-is**: it already is a safetensors file, and keeping it plain means
       * the copy on disk can be handed to a local ComfyUI directly. (Used to be
       * `gzipSync(raw)`; gzip saved ~9% and cost us the interoperability.)
       */
      const stored = await store(input.projectId, latentStoreName(input.taskId, sequence, kind), raw);
      /*
       * Id first, then the row, **in one shot** (the latent file name is
       * `<taskId>-<seq>-<kind>.safetensors` and carries no asset id, so unlike
       * `lib/media.ts` there is no need to settle the id before writing).
       *
       * Do not go back to "create a row with url `/api/assets/pending`, then update it
       * to the real address": if the write-back fails, a row pointing at a placeholder
       * stays behind, the asset library renders it as a broken image and throws 405.
       * This way the worst case is an orphan file (visible, and cleanable).
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
          metadata: { sequence, kind, size: raw.length, originalUrl: String(item.url), path: stored, outputType: item.outputType || null },
        },
      });
    } catch {
      continue;
    }
  }
  return listProjectLatents(input.projectId);
}

/**
 * The user picks a latent from their own machine — **it lands in our latent library
 * first, it is not uploaded to RunningHub straight away**.
 *
 * Why this follows the same path as reference images: putting a file on the canvas is
 * an *input*; whether another platform's key is configured has nothing to do with what
 * the user is doing right now — without a key we would pop "尚未配置 RunningHub API Key"
 * and the node would be dead, while the file never left their own disk. We store it and
 * return `asset:<id>`; when the generation is actually submitted, `resolveLatentValues()`
 * reads it back off disk and re-uploads it (exactly what reference images do).
 *
 * Stored the same way `archiveTaskLatents` stores them (plain safetensors +
 * `metadata.path`), so one reader handles both.
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
  const stored = await store(input.projectId, latentStoreName(id, sequence, 'coarse'), raw);
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
  const onDisk = await readFile(/*turbopackIgnore: true*/ await resolveStoredPath(meta.path));
  return {
    /*
     * Old archives are gzipped, new ones are plain — the reader has to take both,
     * otherwise every latent archived before the switch would fail to upload.
     */
    buffer: isGzip(onDisk) ? gunzipSync(onDisk) : onDisk,
    /*
     * The name used for the upload **must end in `.safetensors`** (the 500 徐先 hit on
     * 2026-10-03): the upstream `Yuan_H3MotionContextLoadLatent` node types the file by
     * its suffix, and we used to hand it `.latent`, so the task ran a full round and
     * then failed. The bytes were always right — only the name was wrong.
     * Single source of truth: `lib/latent-name.ts` (dependency-free, unit-tested).
     */
    fileName: latentUploadName(meta.sequence, meta.kind),
    name: asset.name,
  };
}
