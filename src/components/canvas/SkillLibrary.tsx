'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Files, FolderUp, Loader2, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { apiDelete, apiGet, apiPost, apiSend } from '@/lib/client';
import type { CodexSkill } from '@/lib/desktop-codex';

/**
 * SKILL 社区（2026-09-25，从 AIFISHER 迁过来的模块）。
 *
 * 它解决的是一件很具体的事：**Codex 很能干，但它不知道徐先这套提示词该怎么写。**
 * 「文戏怎么分镜、武戏怎么递进、MJ 资产怎么写双语正文」这些规矩是成体系的，
 * 一条条在对话框里重复说不现实 —— 它们写在技能里，让 Codex 自己读。
 *
 * 所以这里做两件事：
 *  1. 把技能摆出来让人选（官方推荐那七个 + 自己导入的）；
 *  2. 选中的技能把**目录路径**交给 Codex（见 `CodexSkill` 的注释：
 *     只给路径不给正文，正文几万字符塞进 prompt 是浪费）。
 *
 * 同一个技能还能挂到 dock 的「优化提示词」上（`optimize` 那个开关）——
 * 那条路走的是文本模型，只取 SKILL.md 正文当写作规范。
 *
 * ⚠️ 两种形态，**数据逻辑只有一份**：
 *  - `embedded`：嵌在左轨那张居中浮层里（`.cv-ov-body` 自己会滚，这里不管滚动）；
 *  - 弹窗：Codex 面板里点「SKILL 社区」弹出来的，自带遮罩和标题栏，**portal 到 body**。
 * 别为了两种外壳去复制一遍列表和导入。
 *
 * 🔴 弹窗必须 portal 出去（2026-09-25 徐先看出「只能显示部分技能」）：它是从 Codex
 * 抽屉里点开的，而 `.cv-drawer` 带 `will-change: transform` 和进出场 animation ——
 * 那会给 `position: fixed` 的后代造一个新的包含块，`inset: 0` 于是等于「抽屉那么大的
 * 视口」，弹窗被关在 440px 里：宽不起来、没法居中，卡片挤成一列、下半截还够不着。
 * 挂到 body 上它才是真正的全屏浮层（宽 min(960, 100vw-64) + 自带滚动层）。
 *
 * **不分「官方 / 我的」两栏**（徐先 2026-09-25：官方推荐那栏不要了，内置那七个
 * 直接跟自己导入的放一起）。两栏里的卡片长得一样、能做的事也一样，分成两栏只会
 * 让人先纠结「我该看哪一栏」，而且内置技能还删不掉。
 */

export type SkillItem = {
  /** 就是 slug（技能目录名），后端也拿它定位。 */
  id: string;
  slug: string;
  title: string;
  description: string;
  usage: 'use' | 'edit';
  optimize: boolean;
  dir: string;
  files: string[];
  /** 分类标签：用户自己建的，一个技能可以打多个。 */
  tags: string[];
  references: string[];
  updatedAt: number;
};

type ListResult = {
  skills: SkillItem[];
  root: string;
  builtin: string | null;
  /** 已经建好的分类（∪ 技能上正打着的标签）。 */
  categories: string[];
};

/** 只读文本后缀 —— 案例图那种几 MB 的 png 不要跟着进来。 */
const TEXT_EXT = ['.md', '.txt', '.json', '.yaml', '.yml', '.py'];

/** 筛选项「未分类」的内部值 —— 带双下划线，跟用户起的分类名撞不上。 */
const UNTAGGED = '__untagged__';

