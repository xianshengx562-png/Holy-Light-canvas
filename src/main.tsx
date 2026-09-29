import { createRoot } from 'react-dom/client';
import '@/app/globals.css';
import { APPEARANCE_KEY, applyAppearance, parseAppearance } from '@/lib/appearance';
import { installTitlebar } from '@/lib/desktop-titlebar';
import App from './App';

/*
 * 主题必须在 React 渲染**之前**落到 <html> 上，否则会先闪一帧夜间再跳成日间。
 *
 * Next 版是靠 `app/layout.tsx` 里那个防闪内联脚本做到的（它跑在 <head>，早于注水）；
 * 这里是纯客户端渲染，直接在挂载前同步调一次 `applyAppearance` 就够了 ——
 * 同一份规则、同一个 localStorage key，不会再出现两套实现。
 */
try {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyAppearance(parseAppearance(localStorage.getItem(APPEARANCE_KEY)), prefersDark);
} catch {
  /* 偏好读不出来就按默认深色走，绝不能因此白屏 */
}

/*
 * 隐藏系统标题栏的配套（量系统按钮的实宽 → `--window-controls-inset`）。
 * 必须在渲染**之前**跑：页头第一次布局就要知道自己该给右侧让出多少，
 * 否则会先按兜底的 138px 排一次、量到真值再跳一下。
 */
installTitlebar();

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 挂载点');

/*
 * 不套 StrictMode：它会把 effect 跑两遍，于是每个页面首屏都会发两次请求。
 * 桌面版是单进程单窗口，重复请求的代价看得见（生成任务尤其），不值得。
 */
createRoot(container).render(<App />);
