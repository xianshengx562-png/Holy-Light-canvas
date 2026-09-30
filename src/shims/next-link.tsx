import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { canOpenNewWindow } from '@/lib/desktop-fs';
import { confirmLeave } from '@/lib/unsaved';
import { navigate } from './router';

/**
 * `next/link` 的替身。
 *
 * 26 个组件在用 `<Link href="...">`，行为上它就是一个「点一下走前端路由」的 `<a>`。
 * 保留 `<a>` 而不是换成 `<div>`：中键新窗口、"复制链接地址"、以及键盘 Tab 焦点都还能用，
 * 这些是用户真的会去点的东西。
 *
 * 外链（`http://` 开头）和带 `target` 的链接不劫持，交给浏览器。
 *
 * ⚠️ 例外：桌面版（`app://` + hash 路由）**不能**交给浏览器 ——
 * 见 `canOpenNewWindow()` 上面的说明，那边开出来的是一个没有 hash 的白页。
 * 所以桌面版里带 `target` 的同源链接会被拉回应用内导航，新窗口这件事由主进程的
 * `setWindowOpenHandler` 决定（外站才真的开系统浏览器）。
 */
type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
  children?: ReactNode;
};

export default function Link({ href, replace, target, onClick, children, prefetch, scroll, ...rest }: Props) {
  /*
   * `prefetch` / `scroll` 是 Next 专有的 props，必须在这里吃掉 ——
   * 留在 rest 里会被铺到 <a> 上，React 会对「不认识的 DOM 属性」逐条告警，
   * 而且 `scroll={false}` 这种布尔值还会真的渲染出 `scroll="false"`。
   * 单页应用里两者都没有对应行为（没有按路由拆包可预取、路由切换由 hash 驱动）。
   */
  void prefetch;
  void scroll;
  /*
   * 桌面版把同源链接的 `target` 吃掉：留着它就是在要求开一个新窗口，
   * 而桌面版开出来的新窗口没有 hash，只会是白页。外链不吃（那个 target 是给系统浏览器用的）。
   */
  const external = /^([a-z]+:)?\/\//i.test(href) || href.startsWith('mailto:');
  const keepTarget = target && (external || canOpenNewWindow());
  return (
    <a
      href={href}
      target={keepTarget ? target : undefined}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        /*
         * 中键 / Ctrl+点击 这一支也要一起收掉：它们走的是浏览器自己的「新标签」通道，
         * 不经过上面的 `target`，同样会开出一个没有 hash 的白窗口。
         */
        const wantNewPlace = event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0;
        if (external || (keepTarget && (target || wantNewPlace))) {
          return;
        }
        /*
         * 有没保存的改动就先问一句（2026-09-30）。
         *
         * 站内跳转只改 hash、页面**不卸载**，所以 `beforeunload` 根本不触发 ——
         * 从工作流配置页点「返回项目」，改了一屏的字段就这么没了，一个提示都没有。
         * 于是问的责任落在这里（判定在 `lib/unsaved.ts`，只有登记过的编辑页才会被问）。
         *
         * ⚠️ 用户选「留下」时**也必须 preventDefault**：
         * 这是个真的 `<a href>`，不挡掉默认行为，浏览器会照着 href 做整页导航
         * （桌面版里那会被 `will-navigate` 兜回 hash 路由 —— 结果还是走了）。
         */
        if (!confirmLeave()) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        navigate(href, { replace });
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
