'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Star, X } from 'lucide-react';
import {
  CREATIVE_KIND_LABEL, picksOfKind,
  type CreativePreset, type CreativePresetKind, type CreativePresetPick,
} from './creativePresets';
import { CREATIVE_PRESETS } from './creativeCatalog';
import { canImport, useImportedPresets } from '@/lib/importedPresetStore';
import PresetImportPanel from './PresetImportPanel';

/**
 * 创作预设侧边栏（2026-10-07 重构）—— 挑风格 / 滤镜 / 运镜。
 *
 * 从全屏模态框改为**右侧边栏**（420px 固定宽度），展开在节点右侧。
 * 
 * 形态：顶栏 tab（风格 / 滤镜 / 运镜）+ 搜索框 + 分类胶囊 + 
 * 两列卡片网格（每张卡右上角一颗收藏星标）+ 底部计数。
 *
 * 🔴 与 `WorkflowFieldPicker` 的两个同样的坑：
 *   1. 弹层必须 `createPortal` 到 `.flow-shell`：React Flow 的节点外层带 `transform`，
 *      那是 `position: fixed` 的包含块，留在原处的话遮罩会跟着画布缩放漂。
 *      挂 body 则会取不到 `cv-*` 那些 CSS 变量（变成一块没有配色的白板）。
 *   2. 收藏星标点一下**不能**把卡片也选了 —— 得 `stopPropagation`，否则
 *      「我想收藏这条」直接变成「我选了这条」。
 */

/** 「全部 / 收藏 / 自定义」这三颗胶囊永远在最前，后面才是这一档自己的分类。 */
const ALWAYS_CATEGORIES = ['全部', '收藏', '自定义'];

/** 一屏挂多少张图，以及滚到底再加多少 —— 见下面 `shown` 那段的长注释。 */
const PAGE = 60;

/**
 * 分类胶囊的排列：按**数据里第一次出现的顺序**现算，不写死。
 */
function categoriesOf(items: CreativePreset[]): string[] {
  const out: string[] = [...ALWAYS_CATEGORIES];
  for (const item of items) {
    const category = String(item.category || '').trim();
    if (category && !out.includes(category)) out.push(category);
  }
  return out;
}

function matches(item: CreativePreset, query: string) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [item.name, item.description, item.category]
    .some(part => String(part || '').toLowerCase().includes(needle));
}

/**
 * 卡片上的预览：运镜是 `.mp4`，鼠标移上去才播，平时显示静帧（`poster`）。
 */
function PresetThumb({ item, play }: { item: CreativePreset; play: boolean }) {
  const isVideo = /\.mp4($|\?)/i.test(item.preview);
  const still = item.poster || (isVideo ? '' : item.preview);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    if (!play || videoFailed) return;
    void videoRef.current?.play().catch(() => setVideoFailed(true));
  }, [play, videoFailed]);

  if (!isVideo || !still) {
    return item.preview
      ? <img src={item.preview} alt="" />
      : <span className="cv-cpk-noimg" aria-hidden />;
  }
  return (
    <>
      <img src={still} alt="" />
      {play && !videoFailed && (
        <video
          ref={videoRef}
          src={item.preview}
          muted
          loop
          playsInline
          preload="none"
          onError={() => setVideoFailed(true)}
        />
      )}
    </>
  );
}

