'use client';
import { useEffect, useRef, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import type { AssetCategoryItem } from '@/lib/asset-kinds';
import { apiDelete, apiPatch, apiPost } from '@/lib/client';
import { ConfirmDialog } from '@/components/ui/ContextMenu';

/*
 * 分类管理弹层（2026-09-26）—— 资产页筛选器上那颗「管理」。
 *
 * 三件事：新增 / 改名 / 删除。**每一件都会动到已经打了这个分类的资产**：
 *  - 改名 → 那些资产的 `category` 一起改成新名字（`assets.category` 存的就是名字本身）；
 *  - 删除 → 那些资产**归到未分类**，接口把改了多少条（`cleared`）回过来，这里写进回执。
 *
 * 删除是两步（先确认、后执行），而且确认框里**先报一个数**：「有 N 项会变成未分类」。
 * 分类不像资产那样删了就没了，但「删一个分类顺手改掉几十张图的标签」一样要让人看见。
 *
 * 确认框复用 `components/ui/ContextMenu.tsx` 的 `ConfirmDialog`：位置计算、贴边回弹、
 * 键盘、Esc 那些跟「框里写着什么」无关，抄第二份就是两处各修各的 bug。
 */

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function AssetCategoryDialog({ categories, onClose, onChanged }: {
  categories: AssetCategoryItem[];
  onClose: () => void;
  /** 分类表变过了（新增 / 改名 / 删除都算）—— 让页面重取一次列表。 */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AssetCategoryItem | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  /* Esc 关掉整个弹层；确认框开着时归确认框管（那边故意不响应 Esc，别越权替它关）。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pendingDelete) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pendingDelete]);

  useEffect(() => { editRef.current?.focus(); editRef.current?.select(); }, [editing?.id]);

  async function add() {
    const name = adding.trim();
    if (!name || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost('/api/assets/categories', { name });
      setAdding('');
      setNotice(`已添加分类「${name}」。`);
      onChanged();
      addRef.current?.focus();
    } catch (err) {
      setError(messageOf(err, '分类没建成。'));
    } finally {
      setBusy(false);
    }
  }

  async function commitRename() {
    if (!editing || busy) return;
    const row = categories.find(item => item.id === editing.id);
    if (!row) { setEditing(null); return; }
    const name = editing.value.trim();
    /* 没改（或者改成空的）就当作取消：发一次没有变化的写请求没有意义。 */
    if (!name || name === row.name) { setEditing(null); setError(''); return; }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPatch(`/api/assets/categories/${editing.id}`, { name });
      setEditing(null);
      setNotice(`已改名为「${name}」，${row.count} 项资产的标签跟着改了。`);
      onChanged();
    } catch (err) {
      setError(messageOf(err, '改名没保存。'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!pendingDelete || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await apiDelete<{ name: string; cleared: number }>(
        `/api/assets/categories/${pendingDelete.id}`,
      );
      setPendingDelete(null);
      setNotice(
        result.cleared
          ? `已删除分类「${result.name}」，${result.cleared} 项资产回到未分类。`
          : `已删除分类「${result.name}」。`,
      );
      onChanged();
    } catch (err) {
      setError(messageOf(err, '分类没删掉。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cat-dialog-mask" data-cat-dialog-mask onMouseDown={() => { if (!busy && !pendingDelete) onClose(); }}>
      <div
        className="cat-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="管理分类"
        data-cat-dialog
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="cat-dialog-head">
          <div>
            <strong>管理分类</strong>
            <p className="muted">改名会连已经打了这个分类的资产一起改；删除会把它们归到未分类。</p>
          </div>
          <button className="cat-dialog-close" type="button" onClick={onClose} aria-label="关闭" data-cat-close>
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
        </header>

        <ul className="cat-dialog-list" data-cat-list>
          {categories.map(cat => (
            <li key={cat.id} className="cat-dialog-row" data-cat-row={cat.id}>
              {editing?.id === cat.id ? (
                <input
                  ref={editRef}
                  className="cat-dialog-name-input"
                  data-cat-name-input
                  value={editing.value}
                  maxLength={24}
                  aria-label="分类名"
                  disabled={busy}
                  onChange={event => setEditing({ id: cat.id, value: event.target.value })}
                  onKeyDown={event => {
                    if (event.key === 'Enter') { event.preventDefault(); void commitRename(); }
                    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); }
                  }}
                  onBlur={() => void commitRename()}
                />
              ) : (
                <span className="cat-dialog-name" data-cat-name={cat.name}>{cat.name}</span>
              )}
              <span className="muted cat-dialog-count" data-cat-count={cat.id}>{cat.count} 项</span>
              <button
                className="cat-dialog-icon"
                type="button"
                title="改名"
                aria-label={`给「${cat.name}」改名`}
                data-cat-edit={cat.id}
                disabled={busy || editing !== null}
                onClick={() => { setError(''); setNotice(''); setEditing({ id: cat.id, value: cat.name }); }}
              >
                <Pencil size={14} strokeWidth={1.8} aria-hidden />
              </button>
              <button
                className="cat-dialog-icon danger"
                type="button"
                title="删除"
                aria-label={`删除「${cat.name}」`}
                data-cat-del={cat.id}
                disabled={busy || editing !== null}
                onClick={() => { setError(''); setNotice(''); setPendingDelete(cat); }}
              >
                <Trash2 size={14} strokeWidth={1.8} aria-hidden />
              </button>
            </li>
          ))}
          {!categories.length && <li className="muted cat-dialog-empty">还没有分类，先在下面加一个。</li>}
        </ul>

        <div className="cat-dialog-add">
          <input
            ref={addRef}
            className="cat-dialog-new"
            data-cat-add-input
            value={adding}
            maxLength={24}
            placeholder="新分类名"
            aria-label="新分类名"
            disabled={busy}
            onChange={event => setAdding(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void add(); } }}
          />
          <button className="button small" type="button" data-cat-add disabled={busy || !adding.trim()}
            onClick={() => void add()}>
            <Plus size={14} strokeWidth={2} aria-hidden /> 添加
          </button>
        </div>

        {notice && <p className="pg-notice ok" role="status" data-cat-notice>{notice}</p>}
        {error && <p className="error" role="alert" data-cat-error>{error}</p>}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          testId="asset-category"
          title={`删除分类「${pendingDelete.name}」？`}
          body={<p className="muted">
            {pendingDelete.count
              ? <>有 {pendingDelete.count} 项资产正打着这个分类，删掉之后它们会变成<strong>未分类</strong>（资产本身不会删）。</>
              : '目前没有资产在用这个分类。'}
            <br />
            以后要用，重新建一个同名分类再打回去即可。
          </p>}
          error={error}
          busy={busy}
          busyLabel="正在删除…"
          confirmLabel="删除分类"
          onCancel={() => { if (!busy) setPendingDelete(null); }}
          onConfirm={() => void remove()}
        />
      )}
    </div>
  );
}
