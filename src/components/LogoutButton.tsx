import { isDesktop } from '@/lib/edition';

/**
 * 退出登录。**桌面版不渲染它**：那一版没有登录（`lib/auth/session.ts` 里固定用本机用户），
 * 放一个点了只会跳去「桌面版没有这个界面」的按钮，不如根本没有。
 *
 * 抽成组件而不是在三个页面里各写一个 `!isDesktop`：那正是 `SideNav` 当初被抽出来的原因 ——
 * 同一个判断散在多处，加页面时漏一处的表现是「这个页面有个点了没用的按钮」。
 */
export default function LogoutButton() {
  if (isDesktop) return null;
  return <form action="/api/auth/logout" method="post">
    <button className="subtle" type="submit">退出登录</button>
  </form>;
}
