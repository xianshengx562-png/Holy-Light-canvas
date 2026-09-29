'use client';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useAppearance } from '@/components/theme/ThemeProvider';

/**
 * 左侧导航的收 / 展开关。
 *
 * ⚠️ 它必须待在**页头里**，不能待在侧栏里 —— 侧栏收起后整条滑出屏幕，
 * 按钮跟着一起走就再也点不开了（这类折叠最容易犯的错）。
 * ⚠️ 因此只有首页 / 项目列表是自己把它写进页头的（那两页的页头左边正好有一组
 *    `.home-head-main`）；其它页由 `NavTogglePortal` 找页头挂进去。类名 2026-09-26
 *    从 `home-nav-toggle` 改成通用的 `.nav-toggle`（样式随之搬进 globals）。
 *
 * 状态存在 `frame.appearance.navCollapsed`（设备级偏好，不进库），最终表现是
 * `<html data-nav="collapsed|expanded">`，CSS 只看这个属性。三条好处：
 *   - **刷新不闪**：防闪内联脚本在 `<head>` 里就把它写好了，不会先画一帧展开再跳收起；
 *   - **多标签页同步**：ThemeProvider 监听 `storage`，另一个标签页收起时这边跟着收；
 *   - 侧栏与页头两处动画同源（都读 dataset），收起时不会各动各的错开。
 */
export default function SideNavToggle({ controlsId }: { controlsId?: string } = {}) {
  const { appearance, setNavCollapsed } = useAppearance();
  /* appearance === null 是「还没从 localStorage 读出来」的首帧。
     这时按展开渲染，和 <html> 上防闪脚本写的默认值一致 —— 不会跳。 */
  const collapsed = appearance?.navCollapsed ?? false;
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return <button
    type="button"
    className="nav-toggle"
    aria-expanded={!collapsed}
    /* `undefined` 时 React 根本不写这个属性 —— 通用外壳那几页的侧栏没有 id。 */
    aria-controls={controlsId}
    aria-label={collapsed ? '展开左侧导航' : '收起左侧导航'}
    title={collapsed ? '展开左侧导航' : '收起左侧导航'}
    onClick={() => setNavCollapsed(!collapsed)}
  >
    <Icon size={17} strokeWidth={1.8} aria-hidden />
  </button>;
}
