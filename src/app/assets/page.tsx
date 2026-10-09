'use client';

/*
 * 资产页（2026-09-18 从服务端组件改成客户端取数）。
 *
 * 原来这一页在服务端直接调 `listAssets()` / `listAssetProjects()` / `storageOverview()`。
 * 桌面版没有服务端渲染这一步，三项数据改由 `/api/assets` 一次给全（新增接口）。
 * 筛选条件继续走地址栏的 `?type=` / `?project=`，所以「筛选结果」这个链接仍然可以分享。
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Images, Trash2, Upload } from 'lucide-react';
import SideNav from '@/components/start/SideNav';
/* 常量从 `asset-kinds` 拿：同名的 `lib/assets.ts` 带 node:fs 和数据库，浏览器包里不能出现。 */
import {
  ASSET_KINDS, type AssetCategoryItem, type AssetKind, type CategoryFilter,
} from '@/lib/asset-kinds';
import type { AssetItem, StorageOverview } from '@/lib/assets';
import AssetFilters from '@/components/assets/AssetFilters';
import AssetGallery from '@/components/assets/AssetGallery';
import StorageBar from '@/components/assets/StorageBar';
import { ConfirmDialog } from '@/components/ui/ContextMenu';
import { isDesktop } from '@/lib/edition';
import { apiPost, useApi, useSession } from '@/lib/client';
import { pollDelayMs } from '@/lib/taskPoll';
import { upscaleWorkflowForImported, upscaleEngineOf } from '@/lib/workflows/upscale';
import { readLastUpscaleWorkflow, rememberLastUpscaleWorkflow } from '@/lib/upscaleMemory';
import { useSearchParams } from 'next/navigation';

type AssetProject = { id: string; name: string; count: number };
type AssetsPayload = {
  items: AssetItem[];
  total: number;
  totalSize: number;
  /** 还有没有下一页（2026-10-09 分页）。它是「要不要再拉一页」的唯一依据。 */
  hasMore: boolean;
  page: number;
  pageSize: number;
  projects: AssetProject[];
  storage: StorageOverview;
  /** 用户自己维护的分类表（含每项目前有多少条在用）。见 `/api/assets/categories`。 */
  categories: AssetCategoryItem[];
  /** 一共多少个 latent —— 只给「一键删除 Latent」那颗按钮用（0 时按钮不出现）。 */
  latentCount: number;
};

/**
 * 第二页往后那份（服务端只回列表本身，见 `/api/assets`）。
 *
 * 为什么另开一个类型而不是复用 `AssetsPayload`：那里面的 `projects` / `storage` /
 * `categories` / `latentCount` 在翻页时**真的没有** —— 复用就等于对接口撒了个
 * 「后面几页也带」的谎，哪天有人写 `data.projects.map(...)` 就会在翻页那一支上炸。
 */
type AssetPagePayload = { items: AssetItem[]; total: number; totalSize: number; hasMore: boolean; page: number };

