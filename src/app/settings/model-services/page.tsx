'use client';

/*
 * 设置 · 模型服务（2026-09-21）。
 *
 * 这一页既管**这次生成到底走谁**，也管**每家的密钥**：RunningHub 走哪个站、
 * 提示词优化用哪家文本模型、自定义接口挂了哪些模型、各家的 key 填在哪，全在这一屏 ——
 * 2026-09-25「密钥中心」整页撤掉之后，填 key 只剩这一处。
 *
 * 数据一次拿全（`/api/settings/model-services`）：四段内容的来源各不相同，
 * 分四次取会出现「两段已就绪、两段还在转圈」的半张脸界面。
 */
import Link from 'next/link';
import SideNav from '@/components/start/SideNav';
import SettingsNav from '@/components/settings/SettingsNav';
import ModelServices, { type ModelServicesPayload } from '@/components/settings/ModelServices';
import { useApi } from '@/lib/client';
import './model-services.css';

export default function ModelServicesPage() {
  const { data, loading, error, reload } = useApi<ModelServicesPayload>('/api/settings/model-services');
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
          <div><div className="eyebrow">MODEL SERVICES</div><h1>模型服务</h1></div>
        </div>
        <SettingsNav active="/settings/model-services" />
        {/* 2026-10-01 第五轮：原来四行里有两行是「密钥怎么存」的科普，破了「结论 —— 解释」的形，
            而且 `**用途**` 在 JSX 里是字面星号（界面上原样显示）。压成一句。 */}
        <div className="notice" data-ms-intro>
          按用途分成文本 / 图片 / 视频三段，在哪一段加的只作用于哪一段的节点。
        </div>
        {error && <div className="notice error">读不到模型服务：{error}</div>}
        {loading && !data && <div className="notice">正在读取模型服务…</div>}
        {data && <ModelServices initial={data} reload={reload} />}
      </main>
    </section>
  </div>;
}