export default function SkillLibrary({
  open = false,
  embedded = false,
  activeId = null,
  onClose,
  onPick,
}: {
  /** 弹窗形态下是否打开。嵌在浮层里时这个不用管。 */
  open?: boolean;
  embedded?: boolean;
  /** 当前挂在 Codex 上的技能 id（在卡片上打勾）。 */
  activeId?: string | null;
  onClose?: () => void;
  /** 「在 Codex 中使用」：把技能交给 Codex 面板。 */
  onPick: (skill: CodexSkill) => void;
}) {
  const [data, setData] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newNote, setNewNote] = useState('');
  /** 点开的卡片（一次只开一张）：展开后给完整说明 + 文件清单。 */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 顶部分类条当前选中：'all' / UNTAGGED / 某个分类名。 */
  const [filter, setFilter] = useState<string>('all');
  const [catNewOpen, setCatNewOpen] = useState(false);
  const [catName, setCatName] = useState('');
  /** 正在改名的那个分类（双击 chip 触发）。 */
  const [renameFrom, setRenameFrom] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState('');
  /** 哪张卡片的标题正在被双击改名（一次只开一个）。 */
  const [titleFor, setTitleFor] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  /** 哪张卡片正在编辑标签（一次只开一个）。 */
  const [tagFor, setTagFor] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const dirInput = useRef<HTMLInputElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiGet<ListResult>('/api/skills'));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '技能列表没取到。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open && !embedded) return;
    setNotice('');
    void reload();
  }, [open, embedded, reload]);

  /*
   * `webkitdirectory` 在 React 的 input 类型里没有声明，直接写 JSX 属性过不了 TS。
   * 挂载后自己 setAttribute 最省事 —— 这个属性只有 Chromium 认，Electron 正好是它。
   */
  useEffect(() => {
    dirInput.current?.setAttribute('webkitdirectory', '');
  }, []);

  const list = data?.skills ?? [];

  /** 导入一组文件：按「顶层目录」切成一个个技能。 */
  const importFiles = useCallback(async (picked: File[]) => {
    const usable = picked.filter(file => TEXT_EXT.some(ext => file.name.toLowerCase().endsWith(ext)));
    if (!usable.length) {
      setNotice('这里面没有能用的文本文件（.md / .txt / .json）。');
      return;
    }
    setBusy('import');
    setNotice('');
    try {
      const groups = new Map<string, { path: string; content: string }[]>();
      for (const file of usable) {
        const raw = String((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name)
          .replace(/\\/g, '/');
        const parts = raw.split('/').filter(Boolean);
        /* 第一段是用户选的那个文件夹本身，剥掉；剩下的第一段就是技能名。 */
        const rest = parts.length > 1 ? parts.slice(1) : parts;
        const name = rest.length > 1 ? rest[0] : '（根目录）';
        const path = rest.length > 1 ? rest.slice(1).join('/') : rest[0];
        const content = await file.text();
        const bucket = groups.get(name) ?? [];
        bucket.push({ path, content });
        groups.set(name, bucket);
      }
      const skills = [...groups.entries()].map(([title, files]) => ({ title, files }));
      const result = await apiPost<{ imported: SkillItem[]; failed: string[] }>('/api/skills', { skills });
      setNotice(
        `导入成功 ${result.imported.length} 个${result.failed.length ? `；失败：${result.failed.join('；')}` : ''}`,
      );
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导入失败。');
    } finally {
      setBusy('');
      if (dirInput.current) dirInput.current.value = '';
      if (fileInput.current) fileInput.current.value = '';
    }
  }, [reload]);

  const patch = useCallback(async (
    skill: SkillItem,
    body: { title?: string; usage?: 'use' | 'edit'; optimize?: boolean; tags?: string[] },
  ) => {
    setBusy(skill.id);
    try {
      await apiSend(`/api/skills/${skill.slug}`, 'PATCH', body);
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '改动没保存。');
    } finally {
      setBusy('');
    }
  }, [reload]);

  const remove = useCallback(async (skill: SkillItem) => {
    setBusy(skill.id);
    try {
      await apiDelete<{ deleted: boolean }>(`/api/skills/${skill.slug}`);
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除失败。');
    } finally {
      setBusy('');
    }
  }, [reload]);

  const create = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) {
      setNotice('先给这个技能起个名字。');
      return;
    }
    setBusy('new');
    try {
      await apiPost('/api/skills', { title, note: newNote.trim() });
      setNewTitle('');
      setNewNote('');
      setNewOpen(false);
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '新建失败。');
    } finally {
      setBusy('');
    }
  }, [newNote, newTitle, reload]);

  const restore = useCallback(async () => {
    setBusy('reset');
    try {
      const result = await apiPost<{ seeded: string[] }>('/api/skills/reset', { overwrite: true });
      setNotice(result.seeded.length ? `已恢复 ${result.seeded.length} 个内置技能。` : '内置技能都在，不用恢复。');
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '恢复失败。');
    } finally {
      setBusy('');
    }
  }, [reload]);

  const categories = data?.categories ?? [];
  /** 分类条选完之后真正要渲染的那些技能。 */
  const visible = filter === 'all'
    ? list
    : filter === UNTAGGED
      ? list.filter(skill => !skill.tags.length)
      : list.filter(skill => skill.tags.includes(filter));
  /** chip 上那个计数：UNTAGGED 走「没有标签的那些」，别的走「带这个标签的那些」。 */
  const countOf = (name: string) => (name === UNTAGGED
    ? list.filter(skill => !skill.tags.length).length
    : list.filter(skill => skill.tags.includes(name)).length);

  /** 换一整组标签。空数组就是「取消全部分类」。 */
  const setTags = useCallback(async (skill: SkillItem, tags: string[]) => {
    await patch(skill, { tags });
  }, [patch]);

  /** 输入框里敲的那个名字：分类表里没有也照打 —— 后端会顺手把分类建出来。 */
  const addTag = useCallback(async (skill: SkillItem) => {
    const name = tagDraft.trim().replace(/\s+/g, ' ');
    setTagDraft('');
    if (!name || skill.tags.includes(name)) return;
    await patch(skill, { tags: [...skill.tags, name] });
  }, [patch, tagDraft]);

  const addCat = useCallback(async () => {
    const name = catName.trim().replace(/\s+/g, ' ');
    if (!name) {
      setCatNewOpen(false);
      return;
    }
    setCatNewOpen(false);
    setCatName('');
    setBusy('cat');
    try {
      await apiPost<{ categories: string[] }>('/api/skills/categories', { name });
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '分类没建成。');
    } finally {
      setBusy('');
    }
  }, [catName, reload]);

  const commitRename = useCallback(async () => {
    const from = renameFrom;
    const to = renameTo.trim().replace(/\s+/g, ' ');
    setRenameFrom(null);
    setRenameTo('');
    if (!from || !to || from === to) return;
    /* 正在看这个分类的话，改名后得跟着看新的那个，不然会掉进一个空列表。 */
    if (filter === from) setFilter(to);
    setBusy('cat');
    try {
      await apiSend<{ categories: string[] }>('/api/skills/categories', 'PATCH', { from, to });
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '改名没保存。');
    } finally {
      setBusy('');
    }
  }, [filter, reload, renameFrom, renameTo]);

  /** 双击卡片标题改显示名。只改 `skill.json.title`，目录名（id）不动。 */
  const commitTitle = useCallback(async () => {
    const slug = titleFor;
    const to = titleDraft.trim().replace(/\s+/g, ' ');
    setTitleFor(null);
    setTitleDraft('');
    if (!slug || !to) return;
    const skill = list.find(item => item.slug === slug);
    if (!skill || skill.title === to) return;
    await patch(skill, { title: to });
  }, [list, patch, titleDraft, titleFor]);

  const delCat = useCallback(async (name: string) => {
    if (filter === name) setFilter('all');
    setBusy('cat');
    try {
      await apiSend<{ categories: string[] }>(
        `/api/skills/categories?name=${encodeURIComponent(name)}`,
        'DELETE',
      );
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '分类没删掉。');
    } finally {
      setBusy('');
    }
  }, [filter, reload]);

  /*
   * 分类条（2026-09-25 徐先：技能要能自己归类、自己建分类）。
   * 点 chip = 只看这一类；双击 = 改名；chip 右边那个小 × = 删掉这个分类。
   * ⚠️ 改名时那一格换成 `<span>` 包 input —— `<input>` 不能塞在 `<button>` 里，
   *    浏览器会把点击吞掉、还报交互内容嵌套的错。
   */
  const catsBar = (
    <div className="cv-skill-cats" data-skill-cats="">
      <button
        className={`cv-skill-cat${filter === 'all' ? ' on' : ''}`}
        type="button"
        data-skill-cat="all"
        title="全部技能"
        onClick={() => setFilter('all')}
      >
        全部 <span className="cv-skill-cat-n">{list.length}</span>
      </button>
      <button
        className={`cv-skill-cat${filter === UNTAGGED ? ' on' : ''}`}
        type="button"
        data-skill-cat="untagged"
        title="还没打分类标签的那些"
        onClick={() => setFilter(UNTAGGED)}
      >
        未分类 <span className="cv-skill-cat-n">{countOf(UNTAGGED)}</span>
      </button>
      {categories.map(name => (
        <span className="cv-skill-cat-wrap" key={name}>
          {renameFrom === name ? (
            <span className="cv-skill-cat editing" data-skill-cat-editing={name}>
              <input
                className="cv-skill-cat-input"
                value={renameTo}
                autoFocus
                data-skill-cat-rename=""
                onChange={event => setRenameTo(event.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void commitRename();
                  }
                  if (event.key === 'Escape') {
                    setRenameFrom(null);
                    setRenameTo('');
                  }
                }}
              />
            </span>
          ) : (
            <>
              <button
                className={`cv-skill-cat${filter === name ? ' on' : ''}`}
                type="button"
                data-skill-cat={name}
                title="点一下只看这一类；双击改名；× 删掉这个分类"
                onClick={() => setFilter(name)}
                onDoubleClick={() => {
                  setRenameFrom(name);
                  setRenameTo(name);
                }}
              >
                {name} <span className="cv-skill-cat-n">{countOf(name)}</span>
              </button>
              <button
                className="cv-skill-cat-x"
                type="button"
                data-skill-cat-del={name}
                aria-label={`删掉分类 ${name}`}
                title="删掉这个分类（技能上的标签也会一起摘掉）"
                onClick={() => void delCat(name)}
              >
                <X size={10} strokeWidth={2.4} aria-hidden />
              </button>
            </>
          )}
        </span>
      ))}
      {catNewOpen ? (
        <input
          className="cv-skill-cat-input"
          value={catName}
          autoFocus
          placeholder="分类名，回车建好"
          data-skill-cat-new-input=""
          onChange={event => setCatName(event.target.value)}
          onBlur={() => void addCat()}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void addCat();
            }
            if (event.key === 'Escape') {
              setCatNewOpen(false);
              setCatName('');
            }
          }}
        />
      ) : (
        <button
          className="cv-skill-cat add"
          type="button"
          data-skill-cat-new=""
          title="新建一个分类"
          onClick={() => setCatNewOpen(true)}
        >
          <Plus size={11} strokeWidth={2.2} aria-hidden /> 新分类
        </button>
      )}
    </div>
  );

  /** 导入 / 新建那一排按钮（两种形态共用）。 */
  const tools = (
    <div className="cv-skill-tools">
      <button
        className="cv-btn ghost sm"
        type="button"
        data-skill-import-dir=""
        disabled={busy === 'import'}
        onClick={() => dirInput.current?.click()}
        title="选一个技能文件夹（里面可以直接放好几个技能）"
      >
        <FolderUp size={12} strokeWidth={2} aria-hidden /> 批量导入文件夹
      </button>
      <button
        className="cv-btn ghost sm"
        type="button"
        data-skill-import-files=""
        disabled={busy === 'import'}
        onClick={() => fileInput.current?.click()}
      >
        <Files size={12} strokeWidth={2} aria-hidden /> 选文件
      </button>
      <button
        className="cv-btn ghost sm"
        type="button"
        data-skill-new=""
        onClick={() => setNewOpen(value => !value)}
      >
        <Plus size={12} strokeWidth={2} aria-hidden /> 新建
      </button>
      <div className="cv-spacer" />
      <button
        className="cv-btn ghost sm"
        type="button"
        data-skill-reset=""
        disabled={busy === 'reset'}
        onClick={() => void restore()}
        title="把官方推荐那七个恢复成包里的原始版本"
      >
        <RotateCcw size={12} strokeWidth={2} aria-hidden /> 恢复内置
      </button>
      <input
        ref={dirInput}
        className="cv-skill-file"
        type="file"
        multiple
        data-skill-dir-input=""
        onChange={event => void importFiles([...(event.target.files ?? [])])}
      />
      <input
        ref={fileInput}
        className="cv-skill-file"
        type="file"
        multiple
        accept=".md,.txt,.json,.yaml,.yml,.py"
        data-skill-files-input=""
        onChange={event => void importFiles([...(event.target.files ?? [])])}
      />
    </div>
  );

  const body = (
    <>
      {newOpen && (
        <div className="cv-skill-new" data-skill-new-form="">
          <input
            className="cv-skill-name"
            value={newTitle}
            placeholder="技能名字，比如「我的分镜写法」"
            data-skill-new-title=""
            onChange={event => setNewTitle(event.target.value)}
          />
          <input
            className="cv-skill-name"
            value={newNote}
            placeholder="一句话说明它管什么（可选）"
            data-skill-new-note=""
            onChange={event => setNewNote(event.target.value)}
          />
          <button
            className="cv-btn primary sm"
            type="button"
            data-skill-new-save=""
            disabled={busy === 'new'}
            onClick={() => void create()}
          >
            {busy === 'new' ? <Loader2 size={12} className="cv-spin" aria-hidden /> : '存下来'}
          </button>
        </div>
      )}

      {notice && <div className="cv-skill-notice" data-skill-notice="">{notice}</div>}

      {loading && !data ? (
        <div className="cv-skill-empty">
          <Loader2 size={14} className="cv-spin" aria-hidden /> 正在读技能目录…
        </div>
      ) : null}

      {data && !loading && list.length > 0 && visible.length === 0 ? (
        <div className="cv-skill-empty" data-skill-filter-empty="">
          这个分类下还没有技能。回「全部」，点卡片上标签那行的 ＋ 就能把它归过来。
        </div>
      ) : null}

      {data && !loading && !list.length ? (
        <div className="cv-skill-empty" data-skill-empty="">
          一个技能都没有。点上面「批量导入文件夹」—— 选一个装着 SKILL.md 的目录就行，里面有几个技能就一次进来几个；
          自带的七个一个都不见的话，点「恢复内置」找回来。
        </div>
      ) : null}

      <div className="cv-skill-grid">
        {visible.map(skill => (
          <div
            key={skill.id}
            className={`cv-skill-card${activeId === skill.id ? ' on' : ''}${expandedId === skill.id ? ' expanded' : ''}`}
            data-skill-card={skill.id}
            data-skill-expand={skill.id}
            role="button"
            tabIndex={0}
            aria-expanded={expandedId === skill.id}
            title="点一下展开：完整说明 + 文件清单"
            onClick={() => setExpandedId(current => (current === skill.id ? null : skill.id))}
            onKeyDown={event => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              setExpandedId(current => (current === skill.id ? null : skill.id));
            }}
          >
            <div className="cv-skill-card-top">
              {titleFor === skill.id ? (
                /* ⚠️ 输入框要自己挡住点击：卡片整块是「点一下展开」，冒泡上去会把它开合一遍。 */
                <input
                  className="cv-skill-title-input"
                  value={titleDraft}
                  autoFocus
                  data-skill-rename=""
                  aria-label="改这个技能的名字"
                  onClick={event => event.stopPropagation()}
                  onChange={event => setTitleDraft(event.target.value)}
                  onBlur={() => void commitTitle()}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void commitTitle();
                    }
                    if (event.key === 'Escape') {
                      setTitleFor(null);
                      setTitleDraft('');
                    }
                  }}
                />
              ) : (
                <strong
                  className="cv-skill-title"
                  data-skill-title={skill.id}
                  title="双击改名（只改显示名，不动目录名）"
                  onDoubleClick={event => {
                    event.stopPropagation();
                    setTitleFor(skill.id);
                    setTitleDraft(skill.title);
                  }}
                >
                  {skill.title}
                </strong>
              )}
              <span className={`cv-skill-usage ${skill.usage}`} data-skill-usage={skill.usage}>
                {skill.usage === 'edit' ? '修改' : '使用'}
              </span>
            </div>
            <p className="cv-skill-desc">{skill.description || '（这个技能没写说明）'}</p>
            {/* 不展开也能看出它属于哪几类；＋ 打开标签编辑器。 */}
            <div className="cv-skill-tags" onClick={event => event.stopPropagation()}>
              {skill.tags.length
                ? skill.tags.slice(0, 3).map(tag => <span className="cv-skill-tag" key={tag}>{tag}</span>)
                : <span className="cv-skill-tag empty">未分类</span>}
              {skill.tags.length > 3 ? <span className="cv-skill-tag more">+{skill.tags.length - 3}</span> : null}
              <button
                className="cv-skill-tag-add"
                type="button"
                data-skill-tag-add={skill.id}
                title="给这个技能打分类标签"
                onClick={() => {
                  setTagFor(current => (current === skill.id ? null : skill.id));
                  setTagDraft('');
                }}
              >
                <Plus size={10} strokeWidth={2.2} aria-hidden />
              </button>
            </div>
            {tagFor === skill.id ? (
              <div className="cv-skill-tagedit" data-skill-tagedit={skill.id} onClick={event => event.stopPropagation()}>
                {skill.tags.length
                  ? skill.tags.map(tag => (
                    <span className="cv-skill-tag" key={tag} data-skill-tag={tag}>
                      {tag}
                      <button
                        className="cv-skill-tag-x"
                        type="button"
                        data-skill-tag-remove={skill.id}
                        data-tag={tag}
                        title="去掉这个标签"
                        onClick={() => void setTags(skill, skill.tags.filter(item => item !== tag))}
                      >
                        <X size={9} strokeWidth={2.6} aria-hidden />
                      </button>
                    </span>
                  ))
                  : <span className="cv-skill-tag empty">还没打标签</span>}
                <input
                  className="cv-skill-tag-input"
                  value={tagDraft}
                  placeholder="输入分类名，回车打上（没有就顺手新建）"
                  data-skill-tag-input={skill.id}
                  onChange={event => setTagDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void addTag(skill);
                    }
                    if (event.key === 'Escape') {
                      setTagFor(null);
                      setTagDraft('');
                    }
                  }}
                />
                {categories.filter(name => !skill.tags.includes(name)).length ? (
                  <div className="cv-skill-tag-quick">
                    {categories.filter(name => !skill.tags.includes(name)).map(name => (
                      <button
                        className="cv-skill-tag pick"
                        type="button"
                        key={name}
                        data-skill-tag-quick={name}
                        title={`打上「${name}」`}
                        onClick={() => void setTags(skill, [...skill.tags, name])}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="cv-skill-meta" onClick={event => event.stopPropagation()}>
              <span>{skill.files.length} 个文件</span>
              {skill.references.length ? <span>{skill.references.length} 份参考</span> : null}
              <div className="cv-spacer" />
              <button
                className="cv-skill-mini"
                type="button"
                data-skill-usage-toggle={skill.id}
                disabled={busy === skill.id}
                title="切换「拿来用」还是「拿来改」"
                onClick={() => void patch(skill, { usage: skill.usage === 'edit' ? 'use' : 'edit' })}
              >
                {skill.usage === 'edit' ? '改为使用' : '改为修改'}
              </button>
              <button
                className="cv-skill-mini danger"
                type="button"
                data-skill-del={skill.id}
                disabled={busy === skill.id}
                title="删掉这个技能（自带的也能删，想找回来点上面「恢复内置」）"
                onClick={() => void remove(skill)}
              >
                <Trash2 size={12} strokeWidth={2} aria-hidden />
              </button>
            </div>
            {expandedId === skill.id ? (
              <div className="cv-skill-files" data-skill-files={skill.id}>
                {skill.files.length ? skill.files.slice(0, 14).map(name => (
                  <span className="cv-skill-chip" key={name}>{name}</span>
                )) : <span className="cv-skill-chip empty">（这个技能的目录里还没有文本文件）</span>}
                {skill.files.length > 14 ? (
                  <span className="cv-skill-chip more">…还有 {skill.files.length - 14} 个</span>
                ) : null}
              </div>
            ) : null}
            <div className="cv-skill-actions" onClick={event => event.stopPropagation()}>
              <button
                className={`cv-skill-use${activeId === skill.id ? ' on' : ''}`}
                type="button"
                data-skill-use={skill.id}
                onClick={() => onPick({ id: skill.id, title: skill.title, dir: skill.dir, files: skill.files })}
              >
                {activeId === skill.id ? <Check size={12} strokeWidth={2.4} aria-hidden /> : null}
                {activeId === skill.id ? '已挂在 Codex 上' : '在 Codex 中使用'}
              </button>
              <button
                className={`cv-skill-toggle${skill.optimize ? ' on' : ''}`}
                type="button"
                data-skill-opt={skill.id}
                aria-pressed={skill.optimize}
                disabled={busy === skill.id}
                title="打开后，这个技能会出现在节点「优化提示词」旁边的下拉里"
                onClick={() => void patch(skill, { optimize: !skill.optimize })}
              >
                {skill.optimize ? '已用于优化提示词' : '用于优化提示词'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );

  if (embedded) {
    return (
      <div className="cv-skill-inline" data-skill-lib="embedded">
        {tools}
        {catsBar}
        {body}
      </div>
    );
  }

  if (!open) return null;

  const modal = (
    <div className="cv-skill-mask" data-skill-mask="" onMouseDown={() => onClose?.()}>
      <div
        className="cv-skill"
        data-skill-lib=""
        onMouseDown={event => event.stopPropagation()}
        role="dialog"
        aria-label="SKILL 社区"
      >
        <div className="cv-skill-head">
          <strong>SKILL 社区</strong>
          <span className="cv-skill-sub">
            选一个技能，Codex 会照它的写法干活；也可以挂到「优化提示词」上
          </span>
          <div className="cv-spacer" />
          {data?.root ? <span className="cv-skill-path" title={data.root}>{data.root}</span> : null}
          <button className="cv-skill-x" type="button" data-skill-close="" aria-label="关闭" onClick={() => onClose?.()}>
            <X size={15} strokeWidth={2} aria-hidden />
          </button>
        </div>

        {tools}
        {catsBar}
        {/* 滚动只在这一层：头部标题与工具条要钉住，列表 / 卡片区自己滚（长列表也能看全）。 */}
        <div className="cv-skill-scroll">{body}</div>
      </div>
    </div>
  );

  /*
   * ⚠️ 挂到 `.flow-shell`，**不能挂 `document.body`**：那些 `--cv-*` 配色变量定义在
   * `.flow-shell` 上，挂到 body 会一个都取不到值 —— 弹层会变成一块没有底色的透明板
   * （2026-09-25 徐先报的「技能选择界面出 bug 了」就是这么来的）。
   * 但也不能留在原地：Codex 抽屉带 `will-change: transform`，那是 `position: fixed`
   * 的包含块，留在抽屉里这层「全屏遮罩」只会有抽屉那么大。
   * `.flow-shell` 自己没有 transform，是唯一两全的挂载点（同 WorkflowFieldPicker）。
   * SSR 时没有 document —— 桌面版用不到，但留着这个判断免得打包期报错。
   */
  if (typeof document === 'undefined') return null;
  const host = document.querySelector<HTMLElement>('.flow-shell') || document.body;
  return createPortal(modal, host);
}