export default function CreativePresetPicker({
  kind,
  selected,
  favorites,
  onToggleFavorite,
  onToggle,
  onClear,
  onClose,
}: {
  kind: CreativePresetKind;
  selected: CreativePresetPick;
  favorites: Set<string>;
  onToggleFavorite: (id: string) => void;
  onToggle: (kind: CreativePresetKind, item: CreativePreset) => void;
  onClear: (kind: CreativePresetKind) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<CreativePresetKind>(kind);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [shown, setShown] = useState(PAGE);
  const [showImport, setShowImport] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const importedAll = useImportedPresets();

  const items = useMemo(() => {
    const catalog = CREATIVE_PRESETS.filter(item => item.kind === tab);
    const imported = importedAll.filter(item => item.kind === tab);
    return [...catalog, ...imported];
  }, [tab, importedAll]);

  const categories = useMemo(() => categoriesOf(items), [items]);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const tabPicked = useMemo(() => picksOfKind(selected, tab), [selected, tab]);

  const visible = useMemo(() => {
    let out = items;
    if (category === '收藏') out = out.filter(item => favoriteSet.has(item.id));
    else if (category === '自定义') out = out.filter(() => false);
    else if (category !== '全部') out = out.filter(item => item.category === category);
    if (query.trim()) out = out.filter(item => matches(item, query));
    return out;
  }, [items, category, favoriteSet, query]);

  const step = () => setShown(prev => Math.min(prev + PAGE, visible.length));

  useEffect(() => {
    setQuery('');
    setCategory('全部');
    setShown(PAGE);
  }, [tab]);

  useEffect(() => {
    setShown(PAGE);
  }, [query, category]);

  useEffect(() => {
    const timer = setTimeout(() => searchRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [tab]);

  const host = typeof document !== 'undefined'
    ? document.querySelector('.flow-shell')
    : null;

  if (!host) return null;

  return createPortal((
    <div className="cv-cpk-sidebar" data-cpk-tab={tab}>
      {showImport ? (
        <PresetImportPanel onClose={() => setShowImport(false)} />
      ) : (
        <>
        <div className="cv-cpk-head">
          <div className="cv-cpk-tabs" role="tablist">
            {(['style', 'filter', 'motion'] as const).map(k => (
              <button
                key={k}
                type="button"
                role="tab"
                className={`cv-cpk-tab${tab === k ? ' on' : ''}`}
                aria-selected={tab === k}
                onClick={() => setTab(k)}
              >
                {CREATIVE_KIND_LABEL[k]}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="cv-cpk-close"
            aria-label="关闭预设侧边栏"
            title="关闭（Esc）"
            onClick={onClose}
          >
            <X size={16} strokeWidth={1.8} aria-hidden />
          </button>
        </div>

        <div className="cv-cpk-search">
          <Search size={13} strokeWidth={1.8} aria-hidden />
          <input
            ref={searchRef}
            value={query}
            placeholder={`搜索${CREATIVE_KIND_LABEL[tab]}`}
            onChange={event => setQuery(event.target.value)}
          />
        </div>

        <div className="cv-cpk-cats" role="group" aria-label="预设分类">
          {categories.map(item => (
            <button
              key={item}
              type="button"
              className={`cv-cpk-cat${category === item ? ' on' : ''}`}
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>

        <div
          className="cv-cpk-grid"
          onScroll={event => {
            const el = event.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) step();
          }}
        >
          {category === '自定义' ? (
            <div className="cv-cpk-custom-placeholder">
              <p>自定义提示词</p>
              <p className="cv-cpk-custom-hint">
                在这里可以输入自己的风格描述、滤镜效果或运镜指令
              </p>
              <textarea
                className="cv-cpk-custom-input"
                placeholder={`输入自定义${CREATIVE_KIND_LABEL[tab]}提示词...`}
                rows={6}
              />
              <button type="button" className="cv-cpk-custom-add">
                添加到当前节点
              </button>
            </div>
          ) : (
            <>
              {visible.slice(0, shown).map(item => {
                const on = tabPicked.some(pick => pick.id === item.id);
                const star = favoriteSet.has(item.id);
                return (
                  <article key={item.id} className={`cv-cpk-card${on ? ' on' : ''}`}>
                    <button
                      type="button"
                      className="cv-cpk-pick"
                      data-preset-pick={item.id}
                      data-preset-on={on ? '1' : '0'}
                      title={`${item.name}${item.description ? ` · ${item.description}` : ''}\n${on ? '已选 —— 再点一下去掉' : '点一下加到提示词里'}`}
                      onClick={() => onToggle(tab, item)}
                    >
                      <span className="cv-cpk-thumb" data-preset-thumb={item.id}>
                        <PresetThumb item={item} play={false} />
                      </span>
                      <span className="cv-cpk-name">{item.name}</span>
                    </button>
                    <button
                      type="button"
                      className={`cv-cpk-star${star ? ' on' : ''}`}
                      data-preset-star={item.id}
                      aria-pressed={star}
                      aria-label={`${star ? '取消收藏' : '收藏'}${item.name}`}
                      title={star ? '取消收藏' : '收藏'}
                      onClick={event => { event.stopPropagation(); onToggleFavorite(item.id); }}
                    >
                      <Star size={13} strokeWidth={1.8} fill={star ? 'currentColor' : 'none'} aria-hidden />
                    </button>
                  </article>
                );
              })}
              {!visible.length && (
                <p className="cv-cpk-empty">
                  {query.trim()
                    ? category === '收藏'
                      ? '收藏里没有匹配的预设 —— 点卡片右上角的星标把常用的收进来。'
                      : '没有匹配的预设，换个关键词试试。'
                    : category === '收藏'
                      ? '还没有收藏 —— 点卡片右上角的星标把常用的收进来。'
                      : '这一档没有可用的预设。'}
                </p>
              )}
            </>
          )}
        </div>

        <div className="cv-cpk-foot">
          <span>
            {visible.length} / {items.length} 个预设
            {tabPicked.length > 0 && ` · 已选 ${tabPicked.length} 条`}
          </span>
          <span className="cv-cpk-foot-acts">
            {canImport() && (
              <button
                type="button"
                className="cv-cpk-import-btn"
                data-cpk-import="1"
                onClick={() => setShowImport(true)}
              >导入预设</button>
            )}
            {tabPicked.length > 0 && (
              <button
                type="button"
                className="cv-cpk-clear"
                onClick={() => onClear(tab)}
              >清除{CREATIVE_KIND_LABEL[tab]}</button>
            )}
          </span>
        </div>
        </>
      )}
    </div>
  ), host);
}
