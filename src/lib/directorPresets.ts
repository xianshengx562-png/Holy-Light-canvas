'use client';

/*
 * 用户自己存的构图预设 —— 存在 **localStorage**。
 *
 * 为什么不上数据库：这一柜预设是「我摆顺手的那几种站位」，属于个人手感，
 * 跟全站外观偏好（`frame.appearance.*`）、公告已读（`frame.notice.*`）是同一类东西，
 * 换项目也要跟着走。走服务端就得多一张表 + 一条路由 + 一次迁移，
 * 而桌面版本来就是单机单用户 —— 收益抵不上那三样。
 *
 * 三条规矩：
 *
 * 1. **读写都吞异常**：隐私模式下 `localStorage` 直接抛，配额满了也抛。
 *    表现不该是「面板打不开」，而是「这次没存上」。
 * 2. **一律过 `readUserPresets` 夹取**：这份数据跨版本、也可能被人手改，
 *    读回来的每个数都要当成不可信。
 * 3. **同名覆盖**：改一点再存同一个名字 ＝ 更新那条预设（并排到最前）。
 *    否则用户会连着存出「朝堂」「朝堂2」「朝堂3」一串，而他要的只是更新。
 */
import {
  DIRECTOR_USER_PRESET_MAX, readUserPresets,
  type DirectorUserPreset,
} from '@/lib/director';

export const DIRECTOR_PRESET_KEY = 'frame.director.presets';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadUserPresets(): DirectorUserPreset[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(DIRECTOR_PRESET_KEY);
    return raw ? readUserPresets(JSON.parse(raw)) : [];
  } catch {
    /* 存坏了 / 不是 JSON：当成「还没有预设」，别让面板挂在这一步。 */
    return [];
  }
}

export function writeUserPresets(list: DirectorUserPreset[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(DIRECTOR_PRESET_KEY, JSON.stringify(list.slice(0, DIRECTOR_USER_PRESET_MAX)));
  } catch {
    /* 配额满 / 隐私模式：不记就是了。 */
  }
}

/** 存一条（同名覆盖，并排到最前）。返回新列表，调用方负责写盘与 setState。 */
export function putUserPreset(list: DirectorUserPreset[], preset: DirectorUserPreset): DirectorUserPreset[] {
  const rest = list.filter(item => item.label !== preset.label);
  return [preset, ...rest].slice(0, DIRECTOR_USER_PRESET_MAX);
}

export function dropUserPreset(list: DirectorUserPreset[], id: string): DirectorUserPreset[] {
  return list.filter(item => item.id !== id);
}
