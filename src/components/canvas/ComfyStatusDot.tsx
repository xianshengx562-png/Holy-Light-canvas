'use client';
/*
 * 顶栏那颗「本地 ComfyUI 在不在跑」的状态灯（2026-10-08 徐先圈的位置：
 * 节点数右边、余额左边。绿点 = 在跑）。
 *
 * 判据走 `/api/local/connection/test`（服务端打 ComfyUI 的 `/system_stats`）——
 * 和设置页那颗「已验证」用的是**同一个探测**，两处不会各说各话。
 *
 * ⚠️ 为什么不直接用主进程的 `comfyuiStatus`：那只认「**本应用**启动起来的那一个」。
 *    徐先自己在外头（另一份 portable、另一个终端）开起来的 ComfyUI，照样能跑生成，
 *    但 supervisor 那边一直是 idle —— 灯不亮就是骗人。探测地址可达才是真判据。
 *
 * ⚠️ 轮询用 `setTimeout` 串行、不是 `setInterval`：探不通的时候这一次要等到超时，
 *    interval 会让请求层层叠起来，越叠越多。
 * ⚠️ `silent: true` —— 探测**不写库**。路由默认会把结果记进连接状态（那是设置页
 *    「点一次测一次」的语义），顶栏十几秒问一次不该去动它。
 */
import { useEffect, useState } from 'react';

/** 多久问一次。本机 HTTP，几百毫秒就有结果；15 秒足够跟手又不折腾。 */
const POLL_MS = 15000;

export default function ComfyStatusDot() {
  /* `null` = 还没问出结果（刚挂载那一下），点先按「没在跑」画。 */
  const [ok, setOk] = useState<boolean | null>(null);
  const [detail, setDetail] = useState('');

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const probe = async () => {
      try {
        const response = await fetch('/api/local/connection/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ silent: true }),
        });
        const data = await response.json().catch(() => null);
        if (!alive) return;
        setOk(Boolean(data?.ok));
        setDetail(String(data?.message || data?.error || '').trim());
      } catch {
        if (!alive) return;
        setOk(false);
        setDetail('探测没成功。');
      } finally {
        if (alive) timer = setTimeout(() => void probe(), POLL_MS);
      }
    };

    void probe();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  /* 悬停说明走**原生 `title`**（和窄条那些提示一个做法）：自定义浮层会被顶栏
     那一层的 overflow / 层级裁掉，而且原生那个不用管位置。 */
  const title = ok === null
    ? '正在确认本地 ComfyUI…'
    : ok
      ? `本地 ComfyUI 正在运行${detail ? '（' + detail + '）' : ''}`
      : `本地 ComfyUI 没在跑${detail ? '（' + detail + '）' : ''}`;

  return (
    <span
      className={ok ? 'cv-comfy-dot on' : 'cv-comfy-dot'}
      data-comfy-dot={ok === null ? 'probing' : ok ? 'on' : 'off'}
      title={title}
      aria-label={title}
    />
  );
}
