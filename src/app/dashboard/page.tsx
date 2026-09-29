import { redirect } from 'next/navigation';

/**
 * `/dashboard` 曾经是登录后的首页，2026-09-17 让位给主界面 `/`。
 *
 * 留一条 307 兜住所有旧引用：老书签、外站链接、以及一时还没改过来的 `href`。
 * 真正的界面在 `app/page.tsx`（主界面），这里**不要再长任何内容** ——
 * 两份首页迟早会长歪，而「哪一份才是真的」会变成一个没人答得上来的问题。
 */
export default function Dashboard() {
  redirect('/');
}
