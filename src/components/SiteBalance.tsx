'use client';

/*
 * 账号卡 —— **每一页**页头的右上角（2026-09-25 加，2026-10-13 去掉余额）。
 *
 * 🔴 **2026-10-13 口径翻转**：徐先「还是不要显示余额了」→ 这张卡里的金额去掉，
 *    **连带把「每 2 分钟问一次站点」那趟也停了**。理由：那趟请求的唯一目的就是
 *    显示余额，不显示就没有理由去打站点 —— 站点那边是「同一 IP、20 次 / 20 分钟」，
 *    而余额那趟一直是最大的一笔开销（比续期登录还多）。
 *    现在只剩「打开用户页 / 模型服务页时读一次」那种**用户自己触发**的读。
 *    ⚠️ 要加回来时，别只加回 `<strong>`，那趟轮询也得跟着加回来 —— 只显示不刷新
 *    等于显示一个永远不动的旧数字，比不显示更糟。
 *
 * 为什么用 portal 挂进 `.workspace-header` 而不是在每个页面里各放一次：
 * 有 `.workspace-header` 的页面有十来个，而且它们的右端各不相同（「返回项目」、
 * 「新建项目」、首页那颗头像）。逐个塞进去要改十几个文件，将来新增一页还得记得再塞一次 ——
 * 漏掉的表现是「这一页没有账号卡」，而没人会想到是忘了写这一行。
 * 挂在页头容器里（而不是 `position: fixed` 悬浮）还有个好处：它是 flex 的**最后一个**孩子，
 * 位置由浏览器排，永远不会压到已有的按钮上。
 *
 * 没身份（本机用户 / 站点账号都没有）时**整个不渲染**（不是显示一个空壳）。
 * 2026-10-02 之后它是一张**账号卡**（之前是「站点余额 ¥9.95 | xxs」），
 * 所以判据不再单看站点登录状态 —— 卡里带着头像，不能因为「站点掉线」把身份也藏掉。
 *
 * 数据来自 `lib/site-account.ts` 那个共享 store：侧栏 / 用户页读的是同一份，全站只读一趟。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from '@/shims/router';
import { useSession } from '@/lib/client';
import UserAvatar from '@/components/UserAvatar';
import { useSiteAccount } from '@/lib/site-account';

/**
 * 页头是**随路由换掉**的：hash 一变，旧节点就没了，得重新找。
 * 而且页面里有懒加载的内容，节点可能晚一两帧才出现，所以换路由后再补找几次。
 */
const RETRY_MS = [80, 300, 900];

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
  /*
   * ⚠️ 这个 hook **必须**待在下面那些提前 `return null` 之前：
   *    `host` 是先 null 后才有值的（portal 要等页头渲染出来），
   *    把 hook 写在 early return 后面 = 同一个组件两次渲染的 hook 数量不一样，
   *    React 会直接抛 "Rendered fewer hooks than expected"。
   */
  const { user } = useSession();
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
   * 🔴 2026-10-13：**这里原来挂着一个「每 2 分钟 + 回前台就刷余额」的 effect，删了。**
   *
   * 那趟请求的唯一目的就是让页头那个数字保持新鲜。余额不显示了，它就成了纯消耗 ——
   * 站点那边是「同一 IP、20 次 / 20 分钟」，而它一直是账上最大的一笔
   * （每 20 分钟 10 趟，比续期登录那 1~2 趟多得多）。
   *
   * ⚠️ 余额现在只在**用户自己打开**「用户页 / 模型服务页」时读一次
   *    （那条走的是 `/api/site-account` 全量读，顺带拿令牌清单）。
   *
   * ⚠️ 要恢复显示，别只把 `<strong>` 加回来 —— 轮询也得一起加回来，
   *    否则页头会挂着一个永远不动的旧数字，比不显示更糟。
   */

  if (!host) return null;

  /*
   * 2026-10-02 徐先：「这里的卡片结合，分为头像和名称和余额……」
   * 2026-10-13 徐先：「还是不要显示余额了」→ 金额那一段去掉，卡片回到 **头像 + 名称**。
   *
   * 🔴 渲染条件是「有身份就渲染」—— 卡里带着头像，不能因为「站点掉线 / 还没配站点」
   *    把**身份**也一起藏掉。桌面版 `useSession()` 永远给得出本机用户，所以头像不会消失。
   */
  const who = site?.username || site?.loginName || user?.name || '';
  if (!who) return null;

  const title =
    who +
    (site ? ` · ${site.baseUrl}` : '') +
    (site?.group ? ` · 分组 ${site.group}` : '') +
    (site?.error ? `\n${site.error}` : '');

  return createPortal(
    <div className="site-balance" data-site-balance title={title}>
      <UserAvatar
        avatar={user?.avatar}
        name={user?.name || who}
        email={user?.email}
        className="site-balance-avatar"
        attrs={{ 'data-avatar': 'balance' }}
      />
      <span className="site-balance-who" data-site-balance-who>{who}</span>
    </div>,
    host,
  );
}
