'use client';

/**
 * 底栏里的「可输入搜索框」（2026-10-02 徐先：「工作流可以输入文本或者字符串，
 * 自动索引对应的工作流」）。
 *
 * 它替掉的是原来的 `<select>`：工作流有 122 条、每一条都是 19 位编号，
 * 在原生下拉里翻找等于靠记忆力认人。现在框里可以直接打字，列表**边打边筛**，
 * 点一下选中。
 *
 * ⚠️ 三条做之前必须知道的事：
 *
 * 1. **列表为什么是 `position: absolute` + JS 算坐标**：`.cv-dock-scroll` 是
 *    `overflow-y: auto`，列表是它的后代，照常理会被裁掉。但 CSS 有一条：绝对定位元素的
 *    包含块若在**滚动盒之外**，就不受那个滚动盒裁剪 —— 所以这里以 `.cv-dock`
 *    （`position: absolute`、且 `overflow: visible`）为包含块，坐标用两次
 *    `getBoundingClientRect()` 相减算出来（相减能免疫祖先的 transform）。
 *    面板一滚坐标就失效，所以**滚动即关**（下面那个 `scroll` 监听）。
 *
 * 1b. **🔴 列表必须能翻到上方**：底栏是挂在节点下方的，节点一靠下它就贴着窗口下沿
 *    （探针量到过 `dockBottom=930` 而窗口只有 902 —— 它本来就会伸出去一截），
 *    而「工作流」那一行在展开区靠下的位置。**一律往下开的话，列表整个落在窗口外面**：
 *    看不见、点不到、`elementFromPoint` 直接返回 null（不像被盖住那样还能查出是谁在上面）。
 *    所以下方装不下就翻到上方；上下都装不下就占空间大的那一侧，并把高度压到装得下为止。
 *    判据是 L-5 / L-6：列表里第一行的中心点必须真的点得到，且整体在窗口内。
 *
 * 2. **为什么还留一份 `hidden` 的原生 `<select>`**：外面有六个一次性探针
 *    （`_probe-audio-dock` / `_probe-upscale-capsule` / `_probe-app-params` …）
 *    是靠 `data-dock-workflow` 拿那个 select、用原生 setter 塞值再派 `change` 来造状态的。
 *    `hidden` 的元素仍然在 DOM 里、仍然能触发 React 的 `onChange`，所以它们一行都不用改。
 *    🔴 它是**影子节点**，不是第二份界面：候选改了要跟 visible 那份一起改
 *    （两边都从同一个 `items` 渲染，别在其中一边另加过滤）。
 *
 * 3. **匹配什么**：跟设置页那个工作流库的搜索同一条口径 —— **名字 / 编号 / 显示名**
 *    任一命中即可（大小写不敏感）。这里直接拿整行 label 去匹配，因为
 *    `workflowLabel()` 拼出来的行里已经同时含着名字和编号
 *    （起了名字是「名字 · 编号」，没起名字则显示名本身就是编号）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export type DockComboItem = { value: string; label: string };
export type DockComboGroup = { key: string; label: string; items: DockComboItem[] };

/** 列表高度上下限（`max-height` 的取值，与 `canvas.css` 里那条是同一个数）。 */
const LIST_MAX_H = 260;
/** 上下都装不下时也不能压到比这更矮 —— 再矮就只剩一行半，翻找失去意义。 */
const LIST_MIN_H = 120;
/** 列表与窗口上下沿之间留的余量。 */
const EDGE_MARGIN = 8;

type Props = {
  /** 当前值（工作流 ID）。空串 = 未选 / 自动。 */
  value: string;
  /** 候选 —— 调用方已经按用途 / 来源 / 工序过滤过了，这里不再筛一遍。 */
  items: DockComboItem[];
  /** 分组（可选）。给了就按组显示，空的组自动隐藏。 */
  groups?: DockComboGroup[];
  /** 值不在候选里时那一行显示什么（`null` = 不显示这一行）。 */
  missingLabel?: string | null;
  /** 还没选 / 值为空时的占位文案。 */
  placeholder: string;
  ariaLabel: string;
  /** 探针钩子（如 `workflow`）→ 实际渲染成 `data-dock-workflow`（影子节点）与
   *  `data-dock-workflow-input`（人看得见、也打得字的那个框）。 */
  hook: string;
  /** 列表最上面那颗「动作」行（如「＋ 从工作流库中选择…」）。 */
  action?: { label: string; onPick: () => void } | null;
  /** 一条都没搜到时说的话。 */
  emptyHint: string;
  onChange: (value: string) => void;
};

