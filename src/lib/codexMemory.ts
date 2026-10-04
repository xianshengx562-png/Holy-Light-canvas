'use client';

/**
 * 「上次给 Codex 选的哪个模型」（2026-10-05 徐先：「可以切换 codex 使用的模型」）。
 *
 * 为什么放 localStorage 而不是库里：这是**这台机器上我上次怎么选的**，属于个人手感
 * （和 `upscaleMemory.ts` 那份同一性质），不是画布 / 项目的数据；换台机器重来一遍也没关系，
 * 为此跑一趟服务端存一张表不值。
 *
 * ⚠️ 这里存的只是「**下次启动时我的意图**」。真正生效的那一份握在主进程的内存里，
 * 而界面上显示的是 codex 自己回报的（`thread/settings/updated`）。三方各管一段：
 * 把这里的值当成「当前在用哪个」的真理，迟早和 codex 那边对不上 —— 比如模型下线了、
 * 或者用户在别处换了。
 */
const KEY = 'frame-codex-model';

/** 没记过返回空串（调用方据此「什么都不做」）。 */
export function readCodexModel(): string {
  try {
    return String(localStorage.getItem(KEY) || '').trim();
  } catch {
    /* 读不到（隐私模式 / 手改坏了）就当没记过，绝不因此把 Codex 那一栏弄崩。 */
    return '';
  }
}

/** 切换**成功之后**才记 —— 失败的那个不算「我在用的」。 */
export function rememberCodexModel(modelId: unknown): void {
  const id = String(modelId ?? '').trim();
  if (!id) return;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* 写不进去就不记：下次回到 codex 的默认，总比因为存储失败把整件事做崩强。 */
  }
}
