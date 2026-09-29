/**
 * 连中转站失败时，**该说哪一句**（2026-09-29）。
 *
 * ## 它修的是什么
 *
 * 我们对一个站点是「挨个路径试探」的：登录先试 `/api/user/login`，
 * 不行再试 `/api/auth/login`、`/api/login`。这个写法本身没错 ——
 * new-api / one-api 各版本挂的路径不一样，试是唯一稳妥的做法。
 *
 * 坏在**失败之后该说哪一句**。以前是「拿最后一条流水账」：
 *
 *   1. `POST /api/user/login`  → 200 + `success:false`「用户名或密码错误」
 *   2. `POST /api/auth/login`  → 404（这个版本没这条路径）
 *   3. `POST /api/login`       → 404
 *
 * 最后一条是 404，于是界面上写着「登录 …/api/login → HTTP 404」。
 * 用户照着这个去查，只能得出「这软件连错地址了 / 这功能坏了」——
 * 而真正的原因（**密码错了**）在第一条里，被后面两条 404 冲掉了。
 * 用户报回来就是「登录会失败，还会 404」，两件事听着像两个 bug，其实是同一个。
 *
 * ## 这里的规矩
 *
 * - **404 = 这条路不存在**，换下一条就是了，**但它不是原因**；
 * - **429 = 你打太快了**，站点没说你不对，只是让你等一会儿 —— 更要单独说清楚
 *   （站点那边是「同一 IP、20 次 / 20 分钟」，撞上了什么都不成功，看着就像坏了）；
 * - **站点明说了原因**（`success:false` + message、401、403）→ **立刻停下**，
 *   它就是原因。继续试下去只会把它冲掉。
 * - 最后要给用户看的那句，按「有用程度」挑，不是按「先后顺序」挑。
 *
 * ⚠️ 这个模块**不能** import `server-only` 的东西（渲染进程与回归脚本都要加载它）；
 *    数据库那一层在 `lib/providers/site.ts`，那边才 `import 'server-only'`。
 */

export type SiteStepKind =
  /** 站点明说了原因：密码错、人机校验没过、这个操作不允许。最有用，见到就该停下。 */
  | 'rejected'
  /** 429：站点说你打得太频繁。不是你不对，是让你等一会儿。 */
  | 'rate-limited'
  /** 401 / 403：登录态不对（JWT 过期、这把令牌不是你的）。也该停下。 */
  | 'unauthorized'
  /** 回的是网页 / 不是 JSON —— 站点地址多半填成了后台首页。 */
  | 'bad-shape'
  /** 连不上 / 超时。**这一类才值得再试一次**（网络抖一下很常见）。 */
  | 'unreachable'
  /** 404：这条路径在这个站点上不存在。**换下一条**，但它不是失败的原因。 */
  | 'not-found'
  /** 这一跳成了。 */
  | 'ok';

export type SiteStep = {
  kind: SiteStepKind;
  /** 这一跳在干什么（「登录」「账号信息」「令牌清单」「取完整密钥」）。 */
  what: string;
  /** 试的那个地址（不含域名前缀也行，只用于「哪些路径不存在」那句话）。 */
  path: string;
  /** 站点说的话 / 连不上的原因。**空串表示这一跳没说出原因。 */
  detail: string;
};

/** 挑那句话时的优先顺序：越靠前越该说。 */
const RANK: SiteStepKind[] = ['rejected', 'rate-limited', 'unauthorized', 'bad-shape', 'unreachable', 'not-found'];

/**
 * 这一跳失败了，还要不要**继续试下一个候选路径**。
 *
 * 只有「这条路不存在」「连不上」「回的不是接口」这三种才值得再试；
 * 站点已经明说了原因（或登录态不对、或让你慢点）时再试，就是把真话冲掉 ——
 * 正是要修的那个毛病。
 */
export function shouldTryNextPath(step: SiteStep): boolean {
  return step.kind === 'not-found' || step.kind === 'unreachable' || step.kind === 'bad-shape';
}

/**
 * 网络抖了一下（连不上 / 超时）→ **同一个地址再试一次**。
 *
 * ⚠️ 只重试这一类：业务上被拒绝（密码错）、401、404、429 都不重试 ——
 *    再问一百次还是同一个答案，白白拖慢界面，还把站点那点限流额度吃光。
 *    这里重试的是「**根本没拿到响应**」，那种情况重来一次常常就好了。
 */
export function shouldRetryStep(kind: SiteStepKind): boolean {
  return kind === 'unreachable';
}

/** 重试等多久（`failedTimes` 从 1 开始）。**返回 null = 不再试了**。 */
export function retryDelayMs(failedTimes: number): number | null {
  if (failedTimes === 1) return 600;
  if (failedTimes === 2) return 2000;
  return null;
}

/* ---------------- 撞上限流之后，我们自己先歇一会儿 ---------------- */

/**
 * 站点说了「慢点」之后，我们自己也真的歇这么久。
 *
 * 不歇的后果是**自己把自己按在限流里出不来**：界面上刚跟用户说了「等两三分钟」，
 * 余额那边却还每 2 分钟去刷一趟。站点是「同一 IP、20 次 / 20 分钟」的额度，
 * 光余额这一项就够吃光 —— 于是余额永远读不到、永远显示上一次的老数字，
 * 用户看着是「余额不刷新了」，真因却是我们没听自己刚说过的话。
 */
export const RATE_LIMIT_COOLDOWN_MS = 3 * 60 * 1000;

/** 自动轮询最多等多久。冷却时间算错了（时钟跳变）也不至于睡死过去。 */
export const MAX_POLL_DELAY_MS = 10 * 60 * 1000;

