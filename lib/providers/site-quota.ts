/*
 * 站点额度换算（2026-09-28 从 `site.ts` 分出来）。
 *
 * 单独成文件只有一个理由：这一段是**纯函数**（不碰数据库、不 import electron / next），
 * 可以单独编成 CJS 跑断言（`FRAME\_test-site-quota.py`）。
 * 「界面上的余额和网站上不一样」这种毛病，看界面是怎么也看不出是这里写错的。
 *
 * 🔴 new-api 的额度语义（对着 v1.0.0-rc.40 的 `model/user.go` 核过）：
 *
 *   - `quota`      = **还剩多少**（充值 `+`、消费 `-`）
 *   - `used_quota` = **累计花了多少**（只增不减）
 *
 *   一次消费在站点那边是**两笔分开的账**：`DecreaseUserQuota` 减 `quota`、
 *   `UpdateUserUsedQuota` 加 `used_quota`。所以 `quota` 已经是剩下的了 ——
 *
 *   🔴 **「剩余」就是 `quota`，不要再减一次 `used_quota`**。
 *      减第二次＝把花掉的钱扣两遍：界面上比网站上少 `used_quota` 那么多，
 *      用久了甚至直接掉到 ¥0（2026-09-28 修的就是这个）。
 */

/**
 * 1 元 = 500000 quota。
 *
 * 这个值不是猜的：站点 `GET /api/status` 的 `quota_per_unit`（myvigna.top 实测 500000，
 * 且 `display_in_currency=true` / `quota_display_type=CNY`）。
 * 站点把汇率改了的话，改这里 —— 想自动跟，就得每趟多打一次 `/api/status`，
 * 而那边有「同一 IP 20 次 / 20 分钟」的限流，为这个值不值得。
 */
export const QUOTA_PER_YUAN = 500_000;

/** quota → 元。站点没给这个数（`null`）或给了非数字，就回 `null`（界面上不显示）。 */
export function quotaToYuan(quota: number | null, quotaPerYuan: number = QUOTA_PER_YUAN): number | null {
  if (quota === null || !Number.isFinite(quota)) return null;
  if (!Number.isFinite(quotaPerYuan) || quotaPerYuan <= 0) return null;
  return quota / quotaPerYuan;
}

/**
 * 「网站上看到的余额」是多少钱。
 *
 * `usedQuota` 也收进来，是**故意的**：把「剩余不该减已用」这条规则摆进签名里，
 * 谁想再减一次就得先绕开这个函数，而绕开时注释就在头顶上。
 */
export function remainingYuanOf(
  quota: number | null,
  usedQuota: number | null,
  quotaPerYuan: number = QUOTA_PER_YUAN,
): number | null {
  void usedQuota; // 只是账本流水，不参与「还剩多少」（见文件头）。
  return quotaToYuan(quota, quotaPerYuan);
}
