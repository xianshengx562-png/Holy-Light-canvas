/**
 * 手机端**站点请求**的守门（2026-10-13）。
 *
 * ## 为什么手机端也要有这一层
 *
 * 桌面端那份在 `lib/providers/site-guard.ts`，但**手机是直连站点的**（`providers/site.ts`
 * 走 `CapacitorHttp` 自己发），根本不经过后端 —— 所以桌面那套守门**整条管不到它**。
 *
 * 而手机这一侧的花销比桌面大得多：
 *
 *   一趟「登录 + 自动开通」= 登录最多 3 条候选路径
 *                        + 列令牌 1 + 建令牌 1 + 再列一次 1 + 取完整密钥 2 + 拉模型 1
 *                        ≈ **9 次请求**
 *
 * 站点那条限流是「同一 IP、20 次 / 20 分钟」。按钮点两下就是 18 次，一轮见底。
 *
 * ## 三条规矩
 *
 *  1. **冷却**：上一次失败之后，一段时间里干脆不打站点，直接把上次那句原因回给界面。
 *  2. **并发去重**：同一个动作只允许一趟在飞 —— 手机上连点两下太常见了。
 *  3. 🔴 **只对「重试也不会变」的失败冷却**：
 *     429（限流）、连不上、超时 → 冷却；
 *     401 / 密码错 / 验证码不对 → **不冷却**。那是用户该改输入的情况，
 *     锁他 60 秒只会让人以为 App 坏了。
 *
 * ⚠️ 这一层只管 `/api/*`（站点管理面）。生图走 `/v1/*`，用的是令牌表里那把 key，
 *    不产生会话、也不吃这条限流 —— 别顺手把出图也拦了。
 */

/** 撞限流（429）后的冷却。站点那条线是 20 次 / 20 分钟，等久一点才划算。 */
export const RATE_LIMIT_COOLDOWN_MS = 120_000;

/** 连不上 / 超时后的冷却。网络抖一下而已，锁太久反而碍事。 */
export const UNREACHABLE_COOLDOWN_MS = 30_000;

type Block = { until: number; why: string };

let block: Block = { until: 0, why: '' };
const inflight = new Map<string, Promise<unknown>>();

/** 现在是不是在冷却里。是就回一句能直接显示给人看的话。 */
export function checkGuard(now = Date.now()): { message: string } | null {
  if (now >= block.until) return null;
  const left = Math.ceil((block.until - now) / 1000);
  return { message: `${block.why}（${left} 秒内先不打扰站点，等一下再点。）` };
}

/**
 * 记一次失败。
 *
 * 🔴 哪些该冷却、哪些不该，见文件头第 3 条。
 *
 * `status` 传 **`null`** = 只知道一句话、不知道状态码 → **只看那句话里有没有
 * 「限流 / 连不上」字样**，不靠状态码猜。
 * 🔴 别图省事传 `0`：`0` 在这套代码里是「连不上」的意思，会把「站点不让建令牌」
 *    这类业务拒绝也当成网络问题锁上 30 秒 —— 而那正是用户换个账号就能重试的情况。
 */
export function noteFailure(note: string, status: number | null, now = Date.now()): void {
  const text = note || '';
  const rateLimited = status === 429 || /限流|too many|频繁|rate limit/i.test(text);
  const unreachable = status === 0 || /连不上|超时|timed out|timeout/i.test(text);
  if (!rateLimited && !unreachable) return;
  block = {
    until: now + (rateLimited ? RATE_LIMIT_COOLDOWN_MS : UNREACHABLE_COOLDOWN_MS),
    why: rateLimited ? '站点刚才说我们问得太频繁' : '上一次连站点没连上',
  };
}

/** 成了就把冷却清掉 —— 不然一次抖动会白锁住后面本来能成的请求。 */
export function clearFailure(): void {
  block = { until: 0, why: '' };
}

/** 界面上想显示「还要等多久」时用（测试里也靠它读状态）。 */
export function blockedUntil(): number {
  return block.until;
}

/**
 * 同一个动作只允许一趟在飞，后来者复用它的结果。
 *
 * `key` 按动作给（`login` / `register` / `provision` / `code`），别按 URL 给 ——
 * 登录那三条候选路径是同一个动作的三种写法，不该被当成三件事各打一趟。
 */
export async function withSiteGuard<T>(key: string, run: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const task = (async () => {
    try {
      return await run();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}
