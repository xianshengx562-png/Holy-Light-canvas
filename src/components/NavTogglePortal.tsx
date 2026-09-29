'use client';

/*
 * 把「收起 / 展开左侧导航」那颗钮挂到**每一页**的页头里（2026-09-26，徐先：侧边栏可以收纳）。
 *
 * 为什么用 portal 而不是在每个页面里各放一次：理由与「站点余额」那篇一模一样 ——
 * 有 `.workspace-header` 的页面十来个（资产 / 用户 / 图片生成 / 设置各页 / 实用工具），
 * 逐个塞要改十几个文件，将来新增一页还得记得再塞一次；漏掉的表现只是「这一页收不起来」，
 * 没人会想到是忘了写那一行。挂在页头容器里而不是 `position: fixed` 悬浮，是因为它是
 * flex 的最后一个孩子、位置由浏览器排，永远不会压到页头已有的按钮上。
 *
 * ⚠️ 首页与项目列表（`.home-shell`）**跳过**：那两页的页头里本来就有一颗（在标题左边的
 *    `.home-head-main` 里，位置是特意排过的），这里再挂就成两个了。
 * ⚠️ 状态存在 `frame.appearance.navCollapsed`，最终表现是 `<html data-nav>`，CSS 只看它 ——
 *    组件不写内联样式（防闪脚本在 <head> 里就先写好了，改由组件写必然先画一帧展开再跳收起）。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from '@/shims/router';
import SideNavToggle from '@/components/start/SideNavToggle';

/** 页头随路由换掉，而且页面里有懒加载的内容 —— 换路由后补找几次（照抄 SiteBalance）。 */
const RETRY_MS = [80, 300, 900];

export default function NavTogglePortal() {
  const pathname = usePathname();
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHost(null);
    let found = false;
    const find = () => {
      const node = document.querySelector<HTMLElement>('.workspace-header');
      if (node && !found) {
        found = true;
        /* 首页那套外壳自己带了钮，别挂第二颗。 */
        if (!node.closest('.home-shell')) setHost(node);
      }
      return !!node;
    };
    if (find()) return;
    const timers = RETRY_MS.map(delay => window.setTimeout(find, delay));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [pathname]);

  return host ? createPortal(<SideNavToggle />, host) : null;
}
