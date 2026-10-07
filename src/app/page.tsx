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
          <SideNavToggle />
          <h1>工作台</h1>
        </div>
        {user ? (!isDesktop && <div className="home-account"><LogoutButton /></div>) : (
          <div className="home-account">
            <Link className="button" href="/login"><LogIn size={14} aria-hidden />登录</Link>
          </div>
        )}
      </header>
      <main className="content home">
        <div className="section-head home-section-head">
          <h2>创作</h2>
        </div>
        <StartEntries />

        <div className="section-head home-section-head">
          <h2>最近项目</h2>
          {user && <span className="muted">{list.length} 个项目</span>}
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
