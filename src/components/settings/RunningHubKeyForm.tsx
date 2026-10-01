'use client';
import { useState } from 'react';
import type { WalletOverview } from '@/lib/wallet';
import type { ConnectionView } from '@/lib/providers/runninghub/connection';

type Check = { ok: boolean; message: string };
type Action = 'save' | 'test' | 'clear';

const sourceText: Record<ConnectionView['source'], string> = {
  user: '账号级密钥 · 已保存在数据库',
  env: '服务端环境变量密钥 · 未在此处设置',
  'shared-disabled': '站点未开启共享密钥 · 请在此处填写你自己的 key',
  none: '尚未配置密钥',
};

/**
 * `credits` 允许为 null —— **桌面版没有钱包**，那一栏不该显示成「余额 ¥0.00」
 * （看着像欠费，实际是这版根本不卖积分）。传 null 时余额与计费两行整行不渲染。
 */
export default function RunningHubKeyForm({ initial, credits: initialCredits, compact = false, onChanged }: {
  initial: ConnectionView;
  credits: WalletOverview | null;
  /**
   * `compact`：嵌在「设置 · 模型服务」的 RunningHub 段里用。
   *
   * 那一段的站点卡上已经写着接口地址、当前密钥掩码和连接状态，这张表不再重复第二遍；
   * 「测试连接」也不再放第二颗 —— 卡上那颗测的就是同一个连接，两颗一个意思的按钮只会
   * 让人犹豫点哪个。
   */
  compact?: boolean;
  /**
   * 保存 / 清除成功之后通知外面重新取数。
   *
   * 模型服务页上还有别处在显示同一份状态（站点卡的「已配置 / 未配置」和密钥掩码）——
   * 表单自己 `setView` 只更新自己那一份，外面不重取就是「下面说已配置、上面还说未配置」。
   */
  onChanged?: () => void;
}) {
  const [view, setView] = useState(initial);
  const [credits, setCredits] = useState(initialCredits);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<Action | null>(null);
  const [check, setCheck] = useState<Check | null>(null);

  async function call(action: Action) {
    if (action === 'save' && value.trim().length < 16) { setCheck({ ok: false, message: '请先粘贴完整的 API Key。' }); return; }
    setBusy(action);
    setCheck(null);
    try {
      const isTest = action === 'test';
      const response = await fetch(isTest ? '/api/providers/runninghub/test' : '/api/providers/runninghub/connection', {
        method: isTest ? 'POST' : action === 'save' ? 'PUT' : 'DELETE',
        headers: action === 'save' ? { 'content-type': 'application/json' } : undefined,
        body: action === 'save' ? JSON.stringify({ apiKey: value.trim() }) : undefined,
      });
      const data = await response.json();
      if (!response.ok) { setCheck({ ok: false, message: data.error || '操作失败。' }); return; }
      if (isTest) setCheck({ ok: data.ok, message: data.message });
      else {
        setView(data);
        /** 桌面版这一栏本来就是 null，接口顺手带回来的 wallet 也不该把它点亮。 */
        setCredits(prev => (prev && data.wallet ? data.wallet : prev));
        setCheck(data.test ?? null);
        if (action === 'save') setValue('');
        onChanged?.();
      }
    } catch {
      setCheck({ ok: false, message: '请求失败，请检查网络后重试。' });
    } finally {
      setBusy(null);
    }
  }

  const billed = Boolean(credits) && view.source === 'env' && !credits?.unlimited;

  return <div className="key-form">
    <dl className="key-meta">
      <div><dt>密钥来源</dt><dd className={view.source === 'user' ? 'ok' : view.source === 'env' ? 'warn' : 'off'}>{sourceText[view.source]}</dd></div>
      {!compact && <div><dt>当前密钥</dt><dd>{view.masked || '—'}</dd></div>}
      {credits && <div>
        <dt>余额</dt>
        <dd className={credits.unlimited ? 'ok' : billed && credits.balance < credits.costPerGenerationFen ? 'off' : billed ? 'warn' : 'ok'}>
          {credits.unlimited ? '不限（白名单账号）' : `¥${(credits.balance / 100).toFixed(2)}`}
        </dd>
      </div>}
      <div>
        <dt>生成计费</dt>
        <dd className={billed ? 'warn' : 'ok'}>
          {billed && credits ? `每次生成扣 ¥${(credits.costPerGenerationFen / 100).toFixed(2)}` : '不扣费'}
        </dd>
      </div>
      {!compact && <>
        <div><dt>服务地址</dt><dd>{view.baseUrl || '未配置 RUNNINGHUB_API_BASE_URL'}</dd></div>
        <div><dt>连接状态</dt><dd className={view.status === 'verified' ? 'ok' : view.status === 'failed' ? 'off' : 'warn'}>{view.status === 'verified' ? '已验证' : view.status === 'failed' ? '上次验证失败' : '未验证'}</dd></div>
      </>}
    </dl>

    <label className="field">
      <span>RunningHub API Key</span>
      <input
        type="password"
        value={value}
        autoComplete="off"
        spellCheck={false}
        placeholder={view.source === 'user' ? '留空则不修改，填写后覆盖当前密钥' : '粘贴 32 位 API Key'}
        onChange={event => setValue(event.target.value)}
      />
    </label>

    <div className="key-actions">
      <button className="button" type="button" disabled={busy !== null} data-rh-key-save onClick={() => void call('save')}>{busy === 'save' ? '保存中…' : '保存并测试'}</button>
      {!compact && <button className="button secondary" type="button" disabled={busy !== null || !view.hasKey} data-rh-key-test onClick={() => void call('test')}>{busy === 'test' ? '测试中…' : '测试连接'}</button>}
      <button className="button secondary" type="button" disabled={busy !== null || view.source !== 'user'} data-rh-key-clear onClick={() => void call('clear')}>{busy === 'clear' ? '清除中…' : '清除密钥'}</button>
    </div>

    {check && <p className={check.ok ? 'key-result ok' : 'key-result off'}>{check.message}</p>}
  </div>;
}
