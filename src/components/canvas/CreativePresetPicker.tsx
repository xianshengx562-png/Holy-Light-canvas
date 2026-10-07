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
 * 创作预设面板（2026-10-06，从 AIFISHER 迁移）—— 挑风格 / 滤镜 / 运镜。
 *
 * 形状刻意跟参考产品一致（徐先截图里那个）：顶栏 tab（风格 / 滤镜 / 运镜）+
 * 搜索框 + 分类胶囊 + 两列卡片网格（每张卡右上角一颗收藏星标）+ 底部计数。
 * 为什么不做成下拉：这几百条是**看图挑**的东西，名字都差不多（「电影感」「电影级」
 * 「电影质感」），只看文字根本挑不出来 —— 预览图才是这一屏的主角。
 *
 * 🔴 与 `WorkflowFieldPicker` 的两个同样的坑：
 *   1. 弹层必须 `createPortal` 到 `.flow-shell`：React Flow 的节点外层带 `transform`，
 *      那是 `position: fixed` 的包含块，留在原处的话遮罩会跟着画布缩放漂。
 *      挂 body 则会取不到 `cv-*` 那些 CSS 变量（变成一块没有配色的白板）。
 *   2. 收藏星标点一下**不能**把卡片也选了 —— 得 `stopPropagation`，否则
 *      「我想收藏这条」直接变成「我选了这条」。
 */

/** 「全部 / 收藏」这两颗胶囊永远在最前，后面才是这一档自己的分类。 */
const ALWAYS_CATEGORIES = ['全部', '收藏'];

/** 一屏挂多少张图，以及滚到底再加多少 —— 见下面 `shown` 那段的长注释。 */
const PAGE = 60;

/**
 * 分类胶囊的排列：按**数据里第一次出现的顺序**现算，不写死。
 *
 * 写死的话，将来 catalog 里加一个新分类（比如「写实风格」），它不会出现在胶囊里 ——
 * 而卡片又会列出来，用户看到一堆「不属于任何分类」的东西，也没法按它筛。
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
 *
 * 🔴 `decoding="async"` **不能加**（2026-10-06，查了一整轮）：
 * 加了之后这批被缩放的 webp 在 Electron 里会被画成**一条条横纹**
 * （图是好的、尺寸也是对的，就是每一行都在重复几个像素）。
 * 隔离实验：同一个网格里手工插的 6 张图全正常、React 渲染的 60 张全花 ——
 * 两者唯一的差别就是 `decoding` 和 `loading`。去掉这两个属性即恢复。
 * `loading="lazy"` 同样去掉：这个列表已经按页挂载（见 `PAGE`），不需要它再插一手。
 */
