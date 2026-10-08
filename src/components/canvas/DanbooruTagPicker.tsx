'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, PencilLine, Plus, RefreshCw, Search, Star, Trash2, Upload, X } from 'lucide-react';
import {
  CUSTOM_KEY_PREFIX, SEARCH_LIMIT, characterTagsOf, characterThumb, loadDanbooruData, matchArtist,
  matchCharacter, matchScene, sceneLabelOf, tagModeOf,
  type DanbooruData, type DanbooruCharacter, type TagMode, type TagSelection,
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
 * 两种形态，由 `anchor` 决定：
 *
 *   - **`anchor` 给了** → portal 到 `.cv-stage`，absolute 贴在选中节点**正下方**。
 *     用在「右侧节点参数栏关着」的时候（2026-10-08 徐先：「标签的选择直接在节点的下方显示选择」）
 *     —— 那时候画布是整幅的，挂一条固定侧栏等于白占画布一条边，而挑标签本来就要看着节点。
 *   - **`anchor` 没给** → **就地**渲染在自己所在的位置。只有一个调用者：
 *     `NodeInspector` 把它摆在右侧参数栏的正文里 —— 也就是「它就是这个节点的参数」
 *     （2026-10-08 徐先：「这样吧，选择标签就是这个节点的参数」）。
 *     上一版这里是 portal 到 `.cv-preset-slot` 当**画布与参数栏中间的第三栏** ——
 *     那样参数栏里空着（这个节点别的参数一个都没有）、中间那栏又把画布挤窄，
 *     两头都不对。撤掉那条路，落点只剩「参数栏里」。
 *
 * ⚠️ 浮动形态**别改成挂 `body`**：那样取不到 `cv-*` 变量，整块变白板。
 * ⚠️ 浮动形态的位置由外面算（`CanvasEditor` 的 `dockAnchorFor`）—— 视口变换、节点实测尺寸
 *    只有那边拿得到，这里再算一遍就是第二份真相。
 * ⚠️ 就地形态**必须撤掉浮层那套定位与外观**（见 panels.css 里 `.cv-dtp-inline` 那段）——
 *    `.cv-cpk-sidebar` 是为「并排占一栏」写的，`border-left` / 底色 / 动效进了参数栏都是多余。
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
 * 🔴 分类里的**每一条**都能删、能改名（2026-10-08 徐先：「可以删除标签和给标签命名」）：
 *    `label` 只是列表里给人看的名字，`tags` 才是接进提示词的那串 —— 改名只动前者。
 *    导入的清单自带名字（`名字 | 标签串`），手输的那批就得靠这个补一个。
 * 🔴 **抽签模式也是每一档自己定**（2026-10-08 晚：徐先发现「在画师上点固定，别的档也跟着固定」）：
 *    存在 `selection.modes[<档位键>]`，没设过的档回落老的节点级 `mode`（老画布兼容）。
 *    面板上那两颗按钮**只动当前这一档**；自由文本那一档不抽签，整行不画。
 * 🔴 这份清单**不随画布走**：它是磁盘上的用户数据（`<dataDir>/danbooru-categories.json`），
 *    画布节点上只存「选了哪些条目 id」。所以分类被删之后老画布不会炸 —— 那一档跳过就是。
 */

type Tab = 'character' | 'clothing' | 'pose' | 'background' | 'artist' | 'extra';

/**
 * 自定义分类的 tab key：`dc:<分类 id>`。带前缀是为了和内置那六档放同一个 state 里。
 *
 * 🔴 前缀**只有一份**（`danbooruTags.ts` 里那个常量）：它同时是「每档自己的抽签模式」
 *    （`selection.modes`）与抽签时那条随机流的键 —— 两边各写一遍迟早对不上，
 *    症状是「这一档明明设了固定，跑起来还是每次都换」。
 */
const CUSTOM_PREFIX = CUSTOM_KEY_PREFIX;

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
  /** 只在浮动形态用得上（那颗 ×）。就地形态由参数栏自己收。 */
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
  /**
   * 给**某一条标签**改名（2026-10-08 徐先：「可以删除标签和给标签命名」）。
   *
   * 存的是 `{ id, label }`：id 认出改的是哪一条，label 是输入框里正在打的字。
   * 只改 `label`（列表里给人看的那个），`tags`（接进提示词的那串）一个字都不动 ——
   * 混在一起改的话，改个显示名就把发出去的提示词换了。
   */
  const [entryEdit, setEntryEdit] = useState<{ id: string; label: string } | null>(null);
  /**
   * 角色那一档：展开着的是哪个已选角色、以及正在改哪一条特征标签
   * （2026-10-08 徐先要的「每个角色都有一堆锁定标签」，跟着角色走、可逐条改）。
   *
   * `ctagEdit.idx` 是**这一组里的下标**，不是标签文字：同一个角色完全可能有两个字面
   * 相同的标签（官方那份里就有重复度很高的词），按下标才指得准。代价是改完/删完
   * 下标会平移 —— 所以每次操作完都 `setCtagEdit(null)`，不让它跨帧活着。
   */
  const [openedChar, setOpenedChar] = useState('');
  const [ctagEdit, setCtagEdit] = useState<{ name: string; idx: number; text: string } | null>(null);
  /**
   * 整块「特征标签」收着还是展开（2026-10-08）。
   *
   * 为什么**默认收着**：真机量到面板盒子只有 372px，而 tab / 抽签 / 输出 / 搜索 / 底栏
   * 这五条横杠固定吃掉 223px —— 这一块一铺开（8 个角色的组头就有 200 多 px）就把
   * 下面的列表挤到 20px、底栏预览串整条被裁掉（他说的「下面的图片被遮住」）。
   * 收着的时候只占一行题头（约 28px），列表和缩略图保得住；要看再点开。
   */
  const [ctagsOpen, setCtagsOpen] = useState(false);
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
    setEntryEdit(null);
    setConfirmDel('');
    /* 角色那一档的展开 / 编辑态也一起复位：留着一个正开着的输入框，切回来会横在那儿。 */
    setOpenedChar('');
    setCtagEdit(null);
    /* 整块也复位：切走再切回来时不该还摊着（摊着就会又去挤列表）。 */
    setCtagsOpen(false);
  }, [tab]);

  useEffect(() => {
    const timer = setTimeout(() => searchRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [tab]);

  /*
   * 浮动形态才归自己管「怎么关」：面板上那颗 ×、以及 Esc。
   * 就地形态（参数栏里）**不接管** —— 它只是参数栏里的内容，
   * 收起来那一下属于参数栏标题栏上那颗 ×（`NodeInspector` 自己的 `onClose`）。
   * 在这里再接一个 Esc 的话，用户在搜索框里按 Esc 会把整条参数栏一起收掉。
   */
  const floating = Boolean(anchor);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!floating) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [floating]);

  const customId = tab.startsWith(CUSTOM_PREFIX) ? tab.slice(CUSTOM_PREFIX.length) : '';
  const active = useMemo(
    () => custom.find(item => item.id === customId) || null,
    [custom, customId],
  );

  /*
   * 抽签模式是**每一档自己**的（2026-10-08 晚，徐先：「每个都可以单独设置」）：
   * 读的是当前 tab 那一档，写也只写那一档 ——
   * 原来只动 `selection.mode`（全节点一个开关），在「画师」上点一下，
   * 角色 / 服装 / 环境全都跟着变成固定，等于用一个开关顶掉别的档。
   */
  const tabMode = tagModeOf(selection, tab);
  const setTabMode = (mode: TagMode) =>
    onChange(prev => ({ ...prev, modes: { ...prev.modes, [tab]: mode } }));
  /** 当前这档叫什么（自定义分类用分类名，其余用 tab 上那两个字），写进按钮的悬停提示。 */
  const tabName = active?.name || TAB_LABEL[tab as Tab] || '这一档';

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
   * 角色那一档：输出两档 + 特征标签组
   * ------------------------------------------------------------------ */

  const setCharacterDetail = (on: boolean) => {
    onChange(prev => ({ ...prev, characterDetail: on }));
    if (!on) setCtagEdit(null);
  };

  /**
   * 改这个角色的特征标签组（删一条 / 改一条都走这儿）。
   *
   * 🔴 **第一次动的时候要把官方那组整份写进 `characterTagEdits`** —— 这就是这里为什么
   *    必须在 `onChange` 的回调里重新算一遍：`characterTagsOf(prev, item)` 拿到的正是
   *    「改过就听改的、没改过就是官方那份」，随手一改就自然完成了「首改落盘」。
   *    在外面先算好再传进去的话，删一条会把另外十几条一起抹掉（变成只有这一条）。
   */
  const editCharacterTags = (
    name: string,
    mutate: (tags: string[]) => string[],
  ) => {
    const item = data?.characters.find(one => one.name === name);
    onChange(prev => ({
      ...prev,
      characterTagEdits: {
        ...(prev.characterTagEdits || {}),
        [name]: mutate(characterTagsOf(prev, item)),
      },
    }));
  };

  /** 整组还原成官方那份 —— 把这个键删掉就行（`characterTagsOf` 会回落到官方清单）。 */
  const resetCharacterTags = (name: string) => {
    setCtagEdit(null);
    onChange(prev => {
      const next = { ...(prev.characterTagEdits || {}) };
      delete next[name];
      return { ...prev, characterTagEdits: next };
    });
  };

  /** 已选的那些角色，按 `characters.json` 里的顺序（跟着列表走，不是点击顺序）。 */
  const characterPicks = useMemo<DanbooruCharacter[]>(() => {
    if (!data) return [];
    const chosen = new Set(selection.characters);
    return data.characters.filter(item => chosen.has(item.name));
  }, [data, selection.characters]);

  /**
   * 把内联框里那一条改掉。空着 = 取消（跟自定义分类那条「改名」一个规矩）——
   * 把一条标签改成空串没有意义，那不如点旁边那颗垃圾桶，意图还清楚些。
   */
  const commitCtagEdit = () => {
    const draft = ctagEdit;
    setCtagEdit(null);
    const text = String(draft?.text || '').trim();
    if (!draft || !text) return;
    editCharacterTags(draft.name, list => list.map((one, index) => (index === draft.idx ? text : one)));
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

  /**
   * 给一条标签改名。空着不改（等于取消）—— 名字空了列表里那行会变成没有字的行，
   * 而「显示名」本来就该默认等于标签串（`normalizeEntry` 就是这么兜的）。
   */
  const renameEntry = (category: CustomCategory, entryId: string, label: string) => {
    const clean = label.trim();
    setEntryEdit(null);
    if (!clean) return;
    patchCategory(category.id, prev => ({
      ...prev,
      entries: prev.entries.map(item => (item.id === entryId ? { ...item, label: clean } : item)),
    }));
  };

  const addManual = (category: CustomCategory, text: string) => {
    /*
     * 「加一条」顺手认 `名字 | 标签串`（与导入清单同一套写法，2026-10-08 他要的「给标签命名」）：
     * 前半是列表里显示的名字，后半才是接进提示词的那串。只打一串也行 —— 那就名字 = 标签串。
     *
     * 🔴 **只认第一根竖线**：标签串自己带竖线的情况（有些模型的写法）不该被切掉一半。
     */
    const raw = String(text || '');
    const bar = raw.indexOf('|');
    const name = bar >= 0 ? raw.slice(0, bar).trim() : '';
    const tags = (bar >= 0 ? raw.slice(bar + 1) : raw).trim();
    const entry = entryFromInput(tags);
    if (!entry) return;
    if (name) entry.label = name;
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
   * 宿主在下面按形态分：浮动的那一支挂 `.cv-stage`，并排那一支已经没了（就地渲染）。
   * 两边共同的前提都是「这一块 CSS 变量取不取得到」—— 挂 `body` 会变白板。
   */
  const chips = active
    ? active.entries.filter(entry => picked.includes(entry.id)).map(entry => ({ id: entry.id, label: entry.label }))
    : [];

  const panel = (
    <div
      className={`cv-cpk-sidebar cv-dtp${floating ? ' cv-dtp-float' : ' cv-dtp-inline'}`}
      data-dtp-tab={tab}
      /* 探针要能一眼看出这一块是「照节点算出来的」「参数栏里的」还是「碰巧落在画布上」——
         单看坐标分不出来。 */
      data-dtp-anchor={floating ? (anchor?.place || 'below') : 'inspector'}
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
        {/* 就地形态不画这颗 ×：参数栏标题栏上已经有一颗（收起参数栏），
            同一块地方两颗 × 会让人不知道该收哪一层。 */}
        {floating && (
          <button
            type="button"
            className="cv-cpk-close"
            aria-label="关闭标签面板"
            title="关闭（Esc）"
            onClick={onClose}
          >
            <X size={16} strokeWidth={1.8} aria-hidden />
          </button>
        )}
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

      {/*
        抽签模式：每次运行重抽 / 固定这一批 —— **只改当前这一档**（见上面 `tabMode` 那段）。
        「自定义标签」那一档是自由文本、不抽签，所以整行都不画：
        画了就是两个点了没有任何反应的按钮。
      */}
      {tab !== 'extra' && (
        <div className="cv-dtp-mode" role="group" aria-label={`「${tabName}」的抽签方式`} data-dtp-mode-for={tab}>
          <button
            type="button"
            className={`cv-dtp-mode-btn${tabMode === 'random' ? ' on' : ''}`}
            aria-pressed={tabMode === 'random'}
            title={`只改「${tabName}」这一档：每次点「启动」都重新抽一批`}
            onClick={() => setTabMode('random')}
          >
            每次运行抽
          </button>
          <button
            type="button"
            className={`cv-dtp-mode-btn${tabMode === 'fixed' ? ' on' : ''}`}
            aria-pressed={tabMode === 'fixed'}
            title={`只改「${tabName}」这一档：保持当前这一批，只有点「换一批」才重抽`}
            onClick={() => setTabMode('fixed')}
          >
            固定这一批
          </button>
          <button
            type="button"
            className="cv-dtp-reroll"
            title="整个节点重抽一批（每一档都换）"
            onClick={onReroll}
          >
            <RefreshCw size={12} strokeWidth={2} aria-hidden />
            <span>换一批</span>
          </button>
        </div>
      )}

      {/*
        角色的**输出档位**（2026-10-08 徐先：「可以选择只输出角色名标签，或者输出角色标签」）。
        只在这一档画 —— 别的档没有「角色名」这回事。

        跟上面那行抽签模式长得一模一样，所以这行前面挂一个题头，不然两颗按钮是同一副面孔、
        谁也说不清哪一行管抽签、哪一行管输出。
      */}
      {tab === 'character' && (
        <div
          className="cv-dtp-mode cv-dtp-detail"
          role="group"
          aria-label="角色输出内容"
          data-dtp-detail-mode
        >
          <span className="cv-dtp-mode-label">角色输出</span>
          <button
            type="button"
            className={`cv-dtp-mode-btn${selection.characterDetail ? '' : ' on'}`}
            aria-pressed={!selection.characterDetail}
            title="只把角色名接进提示词（默认，也是这一轮之前的老行为）"
            onClick={() => setCharacterDetail(false)}
          >
            只角色名
          </button>
          <button
            type="button"
            className={`cv-dtp-mode-btn${selection.characterDetail ? ' on' : ''}`}
            aria-pressed={selection.characterDetail}
            title="角色名 + 这个角色官方那一组特征标签 —— 跟 Anima 选择器那颗「应用触发词 + 标签」一样"
            onClick={() => setCharacterDetail(true)}
          >
            角色名 + 标签
          </button>
        </div>
      )}

      {/* 自定义分类的工具栏：加标签 / 导入 / 收藏 / 改模式 / 重命名 / 删除。 */}
      {active && (
        <div className="cv-dtp-tools">
          <button
            type="button"
            className="cv-dtp-tool"
            title="手输一条标签"
            onClick={() => { setManual(manual === null ? '' : null); setRenaming(null); setEntryEdit(null); setConfirmDel(''); }}
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
            onClick={() => { setRenaming(active.name); setManual(null); setEntryEdit(null); setConfirmDel(''); }}
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
                setEntryEdit(null);
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

      {/* 给一条标签改名：一行内联输入（不用原生 prompt —— 它在这个 app 里样式是另一套）。 */}
      {active && entryEdit && (
        <div className="cv-dtp-inline">
          <input
            className="cv-dtp-inline-input"
            value={entryEdit.label}
            autoFocus
            /* 占位里带上这一条真正接出去的那串，免得改到一半忘了在改哪条。 */
            placeholder={`名字，例如「校服」—— 标签串是「${active.entries.find(item => item.id === entryEdit.id)?.tags || ''}」`}
            onChange={event => setEntryEdit({ id: entryEdit.id, label: event.target.value })}
            onKeyDown={event => {
              if (event.key === 'Enter') renameEntry(active, entryEdit.id, entryEdit.label);
              if (event.key === 'Escape') setEntryEdit(null);
            }}
          />
          <button type="button" className="cv-dtp-inline-ok" onClick={() => renameEntry(active, entryEdit.id, entryEdit.label)}>改</button>
          <button type="button" className="cv-dtp-inline-cancel" onClick={() => setEntryEdit(null)}>取消</button>
        </div>
      )}

      {/* 手输一条标签。 */}
      {active && manual !== null && (
        <div className="cv-dtp-inline">
          <input
            className="cv-dtp-inline-input"
            value={manual}
            autoFocus
            placeholder="一条标签，例如 masterpiece（想起名字就写：校服 | school uniform）"
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
                : tab === 'artist' ? '（全部串上）'
                  : tab === 'character' && selection.characterDetail ? '（抽 1 个 · 带特征标签）'
                    : '（抽 1 个）'}
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

          {/*
            已选角色的**特征标签组**（2026-10-08 徐先：「每个角色都有对应的一堆锁定标签」
            + 选定「可改」）。

            只在「角色名 + 标签」这一档画：只出角色名的时候这些标签根本不参与输出，
            画出来只会让人以为它们会被发出去。

            每个角色默认**收起**（一个角色平均 11.8 条，两个角色展开就把列表挤没了），
            点一下头展开。整块自己滚，不跟下面的列表抢高度。
          */}
          {tab === 'character' && selection.characterDetail && characterPicks.length > 0 && (
            <div className="cv-dtp-ctags" data-dtp-ctags data-dtp-ctags-open={ctagsOpen ? 'true' : 'false'}>
              <button
                type="button"
                className={`cv-dtp-ctags-head${ctagsOpen ? ' on' : ''}`}
                aria-expanded={ctagsOpen}
                data-dtp-ctags-toggle=""
                onClick={() => { setCtagsOpen(v => !v); setCtagEdit(null); }}
              >
                {ctagsOpen
                  ? <ChevronDown size={12} strokeWidth={2} aria-hidden />
                  : <ChevronRight size={12} strokeWidth={2} aria-hidden />}
                <span>这些角色的特征标签 · {characterPicks.length} 个角色</span>
                <span className="cv-dtp-ctags-hint">跟着角色走 · 可删可改</span>
              </button>
              {/*
                整块**默认收着**：见上面 `ctagsOpen` 那条注释（铺开就会把列表挤没）。
                收着的时候只留题头那一行。
              */}
              {ctagsOpen && characterPicks.map(item => {
                const tags = characterTagsOf(selection, item);
                const open = openedChar === item.name;
                const edited = Array.isArray(selection.characterTagEdits?.[item.name]);
                return (
                  <div className="cv-dtp-ctag-group" key={item.name}>
                    <div className="cv-dtp-ctag-head">
                      <button
                        type="button"
                        className={`cv-dtp-ctag-toggle${open ? ' on' : ''}`}
                        aria-expanded={open}
                        data-dtp-ctag-open={item.name}
                        onClick={() => { setOpenedChar(open ? '' : item.name); setCtagEdit(null); }}
                      >
                        {open
                          ? <ChevronDown size={12} strokeWidth={2} aria-hidden />
                          : <ChevronRight size={12} strokeWidth={2} aria-hidden />}
                        <span className="cv-dtp-ctag-name">{item.name}</span>
                        <span className="cv-dtp-ctag-count">{tags.length} 条</span>
                      </button>
                      {/* 只有真改过才给「还原」—— 没改过的那份本来就是官方的，点了没有任何反应。 */}
                      {edited && (
                        <button
                          type="button"
                          className="cv-dtp-ctag-reset"
                          data-dtp-ctag-reset={item.name}
                          title="还原成官方那一组"
                          onClick={() => resetCharacterTags(item.name)}
                        >
                          还原
                        </button>
                      )}
                    </div>
                    {open && (
                      <div className="cv-dtp-ctag-list">
                        {!tags.length && <p className="cv-dtp-ctag-empty">这一组是空的 —— 等于只出角色名</p>}
                        {tags.map((tag, idx) => {
                          const editing = ctagEdit !== null && ctagEdit.name === item.name && ctagEdit.idx === idx;
                          if (editing) {
                            return (
                              <div className="cv-dtp-inline cv-dtp-ctag-edit" key={`edit-${idx}`}>
                                <input
                                  className="cv-dtp-inline-input"
                                  value={ctagEdit.text}
                                  autoFocus
                                  placeholder="标签串"
                                  onChange={event => setCtagEdit({ name: item.name, idx, text: event.target.value })}
                                  onKeyDown={event => {
                                    if (event.key === 'Enter') commitCtagEdit();
                                    if (event.key === 'Escape') setCtagEdit(null);
                                  }}
                                />
                                <button type="button" className="cv-dtp-inline-ok" onClick={commitCtagEdit}>改</button>
                                <button type="button" className="cv-dtp-inline-cancel" onClick={() => setCtagEdit(null)}>取消</button>
                              </div>
                            );
                          }
                          return (
                            <div className="cv-dtp-ctag-row" key={`${tag}-${idx}`}>
                              <span className="cv-dtp-ctag-text">{tag}</span>
                              <button
                                type="button"
                                className="cv-dtp-row-act"
                                data-dtp-ctag-edit={`${item.name}::${idx}`}
                                aria-label={`改「${tag}」`}
                                title="改这一条（显示的就是接进提示词的那串）"
                                onClick={() => setCtagEdit({ name: item.name, idx, text: tag })}
                              >
                                <PencilLine size={11} strokeWidth={2} aria-hidden />
                              </button>
                              <button
                                type="button"
                                className="cv-dtp-row-act cv-dtp-row-del"
                                data-dtp-ctag-del={`${item.name}::${idx}`}
                                aria-label={`去掉「${tag}」`}
                                title="从这一组里去掉这条"
                                onClick={() => {
                                  setCtagEdit(null);
                                  editCharacterTags(item.name, list => list.filter((_, index) => index !== idx));
                                }}
                              >
                                <Trash2 size={11} strokeWidth={2} aria-hidden />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

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
                  {/* 改名 + 删掉，两颗并排。原来只有删掉那颗，他没找着 —— 顺手也让删除显眼一点。 */}
                  <button
                    type="button"
                    className="cv-dtp-row-act"
                    data-dtp-row-rename={row.id}
                    aria-label={`给「${row.title}」改个名字`}
                    title="改个名字（只改列表里显示的名字，不改接进提示词的那串标签）"
                    onClick={() => {
                      const entry = active.entries.find(item => item.id === row.id);
                      setManual(null);
                      setRenaming(null);
                      setConfirmDel('');
                      setEntryEdit({ id: row.id, label: entry?.label || row.title });
                    }}
                  >
                    <PencilLine size={11} strokeWidth={2} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="cv-dtp-row-act cv-dtp-row-del"
                    data-dtp-row-del={row.id}
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
  );

  /* 就地形态：直接交给自己所在的位置（参数栏正文），不 portal。 */
  if (!floating) return panel;

  /* 浮动形态：portal 到 `.cv-stage`（`position: relative`，与 `.cv-dock` 同一个宿主）。
     取不到就整块不渲染 —— 宁可不出，也不能挂到别的层上去当浮层。 */
  const host = typeof document !== 'undefined' ? document.querySelector('.cv-stage') : null;
  if (!host) return null;
  return createPortal(panel, host);
}
