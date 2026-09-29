'use client';

/*
 * 主界面（2026-09-17 从 `/dashboard` 挪到这里）。
 *
 * ⚠️ **从服务端组件改成了客户端组件**：原来这一页在服务端 `await currentUser()` /
 * `await listProjects()` 直接读库。桌面版没有服务端渲染这一步（`app://` 下只有静态文件），
 * 数据只能改成渲染进程发 `/api/*` 请求拿。版式与文案一字未改。
 *
 * 版式自上而下是两段（2026-09-21 徐先把 hero 板块整个删了 —— 大标题、副标题、
 * 大输入框 `ComposeBar` 都不再上主页；组件本身留着没删，`?prompt=` 种子链路还认它）：
 *   1. 创作入口卡片（数据在 `lib/start/entries.ts`，加入口只改那一处，**别在这里数它有几张**）；
 *   2. 最近项目，横排卡片。
 *
 * ⚠️ 这一页允许「没有用户」也能渲染：未登录的人也要能看到界面。
 * 真正要动手的动作（建项目 / 开画布 / 发消息）仍然必须登录 —— 接口层照拦。
 *
 * ⚠️ 版式（2026-09-17 下午改）：**左侧导航和页头都不再占布局流**。
 *   - 侧栏 `position: fixed`，收起时整条滑出屏幕；状态存在 `frame.appearance` 的
 *     `navCollapsed` 里（设备级偏好，不进库），由 `<html data-nav>` 驱动 CSS，
 *     所以刷新不会闪一下 —— 挂载前的 `applyAppearance` 已经把它写好了。
 *   - 页头也 `fixed`，浮在 `.content` 之上；它左边那颗按钮就是侧栏的开关。
 *   - 因此 `.content.home` 要自己留够 padding-top（见 home.css），别以为页头还在占位。
 */
import Link from 'next/link';
import { LogIn, Plus } from 'lucide-react';
import SideNav from '@/components/start/SideNav';
/* 软件 logo：`src/lib/logo.ts` 是从 `src/assets/logo.png` 生成的，别手改那个文件。 */
import { LOGO_DATA_URI } from '@/lib/logo';
import LogoutButton from '@/components/LogoutButton';
import UserAvatar from '@/components/UserAvatar';
import SideNavToggle from '@/components/start/SideNavToggle';
import StartEntries from '@/components/start/StartEntries';
import ProjectGrid, { type ProjectCardItem } from '@/components/start/ProjectGrid';
import Starfield from '@/components/start/Starfield';
import { isDesktop } from '@/lib/edition';
import { useApi, useSession } from '@/lib/client';
import '@/app/home.css';

/*
 * 卡片的字段、封面怎么挑、右键菜单（打开 / 重命名 / 删除项目）—— 全在 `ProjectGrid` 里。
 * 这一页只决定「列哪些」和「时间怎么说」（相对时间，一天内的点亮成强调色）。
 * 类型从那边 import 而不是再写一遍：两处各写一份，加了字段就会有一边漏掉。
 */

/**
 * 「最后编辑」说**相对时间**，不说绝对日期。
 *
 * 十五条卡片的日期全都是同一天时，「2026年9月22日」这句话等于没写 ——
 * 而「最近项目」这块要回答的恰恰是「哪个是刚动过的」。超过一个月退回绝对日期：
 * 「43 天前」那种说法已经开始需要用户自己做换算了。
 */
const DAY = 24 * 60 * 60 * 1000;

function relativeTime(value: string) {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(then));
}

/** 一天内动过的：时间那行点亮成强调色，扫一眼就知道最近在忙哪个项目。 */
const isFresh = (value: string) => Date.now() - new Date(value).getTime() < DAY;

