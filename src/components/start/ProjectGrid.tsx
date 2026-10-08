'use client';

/*
 * 项目卡片网格 —— 首页「最近项目」与 `/projects` 列表页**共用同一份**。
 *
 * 为什么抽出来：两页原来各写了一遍一模一样的卡片结构（连 `coverOf` 都抄了两份），
 * 2026-09-25 徐先要「右键可以打开 / 重命名 / 删除项目」时，两处再各改一遍就等于
 * 以后两处会各修各的 bug。这里把「卡片长什么样」和「右键能干什么」一起收进来，
 * 两页只决定**列哪些项目**和**时间怎么显示**。
 *
 * 2026-09-26 又加了**批量选择**（徐先：「项目和资产可以批量选择」）。两页都要，
 * 所以选择模式也跟着卡片一起住在这里，两页同样一个字都不用改。
 *
 * 菜单与确认框本身搬去了 `components/ui/ContextMenu.tsx` —— 资产卡片也要右键，
 * 而「位置计算 / 贴边回弹 / 键盘 / Esc」跟菜单内容无关，抄第二份就是两处各修各的 bug。
 * 那边的做法是 `createPortal(…, document.body)`，所以这里不用再操心地卡片上的
 * `transform` 会给 `position: fixed` 造包含块、`overflow: hidden` 会裁掉菜单那两个坑。
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, FolderOpen, MousePointerClick, Pencil, Trash2 } from 'lucide-react';
import { coverTintOf } from '@/lib/coverTint';
import { apiDelete, apiPatch, apiPost } from '@/lib/client';
import { ConfirmDialog, ContextMenu, type MenuItem } from '@/components/ui/ContextMenu';
import { SelectionBar, SelectionEnter } from '@/components/ui/SelectionBar';
import './project-grid.css';

/** `GET /api/projects` 回来的字段（比服务端少：这里只需要列卡片）。 */
export type ProjectCardItem = {
  id: string;
  name: string;
  thumbnail: string | null;
  cover: string | null;
  updatedAt: string;
};

/** 封面：`cover` 是这个项目的资产里随机挑的一张图，`thumbnail` 是项目表上那个字段（一直没人写）。 */
const coverOf = (p: ProjectCardItem) => p.cover || p.thumbnail || '';

/*
 * 没有封面的项目卡轮换用这几支低饱和色（2026-10-08 徐先：「主页的卡片颜色可以更丰富一点」）。
 *
 * 🔴 **非要一组轮换色、不能就这么回落到中性面**：一个还没出过图的新项目（或只出过视频的）
 *    正好是最容易被一眼扫过去的那几张卡，把它们留在灰面上，「更丰富」就等于没做。
 *    颜色按卡片在列表里的位置轮换（不是按项目 id）—— 一排里相邻的两张一定不同色。
 * 具体取值在 `globals.css` 里按深浅两档各写一份（那是**洗底**用的 alpha，不是实心色）。
 */
const FALLBACK_TINTS = [
  'var(--home-tint-1)',
  'var(--home-tint-2)',
  'var(--home-tint-3)',
  'var(--home-tint-4)',
  'var(--home-tint-5)',
];

type MenuState = { x: number; y: number; project: ProjectCardItem } | null;
type Notice = { text: string; ok?: boolean } | null;

