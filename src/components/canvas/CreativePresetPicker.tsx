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
 * 创作预设侧边栏（2026-10-07 重构，同日第二版）—— 挑风格 / 滤镜 / 运镜。
 *
 * 形态：**画布 │ 预设栏 │ 节点参数** 三栏并排（徐先 2026-10-07 当面定）。
 * 它不再覆盖任何东西、也不跳转新界面 —— 挑预设时参数还在右边、节点还在左边。
 *
 * 内容：顶部 tab（风格 / 滤镜 / 运镜）+ 搜索框 + 分类胶囊 +
 * 两列卡片网格（每张卡右上角一颗收藏星标）+ 底部计数。
 *
 * 🔴 为什么要 `createPortal` 而不是就地渲染：这个组件挂在 `GenerateDock` 里，
 *    而那东西在 `.cv-stage` 内部 —— React Flow 的节点外层带 `transform`，
 *    是 `position: fixed`/`absolute` 的包含块，就地渲染会跟着画布缩放平移一起漂。
 *    所以 portal 到 `CanvasEditor` 在 `<NodeInspector>` 之前摆的那块
 *    `.cv-preset-slot`（`display: contents`，于是这一栏直接成为 `.cv-body` 的 flex 子项）。
 *    ⚠️ 别改成挂 `body`：那样取不到 `cv-*` 那些 CSS 变量，会变成一块没有配色的白板。
 *    ⚠️ 也别挂回 `.flow-shell`：那是浮层时代（`position: fixed; right: 0`）的宿主，
 *       那样会盖住右侧参数栏 —— 徐先要的是并排，不是盖住。
 *
 * 🔴 收藏星标点一下**不能**把卡片也选了 —— 得 `stopPropagation`，否则
 *    「我想收藏这条」直接变成「我选了这条」。
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
    if (item.preview) return <img src={item.preview} alt="" />;
    /*
     * 自定义那条没有图。铺一块斜纹占位等于「每张自定义卡长得一模一样」——
     * 直接把用户写进去的那句提示词铺在图上，一眼就知道这条是什么。
     */
    return <span className="cv-cpk-noimg" aria-hidden>{item.prompt || item.name}</span>;
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
  /*
   * 收藏是**数组**不是 Set：真值源在 localStorage（`readPresetFavorites(): string[]`），
   * 这层只读、不去改它的形状。查得快那点在面板规模上无所谓，
   * 但「传什么进来」必须跟来源一致 —— 之前这里写 `Set<string>`，
   * 调用方传数组，类型对不上（运行时不炸，因为 `new Set(array)` 恰好也成立）。
   */
  favorites: readonly string[];
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
  const [customText, setCustomText] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const importedAll = useImportedPresets();

  /*
   * 🔴 `useImportedPresets()` 返回的是 `{ groups, presets, loading }` —— **不是数组**。
   * 这里原先写的是 `importedAll.filter(...)`，等于 `undefined.filter`：
   * 组件在一次 render 里就抛 `TypeError`，React 把整棵树卸载，
   * 表现是「点一下风格/滤镜/运镜，整个窗口变成一片空白（连顶栏都没了）」。
   * 徐先 2026-10-07 报的就是这个 —— 他以为那是「跳转了一个新界面」。
   */
  const items = useMemo(() => {
    const catalog = CREATIVE_PRESETS.filter(item => item.kind === tab);
    const imported = (importedAll.presets || []).filter(item => item.kind === tab);
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

  /*
   * Esc 关闭。两级：导入子面板开着时先回列表，再按一次才关整栏 ——
   * 一步到底的话，用户从导入页按 Esc 会把整条预设栏一起关掉，得重新点开。
   *
   * 🔴 挂 `window` 的**捕获阶段**，不是挂在对话框自己的 onKeyDown 上：
   *    焦点一旦掉到 `body`（用户点过里面任意一样东西就会），
   *    原来那种写法里那个处理函数根本收不到事件 —— Esc 彻底失效。
   *    这和 `CanvasDrawer` / `CanvasContextMenu` 是同一套写法，跟它们保持一致。
   *
   * ⚠️ 这里**不**学 `CanvasDrawer` 那条「焦点在输入框里就放行」的例外：
   *    抽屉里那条例外是因为输入框自己认 Esc（取消改名）。这儿的搜索框不认，
   *    放行的话「搜了一半想退出来」按 Esc 会毫无反应。
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /* 用 ref 读 `showImport`，不用 state：state 会让下面那个 effect 每次开关都重挂监听，
     而「开关变了就重挂文档监听」本身没必要。也绝不能在 setState 的更新函数里调 onClose
     —— 那个函数必须是纯的（StrictMode 下会跑两遍，等于关两次）。 */
  const importingRef = useRef(false);
  importingRef.current = showImport;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (importingRef.current) { setShowImport(false); return; }
      closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  /*
   * 落点是 `CanvasEditor` 在 `<NodeInspector>` 之前摆的那块 `.cv-preset-slot`。
   * 取不到就整块不渲染（比如禅模式 / 别的窗口里没这块画布）——
   * 宁可不出这一栏，也不能盖在别的东西上。
   */
  const host = typeof document !== 'undefined'
    ? document.querySelector('.cv-preset-slot')
    : null;

  if (!host) return null;

  return createPortal((
    <div className="cv-cpk-sidebar" data-cpk-tab={tab}>
      {showImport ? (
        /* 🔴 这个组件的 props 是 `onBack` / `onPicked`，**没有** `onClose` ——
           传错名字不会报错、也不会崩，只是「返回」那颗按钮永远点不动（onClick 是 undefined）。 */
        <PresetImportPanel
          onBack={() => setShowImport(false)}
          onPicked={category => { setShowImport(false); setCategory(category); }}
        />
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
                value={customText}
                onChange={e => setCustomText(e.target.value)}
                rows={6}
              />
              <button type="button" className="cv-cpk-custom-add" onClick={() => {
                const text = customText.trim();
                if (!text) return;
                const customPreset: CreativePreset = {
                  id: `custom-${Date.now()}`,
                  kind: tab,
                  name: text.slice(0, 30) + (text.length > 30 ? '...' : ''),
                  description: '自定义',
                  category: '自定义',
                  prompt: text,
                  /* `preview` 是必填字段（`CreativePreset`）—— 自定义那条没有图，
                     给空串，缩略图那位会走「没有图」的兜底分支。 */
                  preview: '',
                };
                onToggle(tab, customPreset);
                setCustomText('');
              }}>
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
