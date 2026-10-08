'use client';
import { useState } from 'react';
import Link from 'next/link';
import { LogIn, Plus, Search } from 'lucide-react';
import SideNav from '@/components/start/SideNav';
import LogoutButton from '@/components/LogoutButton';
import SideNavToggle from '@/components/start/SideNavToggle';
import StartEntries from '@/components/start/StartEntries';
import ProjectGrid, { type ProjectCardItem } from '@/components/start/ProjectGrid';
import Starfield from '@/components/start/Starfield';
import { isDesktop } from '@/lib/edition';
import { useApi, useSession } from '@/lib/client';
import '@/app/home.css';
import '@/app/workspace-home.css';

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

const isFresh = (value: string) => Date.now() - new Date(value).getTime() < DAY;

export default function Home() {
  const { user } = useSession();
  const guest = !isDesktop && !user;
  const { data: projects, error: projectsError, reload } = useApi<ProjectCardItem[]>(user ? '/api/projects' : null);
  const [searchQuery, setSearchQuery] = useState('');
  
  const list = projects ?? [];
  const filteredList = searchQuery.trim()
    ? list.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase().trim()))
    : list;

  return <div className="shell home-shell">
    <aside className="sidebar" id="home-sidebar">
      <Link className="brand" href="/"><span className="brand-mark">✦</span> Holy Light画布</Link>
      <SideNav active="projects" />
    </aside>
    <section className="workspace">
      <Starfield />
      <header className="workspace-header">
        <div className="workspace-title">
          <h1>工作台</h1>
        </div>
        {user ? (!isDesktop && <div className="home-account"><LogoutButton /></div>) : (
          <div className="home-account">
            <Link className="button" href="/login"><LogIn size={14} aria-hidden />登录</Link>
          </div>
        )}
        {/*
         * 站点余额的**卡槽**（`SiteBalance` 认 `[data-balance-slot]`，与画布顶栏同一套机制）。
         *
         * 为什么必须显式摆一个：余额是 portal **追加**到页头末尾的 —— 不摆卡槽的话它会
         * 排在收纳钮**后面**，收纳钮就永远到不了最右端。摆上之后余额落到这个 span 里，
         * `display: contents` 让它自己成为页头的 flex 子项、位置由这一行 JSX 说了算。
         */}
        <span className="home-balance-slot" data-balance-slot />
        {/*
         * 收纳钮放**最后**（2026-10-07 徐先：「这里有一个图标，位置变一下」→ 挪到页头最右端）。
         *
         * 它原来在 `.workspace-title` 里面，而**那个类在整份 CSS 里一条规则都没有** ——
         * 于是 `<button>` 和 `<h1>` 是块级上下堆叠：按钮跑到标题**上方**、还探出页头
         * 顶边 5px（实测 `y = -5`）。其它页由 `NavTogglePortal` 把它挂在页头末尾，
         * 那些页它在最右边 —— 首页和别处的位置本来就不一致。
         */}
        <SideNavToggle />
      </header>
      <main className="content home">
        {/*
          * `data-head` 只给样式用：首页这两处区块标题各有一支自己的色
          * （2026-10-08 徐先：「这里的文字的颜色也可以改下」）。
          * 没走 `:first-of-type` 之类的选择器 —— 那种写法在这个父级下不稳
          * （中间还夹着 `<StartEntries />` 与条件渲染的兄弟），加一个显式属性最省事。
          */}
        <div className="section-head home-section-head" data-head="create">
          <h2>创作</h2>
        </div>
        <StartEntries />

        <div className="section-head home-section-head" data-head="projects">
          <h2>最近项目</h2>
          {/*
           * ⚠️ `projects !== null` 这个守卫不能省（2026-10-07）：`projects === null` 是
           * **还在读**（下面骨架屏那一路就是判它）。读的过程中 `list` 是 `[]`，
           * 于是这一格会在「正在读取项目…」旁边显示「**0 个项目**」——
           * 用户看到的是「我的项目全没了」，而不是「稍等一下」。
           */}
          {user && projects !== null && <span className="muted">{list.length} 个项目</span>}
          {user && <Link className="button secondary small" href="/projects/new"><Plus size={14} />新建项目</Link>}
        </div>

        {/* 搜索栏 */}
        {user && list.length > 0 && (
          <div className="home-search-wrapper">
            <input
              type="text"
              className="home-search-input"
              placeholder="搜索项目..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <Search className="home-search-icon" size={20} />
          </div>
        )}

        {guest ? (
          <div className="empty home-guest">
            <div className="empty-icon">✦</div>
            <h3>登录后就能看到你的项目</h3>
            <p className="muted">项目、生成的图片与视频都挂在这个账号下 —— 换台设备也还在。</p>
            <Link className="button" href="/login"><LogIn size={14} aria-hidden />登录 / 注册</Link>
          </div>
        ) : projectsError ? (
          <div className="empty">
            <div className="empty-icon">？</div>
            <h3>读取失败</h3>
            <p className="muted">{projectsError}</p>
          </div>
        ) : projects === null ? (
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
        ) : filteredList.length === 0 ? (
          searchQuery.trim() ? (
            <div className="empty">
              <div className="empty-icon">🔍</div>
              <h3>没有找到匹配的项目</h3>
              <p className="muted">试试其他关键词</p>
            </div>
          ) : (
            <div className="empty">
              <div className="empty-icon">＋</div>
              <h3>还没有项目</h3>
              <p className="muted">在上面说一句想做什么，就会有一张属于它的画布。</p>
            </div>
          )
        ) : (
          <ProjectGrid
            projects={filteredList}
            onChanged={reload}
            when={(p) => (
              <em className={isFresh(p.updatedAt) ? 'home-when fresh' : 'home-when'}>{relativeTime(p.updatedAt)}</em>
            )}
          />
        )}

        <div className="home-watermark" aria-hidden><span>Holy Light画布</span></div>
      </main>
    </section>
  </div>;
}
