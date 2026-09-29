import { useEffect, useState } from 'react';
import {
  backendMessage,
  fetchBackendState,
  isBackendOffline,
  subscribeBackendState,
  type BackendState,
} from '@/lib/backend-status';

/**
 * 后端断线提示条。
 *
 * 桌面版把路由跑在**另一个进程**里（见 `electron/backend/index.ts`），它重启时窗口是好的，
 * 但页面上每个 `/api/*` 都会拿到 503 —— 没有这一条，用户看到的就是「按钮点了没反应」
 * 或者「列表一直是空的」，完全不知道其实只是本机服务在重启。
 *
 * web 版里 `fetchBackendState()` 返回 null，组件什么都不渲染，不需要调用方判断版本。
 */
export default function BackendStatusBanner() {
  const [state, setState] = useState<BackendState | null>(null);

  useEffect(() => {
    let alive = true;
    /*
     * 先查一次再订阅：推送只在状态**变化**时发，而窗口是「不等后端 ready 就先开」的，
     * 页面挂载得比 ready 晚的话一条都收不到，会一直卡在「正在连接」。
     */
    void fetchBackendState().then((current) => {
      if (alive) setState(current);
    });
    const off = subscribeBackendState((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!state || !isBackendOffline(state)) return null;
  const failed = state === 'failed';

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: 'min(680px, calc(100vw - 32px))',
        padding: '8px 14px',
        fontSize: 12.5,
        lineHeight: 1.5,
        color: 'var(--text)',
        background: failed ? 'var(--danger-soft)' : 'var(--surface)',
        border: `1px solid ${failed ? 'var(--danger-line)' : 'var(--line)'}`,
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
          background: failed ? 'var(--danger)' : 'var(--warn)',
          animation: 'backend-pulse 1.2s ease-in-out infinite',
        }}
      />
      <span>{backendMessage(state)}</span>
    </div>
  );
}
