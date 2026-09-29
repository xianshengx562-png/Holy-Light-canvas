/**
 * 画布里的 Codex 对话（**只有桌面版有**）。
 *
 * 和 `desktop-browser.ts` 同构：走 preload 的 `window.api.codex*`，web 版没这些字段，
 * 组件直接调就行，拿不到就当「不支持」。
 *
 * 需要单独说明的一点：**这里不碰 stdio，也不缓存会话**。
 * codex 进程握在主进程，会话（thread）也活在那里 —— 页面刷新、侧栏关掉再打开，
 * 会话都还在。渲染层只负责「发一句话、收一段流、画出来」，
 * 一旦自己缓存一份，两边迟早会对不上（比如主进程那边已经换了新会话）。
 */

export type CodexStatus = {
  phase: 'off' | 'starting' | 'ready' | 'error';
  message: string;
  version: string | null;
  account: { type: string; email: string | null; planType: string | null } | null;
  requiresAuth: boolean;
  model: string | null;
  mcp: { name: string; tools: number; status: string; error: string | null }[];
  busy: boolean;
  threadId: string | null;
  codexPath: string | null;
};

/**
 * 一次调用挂着的那个技能（SKILL 社区里选的）。
 *
 * 只带**路径**，不带正文：技能正文动辄几万字符，还带着一整个 references 目录，
 * 塞进 IPC 再塞进 codex 的 prompt 里等于把上下文烧掉一半。
 * 正确的用法是让 Codex 自己按路径去读 —— 它本来就是个能翻文件的 agent，
 * 而且技能里点名了「哪些参考按需读」，只有它自己知道这一轮该读哪几份。
 */
export type CodexSkill = {
  /** `official:closed-drama`。日志与排错用。 */
  id: string;
  title: string;
  /** 技能目录的绝对路径。 */
  dir: string;
  /** 目录里的文件清单（相对路径），让 Codex 知道手上有哪些资料。 */
  files: string[];
};

export type CodexItemView = {
  id: string;
  type: string;
  server?: string;
  tool?: string;
  status?: string;
  arguments?: string;
  result?: string;
  error?: string | null;
};

export type CodexEvent =
  | { kind: 'status'; status: CodexStatus }
  | { kind: 'message'; itemId: string; text: string }
  | { kind: 'reasoning'; itemId: string; text: string }
  | { kind: 'item'; phase: 'started' | 'completed'; item: CodexItemView }
  | { kind: 'turn'; state: 'started' | 'completed' | 'failed'; error: string | null }
  | { kind: 'canvas' }
  | { kind: 'error'; message: string };

type DesktopCodexApi = {
  codexStatus?: () => Promise<CodexStatus>;
  codexStart?: () => Promise<CodexStatus>;
  codexStop?: () => Promise<CodexStatus>;
  codexSend?: (payload: { text: string; projectId: string; projectName: string; skill?: CodexSkill | null }) => Promise<{ ok: boolean; message: string }>;
  codexInterrupt?: () => Promise<{ ok: boolean; message: string }>;
  codexNewThread?: () => Promise<CodexStatus>;
  codexLogin?: () => Promise<{ ok: boolean; message: string }>;
  onCodexEvent?: (listener: (event: CodexEvent) => void) => () => void;
};

function codexApi(): DesktopCodexApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { api?: DesktopCodexApi }).api;
  return api?.codexSend ? api : null;
}

/** 界面上要不要显示「Codex」这个入口（web 版不该显示一个点了没反应的按钮）。 */
export function codexSupported(): boolean {
  return codexApi() !== null;
}

export const OFF_CODEX_STATUS: CodexStatus = {
  phase: 'off',
  message: '还没连接 Codex。',
  version: null,
  account: null,
  requiresAuth: false,
  model: null,
  mcp: [],
  busy: false,
  threadId: null,
  codexPath: null,
};

export async function codexStatus(): Promise<CodexStatus> {
  const api = codexApi();
  if (!api?.codexStatus) return OFF_CODEX_STATUS;
  try {
    return await api.codexStatus();
  } catch {
    return OFF_CODEX_STATUS;
  }
}

/**
 * 连上 Codex（没连过时自动连）。
 *
 * 起进程要几秒，而且**可能失败**（没装 codex / 没登录）—— 失败也要回一个状态，
 * 让界面把「为什么用不了」说出来，而不是让 promise 一路 reject 到控制台。
 */
export async function codexStart(): Promise<CodexStatus> {
  const api = codexApi();
  if (!api?.codexStart) return OFF_CODEX_STATUS;
  try {
    return await api.codexStart();
  } catch {
    return { ...OFF_CODEX_STATUS, phase: 'error', message: '连接 Codex 失败。' };
  }
}

export async function codexStop(): Promise<CodexStatus> {
  const api = codexApi();
  if (!api?.codexStop) return OFF_CODEX_STATUS;
  try {
    return await api.codexStop();
  } catch {
    return OFF_CODEX_STATUS;
  }
}

/** 发一句话。`ok=false` 时 `message` 就是给用户看的原因。 */
export async function codexSend(
  text: string,
  context: { projectId: string; projectName: string; skill?: CodexSkill | null },
): Promise<{ ok: boolean; message: string }> {
  const api = codexApi();
  if (!api?.codexSend) return { ok: false, message: '只有桌面版能用 Codex。' };
  try {
    return await api.codexSend({
      text,
      projectId: context.projectId,
      projectName: context.projectName,
      skill: context.skill ?? null,
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '发给 Codex 失败。' };
  }
}

export async function codexInterrupt(): Promise<void> {
  const api = codexApi();
  if (!api?.codexInterrupt) return;
  try {
    await api.codexInterrupt();
  } catch { /* 中断不了就算了，界面自己会把 busy 解掉 */ }
}

export async function codexNewThread(): Promise<CodexStatus> {
  const api = codexApi();
  if (!api?.codexNewThread) return OFF_CODEX_STATUS;
  try {
    return await api.codexNewThread();
  } catch {
    return OFF_CODEX_STATUS;
  }
}

export async function codexLogin(): Promise<{ ok: boolean; message: string }> {
  const api = codexApi();
  if (!api?.codexLogin) return { ok: false, message: '只有桌面版能登录 Codex。' };
  try {
    return await api.codexLogin();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '打开登录页失败。' };
  }
}

/** 订阅流式事件，返回取消函数。 */
export function onCodexEvent(listener: (event: CodexEvent) => void): () => void {
  const api = codexApi();
  if (!api?.onCodexEvent) return () => {};
  try {
    return api.onCodexEvent(listener);
  } catch {
    return () => {};
  }
}
