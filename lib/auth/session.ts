import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { isDesktop } from '@/lib/edition';
export const sessionCookie = 'frame_session';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/*
 * 桌面版**没有登录这一步**。
 *
 * 它装在你自己机器上、数据库也是软件自带的那一份，打开就要先注册一个账号纯粹是噪音 ——
 * 而「免登录」在这里不是偷工减料：桌面版根本没有多用户（`HOLYLIGHT_EDITION=desktop` 下这台机器
 * 就是这一个使用者），账号的存在只是为了复用数据模型里那个 `userId`（画布、资产、任务都挂在它下面）。
 *
 * 所以固定以「本机用户」身份运行：第一次用到时懒创建，之后一直复用那一行。
 * 写进 `currentUser()` 而不是在页面里各自兜一层，是因为鉴权只有这一个入口 ——
 * 放在这里，任何 `requireUser()` 的地方都自动是登录态，不用挨个改。
 */
const DESKTOP_USER_EMAIL = 'local@frame.desktop';
/** 默认昵称（徐先 2026-09-26：「用户没有修改时默认名称是用户1」）。 */
const DESKTOP_USER_NAME = '用户1';
/*
 * 2026-09-26 之前的默认名。
 *
 * **它只说明「这一行是自动建的、用户从没改过名」** —— 所以见到它就顺手升成新的默认名。
 * 用户自己起过名字的（在 `/user` 改过档案）一律不动，名字不是我们说了算。
 * 只在**恰好等于**这个旧默认值时才触发，不做任何批量改名。
 */
const LEGACY_DESKTOP_USER_NAME = '本机用户';
const USER_SELECT = { id: true, email: true, name: true, avatar: true };

async function desktopUser() {
  /*
   * ⚠️ 构建期一律返回 null，**不要连库**。
   *
   * Next 在 `next build` 时会把能静态化的页面预渲染一遍。云端版天然安全：
   * 构建期没有 cookie → `currentUser()` 返回 null → `requireUser()` 重定向到登录页 →
   * 页面被判成动态、跳过预渲染。而桌面版「永远有用户」，于是构建机会一路渲染下去，
   * 真的去连**开发机上的那个库**读数据，甚至把「本机用户」这一行写进去 ——
   * 构建产物里还会带上开发库的内容。
   *
   * 返回 null 正是要复用上面那条天然行为：重定向 → 动态渲染 → 构建期不碰库。
   * `NEXT_PHASE` 只在构建进程里是这个值，运行时是 `phase-production-server`，不受影响。
   */
  if (process.env.NEXT_PHASE === 'phase-production-build') return null;

  const found = await db.user.findUnique({ where: { email: DESKTOP_USER_EMAIL }, select: USER_SELECT });
  if (found) {
    /* 没改过名的（还停在旧默认值）补一次新默认名。改不动就算了 —— 这只是个显示用的名字，
       不值得因为它把整个会话弄成 500（那才是「打开就是登录界面」那条路）。 */
    if (found.name !== LEGACY_DESKTOP_USER_NAME) return found;
    const renamed = await db.user
      .update({ where: { id: found.id }, data: { name: DESKTOP_USER_NAME }, select: USER_SELECT })
      .catch(() => null);
    return renamed ?? found;
  }
  try {
    const created = await db.user.create({
      data: { email: DESKTOP_USER_EMAIL, name: DESKTOP_USER_NAME, passwordHash: '' },
      select: USER_SELECT,
    });
    /* 钱包那张表不是 User 的一部分，注册流程里会顺手建；桌面版不走注册，所以在这里补上，
       免得万一哪里读余额时因为「没有这一行」而炸（桌面版不扣费，但读得到 0 比报错好）。 */
    await db.wallet.upsert({ where: { userId: created.id }, create: { userId: created.id, balance: 0 }, update: {} });
    return created;
  } catch (error) {
    /* 首次启动会有好几个请求同时打进来，撞唯一索引是常态 —— 撞了就再查一次，那行已经有了。 */
    const again = await db.user.findUnique({ where: { email: DESKTOP_USER_EMAIL }, select: USER_SELECT });
    if (again) return again;
    throw error;
  }
}

/**
 * 桌面版把会话令牌放在这个请求头里 —— **因为它没有 cookie 可用**。
 *
 * `app://` 是自定义协议，Chromium 不为它存任何 cookie：
 * 页面里 `document.cookie = 'a=1'` 写完立刻读是空串，CDP 的 `Network.setCookie` 直接回
 * "URL must have scheme http or https"。所以「登录 → 浏览器记住 → 下次请求自动带上」
 * 这条路在桌面版根本不存在（2026-09-25 实测：库里 Session 建好了、浏览器里一个 cookie 都没有，
 * 表现就是「注册成功，刷新一下又变回本机用户」）。
 *
 * 于是桌面版改成**显式令牌**：登录接口把 token 当场回给前端，前端存 localStorage，
 * 之后每个请求带这个头（见 `src/lib/client.ts`）。`httpOnly` 那层保护在桌面版没有了，
 * 但换不来也一样没有 —— 桌面版本来就是本机单用户、数据在本机库里。
 *
 * ⚠️ 只在桌面版认这个头：web 版照旧只认 cookie，不额外开一条凭头就能登录的口子。
 */
