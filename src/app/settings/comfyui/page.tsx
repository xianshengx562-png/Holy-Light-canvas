'use client';

/*
 * 「ComfyUI 服务」—— 本机 ComfyUI 的**唯一一页**。
 *
 * （2026-09-20）用户要的：能**一键启动**本机 ComfyUI，并把服务状态摊开看
 * ——GPU 显存够不够、模型在不在、连上没连上、目录对不对。
 *
 * （2026-09-21）原来还有一页「本机 ComfyUI」（`/settings/local`）。两页重复了四样东西：
 * 服务地址、安装目录、测试连接、目录扫描 —— 改地址要去 A 页、看连没连上要去 B 页，
 * 而新做的进程发现 / 模型清单还只在这一页有。那一页已经删掉，全部并到这里：
 * 填地址 / 找目录 → 看连没连上 → 没起来就一键启动 → 看模型清单，一页走完。
 *
 * ⚠️ 桌面版才有这一页的完整能力（启动器走主进程 IPC）。web 版也走这一页，
 * 差别是：web 版多一个「本地模式」开关（决定生成走本机还是云端），没有启动按钮。
 */
import Link from 'next/link';
import SideNav from '@/components/start/SideNav';
import SettingsNav from '@/components/settings/SettingsNav';
import ComfyuiServicePanel from '@/components/settings/ComfyuiServicePanel';
import type { LocalConnectionView } from '@/lib/providers/local/connection';
import { isDesktop } from '@/lib/edition';
import { useApi } from '@/lib/client';
import '@/app/comfyui-service.css';

export default function ComfyuiServiceSettings() {
  const { data: view, loading, error } = useApi<LocalConnectionView>('/api/local/connection');
  return <div className="shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">✦</span> Holy Light画布</Link>
      <SideNav active="settings" />
    </aside>
    <section className="workspace">
      <header className="workspace-header">
        <strong>设置</strong>
        <Link className="button secondary" href="/">返回项目</Link>
      </header>
      <main className="content">
        <div className="page-heading">
          <div>
            <div className="eyebrow">{isDesktop ? 'COMFYUI SERVICE' : 'LOCAL MODE'}</div>
            <h1>{isDesktop ? 'ComfyUI 服务' : '本地模式'}</h1>
          </div>
          <p className="muted">{isDesktop ? '仅本机访问，不提供局域网访问' : '出图出视频改跑在你自己的机器上'}</p>
        </div>
        <SettingsNav active="/settings/comfyui" />
        {error && <div className="notice error">读不到本机连接配置：{error}</div>}
        {loading && !view && <div className="notice">正在读取本机连接…</div>}
        {view && !isDesktop && <div className="notice">{view.enabled
          ? '本地模式已开启：画布上的生成会投到你这台机器的 ComfyUI，不经过 RunningHub、也不扣余额。字段绑定沿用「设置 · 工作流配置」里那份，不用重新配。'
          : '现在跑的是云端。打开下面的「本地模式」开关后，生成改投你自己的 ComfyUI —— 用的是你自己显卡上的模型，不扣费、也不把素材传到别处。'}</div>}
        {view && <ComfyuiServicePanel initial={view} />}
      </main>
    </section>
  </div>;
}
