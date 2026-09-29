'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check, Download, Eye, FileArchive, ImageIcon, Music, Pencil, Trash2, Video, X,
} from 'lucide-react';
import { apiPatch, apiPost } from '@/lib/client';
import type { AssetCategoryItem } from '@/lib/asset-kinds';
import { ConfirmDialog, ContextMenu, type MenuItem } from '@/components/ui/ContextMenu';
import { SelectionBar, SelectionEnter } from '@/components/ui/SelectionBar';

/*
 * 不从 `@/lib/assets` 引类型（那个模块标了 `server-only`），字段在这里重述一遍。
 * 服务端传下来的时间/体积**已经是格式化好的字符串**，客户端不要再算一次——
 * 服务端时区与浏览器时区不同会直接触发 hydration 不一致。
 *
 * 2026-09-26 这一版加了**卡片右键菜单（预览 / 重命名 / 删除）**与**批量选择**
 * （徐先：「资产也可以右键删除，重命名，批量选择（归类，删除）」）。
 * 「归类」按他确认的是**打分类**，不是「换个项目挂」—— 所以批量那一排给的是
 * 分类表里每一颗 chip + 一颗「清除分类」。分类**由用户自己维护**（资产页筛选器上那颗
 * 「管理」），2026-09-26 起不再写死成角色 / 场景 / 道具，也不再只给图片打。
 *
 * 菜单与确认框在 `components/ui/ContextMenu.tsx`：它们跟项目页共用一份
 * （位置计算、贴边回弹、键盘、Esc 那些跟「菜单里有什么」无关，抄第二份就是两处各修各的 bug）。
 */
type Kind = 'video' | 'image' | 'audio' | 'latent';

export type GalleryItem = {
  id: string;
  name: string;
  type: Kind;
  /** 分类名本身（`assets.category` 里存的就是它，不再需要「值 → 标签」的映射表）。 */
  category: string | null;
  url: string;
  downloadUrl: string;
  createdLabel: string;
  sizeLabel: string;
  projectId: string;
  projectName: string;
};

const KIND_TEXT: Record<Kind, string> = { video: '视频', image: '图片', audio: '音频', latent: 'Latent' };
/* 分类列表由页面从 `/api/assets` 传下来（`categories`），这里不再自带一份写死的表。 */

type Notice = { text: string; ok?: boolean } | null;

function Glyph({ kind }: { kind: Kind }) {
  if (kind === 'video') return <Video size={22} strokeWidth={1.5} aria-hidden />;
  if (kind === 'image') return <ImageIcon size={22} strokeWidth={1.5} aria-hidden />;
  if (kind === 'audio') return <Music size={22} strokeWidth={1.5} aria-hidden />;
  return <FileArchive size={22} strokeWidth={1.5} aria-hidden />;
}

