import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '@/lib/db';
import { mediaRoot, resolveStoredPath } from '@/lib/output-dir';

/**
 * 生成结果的落盘归档。
 *
 * RunningHub 的结果 URL 只有 24 小时寿命，过期后画布上的历史、节点画框、
 * 侧边栏的生成记录全是坏图。所以任务一成功就把媒体抓下来存到本地，
 * 之后一律走 `/api/assets/{id}/media.{ext}` 取流——同源、不过期、还能拖动进度条。
 *
 * 落盘失败（超时、太大、网络抽风）都**静默回退到原始 URL**：24 小时内还能用，
 * 总比把「生成成功」变成「生成失败」强。
 */
/** 音频也在里面：画布上往里粘 / 拖一段音频，同样要落成本项目下的一份资产。 */
/**
 * `text` 也在里面（2026-10-04）：应用 / 节点**只吐一段文字**时，那段文字同样要落成本项目下的
 * 一份资产（写成一个 `.txt`），否则任务成功、结果却什么地方都没有 —— 这正是徐先说的
 * 「不管输出的是什么，都能保存」里最靠后、也最容易被漏掉的一档。
 */
export type MediaKind = 'video' | 'image' | 'audio' | 'text';
export type ArchivedMedia = { originalUrl: string; url: string; kind: MediaKind; size: number };

/**
 * 纯文本结果在那个没法当 URL 用的「原始地址」里长什么样。
 *
 * 文本没有 URL 可下载，但归档的缓存 / 回写这两处都按 `originalUrl` 找条目
 * （`archiveTaskMedia` 用它去重、`rewriteResultUrls` 用它把结果里的地址换成落盘地址）。
 * 给它一个**按位置算出来、两边都能重算**的键，这两套逻辑就完全不用为文本分叉。
 */
export function textResultKey(taskId: string, index: number) {
  return `text:${taskId}:${index}`;
}

/*
 * ⚠️ 根目录**不能**在模块加载时算死：桌面版允许用户在设置里换产出目录，
 * 换了之后这里必须跟着变。所以每次落盘都现取一次（`mediaRoot()` 内部有缓存，
 * 不是每张图读一次配置）。
 *
 * 不用 `path.join(storageRoot(), 'media')` 那种写法的原因见 `lib/output-dir.ts` 文件头。
 */
const maxBytes = 512 * 1024 * 1024;
const fetchTimeout = 300_000;

const MIME: Record<string, { mime: string; media: MediaKind }> = {
  mp4: { mime: 'video/mp4', media: 'video' },
  webm: { mime: 'video/webm', media: 'video' },
  mov: { mime: 'video/quicktime', media: 'video' },
  png: { mime: 'image/png', media: 'image' },
  jpg: { mime: 'image/jpeg', media: 'image' },
  jpeg: { mime: 'image/jpeg', media: 'image' },
  webp: { mime: 'image/webp', media: 'image' },
  gif: { mime: 'image/gif', media: 'image' },
  avif: { mime: 'image/avif', media: 'image' },
  mp3: { mime: 'audio/mpeg', media: 'audio' },
  wav: { mime: 'audio/wav', media: 'audio' },
  m4a: { mime: 'audio/mp4', media: 'audio' },
  ogg: { mime: 'audio/ogg', media: 'audio' },
  flac: { mime: 'audio/flac', media: 'audio' },
  /* 文本结果落成 `.txt`（2026-10-04）。带上 charset，直接开链接看才是中文而不是乱码。 */
  txt: { mime: 'text/plain; charset=utf-8', media: 'text' },
};

