'use client';

/*
 * 把**一份资产拖到别的软件里**（2026-10-09 徐先：「生成结果也能拖到别的软件」）。
 *
 * 三处要用同一套：资产卡片、资产灯箱、画布右上角「生成结果」那一栏。
 * 放在这里共享，而不是每处抄一遍 —— 各写一份的话，「路径还没取回来时该说哪句」
 * 这种细节迟早说成三种，而拖拽这种事偏偏又全是细节。
 *
 * 🔴 真正的那一手在主进程：`ipcMain.on('start-drag')` → `event.sender.startDrag({ file, icon })`。
 *    这里的职责只有两条：**提前拿到本机路径**、**拦掉浏览器自己那次拖拽**。
 */

import { useCallback, useRef } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { startDragFilePath } from './desktop-fs';

/**
 * 从资产地址里挖出资产 id。**不是本机那份（RunningHub 的远程链接）返回 `null`**。
 *
 * 只有这一种形状认得出来：`/api/assets/<id>/<file>`（取流 / 下载 / 文本都是这个前缀）。
 * 认不出的就不给拖 —— 那种结果没有本机文件，硬要拖只会让人以为自己拖出去了、
 * 结果粘进去的是一串地址。
 */
const ASSET_URL_RE = /\/api\/assets\/([^/?#]+)\//;

export function assetIdFromUrl(url: string): string | null {
  const hit = ASSET_URL_RE.exec(String(url || ''));
  return hit ? hit[1] : null;
}

/**
 * 这条资产在**本机磁盘上的绝对路径**。
 *
 * 单开一条接口按需取，不放进列表：列表一页六十行，每行都要摸一次盘才算出这个字段，
 * 而它只在**按下去（或拖起来）才会用到**的那一刻才需要（见 `/api/assets/[id]/path`）。
 */
export async function localPathOfAsset(id: string): Promise<string> {
  const res = await fetch(`/api/assets/${id}/path`);
  if (res.status === 404) throw new Error('这个文件已经不在磁盘上了。');
  if (!res.ok) throw new Error(`取文件位置失败（${res.status}）。`);
  const body = (await res.json().catch(() => null)) as { path?: unknown } | null;
  const file = String(body?.path || '');
  if (!file) throw new Error('没拿到文件位置。');
  return file;
}

/**
 * 拖拽那一套：`onPointerDown` 里调 `prefetch`、`onDragStart` 里调 `beginDrag`。
 *
 * 🔴 拖拽**没有**「先等一下再拖」的余地：`dragstart` 那一刻必须已经把路径交给主进程
 *    （见 preload 里 `startDrag` 那段，晚一步用户的拖拽会话就结束了）。
 *    所以路径只能在**按下鼠标**时就开始取 —— 人到真正拖起来中间那几十~几百毫秒，
 *    足够本地那条接口跑完。
 *
 * @param notice 拖不动 / 还没准备好时说一句话的出口（各处的提示长在不同地方，
 *               所以由调用方决定这句话往哪儿放）。
 */
export function useAssetFileDrag(notice: (text: string) => void) {
  /** id → 本机路径。取过一次就不再问（同一个面板里会来回拖同一条）。 */
  const cache = useRef<Record<string, string>>({});
  /**
   * 正在取的那几个。
   *
   * 没有这一层的话，「冷拖一下（没取到，顺手发起一次）+ 立刻按下鼠标」就是**两趟一模一样
   * 的请求**（真机实测过：同一个 id 发了两次 `/api/assets/<id>/path`）。
   * 请求本身虽然幂等，但它会让人以为「这条路走不通所以在重试」。
   */
  const inflight = useRef<Record<string, true>>({});

  /** 提前把路径取回来（鼠标一按下就叫）。失败就静默 —— 拖的时候再说。 */
  const prefetch = useCallback((id: string) => {
    if (!id || cache.current[id] || inflight.current[id]) return;
    inflight.current[id] = true;
    void localPathOfAsset(id)
      .then(file => { cache.current[id] = file; })
      .catch(() => {})
      /* 失败了要把位置让出来 —— 否则这一次没取到，之后永远不再试。 */
      .finally(() => { delete inflight.current[id]; });
  }, []);

  /**
   * 开始往外拖。
   *
   * 🔴 一定要 `preventDefault()`：不拦的话 Chromium 会自己起一次 HTML5 拖拽，
   *    落到目标软件里的是一张「图片」或一坨文本，**不是那个文件**；
   *    而且它跟主进程那次 `startDrag` 会打架，表现就是「拖过去的东西不对/拖不动」。
   *
   * 路径还没取回来时也照拦 —— 宁可这次拖不动（并说一句），
   * 也不要让用户以为自己拖出去了、结果粘进去的是别的什么东西。
   */
  const beginDrag = useCallback((event: ReactDragEvent, id: string) => {
    event.preventDefault();
    const file = cache.current[id];
    if (!file) {
      prefetch(id);
      notice('正在取这个文件的位置，稍等一下再拖。');
      return;
    }
    if (!startDragFilePath(file)) notice('这一版没法把文件拖出去（只有桌面版可以）。');
  }, [notice, prefetch]);

  return { prefetch, beginDrag };
}
