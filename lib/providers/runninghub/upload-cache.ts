import 'server-only';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { storageRoot } from '@/lib/storage-root';

/**
 * Remembers which upstream file name a given byte stream was uploaded under, so the same
 * latent / reference image is not pushed to RunningHub again on every run.
 *
 * Why it exists (2026-10-04): a run submits its latents and reference images *before* the
 * task is created, and uploads are serial. Two latents (13.5 MB + 31.6 MB) at this machine's
 * ~75 KB/s upstream take the better part of ten minutes — 徐先 watched the canvas sit on
 * "运行中 04:34" and asked why the cloud took so long to *start*. It wasn't the cloud
 * queueing: it was us still pushing bytes. The same latent is re-sent on every single run
 * of a chain, which is pure waste.
 *
 * Key = upstream host + key prefix + sha256 of the bytes. Keying on the *content* (not the
 * asset id) means a re-generated but byte-identical file also hits.
 *
 * ⚠️ Upstream files do not live forever. `UPLOAD_CACHE_TTL_MS` is deliberately short; if a
 * task ever comes back with "file not found", the fix is to drop that entry and re-upload
 * rather than to lengthen the TTL.
 */

/** Sits next to the media files; follows `HOLYLIGHT_DATA_DIR` like everything else. */
export const UPLOAD_CACHE_FILE = 'runninghub-uploads.json';

/** How long an upstream file name is trusted. */
export const UPLOAD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Hard cap — the file is a convenience cache, not a record of anything. */
const MAX_ENTRIES = 120;

export type CachedUpload = { fileName: string; url: string };

type Row = CachedUpload & { at: number; size: number };

type DiskShape = { version: 1; entries: Record<string, Row> };

function cacheFile(): string {
  return path.join(storageRoot(), UPLOAD_CACHE_FILE);
}

/** sha256 of the file bytes — the part of the key that makes "same file" detectable. */
export function bytesDigest(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

/**
 * One key per (upstream account, file content).
 *
 * The account goes in because a file name only means something on the site that issued it —
 * the domestic and overseas RunningHub instances are separate accounts with separate stores.
 */
export function uploadCacheKey(input: { baseUrl?: string; apiKey?: string; digest: string }): string {
  const site = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  const who = String(input.apiKey || '').slice(0, 12);
  return createHash('sha256').update(site + '|' + who + '|' + input.digest).digest('hex').slice(0, 40);
}

/**
 * Reads and writes of the cache file are funnelled through one chain: an upload run may
 * resolve several files in parallel (`Promise.all`), and two concurrent
 * read-modify-write cycles would have one of them silently win.
 */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job);
  chain = next.catch(() => undefined);
  return next;
}

async function readDisk(): Promise<DiskShape> {
  try {
    const raw = await readFile(/*turbopackIgnore: true*/ cacheFile(), 'utf8');
    const parsed = JSON.parse(raw) as DiskShape;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed;
  } catch {
    /* Missing / corrupt cache is not worth failing an upload over — just start clean. */
  }
  return { version: 1, entries: {} };
}

/**
 * A hit, or `null`.
 *
 * Expired rows are reported as a miss *and* removed, so a stale name cannot come back.
 */
export async function readUploadCache(key: string): Promise<CachedUpload | null> {
  return serialize(async () => {
    const disk = await readDisk();
    const row = disk.entries[key];
    if (!row || !row.fileName) return null;
    if (!Number.isFinite(row.at) || Date.now() - row.at > UPLOAD_CACHE_TTL_MS) {
      delete disk.entries[key];
      await writeDisk(disk);
      return null;
    }
    /** The download URL is a bonus; the file name is the thing callers actually need. */
    return { fileName: row.fileName, url: row.url || '' };
  });
}

/** Survives a failed write: the upload already succeeded upstream, a full cache is not an error. */
export async function rememberUpload(key: string, value: CachedUpload, size: number): Promise<void> {
  await serialize(async () => {
    const disk = await readDisk();
    disk.entries[key] = { fileName: value.fileName, url: value.url || '', at: Date.now(), size };
    const rows = Object.entries(disk.entries);
    if (rows.length > MAX_ENTRIES) {
      /* Oldest first — `at` is when we recorded it, which is close enough to upload order. */
      rows.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
      disk.entries = Object.fromEntries(rows.slice(0, MAX_ENTRIES));
    }
    await writeDisk(disk);
  }).catch(() => undefined);
}

async function writeDisk(disk: DiskShape): Promise<void> {
  const file = cacheFile();
  await mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
  await writeFile(/*turbopackIgnore: true*/ file, JSON.stringify(disk), 'utf8');
}
