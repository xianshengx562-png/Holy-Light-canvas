'use client';

/**
 * 「上一次超清用过的那份工作流」—— 导入素材那一档「跟随」的兜底（2026-10-04 徐先）。
 *
 * 「超清工作流引擎跟随连接的节点；如果没有，默认使用上一次超清的工作流」
 *
 * 为什么放在 localStorage 而不是库里：这是**这台机器上我上次怎么选的**，属于个人手感，
 * 和「我摆顺手的那几种站位」（`src/lib/directorPresets.ts`）同一性质，不是画布 / 项目的数据。
 * 换台机器重来一遍也没关系，但为此跑一趟服务端存一张表就不值了。
 *
 * 按用途分开记（图 / 视频）：一份图超清工作流喂不了视频，串了只会跑出废片，
 * 而且是**跑了才知道** —— 所以宁可不共用一个值。
 */
const KEY = 'frame-upscale-last';

type Purpose = 'image' | 'video';
type Memory = Partial<Record<Purpose, string>>;

function purposeOf(value: unknown): Purpose {
  return String(value ?? '') === 'video' ? 'video' : 'image';
}

function read(): Memory {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || 'null');
    return parsed && typeof parsed === 'object' ? (parsed as Memory) : {};
  } catch {
    /* 读不到（隐私模式 / 手改坏了）就当没记过，绝不因此崩掉画布。 */
    return {};
  }
}

/** 没记过返回空串 —— 调用方据此回落「候选里最近改过的那份」。 */
export function readLastUpscaleWorkflow(purpose: unknown): string {
  const value = read()[purposeOf(purpose)];
  return typeof value === 'string' ? value : '';
}

/** 超清**提交成功之后**才记 —— 提交失败的那一份不算「用过的」。 */
export function rememberLastUpscaleWorkflow(purpose: unknown, workflowId: unknown): void {
  const id = String(workflowId ?? '').trim();
  if (!id) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), [purposeOf(purpose)]: id }));
  } catch {
    /* 写不进去就不记：下次回到「最近改过的那份」，总比因为存储失败把整件事做崩强。 */
  }
}
