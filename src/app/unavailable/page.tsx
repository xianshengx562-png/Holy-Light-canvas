import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isDesktop } from '@/lib/edition';

/**
 * 桌面版把收起来的那些入口统一重写到这里（见 `middleware.ts`）。
 *
 * 为什么需要一整个页面而不是直接回 404：这类路径在桌面版里**曾经存在过**
 * （登录、计费……），冷冰冰一个 404 只会让人以为软件坏了。
 * 说清「这个版本就是没有它」＋给两个能去的出口，比一个状态码有用得多。
 *
 * 云端版访问它会 `notFound()` —— 那一版所有入口都还在，这个页面没有任何意义。
 */
export default function Unavailable() {
  if (!isDesktop) notFound();
  return <main className="content">
    <div className="page-heading"><div><div className="eyebrow">DESKTOP EDITION</div><h1>桌面版没有这个界面</h1></div></div>
    <div className="notice">
      Holy Light画布桌面版只做一件事：在你自己机器的 ComfyUI 上出图、出视频。
      登录、计费、云端连接这些属于云端版，桌面版里没有保留 —— 你也没有输错地址。
    </div>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 20 }}>
      <Link className="button" href="/">回到项目</Link>
      <Link className="button secondary" href="/settings/comfyui">ComfyUI 服务设置</Link>
    </div>
  </main>;
}
