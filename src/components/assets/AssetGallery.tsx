'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check, Copy, Eye, FileArchive, FileText, FolderOpen, ImageIcon, Music, Pencil, Sparkles, Trash2, Video, X,
} from 'lucide-react';
import { apiPatch, apiPost } from '@/lib/client';
import { revealFilePath, startDragFilePath } from '@/lib/desktop-fs';
import type { AssetCategoryItem } from '@/lib/asset-kinds';
/* 类型清单只认 `AssetFilters` 那一份（见那边的注释）：抄第二份迟早两边不同步。 */
import type { Kind } from './AssetFilters';
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

export type GalleryItem = {
  id: string;
  name: string;
  type: Kind;
  /** 分类名本身（`assets.category` 里存的就是它，不再需要「值 → 标签」的映射表）。 */
  category: string | null;
  url: string;
  /**
   * 接口还在给这个字段，但**界面已经不用它了**（2026-10-09）：
   * 灯箱上那颗「下载」换成了「打开文件所在位置」—— 资产本来就是本机落盘的，
   * 再存一份没有意义，用户要的是「它到底在哪」。
   */
  downloadUrl: string;
  createdLabel: string;
  sizeLabel: string;
  projectId: string;
  projectName: string;
};

const KIND_TEXT: Record<Kind, string> = { video: '视频', image: '图片', audio: '音频', latent: 'Latent', text: '文本' };
/* 分类列表由页面从 `/api/assets` 传下来（`categories`），这里不再自带一份写死的表。 */

type Notice = { text: string; ok?: boolean } | null;

function Glyph({ kind }: { kind: Kind }) {
  if (kind === 'video') return <Video size={22} strokeWidth={1.5} aria-hidden />;
  if (kind === 'image') return <ImageIcon size={22} strokeWidth={1.5} aria-hidden />;
  if (kind === 'audio') return <Music size={22} strokeWidth={1.5} aria-hidden />;
  if (kind === 'text') return <FileText size={22} strokeWidth={1.5} aria-hidden />;
  return <FileArchive size={22} strokeWidth={1.5} aria-hidden />;
}