export default function Home() {
  const { user } = useSession();
  /*
   * 🔴 游客判据是 `!isDesktop && !user`，不是 `!user`。
   *
   * 桌面版**没有「未登录」这个状态**（`lib/auth/session.ts` 固定一个本机用户），
   * 而 `useSession()` 在桌面版永远给得出用户（接口还没回来时先给本机兜底，见 `src/lib/client.ts`）。
   * 万一兜底那层被绕过，这里也必须挡住：桌面版画不出登录引导 —— 那个按钮点进去是登录**网站**，
   * 对本机无意义（见 `src/app/user` 那段说明），出现了就是个死胡同。
   */
  const guest = !isDesktop && !user;
  const { data: projects, error: projectsError, reload } = useApi<ProjectCardItem[]>(user ? '/api/projects' : null);
  const list = projects ?? [];

  return <div className="shell home-shell">
    <aside className="sidebar" id="home-sidebar">
      <Link className="brand" href="/"><span className="brand-mark">✦</span> Holy Light画布</Link>
      <SideNav active="projects" />
    </aside>
    <section className="workspace">
      {/*
        星空是**固定层**（`position: fixed`）。挂在这里只是因为它需要一个普通块级容器：
        若让它当 `.shell` 的直接子元素，那个两列网格会多出一整行、把整页版式顶歪。
        它本身脱离文档流，不占位、也不影响任何兄弟节点。
      */}
      <Starfield />
      {/*
        账号 / 登录固定在这一页的**右上角**，不再塞在左下角 ——
        这是整页唯一一个「和账号有关」的位置，未登录时它就是进站的第一步。

        桌面版不显示「退出登录」：桌面版根本没有登录这一步（固定一个本机用户），
        点退出什么也不会发生，反而让人以为它坏了。
      */}
      <header className="workspace-header">
        <div className="home-head-main">
          {/* 侧栏的开关。它得待在页头里 —— 侧栏收起后整个没了，按钮不能跟着一起消失。 */}
          <SideNavToggle controlsId="home-sidebar" />
          <div>
            <strong>创作空间</strong>
            <br />
            <small>{user ? '一句话开始，或者接着上次的项目' : '一句话开始 —— 登录后项目会存在你的账号下'}</small>
          </div>
        </div>
        {/*
          右上角的软件 logo（2026-09-29 徐先：「加载界面和右上角的图标可以用我的软件 logo」）。
          放在头像**左边**：右侧最边上那块是系统按钮（WCO）的位置，而这一颗和头像一起
          构成"品牌 + 我是谁"，logo 在外、人在里。
        */}
        {user ? <div className="home-account">
          <img className="home-logo" src={LOGO_DATA_URI} alt="" aria-hidden />
          {/*
            ⚠️ 这里**只有一颗头像**（2026-09-25 徐先：「这里只显示一个头像就行」）。
            原来它右边还有两行「昵称 / 邮箱」，但左下角侧栏那张用户卡片已经把这两样写全了，
            页头再写一遍等于同一句话说两次，还占着右上角最值钱的那块位置。
            改档案的入口仍然只有侧栏那张卡（`/user`），这一块只负责显示自己是谁。

            身份改成挂在 `title` 上：文字从视觉上撤了，但鼠标停一下还能看到是谁的账号 ——
            头像本身是 `aria-hidden` 的（见 `UserAvatar`），撤掉文字后读屏也念不到这一块，
            侧栏那张卡是它的可访问替身。
          */}
          <UserAvatar avatar={user.avatar} name={user.name} email={user.email}
            className="home-avatar"
            attrs={{ 'data-avatar': 'home', title: `${user.name} · ${user.email}` }} />
          {!isDesktop && <LogoutButton />}
        </div> : <div className="home-account">
          <img className="home-logo" src={LOGO_DATA_URI} alt="" aria-hidden />
          <Link className="button" href="/login"><LogIn size={14} aria-hidden />登录</Link>
        </div>}
      </header>
      <main className="content home">
        {/*
          创作入口。数据在 `lib/start/entries.ts` —— 加一个入口只改那一处，
          别在这里再写死一张卡片（「图片生成」那个占位就是靠它渲染出来的）。
        */}
        <div className="section-head home-section-head">
          <h2><span className="home-section-index" aria-hidden>01</span><span className="home-section-label">Studio entries</span>从这里开始</h2>
          <span className="muted">也可以直接选一种创作方式</span>
        </div>
        <StartEntries />

        <div className="section-head home-section-head">
          <h2><span className="home-section-index" aria-hidden>02</span><span className="home-section-label">Recent projects</span>最近项目</h2>
          {user && <span className="muted">{list.length} 个项目</span>}
          {user && <Link className="button secondary small" href="/projects/new"><Plus size={14} />新建项目</Link>}
        </div>
        {guest ? (
          /*
           * 未登录看到的是**引导**而不是「还没有项目」：后者会让人以为站点是空的，
           * 而真正缺的不是项目、是登录这一步。
           * ⚠️ 只对 web 版成立 —— 桌面版是 `guest === false`，这一块根本轮不到。
           */
          <div className="empty home-guest">
            <div className="empty-icon">✦</div>
            <h3>登录后就能看到你的项目</h3>
            <p className="muted">项目、生成的图片与视频都挂在这个账号下 —— 换台设备也还在。</p>
            <Link className="button" href="/login"><LogIn size={14} aria-hidden />登录 / 注册</Link>
          </div>
        ) : projectsError ? (
          /* 读失败要说读失败。拿「还没有项目」顶上，用户会以为自己的项目没了。 */
          <div className="empty">
            <div className="empty-icon">？</div>
            <h3>读取失败</h3>
            <p className="muted">{projectsError}</p>
          </div>
        ) : projects === null ? (
          /*
           * 项目还没回来。这一档是**必须的**：`list` 在 `projects === null` 时是空数组，
           * 少了它就会先闪一句「还没有项目」再变成卡片列表（和 /projects 页同一套处理）。
           *
           * 2026-09-29：空白换成**骨架屏** —— 原来那一块 `.empty` 会把整页塌成一小块
           * 再弹开；骨架屏的高度照着真卡片给，列表回来时不跳版。
           * 「正在读取项目…」这句留着（读屏与"是不是卡住了"都靠它），只是缩成一行小字。
           */
          <div className="home-skeleton" role="status" aria-live="polite">
            <p className="muted home-skeleton-tip">正在读取项目…</p>
            <div className="sk-grid">
              {[0, 1, 2].map(n => (
                <div className="home-skeleton-card" key={n}>
                  <span className="home-skeleton-thumb" />
                  <span className="home-skeleton-line wide" />
                  <span className="home-skeleton-line" />
                </div>
              ))}
            </div>
          </div>
        ) : list.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">＋</div>
            <h3>还没有项目</h3>
            <p className="muted">在上面说一句想做什么，就会有一张属于它的画布。</p>
          </div>
        ) : (
          <ProjectGrid
            projects={list}
            onChanged={reload}
            /* 相对时间：十五条卡片的日期全同天时，「2026年9月22日」等于没写。 */
            when={(p) => (
              <em className={isFresh(p.updatedAt) ? 'home-when fresh' : 'home-when'}>{relativeTime(p.updatedAt)}</em>
            )}
          />
        )}

        {/*
          页脚水印：一块超大半透明文字，给整页收尾。
          装饰物，所以 `aria-hidden` + CSS 那边 `user-select: none`。
          ⚠️ 它是**最后一行的兄弟节点**，不在任何条件分支里 ——
          放进去的话未登录 / 空列表时会莫名其妙地消失。
        */}
        <div className="home-watermark" aria-hidden><span>Holy Light画布</span></div>
      </main>
    </section>
  </div>;
}
