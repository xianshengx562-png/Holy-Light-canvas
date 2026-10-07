/*
 * 创作预设的收藏（2026-10-06，从 AIFISHER 迁移）—— 只存本机。
 *
 * 🔴 为什么**不进画布 JSON**：收藏是个人习惯，不是画布内容。存进工程文件的话，
 * 把画布发给别人会连「我喜欢哪几条预设」一起带过去 —— 那是给别人看的工作文件里
 * 最不该出现的东西。AIFISHER 也是这么划的（它存服务端，界面上写着「收藏只存在本机账号」）。
 *
 * 🔴 为什么**不走接口**：就一串 id，几十字节。为它加一条后端路由、加一次落库、
 * 再加一层「读失败怎么办」，代价远大于收益。`localStorage` 在桌面版里是跟着
 * userData 走的，卸载重装才会丢 —— 对「收藏」这件事来说是够的。
 *
 * 所有读写都包在 try 里：隐私模式 / 存储写满 / 用户手动清了都能让这几句抛异常，
 * 而「收藏没存上」绝不该让对话框崩掉 —— 收藏是可选的便利，不是关键路径。
 */

const KEY = 'holylight.creativePresetFavorites';

export function readPresetFavorites(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    /* 只留字符串、去重、去掉空串 —— 手改过 / 老版本写的都能被这一层收拾掉。 */
    return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && !!item.trim()))];
  } catch {
    return [];
  }
}

export function writePresetFavorites(ids: string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* 写不进去就算了：这一次点星标界面上仍然会变，只是重启之后不记得。 */
  }
}
