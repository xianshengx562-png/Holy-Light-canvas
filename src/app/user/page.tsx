'use client';

/*
 * 用户（`/user`）。
 *
 * 这一页 2026-09-23 之前挂在设置二级导航里（`/settings/user`），徐先看着别扭：
 * 改昵称 / 换头像跟「模型服务 / ComfyUI / 输出目录」不是一类事 —— 后者是"能不能跑起来"，
 * 前者是"我是谁"。所以入口搬到**侧栏最底下那颗用户卡片**（`components/start/SideNav.tsx`），
 * 页面也从设置区独立出来：不再挂 `SettingsNav`，页头不再写「设置」。
 *
 * 老地址不落空：`/settings/user` 在 `App.tsx` 的 REDIRECTS 里换到这一页。
 * 表单本身还是 `UserPanel`，这一页只管摆位置。
 */
import { useEffect } from 'react';
import Link from 'next/link';
import SideNav from '@/components/start/SideNav';
import UserPanel from '@/components/settings/UserPanel';

export default function UserProfile() {
  useEffect(() => {
    document.title = 'Holy Light画布 — 用户';
  }, []);

  return <div className="shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">✦</span> Holy Light画布</Link>
      <SideNav active="user" />
    </aside>
    <section className="workspace">
      <header className="workspace-header">
        <strong>用户</strong>
        <Link className="button secondary" href="/">返回项目</Link>
      </header>
      <main className="content">
        <div className="page-heading">
          <div>
            <div className="eyebrow">PROFILE</div>
            <h1>用户</h1>
            {/*
              一句说明把这一页最容易被问到的两件事说掉：为什么没有登录（桌面版本机单用户）、
              以及下面那块「网站账号」跟本机的东西无关。
            */}
            <p className="user-lead">
              桌面版不需要登录 —— 这里的昵称和头像只影响本机显示；下面的「网站账号」只用来调模型，
              跟本机的项目、资产没有关系。
            </p>
          </div>
        </div>
        <UserPanel />
      </main>
    </section>
  </div>;
}
