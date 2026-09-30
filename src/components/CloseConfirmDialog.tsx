import { useEffect, useState } from 'react';
import { onRequestClose, windowCloseAction } from '@/lib/desktop-close';
import { isDesktopWindows } from '@/lib/desktop-titlebar';
import { unsavedLabels } from '@/lib/unsaved';

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

  /*
   * 关应用这条路上 **没有** `beforeunload`（主进程先拦下、再推 IPC 到这里弹自己的框），
   * 所以「还有没保存的」得自己问一句（2026-09-30）。
   * 判定用的是同一个登记处 —— 和站内跳转那句提示说的是同一件事，不会一边提醒一边不提醒。
   *
   * ⚠️ 只提醒、不额外加第三个按钮：这个框的取消本来就有（Esc / 点空白处），
   * 而「最小化」和「退出」是它原有的两个选择。加个「取消」反而变成三选一更啰嗦 ——
   * 但**必须把怎么取消说出来**，否则用户看着警告只会更慌。
   */
  const unsaved = unsavedLabels();

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
        <div className="cv-close-body">
          {unsaved.length > 0 && (
            <div className="cv-close-warn" data-close-unsaved="">
              {unsaved.join('、')}有未保存的改动，退出就没了。
              想先去保存：按 Esc 或点空白处关掉这个框。
            </div>
          )}
          要最小化到系统托盘，还是退出应用？
        </div>
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
