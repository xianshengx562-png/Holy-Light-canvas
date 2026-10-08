import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '@/lib/db';
import { canvasMediaRoot } from '@/lib/output-dir';
import { mediaExtOfBuffer, mediaKindOfExt, mediaMimeOfExt } from '@/lib/media';

/**
 * 画布素材：**拖进画布 / 粘进画布 / 在节点上选的那张图、那段视频、那段音频**（2026-10-08）。
 *
 * 与 `lib/media.ts` 那批落盘函数的区别只有一条 —— **它不建 Asset 记录**，
 * 所以资产库里看不到它、容量统计也算不到它：
 * 「往画布里放一张参考图」不是「我要收藏这张图」，让它们混进资产库等于把用户的
 * 收藏夹当回收站（徐先原话：「从外面添加的图片拉入画布会自动进入资产库，这个 bug 也修复」）。
 *
 * 不建记录的代价要清楚：**没有任何地方会替你清理它**。删掉节点不会删文件，
 * 孤儿扫描（`lib/assets.ts`）又只扫 `media/` 与 `latents/` —— 所以它刻意住在
 * `canvas-media/` 这个独立子目录里：既躲开了那把清扫，也不会让「有文件、没记录」
 * 的文件落进被清扫的目录里被误删。
 *
 * 反过来说，生成**出来**的东西照旧走 `lib/media.ts` 进资产库 —— 那是成果，不是草稿。
 */

/** 单份上限，与「实用工具成品」同一档（120 MB）：拖进来的往往是一段长视频，卡成 20 MB 会莫名其妙。 */
const maxBytes = 120 * 1024 * 1024;

/** 取流地址的形状：`/api/canvas-media/<projectId>/<uuid>.<ext>`。 */
export const CANVAS_MEDIA_PREFIX = '/api/canvas-media/';

/**
 * projectId 与文件名都要卡死：projectId 进路径、文件名也进路径，
 * 放一个 `../` 进来就能顺着取流接口读到盘上别的地方。
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_FILE = /^[a-f0-9-]{8,64}\.[a-z0-9]+$/i;

/** 认出「这是画布素材的地址」并拆出 projectId 与文件名；不是就返回 null。 */
export function parseCanvasMediaUrl(value: unknown): { projectId: string; file: string } | null {
  const text = String(value ?? '').trim();
  if (!text.startsWith(CANVAS_MEDIA_PREFIX)) return null;
  const [projectId, file] = text.slice(CANVAS_MEDIA_PREFIX.length).split('/');
  if (!projectId || !file) return null;
  if (!SAFE_ID.test(projectId) || !SAFE_FILE.test(file.split(/[?#]/)[0])) return null;
  return { projectId, file };
}

export type ArchivedCanvasMedia = {
  id: string;
  /** 取流地址（`/api/canvas-media/<projectId>/<uuid>.<ext>`）。 */
  url: string;
  /** 上传给上游时用的文件名 —— **扩展名必须对**，RunningHub 靠它认类型。 */
  name: string;
  size: number;
  type: 'video' | 'image' | 'audio' | 'text';
};

/**
 * 存一份画布素材。
 *
 * 落盘三步与 `lib/media.ts` 那批完全同构（先定 id → 先写文件 → 再返回值）：
 * 「文件已经在盘上」是这件事实的唯一形态，没有记录可回滚，所以顺序不能变。
 */
export async function archiveCanvasMedia(input: {
  userId: string;
  projectId: string;
  file: File;
}): Promise<ArchivedCanvasMedia | null> {
  const bytes = Buffer.from(await input.file.arrayBuffer());
  if (!bytes.length || bytes.length > maxBytes) return null;
  const ext = mediaExtOfBuffer(bytes);
  const kind = ext ? mediaKindOfExt(ext) : null;
  if (!ext || !kind) return null;
  /* 归属必须查：projectId 是前端给的任意字符串，不验就能往别人的项目里塞文件。 */
  const project = await db.project.findFirst({ where: { id: input.projectId, userId: input.userId }, select: { id: true } });
  if (!project) return null;
  try {
    const dir = path.join(await canvasMediaRoot(), input.projectId);
    await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
    const id = randomUUID();
    const file = `${id}.${ext}`;
    const target = path.join(dir, file);
    await writeFile(/*turbopackIgnore: true*/ target, bytes);
    return {
      id,
      url: `${CANVAS_MEDIA_PREFIX}${input.projectId}/${file}`,
      name: file,
      size: bytes.length,
      type: kind,
    };
  } catch {
    return null;
  }
}

/**
 * 取流前的两件事：验这个项目的归属，再把文件信息量出来。
 *
 * 没有 Asset 记录可查，所以**路径完全由 projectId + 文件名拼出来** ——
 * 这正是上面那两个正则必须卡死的原因（文件名里不许出现斜杠与点点）。
 */
export async function openCanvasMedia(input: { userId: string; projectId: string; file: string }) {
  if (!SAFE_ID.test(input.projectId) || !SAFE_FILE.test(input.file)) return null;
  const project = await db.project.findFirst({ where: { id: input.projectId, userId: input.userId }, select: { id: true } });
  if (!project) return null;
  const ext = String(input.file).split('.').pop() || '';
  const target = path.join(await canvasMediaRoot(), input.projectId, input.file);
  try {
    const info = await stat(/*turbopackIgnore: true*/ target);
    if (!info.isFile()) return null;
    return { path: target, size: info.size, ext, mime: mediaMimeOfExt(ext), name: input.file };
  } catch {
    return null;
  }
}
