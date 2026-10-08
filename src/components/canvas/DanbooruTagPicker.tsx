'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PencilLine, Plus, RefreshCw, Search, Star, Trash2, Upload, X } from 'lucide-react';
import {
  SEARCH_LIMIT, characterThumb, loadDanbooruData, matchArtist, matchCharacter, matchScene,
  sceneLabelOf, type DanbooruData, type TagSelection,
} from './danbooruTags';
import type { DockAnchor } from './GenerateDock';
import { pickFilesPath } from '@/lib/desktop-fs';
import {
  customCategoriesNow, entryFromInput, entryIdOf, importTagFiles, loadCustomCategories,
  newCategoryId, replaceCustomCategories, subscribeCustomCategories,
  type CustomCategory, type CustomEntry,
} from '@/lib/danbooruCats';

/**
 * D站标签选择器面板（2026-10-08）—— 挑角色 / 服装 / 姿势 / 环境 / 画师，
 * 运行时在挑中的那批里随机抽。
 *
 * 两种形态，由 `anchor` 决定（2026-10-08 徐先定的「标签的选择直接在节点的下方显示选择」）：
 *
 *   - **`anchor` 给了** → portal 到 `.cv-stage`，absolute 贴在选中节点**正下方**。
 *     用在「右侧节点参数栏关着」的时候 —— 那时候画布是整幅的，挂一条固定侧栏
 *     等于白占画布一条边，而挑标签本来就要看着节点。
 *   - **`anchor` 没给**（参数栏开着）→ portal 到 `.cv-preset-slot`（`display: contents`），
 *     于是这一栏是 `.cv-body` 的 flex 子项，**并排**在画布与参数栏中间，不盖任何东西。
 *
 * ⚠️ 两种形态都**别改成挂 `body`**：那样取不到 `cv-*` 变量，整块变白板。
 * ⚠️ 浮动形态的位置由外面算（`CanvasEditor` 的 `dockAnchorFor`）—— 视口变换、节点实测尺寸
 *    只有那边拿得到，这里再算一遍就是第二份真相。
 *
 * 这一栏只管**挑哪几个**（`TagSelection`）。抽签的结果（`tagText`）由 `CanvasEditor` 写 ——
 * 面板里改完选择也是通过 `onChange` 交上去、由那边统一重抽一次，
 * 免得「选择」与「本轮抽出来的串」在两处各存一份、慢慢就对不上了。
 *
 * ---------------------------------------------------------------------------
 * 自定义分类（2026-10-08 晚，徐先：「标签也可以自己加分类」+「最右侧加一个加号」）
 * ---------------------------------------------------------------------------
 * tab 条最右边那颗圆形「+」建一个新分类，分类里那批标签有**三条来源**（他三条全要了）：
 *
 *   ① **手输**：一行一条，直接打在面板里；
 *   ② **导入清单**：选磁盘上的 .txt / .csv / .json —— 一行一个标签，或 `名字 | 标签串`；
 *   ③ **收藏已有**：从内置的角色 / 服装 / 姿势 / 环境里挑条目收进来（自带缩略图）。
 *
 * 🔴 提交方式**每个分类自己定**（`pick` 抽 1 条 / `all` 整串接上）—— 他选的那档。
 *    做成全局开关的话，「质量词」这种要整串接的会和「衣服」这种要抽一个的互相打架。
 * 🔴 这份清单**不随画布走**：它是磁盘上的用户数据（`<dataDir>/danbooru-categories.json`），
 *    画布节点上只存「选了哪些条目 id」。所以分类被删之后老画布不会炸 —— 那一档跳过就是。
 */

type Tab = 'character' | 'clothing' | 'pose' | 'background' | 'artist' | 'extra';

/** 自定义分类的 tab key：`dc:<分类 id>`。带前缀是为了和内置那六档放同一个 state 里。 */
const CUSTOM_PREFIX = 'dc:';

const TAB_LABEL: Record<Tab, string> = {
  character: '角色',
  clothing: '服装',
  pose: '姿势',
  background: '环境',
  artist: '画师',
  extra: '自定义',
};

/** tab 的顺序 = 挑的时候的思维顺序（先是谁、再穿什么、再什么姿势在哪、最后谁画的）。 */
const TAB_ORDER: Tab[] = ['character', 'clothing', 'pose', 'background', 'artist', 'extra'];

/** 这一档选中的是 `string[]` 里的哪一个键（画师是「全部串」，其余是「抽一个」）。 */
const TAB_KEY: Record<Exclude<Tab, 'extra'>, keyof Pick<TagSelection, 'characters' | 'clothings' | 'poses' | 'backgrounds' | 'artists'>> = {
  character: 'characters',
  clothing: 'clothings',
  pose: 'poses',
  background: 'backgrounds',
  artist: 'artists',
};

