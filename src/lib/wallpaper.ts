/**
 * 画布背景图的「选 + 校验 + 上传」。
 *
 * 校验放在渲染进程是有原因的：**只有这里解过这张图**，知道它的真实宽高。
 * 主进程拿到的是一串字节，量像素就得再解一次图（还得拖一个图像库进来）。
 * 但主进程那边会**再校验一遍**体积与格式 —— 它才是真正落盘的那一头，
 * 只信调用方传什么就写什么太危险。
 */
import { WALLPAPER_LIMITS } from '@/lib/appearance';

/**
 * 背景图有**两个槽位**：`canvas` 是无限画布底下那张，`site` 是整站（首页 / 设置 / 列表）那张。
 * 一个用户一个槽位一张图 —— 两边各自能换、互不覆盖（画布要压得住节点，整站要压得住正文，
 * 同一张图同时满足两种要求的概率不高）。
 */
export type WallpaperSlot = 'canvas' | 'site';

type WallpaperApi = {
  pickFile?: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  saveWallpaper?: (
    payload: { bytes: ArrayBuffer; mime: string; width: number; height: number; slot?: WallpaperSlot },
  ) => Promise<{ ok: true; name: string } | { ok: false; message: string }>;
  removeWallpaper?: (slot?: WallpaperSlot) => Promise<{ ok: boolean; message?: string }>;
};

function api(): WallpaperApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { api?: WallpaperApi }).api ?? null;
}

/** 量一张图的真实尺寸。解不出来就是「这不是一张能用的图」，必须拦住。 */
async function measure(file: File): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('解不开这张图'));
      el.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 选一张本机图片并交给主进程落盘。
 *
 * 用 `pickFile`（系统文件框）而不是 `<input type=file>`：桌面版里两者都能用，
 * 但 `pickFile` 能把后缀白名单交给系统去过滤 —— 用户在那个框里**选不到**别的类型，
 * 比选完了再弹一句「格式不对」体验好，也少一条「为什么这个文件选不了」的支线。
 */
export async function pickWallpaperFile(
  slot: WallpaperSlot = 'canvas',
): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const bridge = api();
  if (!bridge?.pickFile || !bridge.saveWallpaper) {
    return { ok: false, message: '只有桌面版能设置画布背景图。' };
  }
  const path = await bridge.pickFile({
    title: slot === 'site' ? '选择界面背景图' : '选择画布背景图',
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  });
  if (!path) return { ok: false, message: '没有选择文件。' };

  /*
   * ⚠️ 这里拿到的是**绝对路径**，但浏览器里没有 `fetch(file://)` 这条路
   * （`app://` 协议下更不行）。所以读取必须走主进程 —— 由它把文件读成字节传回来。
   * 于是「选文件」这一步其实只用到了路径，真正的字节在主进程侧读。
   */
  const loaded = await loadBytes(path);
  if (!loaded.ok) return loaded;

  const file = new File([loaded.bytes], path.split(/[\\/]/).pop() || 'wallpaper', { type: loaded.mime });
  const tooBig = file.size > WALLPAPER_LIMITS.maxBytes;
  if (tooBig) {
    return { ok: false, message: `图片 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过 20 MB 上限。` };
  }
  const size = await measure(file);
  if (!size) return { ok: false, message: '解不开这张图，请换一张 JPG / PNG / WebP。' };
  if (size.width * size.height > WALLPAPER_LIMITS.maxPixels) {
    return {
      ok: false,
      message: `图片 ${size.width}×${size.height}（约 ${Math.round((size.width * size.height) / 10_000)} 万像素）超过 3200 万上限，请先缩小。`,
    };
  }

  const saved = await bridge.saveWallpaper({
    bytes: loaded.bytes,
    mime: loaded.mime,
    width: size.width,
    height: size.height,
    slot,
  });
  return saved.ok ? { ok: true, name: saved.name } : saved;
}

/**
 * 把本机文件读成字节。
 *
 * 走 `app://app/local-file?path=...`（主进程那条协议里拦下来），**不是**直接 fetch
 * 一个 `file://` 地址 —— Electron 里 `file://` 能不能取取决于 webSecurity 与是否
 * 允许本地文件访问，改了那个开关等于把整个渲染进程的隔离都放松了。
 * 让主进程读、并且只读它自己校验过的路径，面小得多。
 */
async function loadBytes(
  path: string,
): Promise<{ ok: true; bytes: ArrayBuffer; mime: string } | { ok: false; message: string }> {
  try {
    const res = await fetch(`app://app/local-file?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, message: detail || `读不到这个文件（${res.status}）。` };
    }
    const mime = res.headers.get('content-type') || 'application/octet-stream';
    if (!WALLPAPER_LIMITS.mimes.includes(mime)) {
      return { ok: false, message: `只支持 JPG、PNG、WebP，这张是「${mime}」。` };
    }
    return { ok: true, bytes: await res.arrayBuffer(), mime };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '读取图片失败。' };
  }
}

export async function removeWallpaperFile(slot: WallpaperSlot = 'canvas'): Promise<{ ok: boolean; message?: string }> {
  const bridge = api();
  if (!bridge?.removeWallpaper) return { ok: false, message: '只有桌面版能移除背景图。' };
  try {
    return await bridge.removeWallpaper(slot);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '移除失败。' };
  }
}

/** 当前有没有背景图可用（web 版没有这条通道，界面上就不该显示那一段）。 */
export function canSetWallpaper(): boolean {
  return Boolean(api()?.saveWallpaper);
}
