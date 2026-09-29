'use client';

/*
 * 外观设置。原来在服务端 `await requireUser()` 挡一道，桌面版没有登录这一步
 * （固定一个本机用户），那句判断在这里没有意义，去掉。
 */
import Link from 'next/link';
import SideNav from '@/components/start/SideNav';
import AppearanceForm from '@/components/settings/AppearanceForm';
import SettingsNav from '@/components/settings/SettingsNav';

export default function AppearanceSettings() {
  return <div className="shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">✦</span> Holy Light画布</Link>
      <SideNav active="settings" />
    </aside>
    <section className="workspace">
      <header className="workspace-header">
        <strong>设置</strong>
        <Link className="button secondary" href="/">返回项目</Link>
      </header>
      <main className="content">
        <div className="page-heading">
          <div>
            <div className="eyebrow">APPEARANCE</div>
            <h1>外观</h1>
          </div>
        </div>
        <SettingsNav active="/settings/appearance" />
        <AppearanceForm />
      </main>
    </section>
  </div>;
}