export default function AssetGallery({ items, categories, onChanged, onUpscale, upscalingId }: {
  items: GalleryItem[];
  /** 用户自己维护的分类表。灯箱里的分类按钮与批量「归类」都按它来画。 */
  categories: AssetCategoryItem[];
  /**
   * 改完（分类 / 改名 / 删除）叫一次。列表数据在上层（页面那个 `useApi`），刷新也归上层 ——
   * 传进来的话只重取一次列表；没传就退回 `router.refresh()`（整页重载，桌面版那次等于 reload）。
   */
  onChanged?: () => void;
  /**
   * 超清（2026-10-03 徐先：「从资产库中导入的图片和视频也可以进行超清处理」）。
   *
   * 挑工作流、提交、轮询那些都归上层（页面），这里只负责**在灯箱里给一个入口** ——
   * 资产画廊不该知道「超清是怎么跑的」。传了才画按钮，所以不需要的页面不占版面。
   */
  onUpscale?: (item: GalleryItem) => void;
  /** 正在超清的那一条（页面在轮询）。卡片 / 按钮按它显形，不另开一套状态。 */
  upscalingId?: string | null;
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

  /*
   * 「复制」那颗按钮的短暂回执（2026-10-09 徐先：「我要可以复制的功能」）。
   * 用**按钮自己改字**（复制 → 已复制）而不是在别处加一行提示：
   * 复制是就地一下的动作，回执也该长在他按的那颗按钮上。
   */
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  /** 灯箱里那张图 —— 复制图片要拿它进 canvas，不再多取一次网络。 */
  const stageImgRef = useRef<HTMLImageElement>(null);
  /**
   * 「这条资产在本机哪」的缓存（2026-10-09 徐先：「也可以直接将拖入别的软件」）。
   *
   * 🔴 拖拽**没有**「先等一下再拖」的余地：`dragstart` 那一刻必须已经把路径交给主进程
   *    （见 preload 里 `startDrag` 那段，晚一步用户的拖拽会话就结束了）。
   *    所以路径只能在**按下鼠标**时就开始取 —— 人到真正拖起来中间那几十~几百毫秒，
   *    足够本地那条接口跑完。
   */
  const pathCache = useRef<Record<string, string>>({});

  /** 关灯箱时把删除的中间状态一起清掉，免得下次打开还停在「确认删除」上。 */
  const close = useCallback(() => {
    setOpenId(null);
    setBusy(false);
    setError('');
    setCatBusy(false);
    setCopied(false);
    if (copyTimer.current) { window.clearTimeout(copyTimer.current); copyTimer.current = null; }
  }, []);

  /**
   * 这条资产在**本机磁盘上的绝对路径**。
   *
   * 单开一条接口按需取，不放进列表：列表一次六十行，每行都要摸一次盘才算出这个字段，
   * 而它只在一颗**按下去才会用到**的按钮里出现（见 `server/api/assets/[id]/path/route.ts`）。
   */
  const localPathOf = useCallback(async (id: string): Promise<string> => {
    const res = await fetch(`/api/assets/${id}/path`);
    if (res.status === 404) throw new Error('这条资产的文件已经不在磁盘上了。');
    if (!res.ok) throw new Error(`取文件位置失败（${res.status}）。`);
    const body = (await res.json()) as { path?: unknown };
    const file = String(body?.path || '');
    if (!file) throw new Error('没拿到文件位置。');
    return file;
  }, []);

  /** 打开文件所在位置：资源管理器里定位到这一份，而不是只打开目录。 */
  const reveal = useCallback(async (item: GalleryItem) => {
    setError('');
    try {
      const file = await localPathOf(item.id);
      const outcome = await revealFilePath(file);
      if (!outcome.ok) throw new Error(outcome.message || '打开文件位置失败。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开文件位置失败。');
    }
  }, [localPathOf]);

  /**
   * 复制。
   *
   * · 图片 → **把它本身放进剪贴板**（不是路径）：画到 canvas 再 `toBlob('image/png')`，
   *   这样 WebP / GIF 这类 `nativeImage` 读不了的格式也能复制（Chromium 解得开就行），
   *   粘到别处统一是 PNG，最不容易出问题。
   * · 文本 → 那一段字。
   * · 视频 / 音频 / latent → **文件路径**。剪贴板装不下一个视频，
   *   这时候「把路径给他」才是能用的那件事（粘到 ComfyUI / 播放器里就能打开）。
   *
   * ⚠️ 刻意**不是 `useCallback`**：要从两个地方被调用（灯箱底栏那颗按钮、卡片右键菜单），
   *   而「灯箱开着吗」决定了那句报错往哪儿显示，闭包必须拿到当前这次渲染的 `openId`。
   */
  async function copy(item: GalleryItem) {
    if (openId) setError('');
    try {
      if (item.type === 'image') {
        /*
         * 图源：灯箱里**已经解码好的那一张**能省一次取图，但只有它确实就是这一条资产时才能用。
         * 🔴 右键菜单是在**卡片**上按的，那时灯箱可能开着的是另一张、甚至根本没开 ——
         *    照搬 `stageImgRef` 会安安静静地复制错图（比报错难查得多）。
         *    比 URL 而不是比 id：`<img>.src` 拿到的是解析后的绝对地址，跟 `item.url` 不一定同形。
         */
        const staged = stageImgRef.current;
        const wanted = new URL(item.url, window.location.href).href;
        const img = staged && staged.naturalWidth > 0 && staged.src === wanted
          ? staged
          : await new Promise<HTMLImageElement>((resolve, reject) => {
              const fresh = new Image();
              fresh.onload = () => resolve(fresh);
              fresh.onerror = () => reject(new Error('这张图没读出来，等一下再复制。'));
              fresh.src = item.url;
            });
        if (!img.naturalWidth) throw new Error('这张图还没加载出来，等一下再复制。');
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('这台机器上没能把图转成可复制的格式。');
        ctx.drawImage(img, 0, 0);
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('这张图没法转成可复制的格式。');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      } else if (item.type === 'text') {
        /* 现取一次（.txt 就几 KB）。不借用灯箱里那份 `textBody`：那个 state 声明在下面，
           写进依赖数组会在渲染时就撞上 TDZ —— 为一个几 KB 的请求赔上一次执行顺序的坑不值。 */
        await navigator.clipboard.writeText(await (await fetch(item.url)).text());
      } else {
        await navigator.clipboard.writeText(await localPathOf(item.id));
      }
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => { setCopied(false); copyTimer.current = null; }, 1800);
    } catch (err) {
      /*
       * 报错往哪显示，看这次是从哪儿按的：
       *   · 灯箱开着 → 灯箱里那行红字（就在他眼睛底下）；
       *   · **卡片右键菜单** → 灯箱根本没开，那行红字谁也看不见，必须让顶部那条提示接住。
       */
      const message = err instanceof Error ? err.message : '复制失败。';
      if (openId) setError(message);
      else setNotice({ text: message });
    }
  }

  /** 提前把路径取回来（鼠标一按下就叫，见 `pathCache` 那段注释）。失败就静默 —— 拖的时候再说。 */
  const prefetchPath = useCallback((id: string) => {
    if (pathCache.current[id]) return;
    void localPathOf(id).then(file => { pathCache.current[id] = file; }).catch(() => {});
  }, [localPathOf]);

  /**
   * 开始往外拖。
   *
   * 🔴 一定要 `preventDefault()`：不拦的话 Chromium 会自己起一次 HTML5 拖拽，
   *    落到目标软件里的是一张「图片」或一坨文本，**不是那个文件**；
   *    而且它跟主进程那次 `startDrag` 会打架，表现就是「拖过去的东西不对/拖不动」。
   *
   * 路径还没取回来时也照拦 —— 宁可这次拖不动（并说一句），
   * 也不要让用户以为自己拖出去了、结果粘进去的是别的什么东西。
   */
  const beginDrag = useCallback((event: React.DragEvent, item: GalleryItem) => {
    event.preventDefault();
    const file = pathCache.current[item.id];
    if (!file) {
      prefetchPath(item.id);
      setNotice({ text: '正在取这个文件的位置，稍等一下再拖。' });
      return;
    }
    if (!startDragFilePath(file)) setNotice({ text: '这一版没法把文件拖出去（只有桌面版可以）。' });
  }, [prefetchPath]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  /*
   * 文本资产在灯箱里要**把那一段话显示出来**，而不是只摆一个图标 —— 图标等于什么都没看到。
   * `.txt` 是我们自己落的（上限 512MB，实际就几 KB）。
   *
   * ⚠️ 只在这儿按 URL 直接取文件，**不走 `apiGet`**：那个 helper 一律 `res.json()`，
   *    而这里的响应体是纯文本。取失败就退回「一层指向下载链接的提示」，不把灯箱搞崩。
   */
  const [textBody, setTextBody] = useState<string | null>(null);
  useEffect(() => {
    if (open?.type !== 'text') { setTextBody(null); return; }
    const url = open.url;
    let alive = true;
    setTextBody(null);
    fetch(url)
      .then(res => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then(body => { if (alive) setTextBody(body); })
      .catch(() => { if (alive) setTextBody(''); });
    return () => { alive = false; };
  }, [open?.id, open?.type, open?.url]);

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
      /*
       * 右键就能复制（2026-10-09 徐先：「右键就可以复制」）。
       * 复制的是什么按类型分，跟灯箱底栏那颗按钮**完全同一套**（见 `copy`）——
       * 从哪儿按只是入口不同，出去的东西必须一致。
       */
      id: 'copy',
      label: menu.item.type === 'image' || menu.item.type === 'text' ? '复制' : '复制路径',
      icon: <Copy size={14} strokeWidth={1.8} aria-hidden />,
      run: () => { const it = menu.item; setMenu(null); void copy(it); },
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
              /*
               * 拖出去（2026-10-09 徐先：「也可以直接将拖入别的软件」）。
               *
               * · 选择模式下不给拖 —— 那时左键是「勾选」，拖拽会跟它抢同一个手势；
               * · 正在改名的那张也不给拖（那一行已经是输入框，拖它会顺手选中文字）。
               * 路径在**按下鼠标**时就开始取（`onPointerDown`），到真正拖起来时基本已经有了。
               */
              draggable={!selecting && !editing}
              onPointerDown={() => prefetchPath(item.id)}
              onDragStart={event => beginDrag(event, item)}
            >
              <button
                className="asset-thumb"
                type="button"
                onClick={onThumb}
                aria-label={selecting
                  ? `${on ? '取消选中' : '选中'} ${item.name}`
                  : `预览 ${item.name}`}
              >
                {item.type === 'image' && <img src={item.url} alt={item.name} loading="lazy" draggable={false} />}
                {item.type === 'video' && <video src={item.url} preload="metadata" muted playsInline draggable={false} />}
                {/* 音频、文本和 latent 一样没有画面：格子中间放一个图标，看内容在灯箱里做 */}
                {(item.type === 'latent' || item.type === 'audio' || item.type === 'text') && (
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
              {/* 灯箱里这两样也能直接拖出去（图片拖进 PS、视频拖进剪辑软件都是常见一步）。 */}
              {open.type === 'image' && (
                <img
                  ref={stageImgRef}
                  src={open.url}
                  alt={open.name}
                  draggable
                  onPointerDown={() => prefetchPath(open.id)}
                  onDragStart={event => beginDrag(event, open)}
                />
              )}
              {open.type === 'video' && (
                <video
                  src={open.url}
                  controls
                  autoPlay
                  playsInline
                  draggable
                  onPointerDown={() => prefetchPath(open.id)}
                  onDragStart={event => beginDrag(event, open)}
                />
              )}
              {open.type === 'audio' && (
                <audio className="asset-lightbox-audio" src={open.url} controls preload="metadata" />
              )}
              {open.type === 'latent' && (
                <div className="asset-lightbox-note">
                  <Glyph kind="latent" />
                  <p>latent 是给「接续上一段」用的中间态，不能预览。用下面的「打开文件所在位置」在文件夹里找到它，拖进画布的接续节点就行。</p>
                </div>
              )}
              {open.type === 'text' && (
                <div className="asset-lightbox-note asset-lightbox-text">
                  {textBody ? (
                    <pre>{textBody}</pre>
                  ) : (
                    <p>内容没能读出来，用下面的「打开文件所在位置」找到这份 .txt 打开看看。</p>
                  )}
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
              {/*
                超清。**只有图片与视频能按**（latent 是中间态、音频没有这一道工序），
                所以这两类之外根本不画这颗按钮 —— 画一个点了只报错的按钮等于骗人。
              */}
              {onUpscale && (open.type === 'image' || open.type === 'video') && (
                <button
                  className="button secondary"
                  type="button"
                  data-asset-lightbox-upscale
                  disabled={upscalingId === open.id}
                  onClick={() => onUpscale(open)}
                  title="用一份「超清」工作流把这份素材再加工一道（结果存成新的资产）"
                >
                  <Sparkles size={16} strokeWidth={2} aria-hidden />
                  {upscalingId === open.id ? '超清中…' : '超清'}
                </button>
              )}
              <span className="asset-lightbox-spacer" />
              <Link className="button secondary" href={`/projects/${open.projectId}`}>打开所在项目</Link>
              {/*
                2026-10-09 徐先：「怎么还有下载，这不是本地的吗，直接换成打开文件所在位置就行了吧」。
                🔴 那颗「下载」**撤了**：资产本来就是本机文件，再存一份没有意义 ——
                   它真正回答不了「这东西到底在哪」，而那才是用户点它的动机。
                   换成的这一颗会在资源管理器里打开父目录、并选中这一份。
              */}
              <button
                className="button secondary"
                type="button"
                data-asset-lightbox-reveal
                onClick={() => void reveal(open)}
              >
                <FolderOpen size={16} strokeWidth={2} aria-hidden /> 打开文件所在位置
              </button>
              {/*
                复制。图片复制的**是图本身**（不是路径），文本复制那段字，
                视频 / 音频 / latent 这一类剪贴板装不下的给文件路径（见 `copy`）。
              */}
              <button
                className="button"
                type="button"
                data-asset-lightbox-copy
                onClick={() => void copy(open)}
              >
                {copied
                  ? <><Check size={16} strokeWidth={2} aria-hidden /> 已复制</>
                  : <><Copy size={16} strokeWidth={2} aria-hidden /> {open.type === 'image' || open.type === 'text' ? '复制' : '复制路径'}</>}
              </button>
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
              如果它正被某个画布用着（latent 接续、节点里的图），删掉之后那条链路下次生成会取不到值。
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
