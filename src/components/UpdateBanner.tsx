'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, RefreshCw, X } from 'lucide-react';
import {
  downloadUpdate,
  fetchUpdateState,
  installUpdate,
  subscribeUpdateState,
} from '@/lib/update-status';
import { isNoticeWorthy, type UpdateState } from '@/lib/update-state';

/**
 * 有新版时那条全局提示（2026-09-29）。
 *
 * 挂在 `App` 根上（和 `BackendStatusBanner` 一样，与路由无关）：用户在任何页面都该知道
 * 「有个新版可以装」，而不是只有主动逛到设置页才发现 —— 后者等于这个功能不存在。
 *
 * ⚠️ 它**只提示、不自动做任何事**。下载要用户点，重启安装更要用户点 ——
 * 后者会关掉整个软件，自动触发一次就能让正在跑的生成任务凭空消失。
 *
 * 「以后再说」按**版本号**记，不是按「关掉了就永远不提」：下次启动如果还是这个版本，
 * 那条提示会再出来一次（有人是当时不方便，隔天就愿意装了）；真出了更新的版本
 * （2.0.1 修了 2.0.0 的问题）它会重新提醒。
 */
export default function UpdateBanner() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchUpdateState().then((current) => {
      if (alive) setState(current);
    });
    const off = subscribeUpdateState((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!state || !isNoticeWorthy(state)) return null;
  if (dismissed && state.version && dismissed === state.version) return null;

  const downloading = state.phase === 'downloading';
  const ready = state.phase === 'downloaded';

  const onDownload = async () => {
    setBusy(true);
    const next = await downloadUpdate();
    if (next) setState(next);
    setBusy(false);
  };

  const onInstall = async () => {
    setBusy(true);
    /* 装完进程就退了，底下那行 setBusy 永远不会执行 —— 这不是 bug，是这条路的终点。 */
    await installUpdate();
    setBusy(false);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      /* 端到端探针靠这个属性找它（`_probe-in-app-update.js`）：这一条是内联样式拼出来的，
         没有一个稳定的类名可抓。值就是当前阶段，探针直接读它就知道走到哪一步了。 */
      data-update-banner={state.phase}
      style={{
        position: 'fixed',
        top: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        maxWidth: 'min(680px, calc(100vw - 32px))',
        padding: '8px 10px 8px 14px',
        fontSize: 12.5,
        lineHeight: 1.5,
        color: 'var(--text)',
        background: 'var(--surface)',
        border: '1px solid var(--line-strong)',
        borderRadius: 999,
        boxShadow: '0 6px 20px rgba(0,0,0,.28)',
      }}
    >
      <span
        style={{
          flex: 'none',
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: ready ? 'var(--accent)' : 'var(--warn)',
          animation: 'backend-pulse 1.2s ease-in-out infinite',
        }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        {downloading
          ? `正在下载 ${state.version} … ${state.percent}%`
          : ready
            ? `${state.version} 已经下载好，重启软件就会装上`
            : `发现新版本 ${state.version}`}
      </span>
      {downloading && (
        /* 进度条：宽度按百分比给，别用 transform —— 这里要的是「填到哪」而不是「从哪滑过来」。 */
        <span
          style={{
            flex: 'none',
            width: 90,
            height: 4,
            borderRadius: 999,
            background: 'var(--surface-3)',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              display: 'block',
              width: `${state.percent}%`,
              height: '100%',
              background: 'var(--accent)',
            }}
          />
        </span>
      )}
      {!downloading && !ready && (
        <button className="button small" onClick={onDownload} disabled={busy}>
          <Download size={13} aria-hidden />下载更新
        </button>
      )}
      {ready && (
        <button className="button small" onClick={onInstall} disabled={busy}>
          <RefreshCw size={13} aria-hidden />重启并安装
        </button>
      )}
      <Link className="button secondary small" href="/settings/update">详情</Link>
      <button
        className="button subtle small"
        onClick={() => setDismissed(state.version)}
        aria-label="以后再说"
        title="以后再说"
        style={{ padding: '4px 6px' }}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}
