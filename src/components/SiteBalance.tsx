'use client';

/*
 * 站点余额 —— **每一页**页头的右上角（2026-09-25）。
 *
 * 为什么用 portal 挂进 `.workspace-header` 而不是在每个页面里各放一次：
 * 有 `.workspace-header` 的页面有十来个，而且它们的右端各不相同（「返回项目」、
 * 「新建项目」、首页那颗头像）。逐个塞进去要改十几个文件，将来新增一页还得记得再塞一次 ——
 * 漏掉的表现是「这一页没余额」，而没人会想到是忘了写这一行。
 * 挂在页头容器里（而不是 `position: fixed` 悬浮）还有个好处：它是 flex 的**最后一个**孩子，
 * 位置由浏览器排，永远不会压到已有的按钮上。
 *
 * 未登录时**整个不渲染**（不是显示一个空壳）—— 徐先要的就是「没有登录就不显示」。
 *
 * 数据来自 `lib/site-account.ts` 那个共享 store：侧栏 / 用户页读的是同一份，
 * 全站只往站点打一趟（那边有 20 次 / 20 分钟的 IP 限流）。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from '@/shims/router';
import { formatYuan, refreshSiteAccount, siteCooldownUntil, useSiteAccount } from '@/lib/site-account';
import { nextPollDelayMs } from '@/lib/providers/site-errors';

/**
 * 页头是**随路由换掉**的：hash 一变，旧节点就没了，得重新找。
 * 而且页面里有懒加载的内容，节点可能晚一两帧才出现，所以换路由后再补找几次。
 */
const RETRY_MS = [80, 300, 900];

/**
 * 余额轮询间隔（2026-09-28）。
 * 站点那边「同一 IP、20 次 / 20 分钟」的限流下，2 分钟是「够新」与「够省」的折中。
 */
const BALANCE_POLL_MS = 120_000;

/**
 * 往哪儿挂。
 *
 * 优先找页面自己留的**卡槽** `[data-balance-slot]`：位置由那一页的 JSX 说了算 ——
 * 画布页（`.cv-topbar`）顶栏最右紧挨着窗口的系统按钮，余额不该追加到末尾（会钻到
 * 它们底下），它把卡槽放在「已保存」之前。没有卡槽的页面（十来个 `.workspace-header`）
 * 照旧挂到容器末尾，位置由浏览器排。
 *
 * ⚠️ 只认**第一个**。画布右侧抽屉里挂着一批设置页组件，将来谁在里面也放个同名卡槽，
 *    余额会跑进抽屉里 —— 真要放，名字得换。
 */
function balanceHost(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('[data-balance-slot]') ||
    document.querySelector<HTMLElement>('.workspace-header')
  );
}

export default function SiteBalance() {
  const pathname = usePathname();
  const { site } = useSiteAccount();
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHost(null);
    let found = false;
    const find = () => {
      const node = balanceHost();
      if (node && !found) {
        found = true;
        setHost(node);
      }
      return !!node;
    };
    if (find()) return;
    const timers = RETRY_MS.map(delay => window.setTimeout(find, delay));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [pathname]);

  /*
   * 余额自动刷新（2026-09-28）。
   *
   * 站点没有「余额变了主动推给你」这种接口，只能我们定时去问。三个时机：
   *   - **窗口回前台**（`visibilitychange` / `focus`）：最可能刚在别处花完钱，回来第一眼就该是新的。
   *   - **每 2 分钟一趟**：兜住「页面一直挂着，别的地方扣了费」。
   *   - **生成结束**：那两处在画布 / 图片工作室里调（只有真走站点的自定义接口才调）。
   * 窗口在后台（包括被收进系统托盘）时**跳过**定时那一趟 —— 看不见的窗口还一直打站点，
   * 纯属白撞那边 20 次 / 20 分钟的限流。
   *
   * ⚠️ 这个 effect 必须写在上面那句 `return null` **之前**：未登录时组件确实不渲染任何东西，
   *    但定时器不能跟着停 —— 用户一登录就该按新节奏刷起来。
   */
  useEffect(() => {
    let timer = 0;
    let stopped = false;
    /*
     * ⚠️ 改成「跑完一趟再排下一趟」，不再是固定间隔的 setInterval：
     *    撞上限流时后端会带回「歇到什么时候」（`siteCooldownUntil`），
     *    那一趟的间隔必须跟着拉长。固定 2 分钟的话，界面上刚跟用户说「等两三分钟」，
     *    我们自己却还在每 2 分钟撞一次 —— 等于把用户按在限流里出不来。
     */
    const schedule = () => {
      if (stopped) return;
      const wait = nextPollDelayMs(BALANCE_POLL_MS, siteCooldownUntil(), Date.now());
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') void refreshSiteAccount();
        schedule();
      }, wait);
    };
    const tick = () => {
      /* 冷却中 `refreshSiteAccount` 自己会跳过，这里不用再判一次。 */
      if (document.visibilityState === 'visible') void refreshSiteAccount();
    };
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, []);

  if (!host || !site?.loggedIn) return null;

  const who = site.username || site.loginName;
  return createPortal(
    <div
      className="site-balance"
      data-site-balance
      title={
        `${who ? `${who} · ` : ''}${site.baseUrl}` +
        (site.group ? ` · 分组 ${site.group}` : '') +
        ` · 按 ${site.quotaPerYuan} quota = ¥1 换算` +
        (site.error ? `\n${site.error}` : '')
      }
    >
      <span className="site-balance-label">站点余额</span>
      <strong data-site-balance-value>{formatYuan(site.remainingYuan)}</strong>
      {who && <span className="site-balance-who" data-site-balance-who>{who}</span>}
    </div>,
    host,
  );
}