export const SESSION_HEADER = 'x-frame-session';

/** cookie 优先（web 版只有它），桌面版回落到请求头。长度 64 是 token 的固定形状。 */
async function sessionToken(): Promise<string | null> {
  const fromCookie = (await cookies()).get(sessionCookie)?.value;
  if (fromCookie && fromCookie.length === 64) return fromCookie;
  if (!isDesktop) return null;
  const fromHeader = (await headers()).get(SESSION_HEADER);
  return fromHeader && fromHeader.trim().length === 64 ? fromHeader.trim() : null;
}

export async function currentUser() {
  /*
   * ⚠️ 桌面版**必须仍然读一次 cookie**，这不是多余的代码。
   *
   * Next 靠「渲染时有没有用到 cookie 这类动态 API」来决定一个页面能不能在构建期预渲染。
   * 桌面版直接走 `desktopUser()`，全程不碰 `cookies()`，于是 `/assets`、`/settings/*`
   * 这些页面被判成**可静态化**；而构建期 `desktopUser()` 按规定返回 null（见上面那条注释），
   * `requireUser()` 当场 `redirect('/login')` —— 于是「重定向到登录页」被**烤进静态产物**，
   * 运行时无论有没有用户，这些页面永远 307（实测：构建输出里它们标着 ○ Static）。
   *
   * 读一次 cookie 就把它们重新判成动态页面，构建期不再预渲染，运行时才去查本机用户。
   * 归零代价：桌面版本来也不看 cookie 的值。
   *
   * 2026-09-25 起桌面版**允许登录**（徐先要「能退出换账号」）：有会话就按那个账号走，
   * 没有会话才回落到「本机用户」—— 免登录仍然是默认，不登录一切照旧。
   */
  const token = await sessionToken();
  const found = token && token.length === 64
    ? await db.session.findUnique({
      where: { tokenHash: digest(token) },
      include: { user: { select: USER_SELECT } },
    })
    : null;
  if (found && found.expiresAt > new Date()) return found.user;
  if (isDesktop) return desktopUser();
  return null;
}

/**
 * 「现在是不是真登录着」。
 *
 * 桌面版默认没有会话（那样它就是本机用户），但仍然**可以**登录 ——
 * 界面要靠这个字段决定显示「退出登录」还是「登录其他账号」，
 * 不能靠 `currentUser()` 有没有返回东西来判断（桌面版两种情况下都有用户）。
 */
export async function sessionState(): Promise<{ hasSession: boolean; local: boolean; email: string | null }> {
  const token = await sessionToken();
  const none = { hasSession: false, local: isDesktop, email: null as string | null };
  if (!token || token.length !== 64) return none;
  const found = await db.session.findUnique({
    where: { tokenHash: digest(token) },
    include: { user: { select: { email: true } } },
  });
  if (!found || found.expiresAt <= new Date()) return none;
  return { hasSession: true, local: false, email: found.user.email };
}

export async function requireUser() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}
/**
 * 建一次会话。返回**明文 token**：桌面版没有 cookie 可写，路由必须把它当场交给前端
 * （`server/api/auth/login|register` 的桌面分支就靠这个返回值）。web 版忽略返回值。
 */
export async function createSession(userId: string, options: { remember?: boolean } = {}): Promise<string> {
  await destroySession();
  /*
   * 「记住我」只决定 cookie 的寿命，不决定服务端那一行的寿命。
   *  - 勾了：cookie 带 expires，关掉浏览器再打开仍是登录态。
   *  - 不勾：cookie 不带 expires，浏览器按「会话 cookie」处理，关掉浏览器即失效。
   * 两种情况服务端都保留 7 天：token 只存在于那个 cookie 里，拿不到 cookie 就换不出会话，
   * 所以把服务端寿命也压到「关浏览器即失效」既换不来更多安全，又会让一直开着标签页的人莫名掉线。
   */
  const remember = options.remember === true;
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 86400_000);
  await pruneExpiredSessions();
  await db.session.create({ data: { userId, tokenHash: digest(token), expiresAt } });
  (await cookies()).set(sessionCookie, token, {
    httpOnly: true,
    /* ⚠️ 桌面版没有 cookie 这一层（`app://` 下 Chromium 不存，见 SESSION_HEADER 那条注释），
       所以这里写不写都对结果没影响；`!isDesktop` 只是让 web 版的行为一个字不变。 */
    secure: !isDesktop && process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    ...(remember ? { expires: expiresAt } : {}),
  });
  return token;
}

/** Drop rows that can no longer authenticate anything. Cheap thanks to `@@index([expiresAt])`. */
export async function pruneExpiredSessions() {
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
export async function destroySession() {
  const token = await sessionToken();
  if (token) await db.session.deleteMany({ where: { tokenHash: digest(token) } });
  (await cookies()).delete(sessionCookie);
}
