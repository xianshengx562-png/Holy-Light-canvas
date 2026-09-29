/*
 * 头像 —— 全站唯一的实现。
 *
 * 有图就显示图，没图就用**昵称（取不到就用邮箱）的第一个字**兜底。
 * 抽成组件是因为它现在有两个落点（设置页那颗 96px 的大头像、首页右上角那颗 32px 的小的），
 * 而「取哪个字当兜底」这种规则只要写两遍就会漂 —— 一边是 `name[0]`、另一边还是 `email[0]`，
 * 同一个用户在两处显示成两个不同的字，看起来像两个人。尺寸差异交给 `className`。
 *
 * ⚠️ 不在这里定尺寸、不在这里给 margin：它就是一个圆形容器，摆哪儿、多大，由调用方决定。
 */
type Props = {
  /** `User.avatar`：data URL 或 http(s) 地址，空表示还没设头像。 */
  avatar: string | null | undefined;
  name: string;
  email?: string;
  className?: string;
  /** 挂在最外层容器上的 `data-*`：验收探针靠它找节点（`{'data-avatar': 'home'}`）。 */
  attrs?: Record<string, string>;
};

/**
 * 没有头像时显示的那颗字。中文按第一个字、英文按首字母，都取不到就用问号。
 *
 * ⚠️ `String(.. ?? '')` 不是多余的防御：这个组件挂在**侧栏**上，一旦它抛异常，
 * React 会把整棵树卸载 —— 一个「昵称没取到」就变成整页白屏、连侧栏都没了
 * （2026-09-25 实测：接口回了个没有 name 的对象，这里 `.trim()` 一抛，全站空白）。
 * 兜底成问号最多是头像上显示个「?」，代价差着两个数量级。
 */
export function fallbackInitial(name: string, email: string): string {
  const first = String(name ?? '').trim()[0] || String(email ?? '').trim()[0] || '?';
  return first.toUpperCase();
}

export default function UserAvatar({ avatar, name, email, className, attrs }: Props) {
  const initial = fallbackInitial(name, email || '');
  return <span className={className} aria-hidden {...attrs}>
    {avatar
      ? <img src={avatar} alt="" data-avatar-img />
      : <span className="avatar-initial" data-avatar-initial>{initial}</span>}
  </span>;
}
