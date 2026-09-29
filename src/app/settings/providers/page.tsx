'use client';

/*
 * 服务连接（2026-09-18 从服务端组件改成客户端取数）。
 *
 * ⚠️ 2026-09-22：**桌面版这一页整页并进了「设置 · 模型服务」**（徐先：这两个重复了吧）。
 * 它只有 RunningHub 一件事，而 RunningHub 的选站 / Key / 测试在模型服务页里本来就有 ——
 * 同一件事摆两页，用户不知道该信哪一页。填 Key / 清除密钥现在在模型服务页的 RunningHub 段。
 *
 * 这一页**只留给 web 版**：web 的导航里没有「模型服务」这一项，删了 web 用户就没处配 RunningHub。
 * 桌面版仍然访问 `/settings/providers` 也不会看到第二份界面 —— 路由换页到模型服务（见 `App.tsx`）。
 *
 * 原来这一页在服务端并发调 `describeConnection()` / `walletOverview()`，
 * 桌面版换到 `/api/settings/providers/bootstrap` —— **一个接口一次拿全**，不是图省事：
 * 「填没填自己的 key」和「余额够不够」是同一件事的两面，分两次取会出现一瞬间
 * 「已配置 + 余额未知」的半张脸，那种状态最难解释。
 *
 * 2026-09-21 之前这里还并发调 `readChatConnection()`（对话中转 API 那一份），
 * 对话整块移除后，这一页就只剩生成链路这一件事了。
 */
import Link from 'next/link';
import { SlidersHorizontal } from 'lucide-react';
import SideNav from '@/components/start/SideNav';
import RunningHubKeyForm from '@/components/settings/RunningHubKeyForm';
import SettingsNav from '@/components/settings/SettingsNav';
import { useApi } from '@/lib/client';
import { isDesktop } from '@/lib/edition';
/*
 * 下面两个都是 `import type`：它们所在的模块连着数据库，但只要不值导入，
 * 编译期就会被擦掉，浏览器包里不会多出一行运行时代码。
 */
import type { WalletOverview } from '@/lib/wallet';
import type { ConnectionView } from '@/lib/providers/runninghub/connection';

type Payload = {
  connection: ConnectionView;
  wallet: WalletOverview;
  defaultWorkflowId: string;
};

export default function Providers() {
  const { data, loading, error } = useApi<Payload>('/api/settings/providers/bootstrap');
  const connection = data?.connection;
  /** 桌面版没有钱包：给表单传 null，余额那一行整行不渲染（见 RunningHubKeyForm）。 */
  const credits = isDesktop ? null : (data?.wallet ?? null);

  const billing = !credits
    ? ''
    : credits.unlimited
      ? '当前账号在免扣费白名单里。'
      : connection?.source === 'user'
        ? '你填了自己的密钥，生成不扣费。'
        : `未填自己的密钥时会使用站点公共密钥，每次生成扣 ¥${(credits.costPerGenerationFen / 100).toFixed(2)}（余额 ¥${(credits.balance / 100).toFixed(2)}）。`;

  return <div className="shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">✦</span> Holy Light画布</Link>
      <SideNav active="settings" />
    </aside>
    <section className="workspace"><header className="workspace-header"><strong>设置</strong><Link className="button secondary" href="/">返回项目</Link></header><main className="content"><div className="page-heading"><div><div className="eyebrow">AI PROVIDERS</div><h1>服务连接</h1></div></div>
      <SettingsNav active="/settings/providers" />
      {error && <div className="notice error">读不到服务连接：{error}</div>}
      {loading && !data && <div className="notice">正在读取服务连接…</div>}
      <section className="provider"><div className="provider-head"><div><h2>RunningHub</h2><p className="muted">工作流与算力服务</p></div><span className="badge">{connection?.hasKey ? '已配置' : '未配置'}</span></div>
        <div className="notice">{connection?.source === 'user'
          ? `已为你的账号单独保存密钥，优先级高于服务端环境变量。当前默认工作流：${data?.defaultWorkflowId ?? ''}`
          : connection?.source === 'env'
            ? `当前使用服务端环境变量中的密钥。你可以在下方填写自己的密钥覆盖它。当前默认工作流：${data?.defaultWorkflowId ?? ''}`
            : '尚未配置密钥。请在下方填写，或由管理员在项目 .env 中配置 RUNNINGHUB_API_KEY。'}</div>
        {billing && <div className="notice">{billing}</div>}
        {connection && <RunningHubKeyForm initial={connection} credits={credits} />}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 24 }}><Link className="button" href="/settings/providers/workflows"><SlidersHorizontal size={16} />工作流列表与配置</Link></div>
      </section></main></section></div>;
}
