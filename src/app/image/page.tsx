'use client';

/*
 * `/image` —— 图片生成全页界面（2026-09-21 新增）。
 *
 * 首页「图片生成」卡片跳这里。版式与出图逻辑都在 `ImageStudio` 组件里
 * （左侧历史栏 + 中间大区 + 底部生成条），这一页只负责套壳：
 * 侧栏与页头沿用全站的 shell，下面整块交给组件。
 */
import Link from 'next/link';
import SideNav from '@/components/start/SideNav';
import ImageStudio from '@/components/start/ImageStudio';
import { isDesktop } from '@/lib/edition';
import { useSession } from '@/lib/client';

export default function ImagePage() {
  const { user } = useSession();
  return <div className="shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">✦</span> Holy Light画布</Link>
      <SideNav active="projects" />
      {!isDesktop && user && <div className="side-bottom">
        <div className="account">{user.name}<br />{user.email}</div>
      </div>}
    </aside>
    <section className="workspace">
      <header className="workspace-header">
        <div>
          <strong>图片生成</strong>
          <br />
          <small>不走画布，选好比例与分辨率直接出片；结果自动存进资产库</small>
        </div>
      </header>
      <main className="content studio-page">
        <ImageStudio />
      </main>
    </section>
  </div>;
}