export default function AssetGallery({ items, categories, onChanged }: {
  items: GalleryItem[];
  /** 用户自己维护的分类表。灯箱里的分类按钮与批量「归类」都按它来画。 */
  categories: AssetCategoryItem[];
  /**
   * 改完（分类 / 改名 / 删除）叫一次。列表数据在上层（页面那个 `useApi`），刷新也归上层 ——
   * 传进来的话只重取一次列表；没传就退回 `router.refresh()`（整页重载，桌面版那次等于 reload）。
   */
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [catBusy, setCatBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const open = items.find(item => item.id === openId) || null;

  /* ── 右键菜单 / 改名（2026-09-26）──────────────────────────── */
  const [menu, setMenu] = useState<{ x: number; y: number; item: GalleryItem } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  /* ── 删除确认（单条与批量共用一套）────────────────────────── */
  const [confirming, setConfirming] = useState<{ ids: string[]; names: string[] } | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  /* 409 = 被画布引用。这时才把「仍然删除」放出来 —— 先讲清楚再问一次。 */
  const [forceable, setForceable] = useState(false);

  /* ── 批量选择（2026-09-26）────────────────────────────────── */
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  const pickedItems = items.filter(item => picked.includes(item.id));
  const pickedIds = pickedItems.map(item => item.id);

  const refresh = useCallback(() => {
    if (onChanged) onChanged();
    else router.refresh();
  }, [onChanged, router]);

  /** 关灯箱时把删除的中间状态一起清掉，免得下次打开还停在「确认删除」上。 */
  const close = useCallback(() => {
    setOpenId(null);
    setBusy(false);
    setError('');
    setCatBusy(false);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  /* 改名输入框一出现就聚焦并全选：右键点「重命名」的人下一步一定是打字。 */
  useEffect(() => {
    if (!renaming) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [renaming?.id]);

  /* Esc 退出选择（确认框开着时归确认框管，那边故意不响应 Esc，这里别越权关掉它）。 */
  useEffect(() => {
    if (!selecting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || confirming || renaming) return;
      setSelecting(false);
      setPicked([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, confirming, renaming]);

  function togglePick(id: string) {
    setNotice(null);
    setPicked(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  }

  function leaveSelecting() {
    setSelecting(false);
    setPicked([]);
  }

  function openMenu(event: React.MouseEvent, item: GalleryItem) {
    event.preventDefault();
    setNotice(null);
    /* 正在改名的那张卡不弹菜单 —— 那一行已经是输入框了。 */
    if (renaming?.id === item.id) return;
    setMenu({ x: event.clientX, y: event.clientY, item });
  }

  const menuItems: MenuItem[] = menu ? [
    {
      id: 'preview',
      label: '预览',
      icon: <Eye size={14} strokeWidth={1.8} aria-hidden />,
      run: () => { const it = menu.item; setMenu(null); setOpenId(it.id); },
    },
    {
      id: 'rename',
      label: '重命名',
      icon: <Pencil size={14} strokeWidth={1.8} aria-hidden />,
      run: () => {
        const it = menu.item;
        setMenu(null);
        setNotice(null);
        /* 改名要求先退出选择模式：那一行会被换成输入框，和勾选框叠一起没法看。 */
        setSelecting(false);
        setPicked([]);
        setRenaming({ id: it.id, value: it.name });
      },
    },
    {
      id: 'delete',
      label: '删除',
      icon: <Trash2 size={14} strokeWidth={1.8} aria-hidden />,
      danger: true,
      run: () => {
        const it = menu.item;
        setMenu(null);
        askDelete([it.id], [it.name]);
      },
    },
  ] : [];

  function askDelete(ids: string[], names: string[]) {
    setConfirmError(null);
    setForceable(false);
    setConfirming({ ids, names });
  }

  /* ── 改名 ─────────────────────────────────────────────────── */

  async function commitRename() {
    if (!renaming || busy) return;
    const card = items.find(item => item.id === renaming.id);
    const next = renaming.value.trim();
    if (!card) { setRenaming(null); return; }
    /* 没改就当作取消：发一次没有变化的写请求没有意义。 */
    if (next === card.name) { setRenaming(null); setNotice(null); return; }
    if (!next) { setNotice({ text: '名字不能为空。' }); return; }
    setBusy(true);
    try {
      await apiPatch(`/api/assets/${renaming.id}`, { name: next });
      setRenaming(null);
      setNotice({ ok: true, text: `已改名为「${next}」。` });
      refresh();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : '改名失败，稍后再试。' });
    } finally {
      setBusy(false);
    }
  }

  /* ── 灯箱里的分类（单条）──────────────────────────────────── */

  /**
   * 打（或改、或清）分类。
   *
   * 只发 `category` 一个字段（PATCH，见 `/api/assets/[id]`）：把整条资产 PUT 上去
   * 等于把 `metadata.path` 也交给前端改，那是磁盘路径。
   */
  const setCategory = async (category: string | null) => {
    if (!open) return;
    setCatBusy(true);
    setError('');
    try {
      await apiPatch(`/api/assets/${open.id}`, { category });
      close();
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '分类没存上。');
    } finally {
      setCatBusy(false);
    }
  };

  /* ── 批量打分类（「归类」）────────────────────────────────── */

  /**
   * 批量打分类。走 `/api/assets/batch` 而不是前端循环：中转站那种一条一条打，
   * 20 项就是 20 个请求，中途断一个就说不清改到哪了。
   *
   * **任何类型都能打**（2026-09-26），所以 `skipped` 现在只剩一种来源：选中的 id
   * 已经不在了。以前那句「跳过 N 项（分类只对图片有效）」不再成立，别再那么写。
   */
  async function bulkCategory(category: string | null) {
    if (!pickedIds.length || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await apiPost<{ changed: number; skipped: number }>('/api/assets/batch', {
        ids: pickedIds,
        action: 'category',
        category,
      });
      setNotice({
        ok: true,
        text: (category
          ? `已把 ${result.changed} 项标成「${category}」`
          : `已清掉 ${result.changed} 项的分类`)
          + (result.skipped ? `；跳过 ${result.skipped} 项（已经不在了）。` : '。'),
      });
      refresh();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : '分类没存上，稍后再试。' });
    } finally {
      setBusy(false);
    }
  }

  /* ── 删除（单条与批量共用）────────────────────────────────── */

  /**
   * 删除。`force` 只在「被画布引用」那一条上才允许为真 —— 与单条接口的语义一致。
   *
   * 接口不会把被引用的那些删掉，而是把「哪个资产被哪个项目在用」回过来；
   * 这里把它翻成人话写进确认框，并且此时才放出「仍然删除」。
   * 直接一上来就给「仍然删除」，等于默认让用户点它。
   */
  async function removeAssets(force: boolean) {
    if (!confirming || busy) return;
    setBusy(true);
    setConfirmError(null);
    try {
      const result = await apiPost<{
        deleted: number; notFound: number; filesLeft: number;
        inUse: { id: string; name: string; projects: string[] }[];
      }>('/api/assets/batch', { ids: confirming.ids, action: 'delete', force });

      if (result.inUse.length) {
        setForceable(true);
        setConfirmError(
          `有 ${result.inUse.length} 项正被画布引用（`
          + result.inUse.slice(0, 3).map(row => `「${row.name}」在 ${row.projects.join('、')}`).join('；')
          + (result.inUse.length > 3 ? ' …' : '')
          + '），删除后那几条链路会取不到值。'
          + (result.deleted ? `其余 ${result.deleted} 项已删掉。` : '')
          + ' 确认要连它们一起删掉吗？',
        );
        /* 已经删掉的那部分要刷新出来，否则界面还留着那些已经不存在的卡片。 */
        if (result.deleted) { refresh(); setConfirming({ ids: result.inUse.map(row => row.id), names: result.inUse.map(row => row.name) }); }
        return;
      }

      setConfirming(null);
      leaveSelecting();
      if (openId && confirming.ids.includes(openId)) close();
      setNotice({
        ok: true,
        text: `已删除 ${result.deleted} 项`
          + (result.notFound ? `；另有 ${result.notFound} 项已经不在了` : '')
          + (result.filesLeft ? `；${result.filesLeft} 个文件没能从磁盘上删掉（磁盘占用会体现在「孤儿文件」那一栏）` : '')
          + '。',
      });
      refresh();
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : '删除失败，稍后再试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {notice && (
        <p
          className={notice.ok ? 'pg-notice ok' : 'pg-notice'}
          role="status"
          data-assets-notice
        >
          {notice.text}
        </p>
      )}

      {items.length > 0 && !selecting && (
        <SelectionEnter
          testId="assets"
          hint={`${items.length} 项 —— 勾选后可以一次打分类或一次删掉`}
          onEnter={() => { setNotice(null); setSelecting(true); }}
        />
      )}
      {items.length > 0 && selecting && (
        <SelectionBar
          testId="assets"
          count={pickedIds.length}
          total={items.length}
          busy={busy}
          onAll={() => setPicked(items.map(item => item.id))}
          onNone={() => setPicked([])}
          onExit={leaveSelecting}
        >
          <span className="sb-label muted">归类</span>
          <div className="sb-chips" data-assets-bulk-cats>
            {categories.map(cat => (
              <button
                key={cat.id}
                type="button"
                className="assets-chip"
                data-asset-bulk-cat={cat.name}
                disabled={busy || pickedIds.length === 0}
                onClick={() => void bulkCategory(cat.name)}
              >
                {cat.name}
              </button>
            ))}
            <button
              type="button"
              className="assets-chip"
              data-asset-bulk-cat="none"
              disabled={busy || pickedIds.length === 0}
              onClick={() => void bulkCategory(null)}
            >
              清除分类
            </button>
          </div>
          <button
            className="button danger small"
            type="button"
            data-asset-bulk-delete
            disabled={busy || pickedIds.length === 0}
            onClick={() => askDelete(pickedIds, pickedItems.map(item => item.name))}
          >
            <Trash2 size={14} strokeWidth={2} aria-hidden /> 删除所选
          </button>
        </SelectionBar>
      )}

      <div className="assets-grid" data-assets-grid data-assets-selecting={selecting ? 'yes' : 'no'}>
        {items.map(item => {
          const on = picked.includes(item.id);
          const editing = renaming?.id === item.id;
          /*
            封面这一下点的是什么，看当前在哪一档：
             - 选择模式：勾选 / 取消勾选这一张（`stopPropagation` 是因为外层 article 也挂着同一件事，
               不拦掉会连翻两次 = 等于没点）；
             - Ctrl / ⌘ + 单击：顺手进入选择模式并勾上这一张（文件管理器那套肌肉记忆）；
             - 其余：开灯箱。
          */
          const onThumb = (event: React.MouseEvent<HTMLButtonElement>) => {
            if (selecting) { event.stopPropagation(); togglePick(item.id); return; }
            if (event.ctrlKey || event.metaKey) {
              event.stopPropagation();
              setSelecting(true);
              togglePick(item.id);
              return;
            }
            setOpenId(item.id);
          };

          return (
            <article
              className={`asset-card${selecting ? ' picking' : ''}${on ? ' picked' : ''}`}
              key={item.id}
              data-asset-card={item.id}
              data-asset-picked={on ? 'yes' : 'no'}
              onContextMenu={event => { if (!selecting && !editing) openMenu(event, item); }}
              onClick={selecting && !editing ? () => togglePick(item.id) : undefined}
            >
              <button
                className="asset-thumb"
                type="button"
                onClick={onThumb}
                aria-label={selecting
                  ? `${on ? '取消选中' : '选中'} ${item.name}`
                  : `预览 ${item.name}`}
              >
                {item.type === 'image' && <img src={item.url} alt={item.name} loading="lazy" />}
                {item.type === 'video' && <video src={item.url} preload="metadata" muted playsInline />}
                {/* 音频和 latent 一样没有画面：格子中间放一个图标，试听在灯箱里做 */}
                {(item.type === 'latent' || item.type === 'audio') && (
                  <span className="asset-thumb-icon"><Glyph kind={item.type} /></span>
                )}
                <span className={`asset-kind asset-kind-${item.type}`}>{KIND_TEXT[item.type]}</span>
                {item.category && <span className="asset-cat">{item.category}</span>}
                {selecting && (
                  <span className="asset-pick" aria-hidden>
                    {on && <Check size={14} strokeWidth={3} />}
                  </span>
                )}
              </button>
              <div className="asset-body">
                {editing ? (
                  <input
                    ref={renameRef}
                    className="asset-rename"
                    data-asset-rename-input
                    value={renaming.value}
                    maxLength={80}
                    aria-label="资产名称"
                    onClick={event => event.stopPropagation()}
                    onChange={e => setRenaming({ id: item.id, value: e.target.value })}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
                      if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); setNotice(null); }
                    }}
                    onBlur={() => { void commitRename(); }}
                  />
                ) : (
                  <h3 title={item.name}>{item.name}</h3>
                )}
                <p className="muted">
                  <Link className="text-link" href={`/projects/${item.projectId}`}>{item.projectName}</Link>
                  {' · '}{item.createdLabel}
                </p>
                <p className="muted">{item.sizeLabel}</p>
              </div>
            </article>
          );
        })}
      </div>

      {open && (
        <div className="asset-lightbox" role="dialog" aria-modal="true" aria-label={open.name}>
          <div className="asset-lightbox-backdrop" onClick={close} />
          <div className="asset-lightbox-panel">
            <header className="asset-lightbox-head">
              <div>
                <strong>{open.name}</strong>
                <p className="muted">
                  {KIND_TEXT[open.type]}{open.category ? ` · ${open.category}` : ''} · {open.sizeLabel} · {open.createdLabel}
                </p>
              </div>
              <button className="asset-lightbox-close" type="button" onClick={close} aria-label="关闭">
                <X size={18} strokeWidth={2} aria-hidden />
              </button>
            </header>
            <div className="asset-lightbox-stage">
              {open.type === 'image' && <img src={open.url} alt={open.name} />}
              {open.type === 'video' && <video src={open.url} controls autoPlay playsInline />}
              {open.type === 'audio' && (
                <audio className="asset-lightbox-audio" src={open.url} controls preload="metadata" />
              )}
              {open.type === 'latent' && (
                <div className="asset-lightbox-note">
                  <Glyph kind="latent" />
                  <p>latent 是给「续接上一段」用的中间态，不能预览。下载后到画布的续接节点里上传即可。</p>
                </div>
              )}
            </div>
            {/*
              分类**任何类型都能打**（2026-09-26），所以这一排不再只在图片上出现。
              空的分类表也要把「分类」这行留着：否则用户会以为这个资产天生没有分类可打，
              而实际上是「他还没建分类」—— 那句话得由筛选器上那颗「管理」去说。
            */}
            <div className="asset-cat-picker" role="group" aria-label="分类" data-asset-cat-picker>
              <span className="muted">分类</span>
              {categories.map(cat => (
                <button
                  key={cat.id}
                  type="button"
                  className={`assets-chip${open.category === cat.name ? ' active' : ''}`}
                  aria-pressed={open.category === cat.name}
                  disabled={catBusy}
                  data-asset-cat={cat.name}
                  onClick={() => setCategory(open.category === cat.name ? null : cat.name)}
                >
                  {cat.name}
                </button>
              ))}
              {!categories.length && <span className="muted">还没有分类，先在筛选器的「管理」里加一个。</span>}
            </div>
            {error && (
              <p className="error asset-lightbox-error" role="alert">
                {error}
              </p>
            )}
            <footer className="asset-lightbox-foot">
              {/*
                删除统一走那个确认框（不可逆，所以永远两步）。
                这里不再自己画「删除 / 取消 / 确认删除」三态 —— 那套状态在批量那边还得再写一遍。
              */}
              <button className="button secondary" type="button" data-asset-lightbox-delete
                onClick={() => askDelete([open.id], [open.name])}>
                <Trash2 size={16} strokeWidth={2} aria-hidden /> 删除
              </button>
              <span className="asset-lightbox-spacer" />
              <Link className="button secondary" href={`/projects/${open.projectId}`}>打开所在项目</Link>
              <a className="button" href={open.downloadUrl} download>
                <Download size={16} strokeWidth={2} aria-hidden /> 下载
              </a>
            </footer>
          </div>
        </div>
      )}

      {menu && (
        <ContextMenu
          at={{ x: menu.x, y: menu.y }}
          title={menu.item.name}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}

      {confirming && (
        <ConfirmDialog
          testId={confirming.ids.length > 1 ? 'assets-batch' : 'asset'}
          title={confirming.ids.length > 1
            ? `删除选中的 ${confirming.ids.length} 项？`
            : `删除「${confirming.names[0]}」？`}
          body={<>
            <p className="muted">
              记录和磁盘上的文件都会删掉 —— <strong>删了拿不回来</strong>。
              如果它正被某个画布用着（latent 续接、节点里的图），删掉之后那条链路下次生成会取不到值。
            </p>
            {confirming.ids.length > 1 && (
              <ul className="cx-confirm-list" data-assets-batch-list>
                {confirming.names.map((name, index) => <li key={confirming.ids[index]}>{name}</li>)}
              </ul>
            )}
          </>}
          error={confirmError}
          busy={busy}
          busyLabel="正在删除…"
          confirmLabel={forceable ? '仍然删除' : '删除'}
          onCancel={() => { if (!busy) { setConfirming(null); setForceable(false); } }}
          onConfirm={() => void removeAssets(forceable)}
        />
      )}
    </>
  );
}
