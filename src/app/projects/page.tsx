'use client';

/*
 * 项目列表页（`/projects`）。
 *
 * 为什么会有这一页：`/api/projects` 这个接口一直在（首页的「最近项目」就在用），
 * 但**页面**从来只有 `/projects/new` 和 `/projects/[id]` —— 桌面版侧栏「项目」指向 `/`，
 * 于是 `/projects` 落进 404，看着像坏了。这里把它补成一个正经的列表页。
 *
 * 和首页「最近项目」的区别，只有一条：**这里列全部、带搜索与统计**，首页只列最近几张。
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, Search } from 'lucide-react';
import SideNav from '@/components/start/SideNav';
import LogoutButton from '@/components/LogoutButton';
import Starfield from '@/components/start/Starfield';
import ProjectGrid, { type ProjectCardItem } from '@/components/start/ProjectGrid';
import { isDesktop } from '@/lib/edition';
import { useApi, useSession } from '@/lib/client';
import '@/app/home.css';

/* 卡片与右键菜单（打开 / 重命名 / 删除项目）那一份在 `ProjectGrid` —— 与首页共用。 */

export default function Projects() {
  const { user } = useSession();
  const { data, loading, error, reload } = useApi<ProjectCardItem[]>(user ? '/api/projects' : null);
  const [keyword, setKeyword] = useState('');

  const dateText = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });

  const list = useMemo(() => {
    const all = data ?? [];
    const k = keyword.trim().toLowerCase();
    if (!k) return all;
    return all.filter((p) => p.name.toLowerCase().includes(k));
  }, [data, keyword]);

  return <div className="shell home-shell">
    <aside className="sidebar" id="home-sidebar">
        <Link className="brand" href="/">
          <span className="brand-mark">✦</span> Holy Light画布
        </Link>
      <SideNav active="projects" />
      {!isDesktop && user && <div className="side-bottom">
        <div className="account">{user.name}<br />{user.email}</div>
        <LogoutButton />
      </div>}
    </aside>

    <section className="workspace">
      <Starfield />
      <header className="workspace-header">
        <div>
          <strong>项目</strong>
          <br />
          <small>每个项目一张独立画布</small>
        </div>
        {user && <Link className="button small" href="/projects/new"><Plus size={14} aria-hidden />新建项目</Link>}
      </header>

      <main className="content home">
        <div className="section-head">
          <h2>全部项目</h2>
          {(data ?? []).length > 0 && <span className="muted">{(data ?? []).length} 个项目</span>}
        </div>

        {(data ?? []).length > 0 && (
          <label className="field project-search">
            <Search size={14} strokeWidth={1.8} aria-hidden />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="按名称筛选"
              aria-label="按名称筛选项目"
            />
          </label>
        )}

        {!user ? (
          <div className="empty">
            <div className="empty-icon">✦</div>
            <h3>登录后就能看到你的项目</h3>
            <p className="muted">项目、对话记录、生成的图片与视频都挂在这个账号下。</p>
          </div>
        ) : loading && !data ? (
          /* 2026-09-29：和首页同一套骨架屏 —— 这里列的是全部项目，卡片更多，
             用骨架撑住高度才不会在列表回来时整页往下顶。 */
          <div className="home-skeleton" role="status" aria-live="polite">
            <p className="muted home-skeleton-tip">正在读取项目…</p>
            <div className="sk-grid">
              {[0, 1, 2, 3, 4, 5].map(n => (
                <div className="home-skeleton-card" key={n}>
                  <span className="home-skeleton-thumb" />
                  <span className="home-skeleton-line wide" />
                  <span className="home-skeleton-line" />
                </div>
              ))}
            </div>
          </div>
        ) : error ? (
          <div className="empty">
            <div className="empty-icon">？</div>
            <h3>读取失败</h3>
            <p className="muted">{error}</p>
          </div>
        ) : null}
        {/*
          空列表时画廊**仍然挂着**：把整块换掉的话，删光项目时组件被卸载，
          「已删除 N 个项目」那条回执也跟着没了（与资产页同一个坑，2026-09-26）。
        */}
        {user && !loading && list.length === 0 && (
          <div className="empty">
            <div className="empty-icon">＋</div>
            <h3>{keyword ? '没有匹配的项目' : '还没有项目'}</h3>
            <p className="muted">
              {keyword ? '换个关键词试试。' : '在主界面说一句想做什么，就会有一张属于它的画布。'}
            </p>
            <Link className="button" href={keyword ? '/projects' : '/projects/new'}>
              {keyword ? '清空筛选' : '新建项目'}
            </Link>
          </div>
        )}
        <ProjectGrid
          projects={list}
          onChanged={reload}
          /* 这一页列全部、还带筛选，时间说**绝对日期**更好定位（首页才说「几小时前」）。 */
          when={(p) => dateText.format(new Date(p.updatedAt))}
        />
      </main>
    </section>
  </div>;
}
