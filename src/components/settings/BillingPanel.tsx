'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { WalletOverview } from '@/lib/wallet';
import type { TopUpPlan, SubscriptionPlan } from '@/lib/payments/plans';
import type { PublicOrder } from '@/lib/payments/orders';
import type { SubscriptionSummary } from '@/lib/payments/subscriptions';
import type { ChargePayload } from '@/lib/payments/types';

/**
 * 计费面板。
 *
 * 只做三件必须走 HTTP 的事：下单、付款、查单。余额/订单/订阅这些读操作走
 * 服务端渲染 + `router.refresh()` —— 客户端自己缓存一份余额，是「界面显示有钱、
 * 实际生成时被拒」这类矛盾的经典来源。
 *
 * 轮询查单这一步不是装饰：`GET /api/payments/orders/[orderNo]` 在本地还是 pending 时
 * 会主动向渠道查一次并就地结算。所以「回调丢了」这种最常见故障，靠这个轮询就能自己补上。
 */

const STATUS_TEXT: Record<string, string> = {
  pending: '等待支付',
  paid: '已支付',
  failed: '支付失败',
  expired: '已过期',
  refunded: '已退款',
};

const STATUS_CLASS: Record<string, string> = {
  paid: 'ok',
  pending: 'warn',
  refunded: 'mute',
  failed: 'off',
  expired: 'mute',
};

/** 轮询节奏：2 秒一次、最多 45 次（约 90 秒）。到点就停，别让页面永远在转。 */
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_TRIES = 45;

type Pending = {
  orderNo: string;
  provider: string;
  payload: ChargePayload;
  planLabel: string;
  amountLabel: string;
  /** 渠道回调地址，用于手工 curl 造回调 / 配渠道后台 */
  notifyUrl: string | null;
};

type Flash = { ok: boolean; message: string };