/** 这一串尝试里撞上了限流 → 歇到什么时候（epoch ms）；没撞上 → null。 */
export function rateLimitCooldownUntil(
  steps: SiteStep[] | null | undefined,
  now: number,
  cooldownMs: number = RATE_LIMIT_COOLDOWN_MS,
): number | null {
  const hit = (steps || []).find((item) => item && item.kind === 'rate-limited');
  return hit ? now + cooldownMs : null;
}

/**
 * 下一次**自动**轮询该等多久。
 *
 * 冷却没到 → 一直等到冷却结束（不再按固定间隔去撞）；冷却过了 → 回到固定间隔。
 * ⚠️ 只管自动轮询：用户自己点「刷新」不算 —— 那是他明说要问一次，冷却拦不住。
 */
export function nextPollDelayMs(baseMs: number, cooldownUntil: number | null, now: number): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  if (cooldownUntil === null || !Number.isFinite(cooldownUntil)) return baseMs;
  const wait = cooldownUntil - now;
  return wait > baseMs ? Math.min(wait, MAX_POLL_DELAY_MS) : baseMs;
}

/** 「有哪些路径不存在」那句话。404 本身不是原因，得翻译成人能动手改的事。 */
function notFoundMessage(steps: SiteStep[]): string {
  /* 去重：同一个地址试了 POST 又试 GET，列两遍只会让人以为自己看错了。 */
  const paths: string[] = [];
  for (const item of steps) {
    if (item.path && !paths.includes(item.path)) paths.push(item.path);
  }
  const listed = paths.length ? `（${paths.slice(0, 3).join('、')}）` : '';
  /*
   * 只试过一个地址时（典型是「取完整密钥」：POST 与 GET 是同一个地址），
   * **不能**说成「地址填错了」—— 地址多半是对的，是这个站点没开放这一条接口。
   * 说成地址错了，用户会去改一个本来正确的站点地址，越改越远。
   */
  if (paths.length <= 1) {
    return `${steps[0].what}：这个地址站点上说是「不存在」${listed} —— ` +
      '站点可能改版了；要是别的都好好用，多半是这一条接口它没开放。';
  }
  return `${steps[0].what}：这些地址站点上都说是「不存在」${listed} —— ` +
    '站点地址填域名就行（比如 https://www.myvigna.top），别带 /v1 之类的后缀。';
}

/**
 * 429 那句。它跟「你填错了」完全是两回事，必须单独说。
 *
 * 站点常常自己也带一句话（「请求太频繁，请稍后再试。」）—— 那就**两个都要**：
 * 先原样转述它说的（那是现场），再补上「等两三分钟」这个**具体多久**。
 * 只转述站点那句的话，用户不知道要等多久；只说我们这句的话，又丢了站点的原话。
 */
function rateLimitedMessage(steps: SiteStep[]): string {
  const said = (steps.find((item) => item.detail && item.detail.trim()) || {}).detail || '';
  const head = said
    ? `${steps[0].what}：${said}`
    : `${steps[0].what}：站点说你请求太频繁了（一般是同一 IP 一段时间内的次数上限）`;
  return `${head} —— 等两三分钟再试。这段时间里余额可能不会自己变，那是限流，不是坏了。`;
}

/**
 * 从一堆尝试里挑一句**最有用**的给用户。
 *
 * 挑法按 `RANK`（有用程度），**不是**按先后顺序：
 * 站点说过的话 > 被限流 > 登录态问题 > 地址看着不对 > 连不上 > 路径不存在。
 *
 * `fallback` 用在一句都没说出来的时候（比如每一跳都是网络错误且没有 detail）。
 */
export function pickFailureReason(steps: SiteStep[], fallback: string): string {
  for (const kind of RANK) {
    const hits = (steps || []).filter((item) => item && item.kind === kind);
    if (!hits.length) continue;
    if (kind === 'not-found') return notFoundMessage(hits);
    if (kind === 'rate-limited') return rateLimitedMessage(hits);
    const hit = hits.find((item) => item.detail && item.detail.trim()) || hits[0];
    const detail = hit.detail ? `：${hit.detail}` : '';
    return `${hit.what}${detail}`;
  }
  return fallback;
}

/**
 * 把一次 HTTP 结果归成一类。
 *
 * 顺序不能乱：
 * - 连不上 / 超时最优先：压根没拿到响应，状态码和 body 都没有参考价值；
 * - 回了网页 / 不是 JSON：地址多半填成了后台首页，这也压过状态码；
 * - **429 压过 body 里的 message**：限流的回包常常也是 `success:false`
 *   （new-api 就是 429 + 「请求太频繁，请稍后再试。」）。照「你填错了」报出去，
 *   用户会去改一个根本没问题的密码 —— 429 说的是「等一会儿」，不是「你不对」；
 * - 剩下的 `success:false` 才是站点**明说**的原因（密码错、人机校验没过）；
 * - 401 / 403 说的是「登录态」，也不是「这条路不通」；
 * - 404 说的是「这条路不通」，恰恰最不该当成原因。
 */
export function classifyStep(input: {
  ok: boolean;
  status: number;
  /** 站点在 body 里明说的失败原因（`success:false` 的那种）。 */
  businessMessage?: string | null;
  /** 回的是不是网页。 */
  html?: boolean;
  /** 是不是压根没拿到响应（连不上 / 超时）。 */
  network?: boolean;
  /** 响应体不是 JSON。 */
  notJson?: boolean;
}): SiteStepKind {
  if (input.network) return 'unreachable';
  if (input.html || input.notJson) return 'bad-shape';
  if (input.status === 429) return 'rate-limited';
  if (input.businessMessage) return 'rejected';
  if (input.status === 401 || input.status === 403) return 'unauthorized';
  if (input.status === 404) return 'not-found';
  if (!input.ok) return 'rejected';
  return 'ok';
}