export default function DockCombo({
  value, items, groups, missingLabel, placeholder, ariaLabel, hook, action, emptyHint, onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const current = useMemo(() => items.find(item => item.value === value) || null, [items, value]);
  const currentLabel = current?.label || missingLabel || '';
  /** 值不在候选里、且调用方给了说法 —— 这一行要能看见，不然「界面显示 A、其实是 B」。 */
  const showMissing = !current && !!value && !!missingLabel;

  const keyword = query.trim().toLowerCase();
  const hit = (item: DockComboItem) => !keyword
    || (item.label + ' ' + item.value).toLowerCase().includes(keyword);

  /** 有分组就按组筛（空组自动隐藏），没分组就一整列。 */
  const shownGroups = useMemo(() => {
    if (!groups || !groups.length) {
      const flat = items.filter(hit);
      return flat.length ? [{ key: '_all', label: '', items: flat }] : [];
    }
    return groups
      .map(group => ({ ...group, items: group.items.filter(hit) }))
      .filter(group => group.items.length > 0);
  }, [groups, items, keyword]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = useMemo(() => shownGroups.flatMap(group => group.items), [shownGroups]);

  /**
   * 坐标 + 上下翻转（见文件头第 1 / 1b 条）。
   *
   * 在 `useLayoutEffect` 里量而不是在 `onFocus` 里量：列表这时已经进了 DOM，
   * `offsetHeight` 才拿得到真实高度 —— 而「下方装不装得下」必须要这个高度才知道。
   * 依赖里带上 `keyword` 与 `flat.length`：一筛选项变少、列表变矮，位置要重算
   * （否则会出现「先按 260 翻到了上面，筛完只剩一条却还悬在半空」）。
   */
  useLayoutEffect(() => {
    if (!open) return;
    const el = inputRef.current;
    const dock = el?.closest('.cv-dock') as HTMLElement | null;
    if (!el || !dock) return;
    const a = el.getBoundingClientRect();
    const d = dock.getBoundingClientRect();
    const width = Math.max(a.width, 240);
    const h = listRef.current ? listRef.current.offsetHeight : 0;
    const vh = window.innerHeight;
    const below = a.bottom - d.top + 4;
    const above = a.top - d.top - 4 - h;
    let top = below;
    let maxHeight = LIST_MAX_H;
    if (d.top + below + h > vh - EDGE_MARGIN) {
      if (d.top + above >= EDGE_MARGIN) {
        /* 下方装不下、上方装得下 —— 翻上去（下拉的常规做法）。 */
        top = above;
      } else {
        /* 两边都装不下：占空间大的那一侧，并把高度压到装得下为止。 */
        const roomBelow = vh - EDGE_MARGIN - (d.top + below);
        const roomAbove = d.top + a.top - 4 - EDGE_MARGIN;
        if (roomBelow >= roomAbove) {
          top = below;
          maxHeight = Math.max(LIST_MIN_H, Math.min(LIST_MAX_H, roomBelow));
        } else {
          maxHeight = Math.max(LIST_MIN_H, Math.min(LIST_MAX_H, roomAbove));
          top = a.top - d.top - 4 - maxHeight;
        }
      }
    }
    setPos({ left: a.left - d.left, top, width, maxHeight });
    setActive(0);
  }, [open, keyword, flat.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /* 滚动 / 缩放 / 点外面 → 关掉。坐标是量出来的，一动就失效，宁可关了重开。 */
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    /* capture：任何祖先滚动都算（面板滚、画布滚）。 */
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (!open && (event.key === 'ArrowDown' || event.key === 'Enter')) { setOpen(true); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
    event.preventDefault();
    if (event.key === 'Enter') { if (flat[active]) pick(flat[active].value); return; }
    const step = event.key === 'ArrowDown' ? 1 : -1;
    setActive(prev => (prev + step + flat.length) % Math.max(flat.length, 1));
  };

  let rowIndex = -1;
  const hookProps = { ['data-dock-' + hook]: '' } as Record<string, string>;

  return (
    <div className="cv-combo" ref={wrapRef}>
      {/*
        输入框与「下拉」箭头包在这一层里，箭头靠它定位。
        ⚠️ 这一层**只能是** `.cv-combo-box`，不能让 `.cv-combo` 自己 `position: relative` ——
        那会把下面那个列表的包含块从 `.cv-dock` 换成 `.cv-combo`，列表就重新落回
        `.cv-dock-scroll` 那个 `overflow-y: auto` 里，长列表只能看见上面一截。
      */}
      <div className="cv-combo-box">
        <input
          ref={inputRef}
          className="cv-combo-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-label={ariaLabel}
          {...{ ['data-dock-' + hook + '-input']: '' }}
          placeholder={currentLabel || placeholder}
          value={open ? query : currentLabel}
          /* 收起之后再点框要能再开：`onFocus` 在已经有焦点时不会再触发一次，
             只靠它的话「点箭头收掉 → 再点框」会没反应。 */
          onMouseDown={() => { if (!open) { setQuery(''); setOpen(true); } }}
          onFocus={() => { setOpen(true); setQuery(''); }}
          onChange={event => { setQuery(event.target.value); setOpen(true); setActive(0); }}
          onKeyDown={onKeyDown}
        />
        {/*
          下拉箭头（2026-10-02 徐先：「下拉的也保留啊，别删了」）。
          它不只是个装饰：点它 = **按老样子翻全部**（先把框里的关键词清掉再展开），
          而直接往框里点 = 「接着打字筛」。两条路都在，谁也不用重新学。
        */}
        <button
          type="button"
          className={`cv-combo-caret${open ? ' on' : ''}`}
          aria-label="展开全部候选"
          aria-expanded={open}
          title="展开全部候选（也可以直接在框里打字搜）"
          tabIndex={-1}
          {...{ ['data-dock-' + hook + '-caret']: '' }}
          onClick={() => {
            if (open) { setOpen(false); return; }
            setQuery('');
            setOpen(true);
            inputRef.current?.focus();
          }}
        >
          <ChevronDown size={13} strokeWidth={2} className={open ? 'flip' : ''} aria-hidden />
        </button>
      </div>
      {/*
        影子节点：**只给自动化用**，人看不见。老探针靠 `data-dock-workflow` 找到它、
        用原型上的原生 setter 塞值再派 `change`，React 的 `onChange` 会照常收到。
        别因为「界面上没有」就删掉它 —— 删了那六个一次性探针全部假红。
      */}
      <select
        className="cv-combo-native"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        {...hookProps}
        value={value}
        onChange={event => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {showMissing ? <option value={value}>{missingLabel}</option> : null}
        {items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      {open ? (
        <div
          ref={listRef}
          className="cv-combo-list"
          {...{ ['data-dock-' + hook + '-list']: '' }}
          data-combo-top={pos ? Math.round(pos.top) : 'none'}
          data-combo-mh={pos ? Math.round(pos.maxHeight) : 'none'}
          style={pos
            ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }
            : { left: 0, top: 0, width: 240 }}
        >
          {action ? (
            <button type="button" className="cv-combo-row action" onClick={() => { setOpen(false); action.onPick(); }}>
              {action.label}
            </button>
          ) : null}
          {showMissing ? (
            <button type="button" className="cv-combo-row current" onClick={() => pick(value)}>
              {missingLabel}
            </button>
          ) : null}
          {shownGroups.map(group => (
            <div className="cv-combo-group" key={group.key}>
              {group.label ? <span className="cv-combo-head">{group.label}</span> : null}
              {group.items.map(item => {
                rowIndex += 1;
                const mine = rowIndex;
                return (
                  <button
                    type="button"
                    key={item.value}
                    className={`cv-combo-row${mine === active ? ' active' : ''}${item.value === value ? ' on' : ''}`}
                    onMouseEnter={() => setActive(mine)}
                    onClick={() => pick(item.value)}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
          {!flat.length ? <span className="cv-combo-empty">{emptyHint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
