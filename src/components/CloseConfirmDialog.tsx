import { useEffect, useState } from 'react';
import { onRequestClose, windowCloseAction } from '@/lib/desktop-close';
import { isDesktopWindows } from '@/lib/desktop-titlebar';

/**
 * 点右上角系统关闭按钮时的确认框（桌面版自绘，与「要连跑 N 遍？」那种 ConfirmDialog 同语言）。
 *
 * 主进程拦下了默认退出、推 `request-close` 过来，这里弹出让用户选：
 *   - 最小化：收进系统托盘（任务栏不占位），点托盘图标还原；进程继续（后端不重启、数据不动）。
 *   - 退出应用：走主进程的 `app.quit()` → `before-quit`（后端优雅 flush）再真正退出。
 * web 版没有这个 IPC 通道，`onRequestClose` 是空操作，组件永远不渲染。
 */
export default function CloseConfirmDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isDesktopWindows()) return;
    const off = onRequestClose(() => setOpen(true));
    return off;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const minimize = async () => {
    setOpen(false);
    await windowCloseAction('minimize');
  };
  const quit = async () => {
    setOpen(false);
    await windowCloseAction('quit');
  };

  return (
    <div
      className="cv-close-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="cv-close-dialog" role="dialog" aria-modal="true" aria-label="关闭确认">
        <div className="cv-close-title">关闭 Holy Light画布</div>
        <div className="cv-close-body">要最小化到系统托盘，还是退出应用？</div>
        <div className="cv-close-actions">
          <button type="button" className="cv-close-btn" onClick={minimize}>
            最小化
          </button>
          <button type="button" className="cv-close-btn cv-close-btn-danger" onClick={quit}>
            退出应用
          </button>
        </div>
      </div>
    </div>
  );
}
