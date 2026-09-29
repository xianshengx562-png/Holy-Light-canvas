'use client';

import { useState } from 'react';
import Link from 'next/link';
import { FileArchive, Music } from 'lucide-react';
import CanvasOverlay from './CanvasOverlay';
import { useApi } from '@/lib/client';

/**
 * 画布左轨「资产」弹出的那个大浮层（与左轨其它四项共用 `CanvasOverlay` 那个壳）。
 *
 * 它解决的是「想用库里已经有的素材，得先跳去 /assets 看一眼、再回来拖文件」这一段往返。
 * 点一项就进画布，落点规则与拖文件进来完全一致（见 `CanvasEditor.addAssetItem`）。
 *
 * ⚠️ 三件事别搞混：
 *
 * 1. **这不是右侧那个 440px 抽屉**（`CanvasDrawer`）。它是**居中**的一张大卡片 ——
 *    2026-09-21 照参考图统一之后，左轨五项都长这样，只有内容不同。
 *
 * 2. **只导入，不上传**。放进画布的是本站资产地址（`/api/assets/...`），卡片当场就能预览；
 *    传到 RunningHub 那一步由服务端在**提交生成时**做（`lib/referenceImages.ts` 读盘重传）。
 *    所以「导入」是零等待的，而拿去生成照样能用 —— 这两件事以前是绑在一起的。
 *
 * 3. 类型放在**左列**，分类放在内容区。理由：类型是「我在找哪一类东西」，
 *    进了内容区才谈得上「这一类里再细分」。分类**由用户自己维护**（资产页筛选器上那颗
 *    「管理」），2026-09-26 起不再写死成角色 / 场景 / 道具，也不再只对图片成立。
 */

export type CanvasAssetItem = {
  id: string;
  name: string;
  type: 'video' | 'image' | 'audio' | 'latent';
  /** 分类名本身（`assets.category` 里存的就是它）。任何类型都可能带。 */
  category: string | null;
  url: string;
  sizeLabel: string;
  createdLabel: string;
  projectName: string;
};

type KindFilter = 'all' | 'image' | 'video' | 'audio' | 'latent';
/** 分类筛选值：分类名 / `'none'`（没打分类）/ `'all'`（不筛）。分类名是用户自己维护的。 */
type SubFilter = string;

/** 与资产库那页同一套词（`lib/asset-kinds.ts`），这里重述一遍是因为那个文件标了 `server-only`。 */
const KINDS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'latent', label: 'Latent' },
];
const KIND_TEXT: Record<string, string> = { video: '视频', image: '图片', audio: '音频', latent: 'Latent' };

export default function CanvasAssetPanel({
  onClose, onPick,
}: {
  onClose: () => void;
  onPick: (item: CanvasAssetItem) => void;
}) {
  const [kind, setKind] = useState<KindFilter>('all');
  const [sub, setSub] = useState<SubFilter>('all');

  /*
   * 类型与分类是两个**独立**维度（2026-09-26）：接口不再把「有 sub」钉死成图片，
   * 所以这里只是把两个条件各自拼上去。
   *
   * 分类表跟资产一起回来（`/api/assets` 的 `categories`），不再自带一份写死的
   * 「角色 / 场景 / 道具」—— 那份写死的表在画布里会让人以为「只能按这三个词找」。
   */
  const query = new URLSearchParams();
  if (kind !== 'all') query.set('type', kind);
  if (sub !== 'all') query.set('sub', sub);
  const qs = query.toString();
  const { data, loading, error } = useApi<{
    items: CanvasAssetItem[];
    categories: { id: string; name: string; count: number }[];
  }>(`/api/assets${qs ? `?${qs}` : ''}`);
  const items = data?.items || [];
  const categories = data?.categories || [];

  return (
    <CanvasOverlay
      title="资产"
      kicker="ASSETS"
      note="点一项 → 选中了同类型的空节点就填进去，否则新建并连到生成节点"
      nav={KINDS.map(item => ({ key: item.value, label: item.label }))}
      active={kind}
      onNav={key => setKind(key as KindFilter)}
      onClose={onClose}
      actions={<Link className="cv-ov-link" href="/assets">资产库</Link>}
    >
      {/*
        分类这一排**恒显示**：任何类型的资产都能打分类，只在「图片」下摆出来
        会让人以为视频 / 音频 / latent 没有分类。
      */}
      <div className="cv-assets-chips">
        <button
          type="button"
          className={`assets-chip${sub === 'all' ? ' active' : ''}`}
          aria-pressed={sub === 'all'}
          onClick={() => setSub('all')}
        >
          全部
        </button>
        {categories.map(item => (
          <button
            key={item.id}
            type="button"
            className={`assets-chip${sub === item.name ? ' active' : ''}`}
            aria-pressed={sub === item.name}
            onClick={() => setSub(item.name)}
          >
            {item.name}
          </button>
        ))}
        <button
          type="button"
          className={`assets-chip${sub === 'none' ? ' active' : ''}`}
          aria-pressed={sub === 'none'}
          onClick={() => setSub('none')}
        >
          未分类
        </button>
      </div>

      {loading && <p className="cv-assets-note">载入中…</p>}
      {!loading && error && <p className="cv-assets-note error">{error}</p>}
      {!loading && !error && !items.length && <p className="cv-assets-note">这个分类下还没有资产。</p>}

      <div className="cv-assets-grid">
        {items.map(item => (
          <button
            key={item.id}
            type="button"
            className="cv-assets-item"
            data-asset-kind={item.type}
            onClick={() => onPick(item)}
            title={`${item.name} · ${item.projectName}`}
          >
            <span className="cv-assets-thumb">
              {item.type === 'image' && <img src={item.url} alt="" loading="lazy" />}
              {item.type === 'video' && <video src={item.url} preload="metadata" muted playsInline />}
              {item.type === 'audio' && <span className="cv-assets-glyph"><Music size={16} strokeWidth={1.6} aria-hidden /></span>}
              {item.type === 'latent' && <span className="cv-assets-glyph"><FileArchive size={16} strokeWidth={1.6} aria-hidden /></span>}
            </span>
            <span className="cv-assets-meta">
              <span className="cv-assets-name">{item.name}</span>
              <span className="cv-assets-sub">
                {KIND_TEXT[item.type]}{item.category ? ` · ${item.category}` : ''} · {item.sizeLabel}
              </span>
            </span>
          </button>
        ))}
      </div>
    </CanvasOverlay>
  );
}
