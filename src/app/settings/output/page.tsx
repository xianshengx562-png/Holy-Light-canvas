'use client';

/*
 * 设置 · 输出目录。
 *
 * 桌面版独有：产出（图 / 视频 / latent）落在哪个文件夹由用户自己定。
 * web 版这页也不必藏——云端版的产出只能落在服务端自己的 storage 里，
 * 而这里显示出来的「默认目录」正好就是那个路径，看见了也没坏处。
 */
import Link from 'next/link';
import SideNav from '@/components/start/SideNav';
import SettingsNav from '@/components/settings/SettingsNav';
import OutputDirForm from '@/components/settings/OutputDirForm';
import { useApi } from '@/lib/client';
import type { OutputDirView } from '@/lib/output-dir';

export default function OutputSettings() {
  const { data: view, loading, error } = useApi<OutputDirView>('/api/settings/output');
  return <div className="shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">✦</span> Holy Light画布</Link>
      <SideNav active="settings" />
    </aside>
    <section className="workspace"><header className="workspace-header"><strong>设置</strong><Link className="button secondary" href="/">返回项目</Link></header><main className="content"><div className="page-heading"><div><div className="eyebrow">OUTPUT</div><h1>输出目录</h1></div></div>
      <SettingsNav active="/settings/output" />
      <section className="provider">
        <div className="provider-head"><div><h2>产出存在哪</h2><p className="muted">生成出来的图、视频与 latent 都落进这个文件夹</p></div><span className="badge">{view?.source === 'custom' ? '自定义' : '默认'}</span></div>
        {error && <div className="notice error">读不到输出目录配置：{error}</div>}
        {loading && !view && <div className="notice">正在读取输出目录…</div>}
        <div className="notice">默认落在软件自己的数据目录里（系统盘底下、路径很深）。换成你自己挑的文件夹之后，找文件、备份、挪到外接硬盘都方便。</div>
        {view && <OutputDirForm initial={view} />}
      </section></main></section></div>;
}
