/**
 * 出图之后的三个动作：保存到相册 / 复制链接 / 分享。
 *
 * ## 保存到相册为什么要用插件
 *
 * Android 10 之后**不能直接往公共相册目录写文件**（分区存储）：用 `Filesystem` 写出来的
 * 文件躺在「文件管理 → Android/data/…」里，相册里**看不到**。所以保存走
 * `@capacitor-community/media` 的 `savePhoto`，由它用 `MediaStore` 插进相册 ——
 * 验收清单里「保存后相册能找到」就是卡在这一条。
 *
 * 它的 `path` 三种都吃（网址 / base64 data URI / 本地文件路径），所以保存**不先落盘**。
 *
 * ## 网址结果要分享，得先下载
 *
 * 分享要一个本地文件（`Share` 收 uri），所以网址结果这里要先拿到字节：走 `CapacitorHttp`
 * （`responseType: 'blob'` 在原生层返回的就是 base64 字符串），**不能用 fetch + CORS**。
 */
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Media } from '@capacitor-community/media';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { CustomMediaResult } from './providers/generateImage';

export type Outcome = { ok: boolean; message: string };

/** 网址 → base64。失败时把上游的样子说出来（403 / 404 都可能是图已过期）。 */
async function downloadBase64(url: string): Promise<string> {
  if (!Capacitor.isNativePlatform()) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`);
    const blob = await response.blob();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('下载图片失败：读不出来。'));
      reader.readAsDataURL(blob);
    });
  }
  const response = await CapacitorHttp.request({
    url,
    method: 'GET',
    responseType: 'blob',
    connectTimeout: 60,
    readTimeout: 60,
  });
  if (response.status < 200 || response.status > 299) {
    throw new Error(`下载图片失败：HTTP ${response.status}`);
  }
  const data = response.data;
  if (typeof data !== 'string' || !data) throw new Error('下载图片失败：拿到的不是图片数据。');
  return data.includes(',') && data.startsWith('data:') ? data.split(',')[1] : data;
}

/** 结果 → base64（本来就是 base64 就直接返回）。 */
async function base64Of(result: CustomMediaResult): Promise<string> {
  if (result.b64) {
    return result.b64.startsWith('data:') ? result.b64.split(',')[1] : result.b64;
  }
  if (!result.url) throw new Error('这个结果里既没有图片数据也没有网址，没法保存。');
  return downloadBase64(result.url);
}

/** 相册里的文件名（Android 这一档**不要带扩展名**，插件自己按格式补）。 */
function fileName(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `holy-light-${stamp}`;
}

/**
 * 找到（或建出）目标相册，返回 identifier。
 *
 * 🔴 Android 上 `savePhoto` **必须带 albumIdentifier**，缺了直接报
 * "Album identifier required"（2026-10-13 实测）。相册固定叫「Holy Light画布」，
 * 图多了他在相册里一眼能找到；每次先查清单，没有才建。
 */
const ALBUM_NAME = 'Holy Light画布';

async function ensureAlbum(): Promise<string | null> {
  try {
    const existing = await Media.getAlbums();
    const hit = existing.albums?.find(album => album.name === ALBUM_NAME);
    if (hit?.identifier) return hit.identifier;
    await Media.createAlbum({ name: ALBUM_NAME });
    const after = await Media.getAlbums();
    const created = after.albums?.find(album => album.name === ALBUM_NAME);
    return created?.identifier ?? null;
  } catch {
    /* 拿不到相册就让 savePhoto 自己报缺 identifier 的错，比静默丢图好。 */
    return null;
  }
}

export async function saveToGallery(result: CustomMediaResult): Promise<Outcome> {
  try {
    /*
     * `Media.savePhoto` 的 `path` 三种都吃：网址、base64（data URI）、本地文件路径。
     * 所以**不在这里先落盘** —— 网址让它自己下载，base64 直接塞进去，
     * 由它用 MediaStore 插进相册。少一步就少一处失败点。
     */
    const path = result.b64
      ? result.b64.startsWith('data:')
        ? result.b64
        : `data:image/png;base64,${result.b64}`
      : result.url || '';
    if (!path) return { ok: false, message: '这个结果里既没有图片数据也没有网址，没法保存。' };

    if (Capacitor.isNativePlatform()) {
      const albumIdentifier = await ensureAlbum();
      await Media.savePhoto({
        path,
        fileName: fileName(),
        ...(albumIdentifier ? { albumIdentifier } : {}),
      });
      return { ok: true, message: '已存入相册（Holy Light画布）。' };
    }
    /* 浏览器里（调试用）没有 MediaStore，退回到下载 + 落盘。 */
    const data = await base64Of(result);
    const written = await Filesystem.writeFile({
      path: `${fileName()}.png`,
      data,
      directory: Directory.Documents,
      recursive: true,
    });
    return { ok: true, message: `浏览器环境：已写到 ${written.uri}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 先落盘再走系统分享面板 —— 直接分享网址的话，很多 App 收到的是一条链接而不是一张图。 */
export async function shareImage(result: CustomMediaResult): Promise<Outcome> {
  try {
    const data = await base64Of(result);
    const written = await Filesystem.writeFile({
      path: `${fileName()}.png`,
      data,
      directory: Directory.Cache,
      recursive: true,
    });
    await Share.share({ url: written.uri, title: '分享这张图' });
    return { ok: true, message: '已打开分享面板。' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    /* 用户自己取消分享不算失败（原生层会抛 "Share canceled"）。 */
    if (/cancel/i.test(message)) return { ok: true, message: '' };
    return { ok: false, message };
  }
}

/**
 * 复制图片网址。
 *
 * 没用 `@capacitor/clipboard`：少一个原生插件就少一处要配权限的地方，
 * 而复制文本这件事 WebView 的 `navigator.clipboard` 加 `execCommand` 兜底够用了。
 */
export async function copyText(text: string): Promise<Outcome> {
  if (!text) return { ok: false, message: '这个结果没有网址（接口直接给的是图片数据）。' };
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true, message: '网址已复制。' };
    }
    /* 兜底：file:// 下 `navigator.clipboard` 常常是 undefined。 */
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const done = document.execCommand('copy');
    document.body.removeChild(area);
    return done
      ? { ok: true, message: '网址已复制。' }
      : { ok: false, message: '复制失败 —— 长按上面那行网址手动复制。' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
