'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PencilLine, Plus, Search, Star, Trash2, Upload, X } from 'lucide-react';
import {
  CREATIVE_KIND_LABEL, kindLabelOf, picksOfKind, registerExtraKinds,
  type CreativePreset, type CreativePresetKind, type CreativePresetPick,
} from './creativePresets';
import { CREATIVE_PRESETS } from './creativeCatalog';
import { canImport, useImportedPresets } from '@/lib/importedPresetStore';
import { pickFilesPath } from '@/lib/desktop-fs';
import {
  importMinePresets, loadMine, mineNow, newMineCategoryId, newMineKindId, presetFromInput,
  replaceMine, subscribeMine, type MineCategory, type MineFile, type MineKind,
} from '@/lib/presetMine';
import PresetImportPanel from './PresetImportPanel';
import type { DockAnchor } from './GenerateDock';

/**
 * 创作预设侧边栏（2026-10-07 重构，2026-10-08 加自建档 / 自建分类）—— 挑风格 / 滤镜 / 运镜。
 *
 * 形态：**画布 │ 预设栏 │ 节点参数** 三栏并排（徐先 2026-10-07 当面定）。
 * 它不再覆盖任何东西、也不跳转新界面 —— 挑预设时参数还在右边、节点还在左边。
 *
 * 内容：顶部 tab（风格 / 滤镜 / 运镜 / 自建档）+ 搜索框 + 分类胶囊 +
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
 *
 * ---------------------------------------------------------------------------
 * 自建的档 / 分类（2026-10-08 晚，徐先：「风格滤镜运镜哪里的也加上吧」）
 * ---------------------------------------------------------------------------
 * 两颗「+」，与 D站标签面板同一套：
 *
 *   - **tab 条最右侧** → 建一个自己的**档**（和 风格 / 滤镜 / 运镜 并列，比如「我的镜头」）；
 *   - **分类胶囊排最右侧** → 在当前档下建一个自己的**分类**（和「摄影」「超现实」并列）。
 *
 * 建好之后的分类里，条目三条来源（他三条全要）：
 *   ① **手输**：名字 + 提示词，直接打；
 *   ② **导入清单**：选本机文件（.json / .txt / .csv），**追加**到这个分类；
 *   ③ **收藏已有**：从内置 285 条 + 已导入的那批里挑，收进来（自带预览图）。
 *
 * 🔴 「提交时能不能叠加」是**每个自建档自己**的（`single`）：
 *    镜头运动那类只能有一个说法，风格定语那类可以叠 —— 做成全局开关就会互相打架。
 * 🔴 档 / 分类**不随画布走**：节点上存的是整条预设快照，档被删之后老画布照样读得出来、
 *    照样提交，只是那颗 tab 没了。
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
  anchor,
}: {
  kind: CreativePresetKind;
  /**
   * 给了就是**浮动形态**：absolute 贴在参数对话框**右边**（位置由 `CanvasEditor`
   * 算好、经 `GenerateDock` 传下来）。不给就是并排那一栏。
   *
   * 2026-10-08 徐先：「风格选择……从侧边栏一点到参数旁边进行选择」——
   * 参数栏关着的时候画布是整幅的，把 360px 一直立在右边缘，每挑一次风格
   * 都要把视线从节点挪到屏幕最右；贴到对话框旁边之后，挑的同时还看得见节点。
   */
  anchor?: DockAnchor;
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
  const [tab, setTab] = useState<string>(String(kind || 'style'));
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [shown, setShown] = useState(PAGE);
  const [showImport, setShowImport] = useState(false);
  const [customText, setCustomText] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const importedAll = useImportedPresets();

  /* ---- 自建的档 / 分类（磁盘上那份）---- */
  const [mine, setMine] = useState<MineFile>(() => mineNow());
  const [newKindOpen, setNewKindOpen] = useState(false);
  const [newKindName, setNewKindName] = useState('');
  const [newKindSingle, setNewKindSingle] = useState(false);
  const [newCatOpen, setNewCatOpen] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState('');
  const [addPrompt, setAddPrompt] = useState('');
  const [renameCat, setRenameCat] = useState<string | null>(null);
  const [renameKind, setRenameKind] = useState<string | null>(null);
  /** 两步确认：第一次点只是进确认态（不用 `window.confirm`，它会阻塞、也会卡住自动化）。 */
  const [confirmDel, setConfirmDel] = useState('');
  const [collecting, setCollecting] = useState(false);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

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
    const own = (mine.presets || []).filter(item => item.kind === tab);
    return [...catalog, ...imported, ...own] as CreativePreset[];
  }, [tab, importedAll, mine]);

  /** 当前这一档下**自建的**分类（空的也要列出来 —— 刚建完就是空的）。 */
  const mineCatsOfTab = useMemo(
    () => (mine.categories || []).filter(item => item.kind === tab),
    [mine, tab],
  );

  const categories = useMemo(() => {
    const out = categoriesOf(items);
    for (const item of mineCatsOfTab) if (!out.includes(item.name)) out.push(item.name);
    return out;
  }, [items, mineCatsOfTab]);

  const mineCat: MineCategory | null = useMemo(
    () => mineCatsOfTab.find(item => item.name === category) || null,
    [mineCatsOfTab, category],
  );
  const mineKind: MineKind | null = useMemo(
    () => (mine.kinds || []).find(item => item.id === tab) || null,
    [mine, tab],
  );

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const tabPicked = useMemo(
    () => picksOfKind(selected, tab as CreativePresetKind),
    [selected, tab],
  );

  /*
   * 收藏模式下要从**所有**已有预设里挑，不能只看当前这一档。
   *
   * 自建档（比如「我的镜头」）里本来一条都没有 —— 它的用途就是「从别处收一批进来」，
   * 只列当前档的话收藏模式永远是一片空白。收进来时 `kind` 会被改成当前档
   * （见 `collect()`），所以进到这个分类里之后它们就是这个档的条目了。
   */
  const collectPool = useMemo(
    () => [...CREATIVE_PRESETS, ...(importedAll.presets || [])] as CreativePreset[],
    [importedAll],
  );

  const visible = useMemo(() => {
    let out = collecting ? collectPool : items;
    /*
     * 🔴 收藏模式下「当前分类」这层过滤必须撤掉 —— 那一屏的意义就是「从别处挑进来」，
     * 而自建分类本来是空的（它存在的理由就是等着被收），按当前分类过滤的话
     * 挑的那一屏永远一片空白（2026-10-08 真机抓到：0 条，这条路等于没做）。
     * 搜索框那层照旧留着 —— 收藏一千条的时候没搜索找不到人。
     */
    if (!collecting) {
      if (category === '收藏') out = out.filter(item => favoriteSet.has(item.id));
      else if (category === '自定义') out = out.filter(() => false);
      else if (category !== '全部') out = out.filter(item => item.category === category);
    }
    if (query.trim()) out = out.filter(item => matches(item, query));
    return out;
  }, [items, collectPool, collecting, category, favoriteSet, query]);

  const ownedIds = useMemo(
    () => new Set((mine.presets || []).filter(item => item.kind === tab && item.category === category).map(item => item.id)),
    [mine, tab, category],
  );

  const step = () => setShown(prev => Math.min(prev + PAGE, visible.length));

  useEffect(() => {
    setQuery('');
    setCategory('全部');
    setShown(PAGE);
    setCollecting(false);
    setAdding(false);
    setRenameCat(null);
    setRenameKind(null);
    setConfirmDel('');
  }, [tab]);

  useEffect(() => {
    setShown(PAGE);
  }, [query, category]);

  useEffect(() => {
    const timer = setTimeout(() => searchRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [tab]);

  /*
   * 自建那份：读一次 + 订阅。
   *
   * 🔴 读回来要 `registerExtraKinds()` 灌进纯函数层的注册表 —— 那边拼提示词、
   *    算「这一档能选几条」都要知道有哪些自建档，而它是纯函数、读不了磁盘。
   */
  useEffect(() => {
    const pull = () => {
      const next = mineNow();
      setMine(next);
      registerExtraKinds(next.kinds);
    };
    pull();
    void loadMine().then(pull);
    return subscribeMine(pull);
  }, []);

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

  /* ------------------------------------------------------------------ *
   * 自建档 / 自建分类：改那份清单
   * ------------------------------------------------------------------ */

  /** 落盘：先更新本地 state 再发 IPC（下一帧就要拿它渲染 / 拼提示词，等写盘回来就晚了）。 */
  const commit = (next: MineFile) => {
    setMine(next);
    registerExtraKinds(next.kinds);
    void replaceMine(next).then(result => {
      if (!result.ok && result.message) setNote(result.message);
    });
  };

  const createKind = () => {
    const name = newKindName.trim();
    if (!name) {
      setNote('先给这个档起个名字。');
      return;
    }
    const item: MineKind = { id: newMineKindId(), name, single: newKindSingle };
    commit({ ...mine, kinds: [...(mine.kinds || []), item] });
    setNewKindName('');
    setNewKindSingle(false);
    setNewKindOpen(false);
    setNote('');
    setTab(item.id);
  };

  const deleteKind = (item: MineKind) => {
    commit({
      version: 1,
      kinds: (mine.kinds || []).filter(one => one.id !== item.id),
      categories: (mine.categories || []).filter(one => one.kind !== item.id),
      presets: (mine.presets || []).filter(one => one.kind !== item.id),
    });
    /* 节点上那一档选的也一起清掉（留着就是一堆没有 tab 可对上的已选标签）。 */
    onClear(item.id as CreativePresetKind);
    setTab('style');
  };

  const createCategory = () => {
    const name = newCatName.trim();
    if (!name) {
      setNote('先给这个分类起个名字。');
      return;
    }
    if (ALWAYS_CATEGORIES.includes(name)) {
      setNote('「全部 / 收藏 / 自定义」是内置的三个，换一个名字。');
      return;
    }
    const item: MineCategory = { id: newMineCategoryId(), kind: tab, name };
    commit({ ...mine, categories: [...(mine.categories || []), item] });
    setNewCatName('');
    setNewCatOpen(false);
    setNote('');
    setCategory(name);
  };

  const deleteCategory = (item: MineCategory) => {
    commit({
      ...mine,
      categories: (mine.categories || []).filter(one => one.id !== item.id),
      presets: (mine.presets || []).filter(one => !(one.kind === item.kind && one.category === item.name)),
    });
    setCategory('全部');
  };

  /** 改分类名：条目上的 `category` 也得跟着改 —— 那条是**快照**，不跟着改就散了。 */
  const renameCategory = (item: MineCategory, name: string) => {
    const clean = name.trim();
    if (!clean) {
      setRenameCat(null);
      return;
    }
    commit({
      ...mine,
      categories: (mine.categories || []).map(one => (one.id === item.id ? { ...one, name: clean } : one)),
      presets: (mine.presets || []).map(one => (
        one.kind === item.kind && one.category === item.name ? { ...one, category: clean } : one
      )),
    });
    setRenameCat(null);
    setCategory(clean);
  };

  const addManual = () => {
    if (!mineCat) return;
    const one = presetFromInput(tab, mineCat.name, addName, addPrompt);
    if (!one) {
      setNote('提示词不能是空的。');
      return;
    }
    if ((mine.presets || []).some(item => item.id === one.id)) {
      setNote('这条已经在里面了。');
      return;
    }
    commit({ ...mine, presets: [...(mine.presets || []), one] });
    setAddName('');
    setAddPrompt('');
    setNote('');
  };

  const removePreset = (id: string) => {
    commit({ ...mine, presets: (mine.presets || []).filter(item => item.id !== id) });
  };

  /** 从磁盘导一批进来（只读文件，收不收在这里定）。 */
  const runImport = async () => {
    if (!mineCat || busy) return;
    setBusy('选文件中…');
    try {
      const files = await pickFilesPath({
        title: '选预设清单（一行一个，或「名字 | 提示词」）',
        filters: [{ name: '预设清单', extensions: ['json', 'txt', 'csv', 'md'] }],
      });
      if (!files.length) {
        setBusy('');
        return;
      }
      setBusy('读文件中…');
      const result = await importMinePresets(files);
      if (!result.ok) {
        setNote(result.message || '没读到可用的预设。');
        setBusy('');
        return;
      }
      const known = new Set((mine.presets || []).map(item => item.id));
      const fresh = result.entries
        .filter(item => !known.has(item.id))
        .map(item => ({ ...item, kind: tab as CreativePresetKind, category: mineCat.name }));
      commit({ ...mine, presets: [...(mine.presets || []), ...fresh] });
      setNote(`${result.message}${fresh.length < result.entries.length ? `（${result.entries.length - fresh.length} 条已在里面）` : ''}`);
    } catch (e) {
      setNote(String((e as Error)?.message || e));
    } finally {
      setBusy('');
    }
  };

  /** 收藏模式：把内置 / 已导入的一条收进当前分类（再点一下移出）。 */
  const collect = (item: CreativePreset) => {
    if (!mineCat) return;
    const exists = (mine.presets || []).some(one => one.id === item.id);
    if (exists) {
      removePreset(item.id);
      return;
    }
    commit({
      ...mine,
      presets: [...(mine.presets || []), { ...item, kind: tab as CreativePresetKind, category: mineCat.name }],
    });
  };

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  /*
   * 落点是 `CanvasEditor` 在 `<NodeInspector>` 之前摆的那块 `.cv-preset-slot`。
   * 取不到就整块不渲染（比如禅模式 / 别的窗口里没这块画布）——
   * 宁可不出这一栏，也不能盖在别的东西上。
   */
  const host = typeof document !== 'undefined'
    ? document.querySelector(anchor ? '.cv-stage' : '.cv-preset-slot')
    : null;

  if (!host) return null;

  /* 当前分类是自建的 → 显示「管这个分类」那条；否则（且当前档是自建的）→ 显示「管这个档」。 */
  const showCatBar = Boolean(mineCat) && category !== '自定义';
  const showKindBar = Boolean(mineKind) && !showCatBar;

  return createPortal((
    <div
      className={`cv-cpk-sidebar${anchor ? ' cv-cpk-float' : ''}`}
      data-cpk-tab={tab}
      /* 探针要能一眼看出这一块是「照对话框算的」还是「碰巧落在画布上」——坐标看不出来。 */
      data-cpk-anchor={anchor ? 'beside' : 'column'}
      style={anchor
        ? { left: anchor.left, top: anchor.top, width: anchor.width, maxHeight: anchor.maxHeight }
        : undefined}
    >
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
            {(mine.kinds || []).map(item => (
              <button
                key={item.id}
                type="button"
                role="tab"
                className={`cv-cpk-tab cv-cpk-mine-tab${tab === item.id ? ' on' : ''}`}
                aria-selected={tab === item.id}
                title={item.single ? `${item.name}（这一档只能选一条）` : item.name}
                onClick={() => setTab(item.id)}
              >
                {item.name}
              </button>
            ))}
            {/* 新建档：圆圈里一个加号（与标签面板那颗同一款）。 */}
            <button
              type="button"
              className={`cv-cpk-add${newKindOpen ? ' on' : ''}`}
              aria-label="新建预设档"
              aria-expanded={newKindOpen}
              title="新建一个自己的档（和风格 / 滤镜 / 运镜并列）"
              onClick={() => { setNewKindOpen(value => !value); setNote(''); }}
            >
              <Plus size={14} strokeWidth={2.4} aria-hidden />
            </button>
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

        {newKindOpen && (
          <div className="cv-cpk-newcat">
            <input
              className="cv-cpk-newcat-name"
              autoFocus
              placeholder="档名，例如：我的镜头 / 打光"
              value={newKindName}
              onChange={event => setNewKindName(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') createKind(); }}
            />
            <div className="cv-cpk-newcat-modes" role="group" aria-label="这个档能选几条">
              <button
                type="button"
                className={`cv-cpk-mode-btn${!newKindSingle ? ' on' : ''}`}
                aria-pressed={!newKindSingle}
                title="可以叠着选好几条"
                onClick={() => setNewKindSingle(false)}
              >
                可叠加
              </button>
              <button
                type="button"
                className={`cv-cpk-mode-btn${newKindSingle ? ' on' : ''}`}
                aria-pressed={newKindSingle}
                title="只能选一条（运镜那种）"
                onClick={() => setNewKindSingle(true)}
              >
                只一条
              </button>
            </div>
            <button type="button" className="cv-cpk-newcat-ok" onClick={createKind}>创建</button>
          </div>
        )}

        <div className="cv-cpk-search">
          <Search size={13} strokeWidth={1.8} aria-hidden />
          <input
            ref={searchRef}
            value={query}
            placeholder={`搜索${kindLabelOf(tab)}`}
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
          {/* 新建分类（挂在当前这一档下面）。 */}
          <button
            type="button"
            className={`cv-cpk-add${newCatOpen ? ' on' : ''}`}
            aria-label="新建预设分类"
            aria-expanded={newCatOpen}
            title={`在「${kindLabelOf(tab)}」下新建一个自己的分类`}
            onClick={() => { setNewCatOpen(value => !value); setNote(''); }}
          >
            <Plus size={12} strokeWidth={2.4} aria-hidden />
          </button>
        </div>

        {newCatOpen && (
          <div className="cv-cpk-newcat">
            <input
              className="cv-cpk-newcat-name"
              autoFocus
              placeholder={`「${kindLabelOf(tab)}」下的分类名，例如：我的常用`}
              value={newCatName}
              onChange={event => setNewCatName(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') createCategory(); }}
            />
            <button type="button" className="cv-cpk-newcat-ok" onClick={createCategory}>创建</button>
          </div>
        )}

        {/* 管这个自建档：改名 / 能选几条 / 删除（两步确认）。 */}
        {showKindBar && mineKind && (
          <div className="cv-cpk-mine">
            {renameKind !== null ? (
              <>
                <input
                  className="cv-cpk-mine-input"
                  value={renameKind}
                  autoFocus
                  onChange={event => setRenameKind(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      const clean = renameKind.trim();
                      if (clean) commit({ ...mine, kinds: (mine.kinds || []).map(one => (one.id === mineKind.id ? { ...one, name: clean } : one)) });
                      setRenameKind(null);
                    }
                    if (event.key === 'Escape') setRenameKind(null);
                  }}
                />
                <button type="button" className="cv-cpk-mine-ok" onClick={() => {
                  const clean = renameKind.trim();
                  if (clean) commit({ ...mine, kinds: (mine.kinds || []).map(one => (one.id === mineKind.id ? { ...one, name: clean } : one)) });
                  setRenameKind(null);
                }}>改</button>
                <button type="button" className="cv-cpk-mine-cancel" onClick={() => setRenameKind(null)}>取消</button>
              </>
            ) : (
              <>
                <span className="cv-cpk-mine-label">自建档 · {mineKind.single ? '只一条' : '可叠加'}</span>
                <button
                  type="button"
                  className="cv-cpk-mine-btn"
                  title={mineKind.single ? '改成可以叠着选好几条' : '改成只能选一条'}
                  onClick={() => commit({
                    ...mine,
                    kinds: (mine.kinds || []).map(one => (one.id === mineKind.id ? { ...one, single: !one.single } : one)),
                  })}
                >
                  {mineKind.single ? '改可叠加' : '改只一条'}
                </button>
                <button type="button" className="cv-cpk-mine-btn" onClick={() => setRenameKind(mineKind.name)}>
                  <PencilLine size={11} strokeWidth={2} aria-hidden />
                  <span>改名</span>
                </button>
                <button
                  type="button"
                  className={`cv-cpk-mine-btn cv-cpk-mine-del${confirmDel === mineKind.id ? ' on' : ''}`}
                  onClick={() => {
                    if (confirmDel !== mineKind.id) { setConfirmDel(mineKind.id); return; }
                    setConfirmDel('');
                    deleteKind(mineKind);
                  }}
                >
                  <Trash2 size={11} strokeWidth={2} aria-hidden />
                  <span>{confirmDel === mineKind.id ? '确认删除' : '删档'}</span>
                </button>
              </>
            )}
          </div>
        )}

        {/* 管这个自建分类：手输 / 导入 / 收藏 / 改名 / 删除。 */}
        {showCatBar && mineCat && (
          <>
            <div className="cv-cpk-mine">
              <span className="cv-cpk-mine-label">{mineCat.name} · {ownedIds.size} 条</span>
              <button type="button" className="cv-cpk-mine-btn" title="手输一条预设" onClick={() => { setAdding(!adding); setCollecting(false); }}>
                <Plus size={11} strokeWidth={2.4} aria-hidden />
                <span>加一条</span>
              </button>
              <button
                type="button"
                className="cv-cpk-mine-btn"
                disabled={Boolean(busy)}
                title="从本机选一份预设清单（.json / .txt / .csv，一行一个，或「名字 | 提示词」）"
                onClick={() => void runImport()}
              >
                <Upload size={11} strokeWidth={2} aria-hidden />
                <span>{busy || '导入清单'}</span>
              </button>
              <button
                type="button"
                className={`cv-cpk-mine-btn${collecting ? ' on' : ''}`}
                title="从内置 / 已导入的预设里挑，收进这个分类"
                onClick={() => { setCollecting(!collecting); setAdding(false); }}
              >
                <Star size={11} strokeWidth={2} aria-hidden />
                <span>收藏已有</span>
              </button>
              <button type="button" className="cv-cpk-mine-btn cv-cpk-mine-icon" aria-label="给这个分类改名" title="改名" onClick={() => setRenameCat(mineCat.name)}>
                <PencilLine size={11} strokeWidth={2} aria-hidden />
              </button>
              <button
                type="button"
                className={`cv-cpk-mine-btn cv-cpk-mine-icon cv-cpk-mine-del${confirmDel === mineCat.id ? ' on' : ''}`}
                aria-label={confirmDel === mineCat.id ? '确认删除这个分类' : '删除这个分类'}
                title={confirmDel === mineCat.id ? '再点一下确认删掉这个分类' : '删掉这个分类'}
                onClick={() => {
                  if (confirmDel !== mineCat.id) { setConfirmDel(mineCat.id); return; }
                  setConfirmDel('');
                  deleteCategory(mineCat);
                }}
              >
                <Trash2 size={11} strokeWidth={2} aria-hidden />
                {confirmDel === mineCat.id && <span>确认</span>}
              </button>
            </div>

            {renameCat !== null && (
              <div className="cv-cpk-newcat">
                <input
                  className="cv-cpk-newcat-name"
                  value={renameCat}
                  autoFocus
                  onChange={event => setRenameCat(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') renameCategory(mineCat, renameCat);
                    if (event.key === 'Escape') setRenameCat(null);
                  }}
                />
                <button type="button" className="cv-cpk-newcat-ok" onClick={() => renameCategory(mineCat, renameCat)}>改</button>
                <button type="button" className="cv-cpk-mine-cancel" onClick={() => setRenameCat(null)}>取消</button>
              </div>
            )}

            {adding && (
              <div className="cv-cpk-addform">
                <input
                  className="cv-cpk-newcat-name"
                  autoFocus
                  placeholder="名字（可留空，就取提示词前 20 字）"
                  value={addName}
                  onChange={event => setAddName(event.target.value)}
                />
                <textarea
                  className="cv-cpk-addform-prompt"
                  placeholder="提示词：这一条要拼进提示词的那段话"
                  value={addPrompt}
                  rows={3}
                  onChange={event => setAddPrompt(event.target.value)}
                />
                <div className="cv-cpk-addform-acts">
                  <button type="button" className="cv-cpk-newcat-ok" onClick={addManual}>加进去</button>
                  <button type="button" className="cv-cpk-mine-cancel" onClick={() => setAdding(false)}>取消</button>
                </div>
              </div>
            )}

            {collecting && (
              <p className="cv-cpk-collect-hint">
                点一张卡片就收进「{mineCat.name}」—— 再点一下移出。
              </p>
            )}
          </>
        )}

        {note && <p className="cv-cpk-note">{note}</p>}

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
                placeholder={`输入自定义${kindLabelOf(tab)}提示词...`}
                value={customText}
                onChange={e => setCustomText(e.target.value)}
                rows={6}
              />
              <button type="button" className="cv-cpk-custom-add" onClick={() => {
                const text = customText.trim();
                if (!text) return;
                const customPreset: CreativePreset = {
                  id: `custom-${Date.now()}`,
                  kind: tab as CreativePresetKind,
                  name: text.slice(0, 30) + (text.length > 30 ? '...' : ''),
                  description: '自定义',
                  category: '自定义',
                  prompt: text,
                  /* `preview` 是必填字段（`CreativePreset`）—— 自定义那条没有图，
                     给空串，缩略图那位会走「没有图」的兜底分支。 */
                  preview: '',
                };
                onToggle(tab as CreativePresetKind, customPreset);
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
                /* 收藏模式下「在不在这个分类里」比「选没选」重要 —— 那是这一屏在说的事。 */
                const owned = ownedIds.has(item.id);
                const isMine = (mine.presets || []).some(one => one.id === item.id && one.category === category);
                return (
                  <article key={item.id} className={`cv-cpk-card${on ? ' on' : ''}${collecting && owned ? ' owned' : ''}`}>
                    <button
                      type="button"
                      className="cv-cpk-pick"
                      data-preset-pick={item.id}
                      data-preset-on={on ? '1' : '0'}
                      title={collecting
                        ? `${item.name} —— ${owned ? '已收，再点一下移出' : '点一下收进这个分类'}`
                        : `${item.name}${item.description ? ` · ${item.description}` : ''}\n${on ? '已选 —— 再点一下去掉' : '点一下加到提示词里'}`}
                      onClick={() => {
                        if (collecting) collect(item);
                        else onToggle(tab as CreativePresetKind, item);
                      }}
                    >
                      <span className="cv-cpk-thumb" data-preset-thumb={item.id}>
                        <PresetThumb item={item} play={false} />
                      </span>
                      <span className="cv-cpk-name">{item.name}</span>
                      {collecting && (
                        <span className="cv-cpk-collect-mark">{owned ? '已收' : '＋'}</span>
                      )}
                    </button>
                    {/*
                     * 收藏 / 删除两颗都**不能**放进上面那颗 pick 按钮里
                     * （`<button>` 套 `<button>` 是非法结构，浏览器会把外层提前闭合）。
                     * 它们是 `<article>` 的兄弟，靠绝对定位压在卡片右上角。
                     */}
                    {!collecting && (
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
                    )}
                    {!collecting && isMine && !adding && (
                      <button
                        type="button"
                        className="cv-cpk-card-del"
                        data-preset-del={item.id}
                        aria-label={`从${category}里删掉${item.name}`}
                        title="从分类里删掉这条"
                        onClick={event => { event.stopPropagation(); removePreset(item.id); }}
                      >
                        <Trash2 size={12} strokeWidth={2} aria-hidden />
                      </button>
                    )}
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
                      : mineCat
                        ? '这个分类还是空的 —— 上面「加一条」手输，「导入清单」从文件读一批，「收藏已有」从已有预设里挑。'
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
                onClick={() => onClear(tab as CreativePresetKind)}
              >清除{kindLabelOf(tab)}</button>
            )}
          </span>
        </div>
        </>
      )}
    </div>
  ), host);
}
