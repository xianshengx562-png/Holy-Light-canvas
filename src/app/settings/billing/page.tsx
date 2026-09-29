'use client';

/*
 * 计费页（2026-09-18 从服务端组件改成客户端取数）。
 *
 * 原来这一页在服务端直读：`expireStaleOrders()` → 三路并发（订单 / 订阅 / 余额）。
 * 桌面版没有服务端渲染这一步，改打 `/api/settings/billing/bootstrap` ——
 * 那个接口**逐行照抄了这里原来的读法**（同一个 expire、同样的三路并发、同样的整形函数），
 * 所以桌面版和 web 版看到的是同一份数字，不是两套算法。
 *
 * 客户端仍然只在「下单 / 支付 / 查单」这些必须走 HTTP 的动作上打接口。
 */
import Link from 'next/link';
import SideNav from '@/components/start/SideNav';
import BillingPanel from '@/components/settings/BillingPanel';
import SettingsNav from '@/components/settings/SettingsNav';
import { useApi } from '@/lib/client';
/* 全是 `import type`：这三个模块都连着数据库，值导入会把整条依赖拖进浏览器包。 */
import type { WalletOverview } from '@/lib/wallet';
import type { PublicOrder } from '@/lib/payments/orders';
import type { SubscriptionSummary } from '@/lib/payments/subscriptions';
import type { TopUpPlan, SubscriptionPlan } from '@/lib/payments/plans';

type Payload = {
  wallet: WalletOverview;
  orders: PublicOrder[];
  subscription: SubscriptionSummary | null;
  providers: string[];
  plans: { topup: TopUpPlan[]; subscription: SubscriptionPlan[] };
};

export default function Billing() {
  const { data, loading, error } = useApi<Payload>('/api/settings/billing/bootstrap');
  return <div className="shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">✦</span> Holy Light画布</Link>
      <SideNav active="settings" />
    </aside>
    <section className="workspace">
      <header className="workspace-header"><strong>设置</strong><Link className="button secondary" href="/">返回项目</Link></header>
      <main className="content">
        <div className="page-heading"><div><div className="eyebrow">BILLING</div><h1>计费</h1></div></div>
        <SettingsNav active="/settings/billing" />
        {error && <div className="notice error">读不到账单：{error}</div>}
        {loading && !data && <div className="notice">正在读取账单…</div>}
        {data && <BillingPanel
          initialWallet={data.wallet}
          initialOrders={data.orders}
          initialSubscription={data.subscription}
          providers={data.providers}
          plans={data.plans}
        />}
      </main>
    </section>
  </div>;
}
