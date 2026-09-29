/**
 * 提交幂等闸（2026-09-29）。
 *
 * 修的是「同一个节点被提交两次，扣两笔积分」：
 *   1. 两个窗口各点一次生成；
 *   2. 「一键运行」与手动点撞在一起；
 *   3. 手抖双击 —— 界面上那个 `disabled` 挡得住按钮，挡不住这些路。
 *
 * 而 `idempotencyKey` 里带着 `Date.now()`，所以「重试不重复扣」那句注释其实是**假的**：
 * 两笔提交的 key 必然不同，账本去重永远命中不了。
 *
 * 做法是**时间窗**，不是「参数指纹」：
 *   - 同一个节点在 60 秒内已经有在跑的任务 → 把那一条交回去，不建新任务、不扣第二次；
 *   - 窗口之外照旧出新任务 —— 用户「再跑一次」是正当需求，不能永久去重
 *     （按参数指纹去重会让「同参数再来一张」变成白嫖，那才是真 bug）。
 *
 * 纯函数：不碰数据库，好单测。
 */

/** 同一个节点的重复提交窗口。60 秒足够盖住「双击 / 两个窗口」，又短到不会挡住真要重跑的人。 */
export const DUPLICATE_WINDOW_MS = 60 * 1000;

/**
 * 「这个刚建出来的任务算不算重复提交」。
 *
 * ⚠️ 脏数据一律判**不算**：起点为 0 / NaN、`now` 为 NaN、窗口非法时返回 false ——
 * 宁可多放行一次（最坏是重复扣一次，有退款兜底），也不要因为一个坏时间戳
 * 把用户的正常提交悄悄吞掉（那种失败界面上一句话都没有）。
 */
export function isDuplicateSubmit(
  createdAtMs: number,
  nowMs: number,
  windowMs: number = DUPLICATE_WINDOW_MS,
): boolean {
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) return false;
  if (createdAtMs <= 0 || nowMs <= 0) return false;
  const span = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DUPLICATE_WINDOW_MS;
  const elapsed = nowMs - createdAtMs;
  /** 起点在未来（`elapsed < 0`）：时钟跳变，别拿它当重复。 */
  return elapsed >= 0 && elapsed < span;
}