export default function BillingPanel({
  initialWallet,
  initialOrders,
  initialSubscription,
  providers,
  plans,
}: {
  initialWallet: WalletOverview;
  initialOrders: PublicOrder[];
  initialSubscription: SubscriptionSummary | null;
  providers: string[];
  plans: { topup: TopUpPlan[]; subscription: SubscriptionPlan[] };
}) {
  const router = useRouter();
  const [orders, setOrders] = useState(initialOrders);
  const [subscription, setSubscription] = useState(initialSubscription);
  const [wallet, setWallet] = useState(initialWallet);
  const [channelList, setChannelList] = useState(providers);

  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [polls, setPolls] = useState(0);

  const stopPoll = useRef(false);

  /** 重新拉一遍列表。轮询命中付款成功、或从渠道那边知道状态变了，都走这里。 */
  const reload = useCallback(async () => {
    try {
      const response = await fetch('/api/payments/orders', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) return;
      setOrders(data.orders);
      setSubscription(data.subscription);
      setWallet(data.wallet);
      setChannelList(data.providers);
    } catch {
      // 读失败不改动界面：显示旧数据比显示「一片空白」好，下次轮询还会再试。
    }
  }, []);

  /** 下单。请求体里只有一个 planId —— 金额由服务端定价表算，客户端没有说话的份。 */
  async function startOrder(planId: string) {
    setBusy(planId);
    setFlash(null);
    try {
      const response = await fetch('/api/payments/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId }),
      });
      const data = await response.json();
      if (!response.ok) { setFlash({ ok: false, message: data.error || '下单失败。' }); return; }
      stopPoll.current = false;
      setPolls(0);
      setPending({
        orderNo: data.order.orderNo,
        provider: data.provider,
        payload: data.payload,
        planLabel: data.order.planLabel,
        amountLabel: data.order.amountLabel,
        notifyUrl: data.notifyUrl ?? null,
      });
      setOrders(current => [data.order, ...current.filter(order => order.orderNo !== data.order.orderNo)]);
    } catch {
      setFlash({ ok: false, message: '请求失败，请检查网络后重试。' });
    } finally {
      setBusy(null);
    }
  }

  /** 假网关的「模拟支付」。真投回调；`deliverNotify:false` 用来演示「回调丢失靠查单补上」。 */
  async function mockPay(deliverNotify: boolean) {
    if (!pending) return;
    setBusy(deliverNotify ? 'mock-pay' : 'mock-drop');
    setFlash(null);
    try {
      const response = await fetch('/api/payments/mock/pay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderNo: pending.orderNo, deliverNotify }),
      });
      const data = await response.json();
      if (!response.ok) {
        setFlash({ ok: false, message: data.error || `模拟支付失败（HTTP ${response.status}）。` });
        // 即便回调被拒，渠道那份账里也已经记成已付了，所以照样查一次单把真相捞回来。
        await reload();
        return;
      }
      setFlash({
        ok: true,
        message: deliverNotify
          ? `渠道已回调（HTTP ${data.notifyStatus}），正在确认到账…`
          : '已模拟「回调丢失」：渠道账上是已付，但通知没送到。下面这次轮询会靠查单把它补上。',
      });
      await reload();
    } catch {
      setFlash({ ok: false, message: '请求失败，请检查网络后重试。' });
    } finally {
      setBusy(null);
    }
  }

  /*
   * 轮询查单。pending 一变就开始，成功/失败/到次数/卸载都停下 ——
   * 一个永远不自我终止的 setInterval 会在页面跳走后继续打接口，而且没人会注意到。
   */
  useEffect(() => {
    if (!pending) return;
    let tries = 0;
    const timer = setInterval(async () => {
      if (stopPoll.current) return;
      tries += 1;
      setPolls(tries);
      try {
        const response = await fetch(`/api/payments/orders/${pending.orderNo}`, { cache: 'no-store' });
        const data = await response.json();
        if (response.ok && data.order) {
          const status: string = data.order.status;
          setOrders(current => current.map(order => order.orderNo === pending.orderNo ? data.order : order));
          if (status === 'paid') {
            clearInterval(timer);
            setPending(null);
            setFlash({
              ok: true,
              message: data.settledNow
                ? `${pending.planLabel} 已支付，余额已到账。`
                : `${pending.planLabel} 已到账（这笔之前已经入过账，未重复发放）。`,
            });
            router.refresh();
            await reload();
            return;
          }
          if (status === 'failed' || status === 'expired' || status === 'refunded') {
            clearInterval(timer);
            setPending(null);
            setFlash({ ok: false, message: `这笔订单的状态变成了「${STATUS_TEXT[status] ?? status}」。` });
            router.refresh();
            await reload();
            return;
          }
        }
      } catch {
        // 单次失败忽略：轮询本身就是要容忍抖动的。
      }
      if (tries >= POLL_MAX_TRIES) {
        clearInterval(timer);
        setFlash({
          ok: false,
          message: '等了 90 秒还没确认到账。付过款的话刷新页面，或点「立即查单」。',
        });
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pending, reload, router]);

  /** 手工触发一次查单（不依托轮询）。 */
  async function checkNow(orderNo: string) {
    setBusy(`check-${orderNo}`);
    setFlash(null);
    try {
      const response = await fetch(`/api/payments/orders/${orderNo}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) { setFlash({ ok: false, message: data.error || '查单失败。' }); return; }
      setOrders(current => current.map(order => order.orderNo === orderNo ? data.order : order));
      setFlash({
        ok: data.order.status === 'paid',
        message: data.settledNow
          ? '渠道说这笔已付，已补记入账。'
          : `订单状态：${STATUS_TEXT[data.order.status] ?? data.order.status}`,
      });
      router.refresh();
      await reload();
    } catch {
      setFlash({ ok: false, message: '请求失败，请检查网络后重试。' });
    } finally {
      setBusy(null);
    }
  }

  const mine = (order: PublicOrder) => pending?.orderNo === order.orderNo;

  return <>
    <div className="billing-balance">
      <div>
        <div className="muted">余额</div>
        <strong>{wallet.unlimited ? '不限' : `¥${(wallet.balance / 100).toFixed(2)}`}</strong>
      </div>
      <dl className="key-meta">
        <div><dt>白名单账号</dt><dd className={wallet.unlimited ? 'ok' : 'warn'}>{wallet.unlimited ? '不限扣费' : '按次扣费'}</dd></div>
        <div><dt>生成计费</dt><dd className={wallet.unlimited ? 'ok' : 'warn'}>{wallet.unlimited ? '不扣费' : `每次 ¥${(wallet.costPerGenerationFen / 100).toFixed(2)}`}</dd></div>
        <div><dt>注册赠送</dt><dd>¥${(wallet.signupBonusFen / 100).toFixed(2)}</dd></div>
        <div>
          <dt>支付渠道</dt>
          <dd className={channelList.length ? 'ok' : 'off'}>{channelList.length ? channelList.join(' / ') : '未配置可用渠道'}</dd>
        </div>
      </dl>
    </div>

    {!channelList.length && <div className="notice">
      当前没有可用的支付渠道。请检查 `.env` 里的 `PAYMENT_PROVIDER`；想在本地跑通支付流程，
      设 `PAYMENT_PROVIDER=mock` + `PAYMENTS_ALLOW_MOCK=1` + 一个随机 `MOCK_PAY_SECRET`。
    </div>}

    {flash && <p className={flash.ok ? 'key-result ok' : 'key-result off'}>{flash.message}</p>}

    {pending && <section className="provider pay-panel">
      <div className="provider-head">
        <div>
          <h2>待支付 · {pending.planLabel}</h2>
          <p className="muted">{pending.amountLabel} ｜ 单号 {pending.orderNo} ｜ 渠道 {pending.provider}</p>
        </div>
        <span className="badge">订单 15 分钟内有效</span>
      </div>

      {pending.payload.mode === 'manual' && <div className="notice">{pending.payload.note}</div>}

      {pending.payload.mode === 'qr' && <div className="pay-qr">
        <p className="muted">用对应 App 扫描下方内容（当前没有二维码渲染库，这里直接给出原始字符串）：</p>
        <code>{pending.payload.qrText}</code>
      </div>}

      {pending.payload.mode === 'redirect' && <div className="pay-qr">
        <p className="muted">跳转到渠道收银台完成支付：</p>
        <a className="button" href={pending.payload.url} target="_blank" rel="noreferrer">打开收银台</a>
      </div>}

      {pending.payload.mode === 'jsapi' && <div className="pay-qr">
        <p className="muted">渠道调起参数（交给渠道 SDK 使用）：</p>
        <code>{JSON.stringify(pending.payload.params, null, 2)}</code>
      </div>}

      <div className="key-actions">
        {pending.provider === 'mock' && <>
          <button className="button" type="button" disabled={busy !== null} onClick={() => void mockPay(true)}>
            {busy === 'mock-pay' ? '提交中…' : '模拟支付（真回调）'}
          </button>
          <button className="button secondary" type="button" disabled={busy !== null} onClick={() => void mockPay(false)}>
            {busy === 'mock-drop' ? '提交中…' : '模拟支付（回调丢失）'}
          </button>
        </>}
        <button className="button secondary" type="button" disabled={busy !== null} onClick={() => void checkNow(pending.orderNo)}>
          立即查单
        </button>
        <button className="button secondary" type="button" onClick={() => { stopPoll.current = true; setPending(null); }}>取消</button>
      </div>

      {pending.notifyUrl && <p className="muted">
        回调地址（配置渠道后台用）：<code>{pending.notifyUrl}</code>
      </p>}
      {polls > 0 && <p className="muted">已查单 {polls} 次…</p>}
    </section>}

    <div className="section-head"><h2>余额充值</h2><span className="muted">一次性充值，永久有效</span></div>
    <div className="billing-grid">
      {plans.topup.map(plan => <button
        key={plan.id}
        type="button"
        className={plan.highlight ? 'plan-card highlight' : 'plan-card'}
        disabled={busy !== null || !channelList.length}
        onClick={() => void startOrder(plan.id)}
      >
        <span className="plan-name">{plan.label}{plan.highlight && <em>推荐</em>}</span>
        <strong className="plan-price">{(plan.amountFen / 100).toFixed(2)}<small> 元</small></strong>
        <span className="plan-credits">到账 ¥{(plan.amountFen / 100).toFixed(2)}</span>
        <span className="plan-note">{plan.note || `约 ${Math.floor(plan.amountFen / Math.max(1, wallet.costPerGenerationFen))} 次生成`}</span>
        <span className="plan-cta">{busy === plan.id ? '下单中…' : '充值'}</span>
      </button>)}
    </div>

    <div className="section-head">
      <h2>订阅套餐</h2>
      <span className="muted">到期需手动续费，提前续费顺延。</span>
    </div>
    <div className="billing-grid">
      {plans.subscription.map(plan => <button
        key={plan.id}
        type="button"
        className={plan.highlight ? 'plan-card highlight' : 'plan-card'}
        disabled={busy !== null || !channelList.length}
        onClick={() => void startOrder(plan.id)}
      >
        <span className="plan-name">{plan.label}{plan.highlight && <em>推荐</em>}</span>
        <strong className="plan-price">{(plan.amountPerPeriodFen / 100).toFixed(2)}<small> 元/{plan.days} 天</small></strong>
        <span className="plan-credits">每期 ¥{(plan.amountPerPeriodFen / 100).toFixed(2)}</span>
        <span className="plan-note">{plan.note || `${plan.days} 天一期`}</span>
        <span className="plan-cta">{busy === plan.id ? '下单中…' : subscription?.active && subscription.planId === plan.id ? '续费顺延' : '订阅'}</span>
      </button>)}
    </div>

    <div className="section-head"><h2>当前订阅</h2></div>
    {subscription
      ? <section className="provider">
        <div className="provider-head">
          <div><h2>{subscription.planLabel}</h2><p className="muted">每期 ¥{(subscription.amountPerPeriodFen / 100).toFixed(2)}</p></div>
          <span className="badge">{subscription.active ? `剩余 ${subscription.daysLeft} 天` : '已失效'}</span>
        </div>
        <dl className="key-meta">
          <div><dt>状态</dt><dd className={subscription.active ? 'ok' : 'off'}>{subscription.active ? '生效中' : subscription.status}</dd></div>
          <div><dt>本期起</dt><dd>{new Date(subscription.currentPeriodStart).toLocaleString('zh-CN')}</dd></div>
          <div><dt>本期止</dt><dd>{new Date(subscription.currentPeriodEnd).toLocaleString('zh-CN')}</dd></div>
          <div><dt>自动续费</dt><dd className="warn">{subscription.autoRenew ? '已开启' : '未开启（需手动续费）'}</dd></div>
        </dl>
      </section>
      : <div className="empty">
        <div className="empty-icon">✦</div>
        <h3>还没有订阅</h3>
        <p>订阅按周期发放余额，生成仍然扣余额。</p>
      </div>}

    <div className="section-head"><h2>订单记录</h2><span className="muted">最近 50 笔</span></div>
    {orders.length
      ? <div className="order-list">
        <div className="order-row head">
          <span>单号</span><span>内容</span><span>金额</span><span>到账</span><span>状态</span><span />
        </div>
        {orders.map(order => <div key={order.orderNo} className={mine(order) ? 'order-row active' : 'order-row'}>
          <span className="order-no" title={order.orderNo}>{order.orderNo}</span>
          <span>{order.planLabel}<em className="order-kind">{order.kind === 'subscription' ? '订阅' : '充值'}</em></span>
          <span>{order.amountLabel}</span>
          <span>+¥{(order.grantedFen / 100).toFixed(2)}</span>
          <span className={`order-status ${STATUS_CLASS[order.status] ?? 'mute'}`}>{STATUS_TEXT[order.status] ?? order.status}</span>
          <span className="order-act">
            {order.status === 'pending' && <button className="text-link" type="button" disabled={busy !== null} onClick={() => void checkNow(order.orderNo)}>
              {busy === `check-${order.orderNo}` ? '查询中…' : '查单'}
            </button>}
          </span>
        </div>)}
      </div>
      : <div className="empty">
        <div className="empty-icon">✦</div>
        <h3>还没有订单</h3>
        <p>上面选一个充值套餐或订阅套餐，订单会出现在这里。</p>
      </div>}

  </>;
}