export default function ProjectGrid({
  projects, when, onChanged,
}: {
  projects: ProjectCardItem[];
  /**
   * 「最后编辑」那一截怎么显示。两页文案不同：首页说相对时间（「6 分钟前」，一天内的点亮成强调色），
   * 列表页说绝对日期 —— 所以由调用方决定，这里不猜。
   */
  when: (project: ProjectCardItem) => ReactNode;
  /** 改完名 / 删完项目叫一次。列表数据在上层（`useApi`），刷新也归上层。 */
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [menu, setMenu] = useState<MenuState>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  /* 删除要二次确认：确认框里显示的是**哪个项目**，不能只弹一句「确定删除吗」。 */
  const [confirming, setConfirming] = useState<ProjectCardItem | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  /*
   * 项目 id → 从它封面取到的主色（`"r, g, b"`，见 `lib/coverTint.ts`）。
   *
   * 🔴 刻意**不用 effect 预先算**：那需要依赖 `projects` 这个数组，而它的身份由上层
   *    `useApi` 决定、不一定稳定 —— 依赖它会把 effect 打进死循环（本文件上面那条
   *    「只在渲染时过一遍、不用 effect」的注释讲的就是同一个坑）。
   *    改成在封面 `<img>` 的 `load` 里当场取：**什么时候有图什么时候算**，
   *    既不用管 `projects` 的身份，也不用为取样多发一次请求。
   */
  const [tints, setTints] = useState<Record<string, string>>({});

  /* ── 批量选择（2026-09-26）───────────────────────────────── */
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmingPicked, setConfirmingPicked] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * 选中的 id 里，**只认现在还在列表上的那些**。
   *
   * 不做「用 effect 把失效的 id 从 state 里剔掉」：那个 effect 依赖 `projects`，
   * 而它是上层 `useMemo`/`useApi` 出来的数组，身份不稳定时会把 effect 打进死循环。
   * 在渲染时过一遍既没有这个风险，效果也一样。
   */
  const pickedItems = projects.filter(p => picked.includes(p.id));
  const pickedIds = pickedItems.map(p => p.id);

  /* Esc 退出选择：框选到一半发现选错了，最顺手的动作就是按一下 Esc。 */
  useEffect(() => {
    if (!selecting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      /* 确认框开着的时候 Esc 归它管（那边故意不响应 Esc），这里别越权关掉选择模式。 */
      if (confirmingPicked) return;
      setSelecting(false);
      setPicked([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, confirmingPicked]);

  /* 改名输入框一出现就聚焦并全选：右键点「重命名」的人下一步一定是打字。 */
  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming?.id]);

  function togglePick(id: string) {
    setNotice(null);
    setPicked(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  }

  function leaveSelecting() {
    setSelecting(false);
    setPicked([]);
    setBatchError(null);
  }

  function openMenu(event: React.MouseEvent, project: ProjectCardItem) {
    event.preventDefault();
    setNotice(null);
    /* 已经在改名的那张卡不弹菜单 —— 它已经不是链接了，多一个菜单只会打架。 */
    if (renaming?.id === project.id) return;
    setMenu({ x: event.clientX, y: event.clientY, project });
  }

  const menuItems: MenuItem[] = menu ? [
    {
      id: 'open',
      label: '打开',
      icon: <FolderOpen size={14} strokeWidth={1.8} aria-hidden />,
      run: () => { const p = menu.project; setMenu(null); router.push(`/projects/${p.id}`); },
    },
    /* 还没进选择模式时才给这一项 —— 已经在框选了，右键的下一步多半是改这一张的别的东西。 */
    ...(selecting ? [] : [{
      id: 'pick',
      label: '选中它',
      icon: <MousePointerClick size={14} strokeWidth={1.8} aria-hidden />,
      run: () => { const p = menu.project; setMenu(null); setSelecting(true); setPicked([p.id]); },
    }]),
    {
      id: 'rename',
      label: '重命名',
      icon: <Pencil size={14} strokeWidth={1.8} aria-hidden />,
      run: () => {
        const p = menu.project;
        setMenu(null);
        setNotice(null);
        /* 改名要求退出选择模式：那一行会被换成输入框，和勾选框叠在一起没法看。 */
        setSelecting(false);
        setPicked([]);
        setRenaming({ id: p.id, value: p.name });
      },
    },
    {
      id: 'delete',
      label: '删除项目',
      icon: <Trash2 size={14} strokeWidth={1.8} aria-hidden />,
      danger: true,
      run: () => { const p = menu.project; setMenu(null); setConfirmError(null); setConfirming(p); },
    },
  ] : [];

  async function commitRename() {
    if (!renaming || busy) return;
    const card = projects.find(p => p.id === renaming.id);
    const next = renaming.value.trim();
    if (!card) { setRenaming(null); return; }
    /* 没改就当作取消：发一次没有变化的写请求没有意义。 */
    if (next === card.name) { setRenaming(null); setNotice(null); return; }
    if (!next) { setNotice({ text: '项目名不能为空。' }); return; }
    setBusy(true);
    try {
      await apiPatch(`/api/projects/${renaming.id}`, { name: next });
      setRenaming(null);
      setNotice(null);
      onChanged?.();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : '改名失败，稍后再试。' });
    } finally {
      setBusy(false);
    }
  }

  async function removeProject() {
    if (!confirming || busy) return;
    setBusy(true);
    setConfirmError(null);
    try {
      await apiDelete(`/api/projects/${confirming.id}`);
      setConfirming(null);
      setNotice(null);
      onChanged?.();
    } catch (error) {
      setConfirmError(error instanceof Error ? error.message : '删除失败，稍后再试。');
    } finally {
      setBusy(false);
    }
  }

  /**
   * 批量删除。
   *
   * 走一个接口而不是前端 for 循环：循环删到第 7 个报错时，前 6 个已经删了、
   * 界面却只看到一句「删除失败」—— 用户完全不知道现在是什么状态。接口那边逐条删、
   * 把明细回过来，这里一次说清楚。
   */
  async function removePicked() {
    if (!pickedIds.length || busy) return;
    setBusy(true);
    setBatchError(null);
    try {
      const result = await apiPost<{ deleted: number; notFound: number; assets: number }>(
        '/api/projects/batch',
        { ids: pickedIds, action: 'delete' },
      );
      setConfirmingPicked(false);
      leaveSelecting();
      setNotice({
        ok: true,
        text: `已删除 ${result.deleted} 个项目`
          + (result.assets ? `（连带 ${result.assets} 条资产）` : '')
          + (result.notFound ? `；另有 ${result.notFound} 个已经不在了。` : '。'),
      });
      onChanged?.();
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : '删除失败，稍后再试。');
    } finally {
      setBusy(false);
    }
  }

  return <>
    {notice && (
      <p className={notice.ok ? 'pg-notice ok' : 'pg-notice'} role="status" data-pg-notice>
        {notice.text}
      </p>
    )}

    {projects.length > 0 && !selecting && (
      <SelectionEnter
        testId="projects"
        hint={`${projects.length} 个项目 —— 勾选后可以一次删掉好几个`}
        onEnter={() => { setNotice(null); setSelecting(true); }}
      />
    )}
    {projects.length > 0 && selecting && (
      <SelectionBar
        testId="projects"
        count={pickedIds.length}
        total={projects.length}
        busy={busy}
        onAll={() => setPicked(projects.map(p => p.id))}
        onNone={() => setPicked([])}
        onExit={leaveSelecting}
      >
        <button
          className="button danger small"
          type="button"
          data-pg-batch-delete
          disabled={busy || pickedIds.length === 0}
          onClick={() => { setBatchError(null); setConfirmingPicked(true); }}
        >
          <Trash2 size={14} strokeWidth={2} aria-hidden /> 删除所选
        </button>
      </SelectionBar>
    )}

    <div className="home-projects" data-pg-grid data-pg-selecting={selecting ? 'yes' : 'no'}>
      {projects.map((p, index) => {
        const editing = renaming?.id === p.id;
        const on = picked.includes(p.id);
        const cover = coverOf(p);
        /*
         * 卡片面要洗的那支色，三档来源：
         *   ① 封面取色到了 → 用封面自己的色（`--card-tint-a` 由 CSS 按主题给 alpha）；
         *   ② 有封面但取色失败 / 还没加载完 → 先不洗，等 `load` 到了再洗（不留灰底是对的：
         *      有封面的卡下一次渲染就着色了，中间这一帧洗成别的色反而像闪了一下）；
         *   ③ 压根没有封面 → 轮到哪支用哪支，保证一张彩卡都不会是灰的。
         */
        const rgb = tints[p.id];
        const tint = rgb
          /* 取到的是 `"r, g, b"` 三个数 —— alpha 交给 CSS 的 `--card-tint-a`（深浅两档不同）。 */
          ? `rgba(${rgb}, var(--card-tint-a))`
          : (cover ? '' : FALLBACK_TINTS[index % FALLBACK_TINTS.length]);
        const tintStyle = tint ? ({ '--card-tint': tint } as CSSProperties) : undefined;
        const body = <>
          <span className="home-project-thumb">
            {/*
              封面就是这个项目跑出来的图。一个图都没有的新项目（或只出过视频的）退回文件夹图标；
              图真加载不出来（文件被删了）就把 `<img>` 自己藏掉，别留一个碎图标。
            */}
            {cover
              ? <img
                src={cover}
                alt=""
                loading="lazy"
                /* 图一解码完就顺手取一次主色。取不到（真·黑白图 / 画布被污染）就什么都不做。 */
                onLoad={(e) => {
                  const rgb = coverTintOf(e.currentTarget);
                  if (!rgb) return;
                  setTints(prev => (prev[p.id] === rgb ? prev : { ...prev, [p.id]: rgb }));
                }}
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
              : <FolderOpen size={20} strokeWidth={1.4} aria-hidden />}
            {/* 选择模式下「打开 →」那行字要让位给勾选框，两个都浮在封面上会打架。 */}
            {!selecting && <span className="home-project-open" aria-hidden>打开 →</span>}
            {selecting && (
              <span className="pg-pick" aria-hidden>
                {on && <Check size={14} strokeWidth={3} />}
              </span>
            )}
          </span>
          <span className="home-project-body">
            {editing ? (
              <input
                ref={inputRef}
                className="pg-rename"
                data-pg-rename-input
                value={renaming.value}
                maxLength={80}
                aria-label="项目名称"
                onChange={e => setRenaming({ id: p.id, value: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
                  if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); setNotice(null); }
                }}
                onBlur={() => { void commitRename(); }}
              />
            ) : (
              <strong title={p.name}>{p.name}</strong>
            )}
            <small className="muted">最后编辑 {when(p)}</small>
          </span>
        </>;

        if (editing) {
          /* 改名时**不能**外层还是 `<a>`：输入框嵌在链接里，点一下就会跳走。 */
          return <div className="home-project editing" key={p.id} data-project-id={p.id} style={tintStyle}>{body}</div>;
        }

        if (selecting) {
          /*
           * 选择模式下卡片**不是链接**：点它应该切换勾选而不是打开项目。
           * 也不挂右键菜单 —— 那个菜单是「对这一个做什么」，框选状态下只有一颗勾选框有意义。
           */
          return (
            <div
              className={`home-project picking${on ? ' picked' : ''}`}
              key={p.id}
              data-project-id={p.id}
              data-project-picked={on ? 'yes' : 'no'}
              style={tintStyle}
              role="checkbox"
              aria-checked={on}
              aria-label={p.name}
              tabIndex={0}
              onClick={() => togglePick(p.id)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); togglePick(p.id); }
              }}
            >
              {body}
            </div>
          );
        }

        return (
          <Link
            className="home-project"
            key={p.id}
            href={`/projects/${p.id}`}
            data-project-id={p.id}
            data-project-picked="no"
            style={tintStyle}
            onContextMenu={event => openMenu(event, p)}
            /* Ctrl / ⌘ + 单击 = 顺手进入选择模式并勾上这一张（文件管理器那套肌肉记忆）。 */
            onClick={event => {
              if (!event.ctrlKey && !event.metaKey) return;
              event.preventDefault();
              setNotice(null);
              setSelecting(true);
              setPicked([p.id]);
            }}
          >
            {body}
          </Link>
        );
      })}
    </div>

    {menu && (
      <ContextMenu
        at={{ x: menu.x, y: menu.y }}
        title={menu.project.name}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
    )}

    {confirming && (
      <ConfirmDialog
        testId="project"
        title={`删除「${confirming.name}」？`}
        body={
          <p className="muted">
            这个项目的画布、里面所有生成的图片与视频都会一起删掉，磁盘上的文件也会清掉 ——
            <strong>删了拿不回来</strong>。
          </p>
        }
        error={confirmError}
        busy={busy}
        busyLabel="正在删除…"
        confirmLabel="删除"
        onCancel={() => setConfirming(null)}
        onConfirm={() => void removeProject()}
      />
    )}

    {confirmingPicked && (
      <ConfirmDialog
        testId="project-batch"
        title={`删除选中的 ${pickedIds.length} 个项目？`}
        body={<>
          <p className="muted">
            每个项目里的画布、生成的图片与视频都会一起删掉，磁盘上的文件也会清掉 ——
            <strong>删了拿不回来</strong>。
          </p>
          {/* 名字列出来：一次勾十几张时，用户需要回头确认一遍自己勾对了没有。 */}
          <ul className="cx-confirm-list" data-pg-batch-list>
            {pickedItems.map(p => <li key={p.id}>{p.name}</li>)}
          </ul>
        </>}
        error={batchError}
        busy={busy}
        busyLabel="正在删除…"
        confirmLabel={`删除这 ${pickedIds.length} 个`}
        onCancel={() => setConfirmingPicked(false)}
        onConfirm={() => void removePicked()}
      />
    )}
  </>;
}
