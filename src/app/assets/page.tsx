'use client';

/*
 * 资产页（2026-09-18 从服务端组件改成客户端取数）。
 *
 * 原来这一页在服务端直接调 `listAssets()` / `listAssetProjects()` / `storageOverview()`。
 * 桌面版没有服务端渲染这一步，三项数据改由 `/api/assets` 一次给全（新增接口）。
 * 筛选条件继续走地址栏的 `?type=` / `?project=`，所以「筛选结果」这个链接仍然可以分享。
 */
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
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
import { useSearchParams } from 'next/navigation';

type AssetProject = { id: string; name: string; count: number };
type AssetsPayload = {
  items: AssetItem[];
  total: number;
  totalSize: number;
  projects: AssetProject[];
  storage: StorageOverview;
  /** 用户自己维护的分类表（含每项目前有多少条在用）。见 `/api/assets/categories`。 */
  categories: AssetCategoryItem[];
  /** 一共多少个 latent —— 只给「一键删除 Latent」那颗按钮用（0 时按钮不出现）。 */
  latentCount: number;
};

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
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
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
        if (result.deleted) reload();
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
      reload();
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
      reload();
      const skipped = Array.isArray(body.skipped) ? body.skipped.length : 0;
      setUploadMsg(
        `已上传 ${body.saved} 张图片`
        + (skipped ? `，跳过 ${skipped} 个存不下来的文件` : '')
        + (projectId ? '' : '（在「上传的图片」项目里）'),
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
            <div>松开鼠标，把图片传进资产</div>
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
              .filter((f) => f.type.startsWith('image/'));
            if (!files.length) {
              setUploadMsg('拖进来的文件里没有图片 —— 只收 PNG / JPEG / WebP / GIF。');
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
                  <Upload size={15} aria-hidden /> {uploading ? '上传中…' : '上传图片'}
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
              <input ref={fileInputRef} type="file" accept="image/*" multiple hidden data-assets-file
                onChange={(event) => {
                  if (event.target.files?.length) uploadFiles(event.target.files);
                  event.target.value = '';
                }} />
              <span className="muted">
                {loading && !data ? '加载中…' : `${total} 项${items.length < total ? ` · 显示最近 ${items.length} 项` : ''}`}
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
            onCategoriesChanged={reload}
          />

          {user && !loading && items.length === 0 && (
            <div className="empty">
              <div className="empty-icon"><Images size={26} strokeWidth={1.4} aria-hidden /></div>
              <h3>{filtered ? '这个条件下没有资产' : '还没有资产'}</h3>
              <p className="muted">
                {filtered
                  ? '换个类型或项目试试。'
                  : '每次生成成功，视频、图片和接续用的 latent 都会自动存到这里。'}
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
          <AssetGallery items={items} categories={categories} onChanged={reload} />

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
