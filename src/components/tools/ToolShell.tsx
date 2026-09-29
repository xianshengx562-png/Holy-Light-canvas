'use client';

/*
 * 实用工具们共用的页面外壳。
 *
 * 骨架照着资产页（`.shell` / `.sidebar` / `.workspace` / `.page-heading`）来 ——
 * YUH Studio 那套工具页是它自己的视觉语言，这里不做搬运，**Holy Light画布长什么样它就长什么样**。
 *
 * 抽出它的原因和当初抽 `SideNav` 一样：工具的视觉需要一处标定。
 * 以后再加「运镜效果」「人脸马赛克」，新页面只要 `<ToolShell>` 包一层，
 * 不需要再复制一遍侧栏、页头和小标题。
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import SideNav, { type SideNavKey } from '@/components/start/SideNav';
import { isDesktop } from '@/lib/edition';
import { useSession } from '@/lib/client';
import LogoutButton from '@/components/LogoutButton';
import '@/app/tools.css';

export default function ToolShell({
  active,
  eyebrow,
  title,
  intro,
  tabs,
  children,
}: {
  active: SideNavKey;
  eyebrow: string;
  title: string;
  intro: string;
  /** 工具内部的小切换（比如分割页里的「分割 / 拼接」）。不传就不显示。 */
  tabs?: ReactNode;
  children: ReactNode;
}) {
  const { user } = useSession();
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link className="brand" href="/">
          <span className="brand-mark">✦</span> Holy Light画布
        </Link>
        <SideNav active={active} />
        {/* 桌面版不显示账号与退出：固定一个本机用户，这两行只会让人困惑 */}
        {!isDesktop && user && (
          <div className="side-bottom">
            <div className="account">
              {user.name}
              <br />
              {user.email}
            </div>
            <LogoutButton />
          </div>
        )}
      </aside>
      <section className="workspace">
        <header className="workspace-header">
          <div>
            <strong>{title}</strong>
            <br />
            <small>{intro}</small>
          </div>
          <Link className="button secondary" href="/assets">
            去资产库
          </Link>
        </header>
        <main className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">{eyebrow}</div>
              <h1>{title}</h1>
            </div>
          </div>
          {tabs}
          {children}
        </main>
      </section>
    </div>
  );
}
