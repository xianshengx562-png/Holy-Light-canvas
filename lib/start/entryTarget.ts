/**
 * 首页创作入口卡片的**落点解析** —— 外加「空库时点画布要现场建一个项目」那条规则的名字。
 *
 * 为什么单独一份：`lib/start/entries.ts` 是一份**纯数据**（它不许引 React，几处都在读它），
 * 而「画布」这个入口的落点**不是常量** —— 它是 `/projects/<项目 id>`，
 * 得看着「当前有什么项目」才能定。把这段判断塞进数据文件会把纯数据变成带分支的模块，
 * 塞进组件又会让「加一个入口要改哪里」多出一处。
 *
 * ## 为什么画布不能写死 `href: '/'`（2026-09-19 的事故）
 *
 * 那张卡片本身就长在首页，而首页就是 `/`。于是 `href: '/'` 等于**导航到当前页**：
 * `location.hash` 一个字符都不变 → `hashchange` 不触发 → 组件不重挂 → 界面纹丝不动。
 * `Link` 那层还会 `preventDefault()` 掉默认跳转，所以连一次「整页刷新」都不会发生。
 * 用户看到的是「点了没反应」，而这**不是**权限、也不是画布坏了 ——
 * 地址确实是能进的，只是没人把它送过去。
 *
 * ## 三种落点
 *
 * - **有项目** → 最近那个的画布（`/projects/<id>`）。用「最近」是因为首页那块列表本来就是
 *   按最近更新排的，卡片落在第一个上，用户看到的顺序和点下去的结果是一致的。
 * - **一个项目都没有** → `create-canvas`：**点了先建一个再进去**
 *   （2026-09-26 徐先：「点击画布自动创建项目并进入」）。
 *   原来这一支是回 `/` —— 也就是上面那次事故的形状：卡片照旧显示「进入 →」、
 *   照旧是能点的样子，点下去什么都不发生。空库恰恰是**第一次打开这个应用的人**看到的画面，
 *   第一下就点不动，等于「这东西是坏的」。
 * - **这一刻定不下来**（列表还没回来 / 没登录）→ `none`：渲染成**不可点**的卡片。
 *
 * ⚠️ 顺序有讲究：**先确认「有账号 + 列表真的回来了」，再谈「空不空」**。
 * 反过来写（先看 `projectIds.length === 0`）会在冷启动那一瞬把「还没取到」当成「一个都没有」，
 * 于是每点一下画布就凭空多出一个项目。这个窗口不窄：`/api/auth/me` 在慢机器上要 1.3 秒
 * （`src/lib/client.ts` 里 `_probe-session-flash.js` 那段实测）。
 */
import type { StartEntry } from './entries';

/** 只认「当前有哪些项目」这一个外部事实，其余全在纯函数里。 */
export type EntryContext = {
  /** `GET /api/projects` 的结果，按最近更新在前；没登录 / 还没拿到时给空数组。 */
  projectIds: readonly string[];
  /**
   * 列表**到底回来了没有**。
   * 🔴 挂起中的空数组不是事实 —— 拿它去判「空库」会凭空建项目，见文件头那段。
   */
  ready: boolean;
  /** 有账号才谈得上「替他建一个项目」。桌面版恒为 true（固定本机用户，没有未登录这一态）。 */
  signedIn: boolean;
  isDesktop: boolean;
};

/** 一条入口这一刻的可去之处。 */
export type EntryTarget =
  /** 有落点：渲染成链接（`<a href>`）。 */
  | { kind: 'href'; href: string }
  /** 点了**先建一个项目**再进去（空库时的画布入口）。渲染方要接一个 onClick，不能只给 href。 */
  | { kind: 'create-canvas' }
  /** 这一刻没有可去的地方：渲染成**不可点**的卡片，别把它当链接发出去（发出去就是又一次「点了没反应」）。 */
  | { kind: 'none' };

/**
 * 解析一条入口的落点。
 *
 * `dynamic` 的条目（目前只有画布）`href` 是空串 —— 它的落点只能现算，别去读那个字段。
 */
export function resolveEntryTarget(entry: StartEntry, context: EntryContext): EntryTarget {
  if (!entry.dynamic) return entry.href ? { kind: 'href', href: entry.href } : { kind: 'none' };
  /*
   * 画布这一条。桌面版没有「未登录」这一态，所以 `signedIn` 在桌面版恒为 true ——
   * 这里不去碰 `/login`（那会把用户送到「登录网站」的死胡同，见 `src/app/page.tsx` 那段）。
   */
  if (!context.signedIn || !context.ready) return { kind: 'none' };
  const recent = context.projectIds[0];
  if (recent) return { kind: 'href', href: `/projects/${recent}` };
  return { kind: 'create-canvas' };
}

/**
 * 空库时自动建的那个项目叫什么。
 *
 * 用**本机时间**命名（`画布 09-26 20:05`）而不是「未命名画布」：用户还没来得及给它起名，
 * 而项目列表要靠名字区分谁是谁 —— 一屏「未命名画布 ×5」等于没有名字。
 * 时间是他唯一能对上号的信息，也是他之后去改名的线索。
 *
 * 固定两位补零、只拼数字，不走 `toLocaleString()`：那个在不同机器 / 时区设置下给的串长短不一
 * （有的带「上午」「PM」），而这个名字要在**项目名**里出现，不该被系统区域设置改样子。
 *
 * 传 `now` 只是为了单测能钉住输出，正常调用不传。
 */
export function autoCanvasProjectName(now: Date = new Date()): string {
  const t = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `画布 ${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
