'use client';

import { useEffect, useState } from 'react';
import { apiSend } from '@/lib/client';
import { canBrowseFolders, openFolderPath, pickFolderPath } from '@/lib/desktop-fs';
import type { OutputDirView } from '@/lib/output-dir';

/**
 * 产出目录。
 *
 * 桌面版独有的一页：生成出来的图 / 视频 / latent 落在哪个文件夹，由用户自己定。
 * 默认值是 `userData/storage`（系统盘底下、路径又深），换成自己挑的盘之后
 * 找文件、备份、换外接硬盘都方便。
 *
 * 两个容易搞错的点，都写在界面上了：
 *  - **换目录不会动已有资产**：资产记录里存的是绝对路径，改这个只是「之后往哪写」。
 *  - **保存那一刻真的写一个探针文件**：写不进去当场报错，而不是等某次生成静默失败。
 */
export default function OutputDirForm({ initial }: { initial: OutputDirView }) {
  const [view, setView] = useState(initial);
  const [value, setValue] = useState(initial.custom ?? '');
  const [busy, setBusy] = useState<null | 'save' | 'reset' | 'browse'>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /*
   * 「有没有本机通道」只能在浏览器里问，服务端渲染时它一定是 false。
   * 直接用 `canBrowseFolders()` 当渲染条件会有 hydration 不一致，所以先渲染成 false、挂载后再补。
   */
  const [canBrowse, setCanBrowse] = useState(false);
  useEffect(() => { setCanBrowse(canBrowseFolders()); }, []);

  async function save(dir: string | null, action: 'save' | 'reset' | 'browse') {
    setBusy(action);
    setMessage(null);
    try {
      const next = await apiSend<OutputDirView>('/api/settings/output', 'PUT', { dir });
      setView(next);
      setValue(next.custom ?? '');
      setMessage({
        ok: true,
        text: next.custom ? `已保存 —— 之后的产出都会落进「${next.dir}」。` : '已恢复默认目录。',
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : '保存失败。' });
    } finally {
      setBusy(null);
    }
  }

  async function browse() {
    setBusy('browse');
    const picked = await pickFolderPath({ title: '选择产出目录', defaultPath: view.dir });
    if (!picked) { setBusy(null); return; }
    /** 选完立刻存：这一页的意义就是「存到哪」，多一步「保存」按钮没有价值。 */
    await save(picked, 'browse');
  }

  async function open() {
    const result = await openFolderPath(view.dir);
    if (!result.ok) setMessage({ ok: false, text: result.message || '打不开这个目录（可能已经被删掉或改名了）。' });
  }

  const dirty = (value.trim() || null) !== (view.custom ?? null);

  return <div className="key-form">
    <dl className="key-meta">
      <div><dt>当前产出目录</dt><dd>{view.dir}</dd></div>
      <div><dt>来源</dt><dd className={view.source === 'custom' ? 'ok' : 'warn'}>{view.source === 'custom' ? '你自己选的' : '默认目录'}</dd></div>
      <div><dt>可写</dt><dd className={view.writable ? 'ok' : 'off'}>{view.writable ? '可写' : view.exists ? '没有写入权限' : '目录还不存在'}</dd></div>
      <div><dt>默认目录</dt><dd>{view.defaultDir}</dd></div>
    </dl>

    <label className="field">
      <span>产出目录（绝对路径）</span>
      <input
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder={view.defaultDir}
        data-output-input="dir"
        onChange={event => setValue(event.target.value)}
      />
    </label>

    <div className="key-actions">
      <button className="button" type="button" disabled={busy !== null || !dirty} onClick={() => void save(value.trim() || null, 'save')}>
        {busy === 'save' ? '保存中…' : '保存'}
      </button>
      {canBrowse && <button className="button secondary" type="button" disabled={busy !== null} data-output-action="browse" onClick={() => void browse()}>
        {busy === 'browse' ? '选择中…' : '浏览…'}
      </button>}
      {canBrowse && <button className="button secondary" type="button" disabled={busy !== null} data-output-action="open" onClick={() => void open()}>打开文件夹</button>}
      <button className="button secondary" type="button" disabled={busy !== null || !view.custom} onClick={() => void save(null, 'reset')}>
        {busy === 'reset' ? '恢复中…' : '恢复默认'}
      </button>
    </div>

    {message && <p className={message.ok ? 'key-result ok' : 'key-result off'} data-output-message={message.ok ? 'ok' : 'error'}>{message.text}</p>}

    <p className="key-hint">
      换了目录**不会动已有的资产**：每条资产记录的都是它自己那个文件的绝对路径，改这里只影响「之后生成的文件往哪写」。
      目录内部仍是 <code>media</code> 与 <code>latents</code> 两个子目录按项目分文件夹，直接翻也翻得明白。
    </p>
    <p className="key-hint">
      点保存时会真的往目标目录写一个临时文件再删掉 —— 写不进去（没权限、盘是只读的、盘符不存在）当场就报，
      不会等到某次生成才「生成成功但图是空的」。
    </p>
  </div>;
}
