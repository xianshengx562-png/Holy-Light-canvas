/*
 * 已导入的创作预设（2026-10-07）—— 渲染进程这一侧的读与刷新。
 *
 * 数据是主进程的（`<dataDir>/creative-presets/`），渲染进程只能通过 IPC 拿。
 * 而面板可能在一次会话里被打开很多次，**每次开都拉一遍 3946 条**没必要 ——
 * 所以这里存一份缓存，导入 / 删组之后显式 `refresh()`，别处只读缓存。
 *
 * 🔴 为什么不用 `useApi`（那套 `/api/*` 订阅）：导入清单**不在后端进程里**，
 * 它在主进程的数据目录里。走后端要给它新开一条路由、还要在后端里再算一遍数据目录 ——
 * 而主进程那边已经算好了（见 `electron/main/preset-import.ts` 为什么走 IPC 的说明）。
 *
 * 🔴 所有读失败一律当「没有」：导入的预设是**可选内容**，
 * 它读不出来最多是「面板里没有那一组」，绝不该让预设面板整个打不开。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  canImportPresets,
  presetImportList,
  presetImport as runImport,
  presetImportRemove as runRemove,
  type ImportedPresetView,
  type PresetImportRunResult,
} from './desktop-fs';
import { normalizePreset, type CreativePreset } from '@/components/canvas/creativePresets';

export type ImportedGroupView = {
  id: string;
  name: string;
  source: string;
  importedAt: string;
  count: number;
};

type Snapshot = { groups: ImportedGroupView[]; presets: CreativePreset[] };

const EMPTY: Snapshot = { groups: [], presets: [] };

let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** 拉一份新清单（覆盖缓存）。并发调用共用同一次请求 —— 面板开着时不会重复拉。 */
export function refreshImportedPresets(): Promise<Snapshot> {
  if (inflight) return inflight;
  inflight = presetImportList()
    .then(manifest => {
      /*
       * 🔴 一律过 `normalizePreset`：清单是**磁盘上的 JSON**，可能被手改过 / 是老版本写的。
       * 形状不对的那几条悄悄丢掉 —— 一条坏预设不该让整个面板崩，
       * 用户要的是「那几条不见了，我再导一次」，不是一屏报错。
       */
      const presets = manifest.presets
        .map(item => normalizePreset(item))
        .filter((item): item is CreativePreset => Boolean(item));
      cache = { groups: manifest.groups, presets };
      return cache;
    })
    .catch(() => EMPTY)
    .finally(() => {
      inflight = null;
      notify();
    });
  return inflight;
}

/** 面板用：订阅已导入的预设。第一次挂上时自动拉一次。 */
export function useImportedPresets(): Snapshot & { loading: boolean } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick(n => n + 1);
    listeners.add(listener);
    if (!cache) void refreshImportedPresets();
    return () => { listeners.delete(listener); };
  }, []);
  return useMemo(
    () => ({ ...(cache ?? EMPTY), loading: !cache }),
    /* `tick` 只是「缓存变了」的信号，真正的取值来自 `cache`。 */
    [tick], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** 能不能导入（web 版没有主进程，那个入口不该显示）。 */
export function canImport(): boolean {
  return canImportPresets();
}

/** 导入一批。成功后**刷新缓存** —— 否则界面上看不到刚导进来的那一组。 */
export async function importPresetBatch(payload: {
  dir?: string; files?: string[]; category: string;
}): Promise<PresetImportRunResult> {
  const result = await runImport(payload);
  if (result.ok) await refreshImportedPresets();
  return result;
}

/** 删掉一组。同样刷新缓存 —— 卡片要立刻消失，不能等下次开面板。 */
export async function removePresetGroup(groupId: string): Promise<{ ok: boolean; message: string }> {
  const result = await runRemove(groupId);
  if (result.ok) await refreshImportedPresets();
  return result;
}

export type { ImportedPresetView };
