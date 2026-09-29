'use client';

/*
 * 新建项目（2026-09-18 从服务端表单改成客户端提交）。
 *
 * 原来是 `<form action="/api/projects" method="post">`：浏览器整页 POST，服务端 303 跳到
 * `/projects/{id}`。桌面版没有服务端跳转这一步 —— `/api/projects` 在 `app://` 下被主进程
 * 拦下来直接分发，重定向会被 fetch 静默跟掉，页面停在原地什么也不发生。
 * 所以改成 `fetch` 拿回 id、再用前端路由跳过去。
 *
 * 桌面版也不需要 `requireUser()`：它固定以「本机用户」身份运行，没有登录这一步。
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/client';

export default function NewProject() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await apiPost<{ id: string }>('/api/projects', { name });
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败，请重试。');
      setBusy(false);
    }
  }

  return <main className="auth-wrap">
    <Link className="text-link" href="/">← 返回项目</Link>
    <h1>新建项目</h1>
    <p className="muted">每个项目都会拥有一张独立画布。</p>
    <form className="auth-form" onSubmit={submit}>
      <label className="field">
        项目名称
        <input
          name="name"
          required
          maxLength={80}
          placeholder="例如：春日影像计划"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button type="submit" disabled={busy}>{busy ? '创建中…' : '创建并打开'}</button>
      {error && <p className="muted" style={{ color: 'var(--danger, #f87171)' }}>{error}</p>}
    </form>
  </main>;
}
