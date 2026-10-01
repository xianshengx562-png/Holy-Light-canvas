'use client';
import { useEffect, useRef, useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { WORKFLOW_CATEGORY_NAME_MAX, type WorkflowCategoryItem } from '@/lib/workflows/category';
import { apiDelete, apiPatch, apiPost } from '@/lib/client';
import { ConfirmDialog } from '@/components/ui/ContextMenu';

/*
 * 工作流分类管理弹层（2026-10-01 徐先：「分类我自己能加」）—— 工作流库上那颗「分类管理」。
 *
 * 内置那五个（无参考 / 单图参考 / 多图参考 / 视频参考 / 音频 + 多图参考）是代码里的枚举，
 * **这里看不到、也删不掉**；这一屏只管用户自己起的名字。三件事：新增 / 改名 / 删除。
 *
 * 每一件都会动到已经归在这个分类下的工作流：
 *  - 改名 → 那些工作流的 `category` 一起改（`WorkflowDraft.category` 存的就是名字本身）；
 *  - 删除 → 它们**回到「无参考」**，接口把动了几份（`cleared`）回过来，这里写进回执。
 *    🔴 删标签不删工作流：分类只是个标签，不能把工作流一起带走。
 *
 * 删除是两步（先确认、后执行），确认框里**先报一个数**：「有 N 份会回到无参考」。
 *
 * 形态、类名、交互都与资产页那个 `AssetCategoryDialog` 一模一样（连 CSS 类都共用
 * `cat-dialog-*`）：同一件事在两个页面长得不一样，用户会以为那是两个功能。
 */

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function WorkflowCategoryDialog({ categories, onClose, onChanged }: {
  /** 当前的自建分类（跟着列表数据一起拿到，不用再取一遍）。 */
  categories: WorkflowCategoryItem[];
  onClose: () => void;
  /** 分类表变过了（新增 / 改名 / 删除都算）—— 让外面重取一次。 */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkflowCategoryItem | null>(null);
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
      await apiPost('/api/workflows/categories', { name });
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
      await apiPatch(`/api/workflows/categories/${editing.id}`, { name });
      setEditing(null);
      setNotice(`已改名为「${name}」，${row.count} 份工作流的分类跟着改了。`);
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
        `/api/workflows/categories/${pendingDelete.id}`,
      );
      setPendingDelete(null);
      setNotice(
        result.cleared
          ? `已删除分类「${result.name}」，${result.cleared} 份工作流回到「无参考」。`
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
    <div className="cat-dialog-mask" data-wfcat-dialog-mask onMouseDown={() => { if (!busy && !pendingDelete) onClose(); }}>
      <div
        className="cat-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="工作流分类"
        data-wfcat-dialog
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="cat-dialog-head">
          <div>
            <strong>工作流分类</strong>
            <p className="muted">
              自己起的分类会出现在筛选与「分类」下拉里。改名会连归在这个分类下的工作流一起改；
              删除会让它们回到「无参考」（工作流本身不删）。内置那五个是固定的，这里改不了。
            </p>
          </div>
          <button className="cat-dialog-close" type="button" onClick={onClose} aria-label="关闭" data-wfcat-close>
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
        </header>

        <ul className="cat-dialog-list" data-wfcat-list>
          {categories.map(item => (
            <li key={item.id} className="cat-dialog-row" data-wfcat-row={item.name}>
              {editing?.id === item.id
                ? (
                  <input
                    ref={editRef}
                    className="cat-dialog-name-input"
                    data-wfcat-name-input
                    value={editing.value}
                    maxLength={WORKFLOW_CATEGORY_NAME_MAX}
                    aria-label="分类名"
                    disabled={busy}
                    onChange={event => setEditing({ id: item.id, value: event.target.value })}
                    onKeyDown={event => {
                      if (event.key === 'Enter') { event.preventDefault(); void commitRename(); }
                      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); }
                    }}
                    onBlur={() => void commitRename()}
                  />
                )
                : <span className="cat-dialog-name" data-wfcat-name={item.name}>{item.name}</span>}
              <span className="muted cat-dialog-count" data-wfcat-count={item.id}>
                {item.count ? `${item.count} 份` : '还没用过'}
              </span>
              <button
                className="cat-dialog-icon"
                type="button"
                title="改名（归在这个分类下的工作流会一起改）"
                aria-label={`给「${item.name}」改名`}
                data-wfcat-edit={item.id}
                disabled={busy || editing !== null}
                onClick={() => { setError(''); setNotice(''); setEditing({ id: item.id, value: item.name }); }}
              >
                <Pencil size={14} strokeWidth={1.8} aria-hidden />
              </button>
              <button
                className="cat-dialog-icon danger"
                type="button"
                title="删除这个分类"
                aria-label={`删除「${item.name}」`}
                data-wfcat-del={item.id}
                disabled={busy || editing !== null}
                onClick={() => { setError(''); setNotice(''); setPendingDelete(item); }}
              >
                <Trash2 size={14} strokeWidth={1.8} aria-hidden />
              </button>
            </li>
          ))}
          {!categories.length && (
            <li className="muted cat-dialog-empty" data-wfcat-empty>
              还没有自建分类，先在下面加一个。
            </li>
          )}
        </ul>

        <div className="cat-dialog-add">
          <input
            ref={addRef}
            className="cat-dialog-new"
            data-wfcat-add-input
            value={adding}
            maxLength={WORKFLOW_CATEGORY_NAME_MAX}
            placeholder="新分类名，比如「角色参考」"
            aria-label="新分类名"
            disabled={busy}
            onChange={event => { setAdding(event.target.value); setError(''); }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void add(); } }}
          />
          <button className="button small" type="button" data-wfcat-add disabled={busy || !adding.trim()} onClick={() => void add()}>
            <Plus size={14} strokeWidth={2} aria-hidden /> 添加
          </button>
        </div>

        {notice && <p className="pg-notice ok" role="status" data-wfcat-notice>{notice}</p>}
        {error && <p className="error" role="alert" data-wfcat-error>{error}</p>}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          testId="workflow-category"
          title={`删除分类「${pendingDelete.name}」？`}
          body={<p className="muted">
            {pendingDelete.count
              ? <>有 {pendingDelete.count} 份工作流正归在这个分类下，删掉之后它们会回到<strong>无参考</strong>（工作流本身不会删）。</>
              : '目前没有工作流在用这个分类。'}
            <br />
            以后要用，重新建一个同名分类再归回去即可。
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
