import fs from 'node:fs';
import path from 'node:path';
import { runtimePaths } from '@/lib/runtime-paths';

/** 两个槽位各一张图：`canvas` 是画布底下那张，`site` 是整站背景那张。 */
export type WallpaperSlot = 'canvas' | 'site';

/**
 * 画布背景图的落盘与读取（只有主进程做得到这件事）。
 *
 * 为什么要经过主进程，而不是让渲染进程把图转成 dataURL 存 localStorage：
 *   1. **额度**：localStorage 通常只有 5MB，一张 2MB 的图转成 dataURL 就是 2.7MB，
 *      两张就写不进去；而且每次读偏好都要解析这一大坨字符串。
 *   2. **崩溃面**：写偏好失败是**静默**的（超出额度会抛 QuotaExceededError，
 *      但很多地方会 catch 掉），用户会以为「传了但没生效」。
 *   3. 图片本来就该跟其它产出一样落在数据目录里，这样备份 / 迁移 / 换机都跟着走。
 *
 * 目录：`<dataDir>/wallpaper.<ext>`。**一个用户一张图**，替换时把旧后缀的清掉，
 * 免得残留一张永远读不到的图占着几十 MB。
 */

/** 只认这几种：都是浏览器原生能画、体积也合理的格式。 */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** 扩展名反查 MIME，用于把图喂给渲染进程时给对 content-type。 */
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function baseName(slot: WallpaperSlot = 'canvas'): string {
  return path.join(runtimePaths().dataDir, slot === 'site' ? 'wallpaper-site' : 'wallpaper');
}

/** 找出当前存在的那张背景图（不带扩展名的路径 + 实际文件路径）。 */
function current(slot: WallpaperSlot = 'canvas'): { file: string; ext: string } | null {
  const base = baseName(slot);
  for (const ext of Object.values(EXT_BY_MIME)) {
    const file = `${base}${ext}`;
    if (fs.existsSync(file)) return { file, ext };
  }
  return null;
}

export function mimeFor(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 保存一张背景图，返回文件名（`wallpaper.png` 这种，只给渲染进程一个**不透明**的标识）。
 *
 * 写的是渲染进程传来的原始字节：主进程**不重新编码**图片 —— 转码要么拖一个
 * 图像库进来，要么在渲染进程里用 canvas 重画（那会把 PNG 的透明通道和色彩精度
 * 一起拍平，用户传什么得到什么才对）。
 */
export function saveWallpaper(data: Uint8Array, mime: string, slot: WallpaperSlot = 'canvas'): string {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new Error(`不支持的图片格式：${mime || '未知'}`);
  const dir = runtimePaths().dataDir;
  fs.mkdirSync(dir, { recursive: true });
  const target = `${baseName(slot)}${ext}`;
  /*
   * 先写临时文件再 rename：这张图可能有十几 MB，直接覆盖写一半断电会留下一个
   * 半截的 PNG —— 浏览器解它的时候不会报错，只会画出一片空白，而且用户不知道
   * 是自己的图坏了还是软件坏了。
   */
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
  /* 换格式时把旧后缀那份清掉，不然会永远留着一张读不到的图 */
  for (const other of Object.values(EXT_BY_MIME)) {
    if (other === ext) continue;
    const stale = `${baseName(slot)}${other}`;
    if (fs.existsSync(stale)) {
      try {
        fs.unlinkSync(stale);
      } catch {
        /* 删不掉就算了，读的时候只认先命中的那个 */
      }
    }
  }
  return path.basename(target);
}

/** 读当前背景图的字节。没有图就返回 null。 */
export function readWallpaper(slot: WallpaperSlot = 'canvas'): { data: Buffer; mime: string } | null {
  const found = current(slot);
  if (!found) return null;
  try {
    return { data: fs.readFileSync(found.file), mime: mimeFor(found.file) };
  } catch {
    return null;
  }
}

/** 删掉当前背景图。 */
export function removeWallpaper(slot: WallpaperSlot = 'canvas'): void {
  const found = current(slot);
  if (!found) return;
  try {
    fs.unlinkSync(found.file);
  } catch {
    /* 删不掉就让它在，界面上已经当作「没有图」了 */
  }
}