function PresetThumb({ item, play }: { item: CreativePreset; play: boolean }) {
  const isVideo = /\.mp4($|\?)/i.test(item.preview);
  const still = item.poster || (isVideo ? '' : item.preview);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** 视频解码失败（文件缺了 / 格式不认）就退回静帧 —— 别留一块黑。 */
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
  /** 开场停在哪个 tab（用户点的是哪颗按钮）。 */
  kind: CreativePresetKind;
  /**
   * 这个节点**三档各自选了什么**（2026-10-07 起每档可以多条）。
   *
   * 🔴 传整份 `pick` 而不是「开场那一档的那几条」：面板里能切 tab，
   * 只拿到开场那一档的话，切到另一档之后卡片上的「已选」标记说的是**别的档** ——
   * 看着像「我明明没挑过这条，它怎么是选中的」。按当前 tab 现取（`tabPicked`）才对。
   */
  selected: CreativePresetPick;
  /**
   * 收藏的预设 id。
   *
   * 🔴 收藏只存本机（跟 AIFISHER 一样）：它是个人习惯，不是画布内容 ——
   * 存进画布 JSON 的话，把工程发给别人会连「我喜欢哪几条」一起带过去，
   * 而那是发给别人看的工作文件里最不该出现的东西。
   */
  favorites: string[];
  onToggleFavorite: (id: string) => void;
  /**
   * 点一张卡片：**已选的就去掉、没选的加上**（叠加，不是替换）。
   * `kind` 是**当前 tab 那一档**（面板里能切 tab，不传回来就改错档了）。
   * 能不能叠由 `maxPicksFor` 决定（运镜只有一条，新的顶掉旧的）—— 规矩只写在
   * `togglePickIn()` 一处，界面不做第二套判断。
   */
  onToggle: (kind: CreativePresetKind, preset: CreativePreset) => void;
  /** 页脚「清除」：这一档整档清空。 */
  onClear: (kind: CreativePresetKind) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<CreativePresetKind>(kind);
  const [category, setCategory] = useState('全部');
  const [query, setQuery] = useState('');
  /** 导入界面：打开时它盖掉下面那一整块（tab / 搜索 / 分类 / 网格）。 */
  const [showImport, setShowImport] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  /*
   * 🔴 内置那批 + **导入的那批**一起算（2026-10-07）。
   *
   * 导入的归在 `style` 这一档（ComfyUI-Easy-Use 的 styles 全是视觉风格），
   * 分类就是用户导入时填的那个名字 —— 所以分类胶囊会自动多出来，不用在这里写死。
   */
  const { presets: importedPresets } = useImportedPresets();
  const catalog = useMemo(
    () => [...CREATIVE_PRESETS, ...importedPresets],
    [importedPresets],
  );

  /** 这一档的全部条目（按 catalog 里的顺序）。 */
  const items = useMemo(() => catalog.filter(item => item.kind === tab), [catalog, tab]);
  /** **当前 tab 这一档**已选的那几条（卡片「已选」标记、页脚计数都用它）。 */
  const tabPicked = useMemo(() => picksOfKind(selected, tab), [selected, tab]);
  const categories = useMemo(() => categoriesOf(items), [items]);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const visible = useMemo(() => items.filter(item => {
    if (category === '收藏') {
      if (!favoriteSet.has(item.id)) return false;
    } else if (category !== '全部' && item.category !== category) {
      return false;
    }
    return matches(item, query.trim());
  }), [items, category, query, favoriteSet]);

  /** 切 tab / 切分类时把分类还原 —— 不然从「3D风格」切到滤镜会一条都不剩。 */
  useEffect(() => { setCategory('全部'); }, [tab]);

  /**
   * 🔴 一屏里最多挂多少张图（2026-10-06，踩了）。
   *
   * 「风格」这一档有 217 条，全挂上去之后整个网格在 Electron 里被渲染成**横条纹** ——
   * 同一张卡片挪出网格就完全正常，所以不是图坏了，是 Chromium 在滚动容器里
   * 处理几百张同时存在的位图时的合成问题。
   *
   * 不能靠 `content-visibility: auto` / `will-change` 这类合成技巧绕（都试过，没用），
   * 而 217 张图本来也没人会一次看完 —— **边滚边加**才是这个列表本来的用法。
   * 首屏 60 张、滚到底再加 60 张。
   */
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { setShown(PAGE); }, [tab, category, query]);
  const step = () => setShown(n => n + PAGE);

  /*
   * 🔴 Esc 挂在**文档捕获阶段**，不能挂在对话框那个 div 上（2026-10-06，踩了）。
   *
   * 原来写的是 `onKeyDown` → 只有焦点在对话框里面才收得到。而搜索框在挂载时会
   * 自动聚焦（见上面的 `searchRef`），用户顺手点一下缩略图 / 星标 / 空白处，
   * 焦点就落到 `body` 上了 —— 这时候按 Esc **什么都不会发生**，面板照样盖在画布上。
   * 真机上就是被这一条卡住的：探针发完 Esc，`.cv-cpk-mask` 还在，506 个空白扫描点
   * 全被这个满屏遮罩吃掉，于是「加不了节点」看起来像产品缺陷。
   *
   * 捕获阶段在 document 上收，不管焦点在哪都能关掉 —— 弹窗该有的行为。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  const host = document.querySelector<HTMLElement>('.flow-shell') || document.body;

  return createPortal((
    <div className="cv-cpk-mask" onMouseDown={onClose}>
      <div
        className="cv-cpk"
        role="dialog"
        aria-label="创作预设库"
        tabIndex={-1}
        onMouseDown={event => event.stopPropagation()}
      >
        {showImport ? (
          <PresetImportPanel
            onBack={() => setShowImport(false)}
            onPicked={name => {
              setShowImport(false);
              setTab('style');
              setCategory(name);
              setQuery('');
            }}
          />
        ) : (<>
        <div className="cv-cpk-head">
          <div className="cv-cpk-tabs" role="tablist" aria-label="预设类型">
            {(['style', 'filter', 'motion'] as CreativePresetKind[])
              /* 运镜这一档只有视频生成节点会传进来，所以 tab 本身跟着 kinds 走。 */
              .filter(item => item !== 'motion' || kind === 'motion')
              .map(item => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={tab === item}
                  className={`cv-cpk-tab${tab === item ? ' on' : ''}`}
                  onClick={() => setTab(item)}
                >
                  {CREATIVE_KIND_LABEL[item]}
                </button>
              ))}
          </div>
          <button className="cv-cpk-x" type="button" aria-label="关闭" onClick={onClose}>
            <X size={14} strokeWidth={1.8} aria-hidden />
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
                {/*
                  收藏钮**不能**包在上面的选择钮里：HTML 不允许按钮嵌按钮，
                  而且点星标想要的是「收藏」、不是「选中这条」。
                */}
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
        </div>

        <div className="cv-cpk-foot">
          <span>
            {visible.length} / {items.length} 个预设 · 收藏只存在本机
            {/*
              已选几条要**说出来**（2026-10-07）：风格可以叠，挑到第三条时
              用户已经不知道自己挂了几条了 —— 而卡片上的「已选」标记在滚动列表里
              可能已经滚出屏幕。这一句是最省地方的交代。
            */}
            {tabPicked.length > 0 && ` · 已选 ${tabPicked.length} 条`}
          </span>
          <span className="cv-cpk-foot-acts">
            {/*
              导入入口只在桌面版出现：web 版没有主进程，既选不了本机目录、
              也没有地方存那 88 MB 预览图 —— 显示一个点了没反应的按钮是最坏的。
            */}
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
        </>)}
      </div>
    </div>
  ), host);
}
