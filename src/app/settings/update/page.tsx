'use client';

/*
 * 设置 · 版本与更新（2026-09-29）。
 *
 * 徐先的问题：「如果已经到 2.0 了，用户才 1.0，用户怎么在软件内实现更新的效果。」
 *
 * 这一页就是答案的**控制台**：显示自己这份的版本、手动检查、下载、重启安装。
 * 桌面版专属 —— web 版刷新一下就是最新版，根本没有「用户手上的旧版」这回事。
 *
 * 「更新源」2026-10-01 起**不再出现在界面上** —— 默认就是 GitHub releases 那个地址
 * （`updater.ts` 的 `DEFAULT_UPDATE_SOURCE`），装完就能检查更新，不用填任何东西。
 * ⚠️ 但换服务器仍然不用重新打包：数据目录里的 `update-source.json` 优先级更高，
 * 改那一个文件就能把旧包救回来（界面入口收掉了，文件这条路留着）。
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, RefreshCw, Search } from 'lucide-react';
import SideNav from '@/components/start/SideNav';
import SettingsNav from '@/components/settings/SettingsNav';
import {
  checkUpdate,
  downloadUpdate,
  fetchUpdateState,
  installUpdate,
  subscribeUpdateState,
} from '@/lib/update-status';
import { canCheck, canDownload, canInstall, type UpdateState } from '@/lib/update-state';

export default function UpdateSettings() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState<'check' | 'download' | 'install' | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchUpdateState().then((current) => {
      if (!alive || !current) return;
      setState(current);
    });
    const off = subscribeUpdateState((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = async (kind: 'check' | 'download' | 'install') => {
    setBusy(kind);
    if (kind === 'check') {
      const next = await checkUpdate();
      if (next) setState(next);
    } else if (kind === 'download') {
      const next = await downloadUpdate();
      if (next) setState(next);
    } else {
      /* 装完进程就退了，底下的 setBusy(null) 不会执行 —— 这是这条路的终点，不是漏了。 */
      await installUpdate();
    }
    setBusy(null);
  };

  const phase = state?.phase ?? 'idle';
  const unsupported = phase === 'unsupported';

  return <div className="shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">✦</span> Holy Light画布</Link>
      <SideNav active="settings" />
    </aside>
    <section className="workspace"><header className="workspace-header"><strong>设置</strong><Link className="button secondary" href="/">返回项目</Link></header><main className="content"><div className="page-heading"><div><div className="eyebrow">UPDATE</div><h1>版本与更新</h1></div></div>
      <SettingsNav active="/settings/update" />

      <section className="provider">
        {/* 2026-10-01 第六轮：标题下那行「这一份 Holy Light画布的版本号」是纯复述，删。 */}
        <div className="provider-head"><div><h2>当前版本</h2></div>
          <span className="badge">{state?.currentVersion || '…'}</span></div>
        {state?.message && <div className={phase === 'error' ? 'notice error' : 'notice'}>{state.message}</div>}
        {phase === 'downloading' && (
          <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-3)', overflow: 'hidden' }}>
            <div style={{ width: `${state?.percent ?? 0}%`, height: '100%', background: 'var(--accent)' }} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="button small" onClick={() => run('check')} disabled={!state || !canCheck(state) || busy !== null}>
            <Search size={13} aria-hidden />{busy === 'check' ? '正在检查…' : '检查更新'}
          </button>
          <button className="button small" onClick={() => run('download')} disabled={!state || !canDownload(state) || busy !== null}>
            <Download size={13} aria-hidden />{busy === 'download' ? '正在下载…' : '下载更新'}
          </button>
          <button className="button small" onClick={() => run('install')} disabled={!state || !canInstall(state) || busy !== null}>
            <RefreshCw size={13} aria-hidden />重启并安装
          </button>
        </div>
        {unsupported && (
          <div className="notice">便携版 / 开发版装不了自动更新，要升级请重新下载安装包。</div>
        )}
      </section>

      {/* 2026-10-01：「更新源」整张卡收掉 —— 默认就是 GitHub releases 那个地址，
          普通用户不该操心这件事。要换源的话改数据目录里的 `update-source.json`。 */}
      {state?.notes && (
        <section className="provider">
          <div className="provider-head"><div><h2>更新说明</h2></div></div>
          <pre className="notice" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{state.notes}</pre>
        </section>
      )}
    </main></section></div>;
}