export default function Assets() {
  const { user } = useSession();
  const params = useSearchParams();
  const rawType = params.get('type') ?? '';
  const rawSub = params.get('sub') ?? '';
  const projectId = params.get('project') ?? '';
  /*
   * 分类值是**用户自己维护**的字符串，这里不再拿一张写死的表去认它：
   * 认不出的（比如分享出去的链接里留着一个已经被删掉的分类名）由服务端兜成「不筛」，
   * 前端只要原样传过去就行 —— 见 `/api/assets`。
   */
  const category = (rawSub || 'all') as CategoryFilter;
  /* 类型与分类是**两个独立维度**：任何类型的资产都能打分类，不再互相牵制。 */
  const type = (ASSET_KINDS.find((kind) => kind.value === rawType)?.value || 'all') as AssetKind | 'all';

  const query = new URLSearchParams();
  if (type !== 'all') query.set('type', type);
  if (category !== 'all') query.set('sub', category);
  if (projectId) query.set('project', projectId);
  const qs = query.toString();

  const { data, loading, reload } = useApi<AssetsPayload>(user ? `/api/assets${qs ? `?${qs}` : ''}` : null);

  /* ── 分页：一次 60 条，往下滚再要一页（2026-10-09）────────────────── */
  /*
   * 以前这一页**只有**最近 60 条 —— `take` 就是全部，翻不动也说不出「还有多少」。
   * 现在第一页照旧由 `useApi` 管，第二页往后攒在 `extra` 里。
   *
   * 为什么不「把 60 调大、一次给完」：四百来张缩略图一次进 DOM，这一页会明显卡；
   * 而画廊这种东西本来就该「往下滚继续出」，比让人去找页码顺手。
   *
   * 🔴 **任何让第一页重取的动作都要把 `extra` 清掉**（删了一页里的几条、打了分类、
   *    上传完、改了筛选条件）—— 不清的话旧的第二页会挂在新第一页后面，
   *    看着像「删掉的那条又回来了」。所以对外一律走 `reloadAll`，不用裸 `reload`。
   */
  const [extra, setExtra] = useState<AssetItem[]>([]);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  /** 最后一页回回来的 `hasMore`（第一页那份在 `data` 里）；没翻过页时是 `null`。 */
  const [tailHasMore, setTailHasMore] = useState<boolean | null>(null);

  const items = useMemo(() => [...(data?.items ?? []), ...extra], [data, extra]);
  const total = data?.total ?? 0;
  /** 还没翻过页时听第一页的；翻过之后以最后一页回回来的为准。 */
  const hasMore = tailHasMore ?? data?.hasMore ?? false;

  const resetPaging = useCallback(() => {
    setExtra([]);
    setPage(1);
    setTailHasMore(null);
    setMoreError('');
  }, []);

  /** 「这份列表要重取了」—— 顺手把攒下的后面几页一起丢掉。 */
  const reloadAll = useCallback(() => { resetPaging(); reload(); }, [reload, resetPaging]);

  /* 换筛选条件 = 换一份列表：地址栏变了就当重来（挂载时跑一次，无害）。 */
  useEffect(() => { resetPaging(); }, [qs, resetPaging]);

  const loadMore = useCallback(async () => {
    if (!user || loading || loadingMore || !hasMore) return;
    const next = page + 1;
    setLoadingMore(true);
    setMoreError('');
    try {
      /* 从 `qs` 拷一份再盖章：筛选条件一个字都不能少，否则翻到第二页就换了个筛法。 */
      const q = new URLSearchParams(qs);
      q.set('page', String(next));
      const res = await fetch(`/api/assets?${q.toString()}`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`加载失败（${res.status}）`);
      const body = (await res.json().catch(() => null)) as AssetPagePayload | null;
      const fresh = Array.isArray(body?.items) ? body.items : [];
      setExtra(prev => {
        /*
         * 去重：这一页和上一页之间**可能有人删了东西**，`skip` 是按「当前还剩多少」
         * 算的，于是下一条会往上顶一位、出现两次。宁可少一条也不要同一张图出现两遍 ——
         * 真漏了那条，下一次翻页或刷新就补上了。
         */
        const seen = new Set([...(data?.items ?? []), ...prev].map(item => item.id));
        return [...prev, ...fresh.filter(item => !seen.has(item.id))];
      });
      setPage(next);
      setTailHasMore(Boolean(body?.hasMore));
    } catch (e) {
      setMoreError(e instanceof Error ? e.message : '加载失败。');
    } finally {
      setLoadingMore(false);
    }
  }, [user, loading, loadingMore, hasMore, page, qs, data]);

  /*
   * 滚到底自动加载下一页。
   *
   * 提前 360px 就动手 —— 等到底了才发请求，中间那一段是空白，
   * 用户看到的是「卡了一下」；提前一点几乎总是已经加载完了。
   *
   * 🔴 **刻意不用 `IntersectionObserver`**（2026-10-09 真机实测：滚到底之后哨兵的
   *    `getBoundingClientRect()` 明明白白落在视口里，observer 却**一次回调都没给** ——
   *    在页面里另起一个一模一样的 observer 也是 0 次，不是我们挂错了地方。
   *    桌面版这套自定义协议 + 关掉 GPU 合成的组合下不能指望它。）
   *    改成监听**真正滚动的那个容器**的 `scroll` 事件 + 自己量一次 rect：
   *    不依赖浏览器的渲染节拍，什么时候都准。
   *
   * ⚠️ `loadMore` 每渲染都换一个身份（依赖里带着 `data`），它进依赖数组会让监听
   *    每次渲染都重建。用 ref 转一层：effect 只在「还能不能翻 / 这次翻完没有」
   *    真的变了时才重建，但回调里拿到的永远是最新的那个。
   */
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || loadingMore || loading) return;

    const check = () => {
      const rect = node.getBoundingClientRect();
      if (rect.top <= window.innerHeight + 360) void loadMoreRef.current();
    };
    /* 谁在滚：从哨兵往上找第一个真的能滚的祖先（桌面版是 `.workspace` 那一层）。 */
    let scroller: HTMLElement | null = node.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight + 4) scroller = scroller.parentElement;
    /* 挂载后先量一次：比如第一页还没填满一屏，那就该接着往下要。 */
    check();
    const target: EventTarget = scroller ?? window;
    target.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      target.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, [hasMore, loadingMore, loading, items.length]);
  const projects = data?.projects ?? [];
  const storage = data?.storage;
  const categories = data?.categories ?? [];
  /* 「一键删除 Latent」那颗按钮要用：0 个的时候按钮不出现。 */
  const latentCount = data?.latentCount ?? 0;
  const filtered = type !== 'all' || category !== 'all' || Boolean(projectId);

  /*
   * 手动上传（2026-09-25）：页头按钮选图，或把图直接拖进正文。
   * 筛在某个项目里拖图 → 落那个项目；否则服务端落固定项目「上传的图片」。
   */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');

  /* ── 超清（2026-10-03：导入的图 / 视频也能加工）────────────── */
  /*
   * 用哪一份超清工作流：**与画布上那颗「超清」按钮同一个筛法**（`upscaleWorkflowForImported`）。
   *
   * 灯箱这里的 asset 不在画布上、没有连线，所以「跟随」的三条里只剩后两条 ——
   * 用**上一次超清用过的那份**，一份都没记过才取候选里最近改过的那份（2026-10-04）。
   * 两边各写一份挑法的话，迟早出现「画布点得动、资产页说没配」这种同文案两种结论。
   */
  const { data: flowData } = useApi<{
    workflows: { workflowId: string; name: string; kind: string; operation: string; provider?: string }[];
  }>(user ? '/api/workflows?operation=upscale' : null);
  const upscaleFlows = flowData?.workflows ?? [];
  const [upscaling, setUpscaling] = useState<{ assetId: string; taskId: string; name: string } | null>(null);

  /** 参数只用得到这几个字段（画廊那边的 `GalleryItem` 也是这个形状），不绑死某一种类型。 */
  async function startUpscale(item: { id: string; name: string; type: string; url: string; projectId: string }) {
    if (upscaling) return;
    const kind = item.type === 'video' ? 'video' : item.type === 'image' ? 'image' : null;
    if (!kind) { setUploadMsg('只有图片和视频能超清 —— latent 与音频没有这一道工序。'); return; }
    /* 没有连线可跟（asset 不在画布上），所以 followedSide 传 null：「跟随」直接落到「上一次那份」。 */
    const flow = upscaleWorkflowForImported(upscaleFlows, kind, 'follow', null, '', readLastUpscaleWorkflow(kind));
    if (!flow) {
      setUploadMsg(`还没有配${kind === 'video' ? '视频' : '图片'}超清工作流 —— 到「设置 · 工作流」新建一份工作流，`
        + '把「工序」改成「超清」，再把工作流里那个上传段的「画布绑定」选成「画布 · 参考图 1」（图）'
        + '或「画布 · 视频输入 1」（视频）。');
      return;
    }
    setUploadMsg('');
    try {
      const res = await fetch(`/api/projects/${item.projectId}/generation`, {
        method: 'POST',
        /* 桌面版带上它：不带会被当成页面跳转回一个 303，fetch 跟过去就 Failed to fetch。 */
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          /** 这一条不是画布节点：`asset:` 前缀让它在生成历史里也说得清是谁跑的。 */
          nodeId: `asset:${item.id}`,
          nodeLabel: String(item.name || '').slice(0, 60),
          workflowId: flow.workflowId,
          kind,
          operation: 'upscale',
          /*
           * 🔴 Which side this run goes to has to be reported (fixed 2026-10-04): without
           * `engine` the server's "engine ↔ workflow" check reads it as RunningHub and
           * rejects every local upscale (see `upscale()` in CanvasEditor). The asset page
           * has no "node engine" to follow, so the side is the chosen workflow's own.
           */
          engine: upscaleEngineOf('follow', null, flow.provider),
          /* 超清唯一的输入就是这份素材本身；服务端会把它换成对端认得的文件名。 */
          bindingValues: { upscaleInput: item.url },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || '提交失败。');
      /* 提交成功才记「上一次超清用的是这份」（画布那边同一份记录，两边共用）。 */
      rememberLastUpscaleWorkflow(kind, flow.workflowId);
      setUpscaling({ assetId: item.id, taskId: String(body.taskId || ''), name: item.name });
      setUploadMsg(`已提交超清 · ${flow.name || flow.workflowId} —— 跑完会存成新的一份资产。`);
    } catch (e) {
      setUploadMsg(e instanceof Error ? e.message : '提交失败。');
    }
  }

  /*
   * 轮询这一条超清任务。**只问到有结果为止**（与画布同一个口径）：
   * 任务只有成功与失败两种终态，不问到终态就不知道该刷新还是该报错。
   */
  useEffect(() => {
    if (!upscaling?.taskId) return;
    let alive = true;
    const startedAt = Date.now();
    void (async () => {
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, pollDelayMs(Date.now() - startedAt)));
        if (!alive) return;
        const res = await fetch(`/api/tasks/${upscaling.taskId}`).catch(() => null);
        const task = res && res.ok ? await res.json().catch(() => null) : null;
        if (!alive) return;
        /* 这一趟没问到（网络 / 上游抽风）不算失败 —— 任务还在，下一趟接着问。 */
        if (!task || task.status === 'running' || task.status === 'queued') continue;
        if (task.status === 'success') {
          setUploadMsg(`「${upscaling.name}」超清完成 —— 结果已经存进资产库。`);
          reloadAll();
        } else {
          setUploadMsg(`超清失败：${String(task.error || '任务失败了')}`);
        }
        setUpscaling(null);
        return;
      }
    })();
    return () => { alive = false; };
  }, [upscaling, reloadAll]);

  /* ── 一键删除 Latent（2026-10-02）────────────────────────── */
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeForce, setPurgeForce] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [purgeMsg, setPurgeMsg] = useState('');

  /**
   * latent 是「接续上一段」的输入，很容易正被画布用着。
   * 那些**不删**（服务端 `in_use` 拦下），回过来告诉用户是哪几条在哪个项目里，
   * 确认之后才放出「仍然删除」—— 一上来就给「仍然删除」等于默认让人点它。
   */
  async function purgeLatents(force: boolean) {
    if (purgeBusy) return;
    setPurgeBusy(true);
    setPurgeError(null);
    try {
      const result = await apiPost<{
        deleted: number; notFound: number; filesLeft: number;
        inUse: { id: string; name: string; projects: string[] }[];
      }>('/api/assets/batch', { action: 'purge', kind: 'latent', force });

      if (result.inUse.length) {
        setPurgeForce(true);
        setPurgeError(
          `有 ${result.inUse.length} 个正被画布引用（`
          + result.inUse.slice(0, 3).map(row => `「${row.name}」在 ${row.projects.join('、')}`).join('；')
          + (result.inUse.length > 3 ? ' …' : '')
          + '），删掉之后那几条接续链路下次生成会取不到值。'
          + (result.deleted ? `其余 ${result.deleted} 个已经删掉了。` : '')
          + ' 确认要连它们一起删掉吗？',
        );
        if (result.deleted) reloadAll();
        return;
      }

      setPurgeOpen(false);
      setPurgeForce(false);
      setPurgeMsg(
        `已删除 ${result.deleted} 个 Latent`
        + (result.notFound ? `；另有 ${result.notFound} 个已经不在了` : '')
        + (result.filesLeft ? `；${result.filesLeft} 个文件没能从磁盘上删掉（会体现在「孤儿文件」那一栏）` : '')
        + '。',
      );
      reloadAll();
    } catch (e) {
      setPurgeError(e instanceof Error ? e.message : '删除失败，稍后再试。');
    } finally {
      setPurgeBusy(false);
    }
  }
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  /* 拖到侧栏 / 页头这些「非收货区」时浏览器会直接打开文件 —— 全窗先拦掉默认行为。 */
  useEffect(() => {
    const prevent = (event: DragEvent) => { event.preventDefault(); };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  async function uploadFiles(list: FileList | File[]) {
    const files = Array.from(list).filter((f) => f.size > 0);
    if (!files.length || uploading) return;
    setUploading(true); setUploadMsg('');
    try {
      const form = new FormData();
      for (const f of files) form.append('files', f);
      if (projectId) form.append('projectId', projectId);
      const res = await fetch('/api/assets/upload', { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || '上传失败。');
      reloadAll();
      const skipped = Array.isArray(body.skipped) ? body.skipped.length : 0;
      /*
       * 「上传了几个」要说清是图还是视频：混着拖进来时一句「已上传 3 张图片」
       * 会让人以为那一段视频没进来。（数量由服务端按落盘结果点，不靠前端猜扩展名。）
       */
      const saved: { type?: string }[] = Array.isArray(body.items) ? body.items : [];
      const images = saved.filter(item => item.type === 'image').length;
      const videos = saved.filter(item => item.type === 'video').length;
      const counted = [images ? `${images} 张图片` : '', videos ? `${videos} 个视频` : ''].filter(Boolean).join(' 和 ');
      setUploadMsg(
        `已上传 ${counted || `${body.saved} 个文件`}`
        + (skipped ? `，跳过 ${skipped} 个存不下来的文件` : '')
        + (projectId ? '' : `（在「${body.projectName || '上传的素材'}」项目里）`),
      );
    } catch (e) {
      setUploadMsg(e instanceof Error ? e.message : '上传失败。');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link className="brand" href="/">
          <span className="brand-mark">✦</span> Holy Light画布
        </Link>
        <SideNav active="assets" />
        {/* 桌面版不显示账号与退出：固定一个本机用户，这两行只会让人困惑 */}
        {!isDesktop && user && <div className="side-bottom">
          <div className="account">{user.name}<br />{user.email}</div>
        </div>}
      </aside>
      <section className="workspace">
        {dragActive && (
          <div className="assets-drop-hint" data-assets-drop-hint aria-hidden>
            <div>松开鼠标，把图片 / 视频传进资产</div>
          </div>
        )}
        <header className="workspace-header">
          <div>
            <strong>资产</strong>
            <br />
            <small>生成过的图片、视频、音频与接续 latent</small>
          </div>
        </header>
        <main className="content"
          onDragOver={(event) => event.preventDefault()}
          onDragEnter={(event) => {
            event.preventDefault();
            dragDepth.current += 1;
            setDragActive(true);
          }}
          onDragLeave={() => {
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) { dragDepth.current = 0; setDragActive(false); }
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragDepth.current = 0; setDragActive(false);
            const files = Array.from(event.dataTransfer?.files ?? [])
              .filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
            if (!files.length) {
              setUploadMsg('拖进来的文件里没有能存的 —— 只收图片（PNG / JPEG / WebP / GIF）和视频（MP4 / WebM / MOV）。');
              return;
            }
            uploadFiles(files);
          }}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">ASSETS</div>
              <h1>{filtered ? '筛选结果' : '全部资产'}</h1>
            </div>
            <div className="page-side">
              <div className="header-actions">
                <button className="button" type="button" data-assets-upload disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}>
                  <Upload size={15} aria-hidden /> {uploading ? '上传中…' : '上传素材'}
                </button>
                {/* 没有 latent 就不出现 —— 常态不该占版面。 */}
                {latentCount > 0 && (
                  <button
                    className="button danger"
                    type="button"
                    data-assets-purge-latent
                    disabled={purgeBusy}
                    onClick={() => { setPurgeMsg(''); setPurgeError(null); setPurgeForce(false); setPurgeOpen(true); }}
                  >
                    <Trash2 size={15} aria-hidden /> 删除全部 Latent（{latentCount}）
                  </button>
                )}
                <Link className="button" href="/projects/new">新建项目</Link>
              </div>
              <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple hidden data-assets-file
                onChange={(event) => {
                  if (event.target.files?.length) uploadFiles(event.target.files);
                  event.target.value = '';
                }} />
              <span className="muted">
                {loading && !data
                  ? '加载中…'
                  /* 「已显示 N / 总共 M」：以前那句「显示最近 60 项」是在替一个
                     翻不动的实现打圆场 —— 现在后面还能继续翻，就得说清看到哪了。 */
                  : `${total} 项${items.length < total ? ` · 已显示 ${items.length} 项` : ''}`}
              </span>
            </div>
          </div>

          {uploadMsg && <p className="muted assets-upload-msg" data-assets-upload-msg>{uploadMsg}</p>}

          {/* 这一段是**全部账号资产**的口径，不跟着上面的筛选走 */}
          {storage && <StorageBar storage={storage} />}

          <AssetFilters
            type={type}
            category={category}
            projectId={projectId}
            kinds={ASSET_KINDS}
            categories={categories}
            projects={projects}
            onCategoriesChanged={reloadAll}
          />

          {user && !loading && items.length === 0 && (
            <div className="empty">
              <div className="empty-icon"><Images size={26} strokeWidth={1.4} aria-hidden /></div>
              <h3>{filtered ? '这个条件下没有资产' : '还没有资产'}</h3>
              <p className="muted">
                {filtered
                  ? '换个类型或项目试试。'
                  : '每次生成成功，视频、图片、音频、文本，以及接续用的 latent 都会自动存到这里。'}
              </p>
              {!filtered && <Link className="button" href="/projects/new">新建项目</Link>}
            </div>
          )}
          {/*
            画廊**恒挂载**：列表空了不再把整块换成上面的空状态 ——
            否则删完最后几张时组件被卸载，刚设好的「已删除 N 项」回执跟着没了，
            用户删空一个筛选结果就什么都看不到（2026-09-26 探针 H-2 抓到的真 bug）。
            空列表时画廊自己只留回执那一条，不画网格也不画「选择」入口。
          */}
          <AssetGallery
            items={items}
            categories={categories}
            onChanged={reloadAll}
            onUpscale={startUpscale}
            upscalingId={upscaling?.assetId ?? null}
          />

          {/*
            翻页那一块。滚到底（提前 360px）会自动加载下一页，这颗按钮是**兜底**：
            observer 不认的容器（换了布局、被浮层盖住）里它照样能用，
            而且「还有多少没看到」这句话本身也是给用户看的。
          */}
          {hasMore && (
            <div className="assets-more" ref={sentinelRef}>
              <button
                className="button"
                type="button"
                data-assets-more
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? '加载中…' : `加载更多（还有 ${Math.max(total - items.length, 0)} 项）`}
              </button>
            </div>
          )}
          {moreError && <p className="muted assets-upload-msg" data-assets-more-error>{moreError}</p>}

          {purgeMsg && <p className="muted assets-upload-msg" data-assets-purge-msg>{purgeMsg}</p>}

          {purgeOpen && (
            <ConfirmDialog
              testId="assets-purge-latent"
              title={`删除全部 ${latentCount} 个 Latent？`}
              body={<p className="muted">
                记录和磁盘上的文件都会删掉 —— <strong>删了拿不回来</strong>。
                正被画布用着（接续上一段）的那些不会被删，会告诉你是哪几条。
              </p>}
              error={purgeError}
              busy={purgeBusy}
              busyLabel="正在删除…"
              confirmLabel={purgeForce ? '仍然删除' : '删除'}
              onCancel={() => { if (!purgeBusy) { setPurgeOpen(false); setPurgeForce(false); } }}
              onConfirm={() => void purgeLatents(purgeForce)}
            />
          )}
        </main>
      </section>
    </div>
  );
}
