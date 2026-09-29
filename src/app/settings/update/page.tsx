'use client';

/*
 * 设置 · 版本与更新（2026-09-29）。
 *
 * 徐先的问题：「如果已经到 2.0 了，用户才 1.0，用户怎么在软件内实现更新的效果。」
 *
 * 这一页就是答案的**控制台**：显示自己这份的版本、填更新源、手动检查、下载、重启安装。
 * 桌面版专属 —— web 版刷新一下就是最新版，根本没有「用户手上的旧版」这回事。
 *
 * ⚠️ 「更新源」为什么要让人填：写死一个域名的话，将来换服务器时，
 *    **已经装在别人机器上的那些旧包**问的还是那个已经下线的地址 —— 而他们恰恰是
 *    最需要收到新版的一批人。地址存在数据目录里、可以随时改，旧包就还能救回来。
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
  setUpdateSource,
  subscribeUpdateState,
} from '@/lib/update-status';
import { canCheck, canDownload, canInstall, type UpdateState } from '@/lib/update-state';

export default function UpdateSettings() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<'check' | 'download' | 'install' | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchUpdateState().then((current) => {
      if (!alive || !current) return;
      setState(current);
      setSource(current.source);
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

  const saveSource = async () => {
    const next = await setUpdateSource(source);
    if (next) {
      setState(next);
      setSource(next.source);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2400);
    }
  };

  const phase = state?.phase ?? 'idle';
  const unsupported = phase === 'unsupported';
  const unconfigured = phase === 'unconfigured';

  return <div className="shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">✦</span> Holy Light画布</Link>
      <SideNav active="settings" />
    </aside>
    <section className="workspace"><header className="workspace-header"><strong>设置</strong><Link className="button secondary" href="/">返回项目</Link></header><main className="content"><div className="page-heading"><div><div className="eyebrow">UPDATE</div><h1>版本与更新</h1></div></div>
      <SettingsNav active="/settings/update" />

      <section className="provider">
        <div className="provider-head"><div><h2>当前版本</h2><p className="muted">这一份 Holy Light画布的版本号</p></div>
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
          <div className="notice">这一份是便携版或开发版，装不了自动更新 —— 要升级请重新下载安装包。</div>
        )}
      </section>

      <section className="provider">
        <div className="provider-head"><div><h2>更新源</h2><p className="muted">去哪个地址问「有没有新版」</p></div></div>
        <div className="notice">
          填一个静态站地址就行（<code>http://</code> 或 <code>https://</code>，末尾的斜杠可写可不写）。
          那个目录里放一个 <code>latest.yml</code> 和对应的安装包，打包时 electron-builder 会一起生成。
          地址存在软件的数据目录里，以后换服务器不用重新打包 —— 旧版本的用户改一下这里就能继续收到更新。
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <input
            className="field"
            style={{ flex: '1 1 320px', minWidth: 220 }}
            value={source}
            placeholder="https://example.com/frame-updates/"
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
          />
          <button className="button secondary small" onClick={saveSource} disabled={busy !== null}>保存</button>
          {saved && <span className="muted">已保存</span>}
        </div>
        {unconfigured && <div className="notice">还没填更新源，所以没法检查。填一个地址再点「检查更新」。</div>}
      </section>

      {state?.notes && (
        <section className="provider">
          <div className="provider-head"><div><h2>更新说明</h2><p className="muted">{state.version} 这一版改了什么</p></div></div>
          <pre className="notice" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{state.notes}</pre>
        </section>
      )}
    </main></section></div>;
}