/** 只认白名单里的扩展名，`/api/assets/{id}/media.mp4` 这种也认（末尾那段带扩展名）。 */
export function mediaExtOf(value: unknown) {
  const clean = String(value ?? '').split(/[?#]/)[0];
  const match = /\.([a-z0-9]+)$/i.exec(clean);
  const ext = match ? match[1].toLowerCase() : '';
  return MIME[ext] ? ext : '';
}

function classify(item: { url?: string; outputType?: string; text?: string }) {
  const ext = mediaExtOf(item.url);
  if (ext) return { ext, ...MIME[ext] };
  /*
   * 纯文本结果（2026-10-04）：**没有文件地址，只有一段文字**。出文本的应用就是这个形状。
   * 落盘成一份 `.txt` 之后，它就和别的媒体一样走 `/api/assets/{id}/media.txt` 取流，
   * 下游（资产库 / 画布卡片 / 生成历史）不必为它分叉。
   *
   * ⚠️ 条件是「连 url 都没有」而不是「有 text 就算文本」：结果项里 `text` 这个键**常常跟着
   * 文件一起回来**（本地库里 12 条任务的结果项全带这个键）—— 按 text 判定会把好端端的一张图
   * 归档成 .txt。
   */
  if (!item.url && String(item.text || '').trim()) return { ext: 'txt', ...MIME.txt };
  // 没有扩展名时退回到 outputType；猜不出真实格式就按大类给个默认值，
  // 真正落盘时还会用响应的 content-type 校正一次。
  const hint = String(item.outputType || '').toLowerCase();
  if (/video|mp4|webm|mov/.test(hint)) return { ext: 'mp4', ...MIME.mp4 };
  /* 音频（2026-10-02）：`outputType: 'audio'` 这个词本身不含任何扩展名，
     少了这一支的话「URL 上没有扩展名的音频」会被判成「不是媒体」—— 于是**根本不落盘**，
     任务成功、资产库里却什么都没有（音频工作流最典型的形状就是这个）。 */
  if (/audio|mp3|wav|m4a|aac|ogg|flac/.test(hint)) return { ext: 'mp3', ...MIME.mp3 };
  if (/image|png|jpe?g|webp|gif|avif/.test(hint)) return { ext: 'png', ...MIME.png };
  return null;
}

function fileNameOf(value: string) {
  const tail = String(value).split(/[?#]/)[0].split('/').pop() || '';
  if (!tail || tail.length > 120) return '';
  try { return decodeURIComponent(tail); } catch { return tail; }
}

/**
 * 这个结果算不算媒体——媒体归 `lib/media.ts`，别的都归 `lib/latents.ts`。
 *
 * **这是唯一判据，latent 侧必须调它、不许自己写一份**：`archiveTaskLatents` 里曾经
 * 用一个正则直接扫 `outputType + url` 的拼串，而 `outputType: 'video'` 这个词本身不含
 * `mp4/mov/png`，于是「URL 没有扩展名的视频」两边都认领了一次，同一份文件落盘两次，
 * 还多出一条假 latent 混进接续候选。这里复用 `classify`，保证两边永远一致。
 */
export function isMediaResult(item: { url?: string; outputType?: string; text?: string }) {
  return Boolean(classify(item));
}

/**
 * 从字节里认图片格式 —— 只认魔数，不看文件名。
 *
 * 为什么需要它：自定义接口这类同步网关把图放在 `b64_json` 里回来，**没有任何文件名和
 * content-type** 可以依据，而扩展名直接决定落盘后的文件名与 `/media.{ext}` 的取流路由。
 * 认不出时退回 `png`：透明背景那条路上游基本只会给 PNG，这个兜底最不容易错。
 */
export function imageExtOfBuffer(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  return 'png';
}

/**
 * 从字节里认媒体格式 —— **认不出就返回空串，不猜、不兜底**。
 *
 * 和 `imageExtOfBuffer` 的区别就在「认不出时怎么办」：那个服务于用户上传的参考图，
 * 认不出也要给个 png 兜底（否则一张好图就被丢掉了）；这个服务于**我们自己算出来的
 * 成品**，认不出说明这段字节根本不是媒体 —— 兜底成 png 等于往资产库里塞一个
 * 打不开的文件，还不如直接如实报错。
 *
 * 视频只认 WebM（EBML 头）和 MP4（`ftyp` box）：实用工具目前只会产出这两种。
 */
export function mediaExtOfBuffer(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  /* EBML 魔数：WebM / Matroska 一律以它开头。 */
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    /* `.m4a` 与 `.mp4` 是同一个盒子结构，区别只在 ftyp 的牌子（`M4A `）——
       一律当成 mp4 的话，音频会被归档成「视频」，资产库和播放器都会认错。 */
    const brand = bytes.subarray(8, 12).toString('ascii');
    return /^M4A/.test(brand) ? 'm4a' : 'mp4';
  }
  /* ---------- 音频 ---------- */
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  /** 不带 ID3 头的裸 MPEG 流：11 位帧同步全 1。JPEG 的 `FF D8` 落不进这个掩码，不会撞。 */
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
  return '';
}

/**
 * 扩展名 → MIME。`imageExtOfBuffer` 的配套：认出格式之后要给别人一个 content-type
 * （图生图要把参考图塞进 multipart，每段都得带类型）。
 * 认不出一律按 png —— 与 `imageExtOfBuffer` 的兜底同一口径。
 */
export function imageMimeOfExt(ext: string) {
  return MIME[String(ext || '').toLowerCase()]?.mime || 'image/png';
}

/**
 * 同上，但覆盖**全部**媒体扩展名（图 / 视频 / 音频 / 文本），不只是图片。
 * `lib/canvas-media.ts` 要用它给落盘的画布素材回 content-type —— 那份素材没有 Asset 记录，
 * 取流路由得自己报类型。
 */
export function mediaMimeOfExt(ext: string) {
  return MIME[String(ext || '').toLowerCase()]?.mime || 'application/octet-stream';
}

/** 扩展名 → 大类（图 / 视频 / 音频 / 文本）。认不出返回 null。 */
export function mediaKindOfExt(ext: string): MediaKind | null {
  return MIME[String(ext || '').toLowerCase()]?.media ?? null;
}

/**
 * 把一次任务结果里的媒体落盘，返回「原始 URL → 本地 URL」的对照表。
 * 同一任务重复调用不会重复下载（按 `originalUrl` 命中已有 Asset）。
 */
export async function archiveTaskMedia(input: {
  userId: string;
  projectId: string;
  taskId: string;
  results: unknown;
}): Promise<ArchivedMedia[]> {
  const list = Array.isArray(input.results) ? input.results : [];
  type RawItem = { url?: string; outputType?: string; text?: string };
  const items = list
    /*
     * 每一项都带上它在结果数组里的**位置**：纯文本没有 URL，去重与回写都靠
     * `textResultKey(taskId, index)` 这个按位置算出来的键（`rewriteResultUrls` 同样能重算）。
     */
    .map((item, index) => ({ item: (item || {}) as RawItem, kind: classify((item || {}) as RawItem), index }))
    .filter((entry): entry is { item: RawItem; kind: { ext: string; mime: string; media: MediaKind }; index: number } =>
      Boolean(entry.kind)
      /* 有文件地址，或者有一段能落成 .txt 的文字 —— 两者都没有的才丢。 */
      && (Boolean(String(entry.item?.url || '').trim()) || Boolean(String(entry.item?.text || '').trim())));
  if (!items.length) return [];

  const stored = await db.asset.findMany({
    /* 音频、文本也要在里面：漏了它们的话「同一任务重复调用不重复落盘」对那两档不成立 ——
       缓存查不到，于是每调一次就重来一遍、多插一条资产。 */
    where: { projectId: input.projectId, sourceTaskId: input.taskId, type: { in: ['video', 'image', 'audio', 'text'] } },
    select: { url: true, type: true, metadata: true },
  });
  const cache = new Map<string, ArchivedMedia>();
  for (const row of stored) {
    const meta = (row.metadata || {}) as { originalUrl?: string; size?: number };
    if (meta.originalUrl) {
      cache.set(meta.originalUrl, {
        originalUrl: meta.originalUrl,
        url: row.url,
        kind: row.type === 'audio' ? 'audio' : row.type === 'video' ? 'video' : row.type === 'text' ? 'text' : 'image',
        size: Number(meta.size || 0),
      });
    }
  }

  const out: ArchivedMedia[] = [];
  for (const { item, kind, index } of items) {
    /* 纯文本的「原始地址」是按位置算的键；有文件的仍用它的 URL。 */
    const sourceUrl = String(item.url || '').trim();
    const source = sourceUrl || textResultKey(input.taskId, index);
    const hit = cache.get(source);
    if (hit) { out.push(hit); continue; }
    try {
      if (kind.media === 'text') {
        /*
         * 纯文本：没有东西可下载，文字就在结果项里。落盘那三步与媒体完全一致
         * （先定 id → 先写文件 → 再插记录），只是字节来自内存而不是一次 fetch。
         */
        const raw = Buffer.from(String(item.text || ''), 'utf8');
        if (!raw.length || raw.length > maxBytes) continue;
        const dir = path.join(await mediaRoot(), input.projectId);
        await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
        const id = randomUUID();
        const target = path.join(dir, `${id}.txt`);
        await writeFile(/*turbopackIgnore: true*/ target, raw);
        const url = `/api/assets/${id}/media.txt`;
        await db.asset.create({
          data: {
            id,
            userId: input.userId,
            projectId: input.projectId,
            /* 文本那一路 `sourceUrl` 是空串，`fileNameOf` 自然拿不到名字 —— 落回 `text.txt`。 */
            name: fileNameOf(sourceUrl) || `${kind.media}.${kind.ext}`,
            type: kind.media,
            url,
            sourceTaskId: input.taskId,
            metadata: { size: raw.length, originalUrl: source, outputType: item.outputType || null, mime: kind.mime, path: target, ext: kind.ext },
          },
        });
        const record: ArchivedMedia = { originalUrl: source, url, kind: kind.media, size: raw.length };
        cache.set(source, record);
        out.push(record);
        continue;
      }
      const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(fetchTimeout) });
      if (!response.ok) continue;
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared && declared > maxBytes) continue;
      const raw = Buffer.from(await response.arrayBuffer());
      if (!raw.length || raw.length > maxBytes) continue;

      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
      const mime = contentType && contentType !== 'application/octet-stream' ? contentType : kind.mime;
      const dir = path.join(await mediaRoot(), input.projectId);
      await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });

      /*
       * 顺序是**先定 id → 先写文件 → 再插记录**，一次成型。
       *
       * 不要退回「先 create 一条 url 是 `/api/assets/pending` 的记录、写完文件再 update 回真实地址」：
       * 中间任何一步失败（回写报错、进程被杀）都会留下一条指向占位地址的记录，
       * 而资产库会把它渲染成 `<img src="/api/assets/pending">` —— 一张坏图外加一条 405，
       * 用户完全看不出发生了什么。这样写最坏只是留一个孤儿文件，那是看得见、也清得掉的。
       */
      const id = randomUUID();
      const target = path.join(dir, `${id}.${kind.ext}`);
      await writeFile(/*turbopackIgnore: true*/ target, raw);
      const url = `/api/assets/${id}/media.${kind.ext}`;
      await db.asset.create({
        data: {
          id,
          userId: input.userId,
          projectId: input.projectId,
          name: fileNameOf(sourceUrl) || `${kind.media}.${kind.ext}`,
          type: kind.media,
          url,
          sourceTaskId: input.taskId,
          metadata: { size: raw.length, originalUrl: source, outputType: item.outputType || null, mime, path: target, ext: kind.ext },
        },
      });

      const record: ArchivedMedia = { originalUrl: source, url, kind: kind.media, size: raw.length };
      cache.set(source, record);
      out.push(record);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * 把**已经在内存里**的图片落盘 —— 自定义接口出图那条路走这里。
 *
 * 和 `archiveTaskMedia` 的区别只有一个「图从哪来」：那个要先按 URL 下载，这个直接收字节。
 * 落盘的三步顺序（先定 id → 先写文件 → 再插记录）和命名规则必须与那边**完全一致**，
 * 否则同一张图会在资产库里长成两种样子，`/media.{ext}` 取流也会有一半取不到。
 *
 * 返回值里的 `originalUrl` 是空串：这条路上游根本没给 URL（给的是一段 base64），
 * 所以**不能**拿返回值去做「原始 URL → 本地 URL」的替换表 —— 那件事只属于 `archiveTaskMedia`。
 */
export async function archiveInlineMedia(input: {
  userId: string;
  projectId: string;
  taskId: string;
  items: { bytes: Buffer; ext: string; name?: string }[];
}): Promise<ArchivedMedia[]> {
  const out: ArchivedMedia[] = [];
  for (const item of input.items) {
    const kind = MIME[item.ext];
    if (!item.bytes.length || item.bytes.length > maxBytes || !kind || kind.media !== 'image') continue;
    try {
      const dir = path.join(await mediaRoot(), input.projectId);
      await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
      const id = randomUUID();
      const target = path.join(dir, `${id}.${item.ext}`);
      await writeFile(/*turbopackIgnore: true*/ target, item.bytes);
      const url = `/api/assets/${id}/media.${item.ext}`;
      await db.asset.create({
        data: {
          id,
          userId: input.userId,
          projectId: input.projectId,
          name: item.name || `image.${item.ext}`,
          type: kind.media,
          url,
          sourceTaskId: input.taskId,
          metadata: { size: item.bytes.length, originalUrl: null, mime: kind.mime, path: target, ext: item.ext },
        },
      });
      out.push({ originalUrl: '', url, kind: kind.media, size: item.bytes.length });
    } catch {
      /* 单张失败不拖垮整批：它只是少一张可用的图，调用方按拿到的 URL 数量如实汇报。 */
      continue;
    }
  }
  return out;
}

/**
 * 单张**用户上传**图片的上限。
 *
 * 比参考图那边的 8MB 宽 —— 上传只是一个「把图存下来」的动作，真正的尺寸检查
 * 留在提交生成时（`references.ts` 会按张点名报错）。在这里就卡死会让用户
 * 「想传一张大图给别的链路」也传不了。
 */
const uploadMaxBytes = 20 * 1024 * 1024;

/*
 * 为什么不走 RunningHub 的上传（`/api/providers/runninghub/upload`）：那条路要求用户
 * 配好 RunningHub Key、还会把文件传到**别人的服务器**上；而这里要的只是一个
 * 「服务端取得到字节、画布显示得出来」的地址 —— 同步出图的参考图正是按
 * `/api/assets/...` 读本地盘的。存一份素材这件事不该被另一个平台的凭据卡住。
 *
 * 落盘三步与 `archiveInlineMedia` **完全一致**（先定 id → 先写文件 → 再插记录），
 * 那是「一次成型」的硬要求：先插一条占位记录再回头补 URL，中间失败就会留下指向
 * `/api/assets/pending` 的坏行 —— 资产库里一张坏图，取流 405。
 */
/**
 * 视频那一路的上限。比图片那 20MB 宽得多 —— 一段十几秒的 1080p 轻松几十 MB，
 * 按图片的门卡会「拖了个视频进来却存不下」，而那句报错根本说不清为什么。
 * 120MB 与实用工具成品同档：两边都是「用户自己手里的一段成品」，不是我们生成的。
 */
const uploadMediaMaxBytes = 120 * 1024 * 1024;

/**
 * 把**用户上传的文件**落盘成资产 —— 资产页那个「上传」按钮走这里。
 *
 * 与 `archiveUploadedImage` 只差「收哪些文件」：那个是老口径（只收图片，认不出还兜 png），
 * 这个是资产页的新口径（图片 **和** 视频）。落盘三步（先定 id → 先写文件 → 再插记录）
 * 必须与那边完全一致，那是「一次成型」的硬要求。
 *
 * 🔴 认格式一律认**魔数**（`mediaExtOfBuffer`），不看 `File.type`、也不看文件名：
 * 浏览器给的类型可能是 `video/webm;codecs=vp9` 甚至空串，而扩展名直接决定
 * `/media.{ext}` 这条取流路由能不能命中 —— 认错等于往资产库里塞一个打不开的文件。
 */
export async function archiveUploadedMedia(input: {
  userId: string;
  projectId: string;
  file: File;
  /** 落在 metadata.source 里，用来区分「资产页上传」和「实用工具的产出」。 */
  source?: string;
  /**
   * 收哪些。`image` = 只收图片（老口径）；`media` = 图片与视频。
   * 🔴 音频**不在这两种里**：资产页那颗按钮只说图片与视频，放音频进来等于
   * 界面上没提、库里却多出一种，报错时也说不清「为什么不收这个」。
   */
  allow?: 'image' | 'media';
  /** 体积上限。缺省按 `allow` 走：图片 20MB、媒体 120MB。 */
  maxBytes?: number;
}): Promise<{ id: string; url: string; name: string; size: number; type: MediaKind } | null> {
  const allow = input.allow === 'media' ? 'media' : 'image';
  const max = Number(input.maxBytes) > 0 ? Number(input.maxBytes) : (allow === 'media' ? uploadMediaMaxBytes : uploadMaxBytes);
  const bytes = Buffer.from(await input.file.arrayBuffer());
  if (!bytes.length || bytes.length > max) return null;
  const ext = allow === 'media' ? mediaExtOfBuffer(bytes) : imageExtOfBuffer(bytes);
  const kind = MIME[ext];
  if (!kind) return null;
  if (allow === 'image' && kind.media !== 'image') return null;
  if (allow === 'media' && kind.media !== 'image' && kind.media !== 'video') return null;
  try {
    const dir = path.join(await mediaRoot(), input.projectId);
    await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
    const id = randomUUID();
    const target = path.join(dir, `${id}.${ext}`);
    await writeFile(/*turbopackIgnore: true*/ target, bytes);
    const url = `/api/assets/${id}/media.${ext}`;
    const name = fileNameOf(input.file.name) || `参考图.${ext}`;
    await db.asset.create({
      data: {
        id,
        userId: input.userId,
        projectId: input.projectId,
        name,
        type: kind.media,
        url,
        /* 来源不是某个生成任务，所以没有 `sourceTaskId`；用 metadata 记下来源便于排查。 */
        metadata: {
          size: bytes.length,
          originalUrl: null,
          mime: kind.mime,
          path: target,
          ext,
          source: input.source ?? 'compose-upload',
        },
      },
    });
    return { id, url, name, size: bytes.length, type: kind.media };
  } catch {
    return null;
  }
}

/**
 * 老口径：把**用户上传的参考图**落盘成资产（首页那个大输入框的「上传图片」走这里，
 * 快速出图与自定义接口那两条路也在用）—— **只收图片**。
 *
 * 它就是 `archiveUploadedMedia` 的一个薄封装：「只收图片」这个口径只有一处实现，
 * 免得两条路上限 / 认格式的方式悄悄长成两样。
 */
export async function archiveUploadedImage(input: {
  userId: string;
  projectId: string;
  file: File;
  /** 落在 metadata.source 里，用来区分「首页上传的参考图」和「实用工具的产出」。 */
  source?: string;
}): Promise<{ id: string; url: string; name: string; size: number } | null> {
  const saved = await archiveUploadedMedia({ ...input, allow: 'image' });
  return saved ? { id: saved.id, url: saved.url, name: saved.name, size: saved.size } : null;
}

/**
 * 实用工具成品的上限。比用户上传那 20MB 宽得多：一段 10 秒 1080p 的 WebM 轻松到几十 MB，
 * 按图片那道闸门卡会「录了半天存不进去」，而那句失败提示根本说不清为什么。
 */
const toolMaxBytes = 120 * 1024 * 1024;

/**
 * 把**实用工具算出来的成品**落盘（`/api/tools/archive`）。
 *
 * 与 `archiveUploadedImage` 的唯一区别是**它不只收图片**：运镜效果出来的是一段视频，
 * 走图片那条路会被 `kind.media !== 'image'` 一句挡掉，界面上只看到「一个都没存下来」。
 * 落盘三步（先定 id → 先写文件 → 再插记录）与那边完全一致，那是「一次成型」的硬要求。
 *
 * 扩展名认魔数（`mediaExtOfBuffer`）：浏览器给的 `File.type` 在录制器的实现里
 * 可能是 `video/webm;codecs=vp9` 甚至空串，而扩展名直接决定 `/media.{ext}` 这条
 * 取流路由能不能命中。
 */
export async function archiveToolMedia(input: {
  userId: string;
  projectId: string;
  file: File;
  /** 落在 metadata.source 里，用来区分「用户上传的参考图」和「实用工具的产出」。 */
  source?: string;
}): Promise<{ id: string; url: string; name: string; size: number; type: MediaKind } | null> {
  const bytes = Buffer.from(await input.file.arrayBuffer());
  if (!bytes.length || bytes.length > toolMaxBytes) return null;
  const ext = mediaExtOfBuffer(bytes);
  const kind = MIME[ext];
  if (!kind) return null;
  try {
    const dir = path.join(await mediaRoot(), input.projectId);
    await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
    const id = randomUUID();
    const target = path.join(dir, `${id}.${ext}`);
    await writeFile(/*turbopackIgnore: true*/ target, bytes);
    const url = `/api/assets/${id}/media.${ext}`;
    const name = fileNameOf(input.file.name) || `${kind.media}.${ext}`;
    await db.asset.create({
      data: {
        id,
        userId: input.userId,
        projectId: input.projectId,
        name,
        type: kind.media,
        url,
        metadata: {
          size: bytes.length,
          originalUrl: null,
          mime: kind.mime,
          path: target,
          ext,
          source: input.source ?? 'tool-output',
        },
      },
    });
    return { id, url, name, size: bytes.length, type: kind.media };
  } catch {
    return null;
  }
}

/** 取流前把落盘信息捞出来；路径缺失说明这个 Asset 不是落盘的媒体。 */
/**
 * base64 → Buffer。容忍 `data:image/png;base64,` 前缀 —— 有些网关把整个 data URL 塞进 b64_json。
 *
 * 2026-09-23 从 `lib/providers/image2/client.ts` 搬到这里：那一档整条删了，
 * 而自定义接口出图（`/api/projects/[id]/custom-image`）还要用它落盘。
 */
export function base64ToBuffer(value: string): Buffer {
  const text = value.includes(',') && value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  return Buffer.from(text, 'base64');
}

export async function openMediaAsset(assetId: string, userId: string) {
  /* 音频、文本也走这条取流路由（`/media.{ext}`），所以类型白名单里要有它们（文本是 `.txt`）。 */
  const asset = await db.asset.findFirst({ where: { id: assetId, userId, type: { in: ['video', 'image', 'audio', 'text'] } } });
  if (!asset) throw new Error('媒体不存在或无权访问。');
  const meta = (asset.metadata || {}) as { path?: string; mime?: string };
  if (!meta.path) throw new Error('该媒体未落盘。');
  /*
   * `turbopackIgnore` 注释是给构建器看的，不是给人看的注释 —— 少了它，Turbopack 看到
   * 「用一个变量当路径去 stat」时会**保守地把整个项目目录 trace 进 standalone 产物**：
   * 源码、pnpm store（近 500MB）、甚至 `storage/` 里落盘的用户资产全都被复制进去。
   * 而这里的路径是**运行时才存在的落盘文件**，构建期根本不存在，也不需要被 trace。
   * 桌面版打包时这一条直接决定产物是 700MB 还是 100MB 量级。
   */
  /* 路径可能是上一个数据目录名留下的 → 按相对结构找回当前那一份（见 `resolveStoredPath`） */
  const file = await resolveStoredPath(meta.path);
  const info = await stat(/*turbopackIgnore: true*/ file);
  return { path: file, mime: meta.mime || 'application/octet-stream', size: info.size, name: asset.name };
}
