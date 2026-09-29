/**
 * 「把这张画布交给 WorkBuddy」（**只有桌面版有**）。
 *
 * 与 `desktop-codex.ts` 的区别：Codex 是**嵌在这个应用里**跑的 agent（主进程握着一个
 * 长命子进程、流式收事件）；WorkBuddy 是**另一个应用**，这里只负责「把要做的事交代过去」——
 * 提示词进剪贴板 + 唤起它。之后在 WorkBuddy 里说话，它靠同一份 frame-mcp 改这张画布。
 *
 * web 版没有 `workbuddyLaunch` 这个字段，所以组件那边一律先问 `workbuddyAvailable()`，
 * 拿不到就当「这版不支持」，入口不显示 —— 不要让它变成一个点了没反应的按钮。
 */

type DesktopWorkbuddyApi = {
  workbuddyLaunch?: (payload: {
    projectId: string;
    projectName: string;
    /** 输入框里已经写好的那句话；空的话只交代「改哪张画布」。 */
    ask?: string;
  }) => Promise<{ ok: boolean; message: string; copied: boolean }>;
};

function workbuddyApi(): DesktopWorkbuddyApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { api?: DesktopWorkbuddyApi }).api;
  return api?.workbuddyLaunch ? api : null;
}

/** 这一版能不能把画布交给 WorkBuddy。 */
export function workbuddyAvailable(): boolean {
  return workbuddyApi() !== null;
}

/**
 * 交出去。返回一句**给人看**的结果 —— 成功也好、没唤起也好，调用方都原样显示。
 *
 * ⚠️ 这里不吞异常：主进程那条通道可能整个不存在（旧版桌面端），
 *    那时候给出「只有桌面版能…」比静默失败强。
 */
export async function workbuddyLaunch(payload: {
  projectId: string;
  projectName: string;
  ask?: string;
}): Promise<{ ok: boolean; message: string }> {
  const api = workbuddyApi();
  if (!api?.workbuddyLaunch) return { ok: false, message: '这一版没有「交给 WorkBuddy」这条通道（只有桌面版有）。' };
  try {
    return await api.workbuddyLaunch(payload);
  } catch (error) {
    return { ok: false, message: `没能交给 WorkBuddy：${error instanceof Error ? error.message : String(error)}` };
  }
}
