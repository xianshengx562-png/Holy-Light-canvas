/*
 * D站标签的「收藏」（2026-10-09，徐先：「可以每个选项都有收藏功能」）。
 *
 * 每一档（角色 / 服装 / 姿势 / 环境 / 镜头 / 效果 / 表情 / 画师 / 自定义分类）
 * 的每一行都能标星；收藏的排在该档最前面，另有「只看收藏」开关。
 *
 * 存的地方与 `danbooru-categories.json` 一个待遇 —— **用户数据**，不在 asar 里：
 *
 *     <dataDir>/danbooru-favorites.json
 *
 * 🔴 为什么是**用户级**而不是跟节点存：收藏说的是「这个人常用哪几条」，
 *    换了项目、换了画布，常用的还是那几条 —— 存进节点数据就等于每个节点重标一遍。
 *
 * 🔴 为什么走主进程：渲染进程没有 `node:fs`（同 `danbooru-cats.ts` 那段理由）。
 *
 * 🔴 只存 **id 清单**，不存整条内容：内置清单是随包的、会随版本增删，
 *    把整条标签串抄一份进来的话，官方改了拼写这里是改不掉的，而且「收藏了什么」
 *    会跟列表里实际显示的对不上。
 */

import fs from 'node:fs';
import path from 'node:path';
import { runtimePaths } from '@/lib/runtime-paths';

/**
 * 键是「桶」，值是这一桶里收藏了哪些 id。
 *
 * 桶名 = 面板那一档的键（`character` / `clothing` / `pose` / `background` /
 * `shot` / `effect` / `expression` / `artist`）；自定义分类是 `custom:<分类 id>` ——
 * 分类可以删、可以改名，但同一个条目 id 在两个分类里出现时不该互相串。
 */
export type FavoriteFile = {
  version: 1;
  favs: Record<string, string[]>;
};

/** 一个桶最多存多少 —— 有人会整档全标上，那样这份文件会拖慢每次启动的读取。 */
const MAX_PER_BUCKET = 2000;

export function favoritesPath(): string {
  return path.join(runtimePaths().dataDir, 'danbooru-favorites.json');
}

function emptyFile(): FavoriteFile {
  return { version: 1, favs: {} };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把读进来的东西修成合法形状。
 *
 * 🔴 桶名**只留安全字符**：这份文件将来可能被人手改，也可能被别的东西写进来，
 *    键里带个 `"` 或换行不会让 JSON 坏掉，但会让后面拼 key 的地方出怪事。
 */
function normalize(raw: unknown): FavoriteFile {
  if (!raw || typeof raw !== 'object') return emptyFile();
  const src = raw as Record<string, unknown>;
  const favs: Record<string, string[]> = {};
  const source = src.favs && typeof src.favs === 'object' ? (src.favs as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(source)) {
    const bucket = str(key).slice(0, 120);
    if (!/^[A-Za-z0-9_:.\-]+$/.test(bucket)) continue;
    if (!Array.isArray(value)) continue;
    const ids: string[] = [];
    for (const item of value) {
      const id = str(item).slice(0, 200);
      if (id && !ids.includes(id)) ids.push(id);
      if (ids.length >= MAX_PER_BUCKET) break;
    }
    if (ids.length) favs[bucket] = ids;
  }
  return { version: 1, favs };
}

/**
 * 读。**读不出来一律当「还没收藏过」** —— 文件被手删 / 写坏 / 第一次用，同一个结果，
 * 而收藏丢了不致命（只是列表不再把那几条排前面，标签本身还在）。
 */
export function readFavorites(): FavoriteFile {
  try {
    const raw = fs.readFileSync(favoritesPath(), 'utf8');
    return normalize(JSON.parse(raw));
  } catch {
    return emptyFile();
  }
}

/**
 * 写。三档兜底与 `danbooru-cats.ts` 的 `writeCustomCategories()` 一模一样，理由也一样：
 * 改名会被杀软 / 索引器拦一下，走到那一步时用户的点击已经在内存里生效了 ——
 * 为一次 rename 把整趟作废，用户看到的是「收藏失败」却不知道其实已经生效。
 */
export function writeFavorites(next: FavoriteFile): { ok: boolean; message: string } {
  const target = favoritesPath();
  const body = JSON.stringify({ version: 1, favs: next.favs }, null, 2);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch {
    /* 目录已经在了 —— 建不出来下面写盘会报，那时再回话。 */
  }
  const tmp = target + '.tmp';
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, message: '' };
  } catch {
    /* 落到下面：直接写。 */
  }
  try {
    fs.writeFileSync(target, body, 'utf8');
    return { ok: true, message: '' };
  } catch {
    /* 再落一档：先删掉旧的再建一个新的。 */
  }
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.writeFileSync(target, body, 'utf8');
    return { ok: true, message: '' };
  } catch (e) {
    return { ok: false, message: '收藏存不进去：' + String((e as Error)?.message || e) };
  }
}