/** 这三档的行数据同源（姿势 / 环境 / 服装），取 id 的方式也一致。 */
const SCENE_KEY = { pose: 'poses', background: 'backgrounds', clothing: 'clothings' } as const;
type SceneTab = keyof typeof SCENE_KEY;

/** 「收藏已有」能收的四档（画师不收：它的标签是 `@名字`，自己打比收藏快）。 */
const COLLECT_LABEL = {
  character: '角色',
  clothing: '服装',
  pose: '姿势',
  background: '环境',
} as const;
type CollectFrom = keyof typeof COLLECT_LABEL;
const COLLECT_ORDER: CollectFrom[] = ['character', 'clothing', 'pose', 'background'];

/** 列表里的一行（内置档与自定义档共用同一个形状）。 */
type Row = { id: string; title: string; sub: string; preview?: string };

export default function DanbooruTagPicker({
  selection,
  preview,
  anchor,
  onChange,
  onReroll,
  onClose,
}: {
  selection: TagSelection;
  /** 当前这一轮抽出来的串（只读展示，让挑的时候就能看见会交出去什么）。 */
  preview: string;
  /**
   * 给了就是**浮动形态**：absolute 贴在节点正下方（位置由调用方算好）。
   * 不给就是并排那一栏。见文件顶上那段。
   */
  anchor?: DockAnchor;
  /**
   * 改选择。**必须是函数式**（拿上一份算下一份），不能传一个算好的对象：
   * 连着点两行时第二次点击拿到的 props 还是上一帧的，直接传值会把第一次点的那行
   * 覆盖掉 —— 症状是「点了两行，只选上一个」（真机实测到的，2026-10-08）。
   */
  onChange: (mutate: (prev: TagSelection) => TagSelection) => void;
  onReroll: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<string>('character');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<DanbooruData | null>(null);
  const [error, setError] = useState('');
  const [shown, setShown] = useState(SEARCH_LIMIT);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* ---- 自定义分类：清单本身 + 它那几条编辑态（新建 / 手输 / 重命名 / 收藏） ---- */
  const [custom, setCustom] = useState<CustomCategory[]>(() => []);
  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState<'pick' | 'all'>('pick');
  const [newOpen, setNewOpen] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [collectFrom, setCollectFrom] = useState<CollectFrom | null>(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  /**
   * 「删除分类」的两步确认（第一次点变成「确认删除」，再点一次才真删）。
   *
   * 🔴 不用 `window.confirm`：它是**同步阻塞**的原生对话框 —— 在这个 app 里样式是另一套，
   *    而且会**卡住**任何自动化的点击序列（探针点上去就停在那儿等回话）。
   *    做成面板里自己的一步状态，取消也顺手（切 tab / 点别处就复位）。
   */
  const [confirmDel, setConfirmDel] = useState('');

  /* 数据是随包内置的 1.1MB JSON，模块级缓存 —— 关掉再开不会重新拉一遍。 */
  useEffect(() => {
    let alive = true;
    loadDanbooruData()
      .then(loaded => { if (alive) setData(loaded); })
      .catch(err => { if (alive) setError(String(err?.message || err || '标签库加载失败')); });
    return () => { alive = false; };
  }, []);

  /*
   * 自定义分类：磁盘上那份（第一次打开这个面板时读一次）。
   *
   * 🔴 订阅而不是只在挂载时读一次：这份清单在**画布那边**也会被读（抽签要用），
   *    两边各存一份 state 迟早会分叉。写盘之后缓存立刻更新并通知，这里跟着走。
   */
  useEffect(() => {
    const pull = () => setCustom(customCategoriesNow());
    pull();
    void loadCustomCategories().then(pull);
    return subscribeCustomCategories(pull);
  }, []);

  useEffect(() => {
    setQuery('');
    setShown(SEARCH_LIMIT);
    setCollectFrom(null);
    setManual(null);
    setRenaming(null);
    setConfirmDel('');
  }, [tab]);

  useEffect(() => {
    const timer = setTimeout(() => searchRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [tab]);

  /*
   * Esc 关闭：挂 `window` 的**捕获阶段**（与 `CreativePresetPicker` 同一套写法）。
   * 挂面板自己的 onKeyDown 时，焦点一旦掉到 body 就再也收不到事件。
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const customId = tab.startsWith(CUSTOM_PREFIX) ? tab.slice(CUSTOM_PREFIX.length) : '';
  const active = useMemo(
    () => custom.find(item => item.id === customId) || null,
    [custom, customId],
  );

  /** 选中列表：当前 tab 对应的那一份。 */
  const picked = useMemo(() => {
    if (customId) return (selection.custom?.[customId] || []) as string[];
    if (tab === 'extra') return [] as string[];
    return (selection[TAB_KEY[tab as Exclude<Tab, 'extra'>]] || []) as string[];
  }, [selection, tab, customId]);

  /** 收藏模式 / 自定义分类里那些条目的 id（判断「已收藏 / 已选」用）。 */
  const ownedIds = useMemo(
    () => new Set((active?.entries || []).map(entry => entry.id)),
    [active],
  );

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const q = query.trim();
    const out: Row[] = [];

    /* 收藏模式：列内置那一档的数据，点一下收进当前分类。 */
    if (collectFrom) {
      if (collectFrom === 'character') {
        for (const item of data.characters) {
          if (!matchCharacter(item, q)) continue;
          out.push({
            id: item.name,
            title: item.name,
            sub: [item.copyright, item.hair && `${item.hair} hair`, item.eye && `${item.eye} eyes`]
              .filter(Boolean).join(' · ') || '—',
            preview: characterThumb(item.name, item.copyright),
          });
          if (out.length >= shown) break;
        }
        return out;
      }
      const pool = data[SCENE_KEY[collectFrom as SceneTab]];
      for (const item of pool) {
        if (!matchScene(item, q)) continue;
        out.push({ id: item.id, title: item.name_zh || item.name, sub: item.name, preview: item.preview });
        if (out.length >= shown) break;
      }
      return out;
    }

    /* 自定义分类：列它自己的条目。 */
    if (active) {
      for (const entry of active.entries) {
        if (q && !`${entry.label} ${entry.tags} ${entry.sub || ''}`.toLowerCase().includes(q.toLowerCase())) continue;
        out.push({ id: entry.id, title: entry.label, sub: entry.sub || entry.tags, preview: entry.preview });
        if (out.length >= shown) break;
      }
      return out;
    }

    if (tab === 'extra') return out;
    if (tab === 'character') {
      for (const item of data.characters) {
        if (!matchCharacter(item, q)) continue;
        /* 预览图**现拼地址**，清单里没存（见 `characterThumb` 那段注释）。
           没版权的拼不出来，那就这一行没有缩略图 —— 行高由外面那个固定方块撑着，不变。 */
        out.push({
          id: item.name,
          title: item.name,
          sub: [item.copyright, item.hair && `${item.hair} hair`, item.eye && `${item.eye} eyes`]
            .filter(Boolean).join(' · ') || '—',
          preview: characterThumb(item.name, item.copyright),
        });
        if (out.length >= shown) break;
      }
      return out;
    }
    if (tab === 'artist') {
      for (const item of data.artists) {
        if (!matchArtist(item, q)) continue;
        out.push({ id: item.name, title: item.name, sub: `${item.post_count} 张` });
        if (out.length >= shown) break;
      }
      return out;
    }
    const pool = data[SCENE_KEY[tab as SceneTab]];
    for (const item of pool) {
      if (!matchScene(item, q)) continue;
      out.push({ id: item.id, title: item.name_zh || item.name, sub: item.name, preview: item.preview });
      if (out.length >= shown) break;
    }
    return out;
  }, [data, query, shown, tab, active, collectFrom]);

  const total = useMemo(() => {
    if (!data) return 0;
    const q = query.trim();
    if (collectFrom) {
      if (collectFrom === 'character') return data.characters.filter(item => matchCharacter(item, q)).length;
      return data[SCENE_KEY[collectFrom as SceneTab]].filter(item => matchScene(item, q)).length;
    }
    if (active) {
      if (!q) return active.entries.length;
      const needle = q.toLowerCase();
      return active.entries
        .filter(entry => `${entry.label} ${entry.tags} ${entry.sub || ''}`.toLowerCase().includes(needle)).length;
    }
    if (tab === 'extra') return 0;
    if (tab === 'character') return data.characters.filter(item => matchCharacter(item, q)).length;
    if (tab === 'artist') return data.artists.filter(item => matchArtist(item, q)).length;
    return data[SCENE_KEY[tab as SceneTab]].filter(item => matchScene(item, q)).length;
  }, [data, query, tab, active, collectFrom]);

  /* ------------------------------------------------------------------ *
   * 选择
   * ------------------------------------------------------------------ */

  const toggle = (id: string) => {
    if (customId) {
      onChange(prev => {
        const current = prev.custom?.[customId] || [];
        const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id];
        return { ...prev, custom: { ...(prev.custom || {}), [customId]: next } };
      });
      return;
    }
    if (tab === 'extra') return;
    const key = TAB_KEY[tab as Exclude<Tab, 'extra'>];
    onChange(prev => {
      const current = (prev[key] || []) as string[];
      const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id];
      return { ...prev, [key]: next };
    });
  };

  const clear = () => {
    if (customId) {
      onChange(prev => ({ ...prev, custom: { ...(prev.custom || {}), [customId]: [] } }));
      return;
    }
    if (tab === 'extra') return;
    const key = TAB_KEY[tab as Exclude<Tab, 'extra'>];
    onChange(prev => ({ ...prev, [key]: [] }));
  };

  /* ------------------------------------------------------------------ *
   * 自定义分类：改那份清单
   * ------------------------------------------------------------------ */

  /**
   * 落盘。**先更新本地 state 再写盘**（`replaceCustomCategories` 里也是先更缓存）——
   * 紧接着点「启动」时画布那边读的是缓存，等写盘回来就晚了。
   */
  const commit = (next: CustomCategory[]) => {
    setCustom(next);
    void replaceCustomCategories(next).then(result => {
      if (!result.ok && result.message) setNote(result.message);
    });
  };

  const patchCategory = (id: string, mutate: (prev: CustomCategory) => CustomCategory) => {
    commit(custom.map(item => (item.id === id ? mutate(item) : item)));
  };

  const createCategory = () => {
    const name = newName.trim();
    if (!name) {
      setNote('先给这个分类起个名字。');
      return;
    }
    const category: CustomCategory = { id: newCategoryId(), name, mode: newMode, entries: [] };
    commit([...custom, category]);
    setNewName('');
    setNewMode('pick');
    setNewOpen(false);
    setNote('');
    setTab(`${CUSTOM_PREFIX}${category.id}`);
  };

  const deleteCategory = (category: CustomCategory) => {
    commit(custom.filter(item => item.id !== category.id));
    /* 节点上「选了哪些」也一起清掉：留着的话下次点开会是一堆对不上号的 id。 */
    onChange(prev => {
      const next = { ...(prev.custom || {}) };
      delete next[category.id];
      return { ...prev, custom: next };
    });
    setTab('character');
  };

  const renameCategory = (category: CustomCategory, name: string) => {
    const clean = name.trim();
    if (!clean) {
      setRenaming(null);
      return;
    }
    patchCategory(category.id, prev => ({ ...prev, name: clean }));
    setRenaming(null);
  };

  const addManual = (category: CustomCategory, text: string) => {
    const entry = entryFromInput(text);
    if (!entry) return;
    if (category.entries.some(item => item.id === entry.id)) {
      setNote('这条已经在里面了。');
      return;
    }
    patchCategory(category.id, prev => ({ ...prev, entries: [...prev.entries, entry] }));
    /* 加完顺手选中 —— 加一条就是想用它，还要再点一次是白费一步。 */
    onChange(prev => ({
      ...prev,
      custom: { ...(prev.custom || {}), [category.id]: [...(prev.custom?.[category.id] || []), entry.id] },
    }));
    setManual('');
    setNote('');
  };

  const removeEntry = (category: CustomCategory, entryId: string) => {
    patchCategory(category.id, prev => ({ ...prev, entries: prev.entries.filter(item => item.id !== entryId) }));
    onChange(prev => ({
      ...prev,
      custom: {
        ...(prev.custom || {}),
        [category.id]: (prev.custom?.[category.id] || []).filter(id => id !== entryId),
      },
    }));
  };

  /** 从磁盘导一份清单进来（只读文件，收不收在这里定）。 */
  const runImport = async (category: CustomCategory) => {
    if (busy) return;
    setBusy('选文件中…');
    try {
      const files = await pickFilesPath({
        title: '选标签清单（一行一个标签，或「名字 | 标签串」）',
        filters: [{ name: '标签清单', extensions: ['txt', 'csv', 'json', 'md'] }],
      });
      if (!files.length) {
        setBusy('');
        return;
      }
      setBusy('读文件中…');
      const result = await importTagFiles(files);
      if (!result.ok) {
        setNote(result.message || '没读到可用的标签。');
        setBusy('');
        return;
      }
      const known = new Set(category.entries.map(item => item.id));
      const fresh = result.entries.filter(item => !known.has(item.id));
      /* 🔴 按 id 去重而不是整条替换：同一个文件导两次不该翻倍，也不该把用户后来改过的那条盖掉。 */
      patchCategory(category.id, prev => ({ ...prev, entries: [...prev.entries, ...fresh] }));
      setNote(`${result.message}${fresh.length < result.entries.length ? `（${result.entries.length - fresh.length} 条已在里面）` : ''}`);
    } catch (e) {
      setNote(String((e as Error)?.message || e));
    } finally {
      setBusy('');
    }
  };

  /*
   * 收藏模式下「这一行对应哪个条目」。
   *
   * 🔴 内置档的行 id 和收藏进分类的条目 id **不是一回事**：行 id 是内置清单自己的
   *    （角色是名字、场景是数字 id），条目 id 是 `tags` 的哈希 —— 因为同一串标签可能
   *    从两个来源进来，只有按 `tags` 去重才不会出两条。所以这儿要翻一次。
   */
  const collectEntryOf = (row: Row): CustomEntry | null => {
    if (!collectFrom) return null;
    if (collectFrom === 'character') {
      return {
        id: entryIdOf(row.id),
        label: row.title,
        tags: row.title,
        sub: row.sub,
        preview: row.preview || undefined,
      };
    }
    const pool = data ? data[SCENE_KEY[collectFrom as SceneTab]] : [];
    const item = pool.find(one => one.id === row.id);
    if (!item) return null;
    return {
      id: entryIdOf(item.tags || item.id),
      label: item.name_zh || item.name,
      tags: item.tags || item.name,
      sub: item.name,
      preview: item.preview || undefined,
    };
  };

  /** 把内置那一档的一条收进当前分类（再点一下移出）。 */
  const collect = (category: CustomCategory, row: Row) => {
    const entry = collectEntryOf(row);
    if (entry) toggleEntry(category, entry);
  };

  const toggleEntry = (category: CustomCategory, entry: CustomEntry) => {
    const exists = category.entries.some(item => item.id === entry.id);
    if (exists) {
      removeEntry(category, entry.id);
      return;
    }
    patchCategory(category.id, prev => ({ ...prev, entries: [...prev.entries, entry] }));
    onChange(prev => ({
      ...prev,
      custom: { ...(prev.custom || {}), [category.id]: [...(prev.custom?.[category.id] || []), entry.id] },
    }));
  };

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  /*
   * 浮动形态挂 `.cv-stage`（`position: relative`，与 `.cv-dock` 同一个宿主 ——
   * 抽屉、对话框、工具条都在那儿）。并排形态照旧挂 `.cv-preset-slot`。
   * 两个宿主管子的都是「这一块 CSS 变量取不取得到」：挂 `body` 会变白板。
   */
  const host = typeof document !== 'undefined'
    ? document.querySelector(anchor ? '.cv-stage' : '.cv-preset-slot')
    : null;
  if (!host) return null;

  const chips = active
    ? active.entries.filter(entry => picked.includes(entry.id)).map(entry => ({ id: entry.id, label: entry.label }))
    : [];

  return createPortal((
    <div
      className={`cv-cpk-sidebar cv-dtp${anchor ? ' cv-dtp-float' : ''}`}
      data-dtp-tab={tab}
      /* 探针要能一眼看出这一块是「照节点算出来的」还是「碰巧落在画布上」——
         单看坐标分不出来。 */
      data-dtp-anchor={anchor ? 'below' : 'column'}
      style={anchor
        ? { left: anchor.left, top: anchor.top, width: anchor.width, maxHeight: anchor.maxHeight }
        : undefined}
    >
      <div className="cv-cpk-head">
        <div className="cv-cpk-tabs" role="tablist">
          {TAB_ORDER.map(key => (
            <button
              key={key}
              type="button"
              role="tab"
              className={`cv-cpk-tab${tab === key ? ' on' : ''}`}
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {TAB_LABEL[key]}
            </button>
          ))}
          {custom.map(category => {
            const key = `${CUSTOM_PREFIX}${category.id}`;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                className={`cv-cpk-tab cv-dtp-cat${tab === key ? ' on' : ''}`}
                aria-selected={tab === key}
                title={category.name}
                onClick={() => setTab(key)}
              >
                {category.name}
              </button>
            );
          })}
          {/* 新建分类：圆圈里一个加号（2026-10-08 他画的图就是这个）。 */}
          <button
            type="button"
            className={`cv-dtp-add${newOpen ? ' on' : ''}`}
            aria-label="新建标签分类"
            aria-expanded={newOpen}
            title="新建标签分类"
            onClick={() => {
              setNewOpen(value => !value);
              setNote('');
            }}
          >
            <Plus size={14} strokeWidth={2.4} aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className="cv-cpk-close"
          aria-label="关闭标签面板"
          title="关闭（Esc）"
          onClick={onClose}
        >
          <X size={16} strokeWidth={1.8} aria-hidden />
        </button>
      </div>

      {newOpen && (
        <div className="cv-dtp-newcat">
          <input
            className="cv-dtp-newcat-name"
            autoFocus
            placeholder="分类名，例如：质量词 / 我的服装"
            value={newName}
            onChange={event => setNewName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') createCategory();
            }}
          />
          <div className="cv-dtp-newcat-modes" role="group" aria-label="新分类的提交方式">
            <button
              type="button"
              className={`cv-dtp-mode-btn${newMode === 'pick' ? ' on' : ''}`}
              aria-pressed={newMode === 'pick'}
              title="每次运行从这个分类选中的条目里抽 1 条"
              onClick={() => setNewMode('pick')}
            >
              抽 1 条
            </button>
            <button
              type="button"
              className={`cv-dtp-mode-btn${newMode === 'all' ? ' on' : ''}`}
              aria-pressed={newMode === 'all'}
              title="选中的条目按顺序整串接上（适合质量词这类）"
              onClick={() => setNewMode('all')}
            >
              整串接上
            </button>
          </div>
          <button type="button" className="cv-dtp-newcat-ok" onClick={createCategory}>创建</button>
        </div>
      )}

      {/* 抽签模式：每次运行重抽 / 固定这一批。 */}
      <div className="cv-dtp-mode" role="group" aria-label="抽签方式">
        <button
          type="button"
          className={`cv-dtp-mode-btn${selection.mode === 'random' ? ' on' : ''}`}
          aria-pressed={selection.mode === 'random'}
          title="每次点「启动」都重新抽一批"
          onClick={() => onChange(prev => ({ ...prev, mode: 'random' }))}
        >
          每次运行抽
        </button>
        <button
          type="button"
          className={`cv-dtp-mode-btn${selection.mode === 'fixed' ? ' on' : ''}`}
          aria-pressed={selection.mode === 'fixed'}
          title="保持当前这一批，只有点「换一批」才重抽"
          onClick={() => onChange(prev => ({ ...prev, mode: 'fixed' }))}
        >
          固定这一批
        </button>
        <button
          type="button"
          className="cv-dtp-reroll"
          title="现在就重抽一批"
          onClick={onReroll}
        >
          <RefreshCw size={12} strokeWidth={2} aria-hidden />
          <span>换一批</span>
        </button>
      </div>

      {/* 自定义分类的工具栏：加标签 / 导入 / 收藏 / 改模式 / 重命名 / 删除。 */}
      {active && (
        <div className="cv-dtp-tools">
          <button
            type="button"
            className="cv-dtp-tool"
            title="手输一条标签"
            onClick={() => { setManual(manual === null ? '' : null); setRenaming(null); setConfirmDel(''); }}
          >
            <Plus size={11} strokeWidth={2.4} aria-hidden />
            <span>加标签</span>
          </button>
          <button
            type="button"
            className="cv-dtp-tool"
            disabled={Boolean(busy)}
            title="从本机选一份标签清单（.txt / .csv / .json，一行一个，或「名字 | 标签串」）"
            onClick={() => void runImport(active)}
          >
            <Upload size={11} strokeWidth={2} aria-hidden />
            <span>{busy || '导入清单'}</span>
          </button>
          <button
            type="button"
            className={`cv-dtp-tool${collectFrom ? ' on' : ''}`}
            title="从内置的角色 / 服装 / 姿势 / 环境里挑条目收进来"
            onClick={() => setCollectFrom(collectFrom ? null : 'character')}
          >
            <Star size={11} strokeWidth={2} aria-hidden />
            <span>收藏已有</span>
          </button>
          <div className="cv-dtp-tools-mode" role="group" aria-label="这个分类的提交方式">
            <button
              type="button"
              className={`cv-dtp-mode-btn${active.mode === 'pick' ? ' on' : ''}`}
              aria-pressed={active.mode === 'pick'}
              title="每次运行抽 1 条"
              onClick={() => patchCategory(active.id, prev => ({ ...prev, mode: 'pick' }))}
            >
              抽 1 条
            </button>
            <button
              type="button"
              className={`cv-dtp-mode-btn${active.mode === 'all' ? ' on' : ''}`}
              aria-pressed={active.mode === 'all'}
              title="选中的整串接上"
              onClick={() => patchCategory(active.id, prev => ({ ...prev, mode: 'all' }))}
            >
              整串接上
            </button>
          </div>
          <button
            type="button"
            className="cv-dtp-tool cv-dtp-tool-icon"
            title="给这个分类改个名字"
            aria-label="重命名分类"
            onClick={() => { setRenaming(active.name); setManual(null); setConfirmDel(''); }}
          >
            <PencilLine size={12} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            className={`cv-dtp-tool cv-dtp-tool-icon cv-dtp-tool-del${confirmDel === active.id ? ' on' : ''}`}
            title={confirmDel === active.id
              ? `再点一下确认删掉「${active.name}」（里面 ${active.entries.length} 条标签会一起没）`
              : '删掉这个分类'}
            aria-label={confirmDel === active.id ? '确认删除这个分类' : '删除分类'}
            onClick={() => {
              if (confirmDel !== active.id) {
                setConfirmDel(active.id);
                return;
              }
              setConfirmDel('');
              deleteCategory(active);
            }}
          >
            <Trash2 size={12} strokeWidth={2} aria-hidden />
            {confirmDel === active.id && <span>确认删除</span>}
          </button>
        </div>
      )}

      {/* 重命名：内联一行输入（不用原生 prompt —— 它在这个 app 里样式是另一套）。 */}
      {active && renaming !== null && (
        <div className="cv-dtp-inline">
          <input
            className="cv-dtp-inline-input"
            value={renaming}
            autoFocus
            onChange={event => setRenaming(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') renameCategory(active, renaming);
              if (event.key === 'Escape') setRenaming(null);
            }}
          />
          <button type="button" className="cv-dtp-inline-ok" onClick={() => renameCategory(active, renaming)}>改</button>
          <button type="button" className="cv-dtp-inline-cancel" onClick={() => setRenaming(null)}>取消</button>
        </div>
      )}

      {/* 手输一条标签。 */}
      {active && manual !== null && (
        <div className="cv-dtp-inline">
          <input
            className="cv-dtp-inline-input"
            value={manual}
            autoFocus
            placeholder="一条标签，例如 masterpiece"
            onChange={event => setManual(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') addManual(active, manual);
              if (event.key === 'Escape') setManual(null);
            }}
          />
          <button type="button" className="cv-dtp-inline-ok" onClick={() => addManual(active, manual)}>加</button>
          <button type="button" className="cv-dtp-inline-cancel" onClick={() => setManual(null)}>取消</button>
        </div>
      )}

      {note && <p className="cv-dtp-note">{note}</p>}

      {tab === 'extra' ? (
        <div className="cv-dtp-extra">
          <p className="cv-dtp-extra-title">自定义标签</p>
          <p className="cv-dtp-extra-hint">
            原样接在这一轮抽出来的标签串末尾，多个标签用逗号分隔。
          </p>
          <textarea
            className="cv-dtp-extra-input"
            placeholder="例如：masterpiece, best quality, 1girl"
            value={selection.extra}
            rows={8}
            onChange={event => {
              const value = event.target.value;
              onChange(prev => ({ ...prev, extra: value }));
            }}
          />
        </div>
      ) : (
        <>
          {collectFrom && (
            <div className="cv-dtp-collect" role="group" aria-label="从哪一档收">
              {COLLECT_ORDER.map(key => (
                <button
                  key={key}
                  type="button"
                  className={`cv-dtp-collect-tab${collectFrom === key ? ' on' : ''}`}
                  aria-pressed={collectFrom === key}
                  onClick={() => { setCollectFrom(key); setShown(SEARCH_LIMIT); }}
                >
                  {COLLECT_LABEL[key]}
                </button>
              ))}
              <span className="cv-dtp-collect-hint">点一行收进这个分类</span>
            </div>
          )}

          <div className="cv-cpk-search">
            <Search size={13} strokeWidth={1.8} aria-hidden />
            <input
              ref={searchRef}
              value={query}
              placeholder={collectFrom
                ? `搜索${COLLECT_LABEL[collectFrom]}（支持中文）`
                : active ? `搜索${active.name}` : `搜索${TAB_LABEL[tab as Tab] || ''}`}
              onChange={event => setQuery(event.target.value)}
            />
          </div>

          <div className="cv-dtp-picked">
            <span className="cv-dtp-picked-label">
              已选 {picked.length}
              {customId
                ? (active?.mode === 'all' ? '（整串接上）' : '（抽 1 个）')
                : tab === 'artist' ? '（全部串上）' : '（抽 1 个）'}
            </span>
            {picked.length > 0 && (
              <button type="button" className="cv-dtp-clear" onClick={clear}>清空</button>
            )}
            <div className="cv-dtp-chips">
              {picked.length === 0 && <span className="cv-dtp-empty">还没选 —— 不选就轮空</span>}
              {data && active && chips.map(chip => (
                <button
                  key={chip.id}
                  type="button"
                  className="cv-dtp-chip"
                  title="点一下去掉"
                  onClick={() => toggle(chip.id)}
                >
                  <span>{chip.label}</span>
                  <X size={11} strokeWidth={2.2} aria-hidden />
                </button>
              ))}
              {data && !active && picked.map(id => (
                <button
                  key={id}
                  type="button"
                  className="cv-dtp-chip"
                  title="点一下去掉"
                  onClick={() => toggle(id)}
                >
                  <span>{tab in SCENE_KEY
                    ? sceneLabelOf(data, SCENE_KEY[tab as SceneTab], id)
                    : id}</span>
                  <X size={11} strokeWidth={2.2} aria-hidden />
                </button>
              ))}
            </div>
          </div>

          <div
            className="cv-dtp-list"
            ref={listRef}
            onScroll={event => {
              const el = event.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 320 && shown < total) {
                setShown(prev => prev + SEARCH_LIMIT);
              }
            }}
          >
            {error && <p className="cv-dtp-error">{error}</p>}
            {!error && !data && <p className="cv-dtp-error">标签库载入中…</p>}
            {data && active && !active.entries.length && !collectFrom && (
              <p className="cv-dtp-error">
                这个分类还是空的 —— 上面「加标签」自己打一条，「导入清单」从文件读一批，
                「收藏已有」从角色/服装/姿势/环境里挑。
              </p>
            )}
            {data && rows.map(row => {
              const entry = collectFrom ? collectEntryOf(row) : null;
              const on = entry ? ownedIds.has(entry.id) : picked.includes(row.id);
              const body = (
                <>
                  {row.preview !== undefined && (
                    /* 预览图是远程的（jsDelivr）。加载不出来就留一个空位子，
                       别让半张图把行高顶乱 —— 名字还在，条目照样能选。 */
                    <span className="cv-dtp-thumb">
                      {row.preview && <img src={row.preview} alt="" loading="lazy" />}
                    </span>
                  )}
                  <span className="cv-dtp-row-text">
                    <span className="cv-dtp-row-title">{row.title}</span>
                    <span className="cv-dtp-row-sub">{row.sub}</span>
                  </span>
                </>
              );
              /*
               * 自定义分类的行右边多一颗「从分类里删掉」—— 它**不能**放进行按钮里面：
               * `<button>` 里套 `<button>` 是非法结构（浏览器会把外层的提前闭合），
               * 而且里层点击本来就要阻止冒泡才不会被当成「选中」。所以外面套一层定位容器。
               */
              if (collectFrom || !active) {
                return (
                  <button
                    key={row.id}
                    type="button"
                    className={`cv-dtp-row${on ? ' on' : ''}`}
                    aria-pressed={on}
                    onClick={() => {
                      if (collectFrom && active) collect(active, row);
                      else toggle(row.id);
                    }}
                  >
                    {body}
                    {collectFrom && (
                      <span className={`cv-dtp-collect-mark${on ? ' on' : ''}`}>{on ? '已收' : '＋'}</span>
                    )}
                  </button>
                );
              }
              return (
                <div key={row.id} className="cv-dtp-row-wrap">
                  <button
                    type="button"
                    className={`cv-dtp-row${on ? ' on' : ''}`}
                    aria-pressed={on}
                    onClick={() => toggle(row.id)}
                  >
                    {body}
                  </button>
                  <button
                    type="button"
                    className="cv-dtp-row-del"
                    aria-label={`从${active.name}里删掉这条`}
                    title="从分类里删掉这条"
                    onClick={() => removeEntry(active, row.id)}
                  >
                    <Trash2 size={11} strokeWidth={2} aria-hidden />
                  </button>
                </div>
              );
            })}
            {data && !rows.length && !error && !active && <p className="cv-dtp-error">没搜到</p>}
          </div>
        </>
      )}

      <div className="cv-dtp-foot">
        <span className="cv-dtp-foot-label">
          {collectFrom
            /* 收藏模式下「共 N 条」说的是**这一档有多少可收**（角色那档 4000 条），
               分类自己收了几条得另外写，不然在收藏模式里就看不到自己攒了多少。 */
            ? `${COLLECT_LABEL[collectFrom]} ${total} 条 · 已收 ${active?.entries.length || 0}`
            : customId
              ? `${active?.name || ''} 共 ${active?.entries.length || 0} 条`
              : tab === 'artist' ? '画师全部串上' : `共 ${total} 条`}
        </span>
        <span className="cv-dtp-foot-preview" title={preview}>{preview || '（还没抽）'}</span>
      </div>
    </div>
  ), host);
}
