'use client';
import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowUp, Check, ChevronDown, Image as ImageIcon, ImagePlus, Loader2, SlidersHorizontal,
  Sparkles, Video, X,
} from 'lucide-react';
import '@/app/home.css';
import { GUEST_HINT, PROMPT_MAX, QUICK_CHIPS, QUICK_TARGETS } from '@/lib/start/quick';
import {
  COMPOSE_MODES, ENGINE_META, ENGINES_FOR, MAX_REFS, canvasHref, defaultEngine, defaultParams,
  durationOptions, isCanvasMode, paramSummary, ratioOptions, resolutionOptions,
  type CanvasMode, type ComposeEngine, type ComposeMode, type ComposeOption, type ComposeParams,
} from '@/lib/start/compose';

/** 两个去向各配一个图标。图标映射留在组件里 —— 数据文件不引 React 组件。 */
const MODE_ICON: Record<ComposeMode, typeof Sparkles> = {
  image: ImageIcon,
  video: Video,
};

/** 展开中的那一层。两层面板**互斥** —— 同时开着两张浮层，用户不知道该先看哪个。 */
type ComposePanel = 'mode' | 'params';

/**
 * 首页正中间那个大输入框 —— 「想到什么直接说」的那一步。
 *
 * 版式是「一张卡片，上面写字、下面一排工具」（2026-09-17 下午按参考图改版）：
 *   - **去向收进一颗下拉胶囊**（原来并排摆三颗按钮，占了整整一行）。点开是个带图标与说明的菜单：
 *     生成图片 / 生成视频，当前那颗打勾。选它是**纯选择**，不会把我送走 ——
 *     出发是右下角那颗独立的圆形键（Enter 同效）。选择和出发分开之后，
 *     「点一下只是换了个选项」这件事就再也不会让人困惑了。
 *   - **参数默认收起**（生成分类 / 选择比例 / 分辨率 / 时长都在「生成偏好」面板里）。
 *     没选过参数的人不该先看到一排他没在意的下拉；但胶囊上写着**当前那套参数的摘要**
 *     （`自适应 · 1K` / `16:9 横屏 · 720p · 5 秒`），收起来也不会「选完就忘」。
 *   - 三套参数值域按**引擎**整块换装（见 `lib/start/compose.ts`）—— 切换引擎时必须整组重置，
 *     因为 `<select>` 的 value 匹配不到任何 option 时是**静默跳到第一项**，
 *     用户看到的是「我选的明明没变」，而节点上存的已经是另一个值了。
 *   - **可以直接往这张输入框里贴图片**（2026-09-17 傍晚）：缩略图排在第 2 列的**上半部分**，
 *     也就是「文本框中间偏上」那一块 —— 图和这段描述是一起看的，不该掉到下面工具行旁边去。
 *
 * ⚠️ 主界面未登录也能看（`app/page.tsx` 用的是 `currentUser()`），所以这里必须自己判登录：
 * 没登录时出发键**统一先去 `/login`**，而不是让请求打出去吃一个 401。
 */
export default function ComposeBar({ signedIn = false }: { signedIn?: boolean }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<ComposeMode>('image');
  const [engine, setEngine] = useState<ComposeEngine>(defaultEngine('image'));
  const [params, setParams] = useState<ComposeParams>(defaultParams('image', defaultEngine('image')));
  const [files, setFiles] = useState<{ file: File; preview: string }[]>([]);
  const [open, setOpen] = useState<ComposePanel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const value = text.trim();
  const canvas = isCanvasMode(mode);

  /* 组件卸载时把 blob 地址还回去；引用保持最新，免得闭包里拿到的是第一帧那个空数组。 */
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => () => { filesRef.current.forEach(item => URL.revokeObjectURL(item.preview)); }, []);

  /**
   * 点空白处 / 按 Esc 收起浮层。
   *
   * ⚠️ 判据是「点在**这个组件**里没有」，不是「点在那颗胶囊上没有」——
   * 点面板里面的档位（比例、分辨率）不该顺手把面板关掉，那样每选一次都要重开一遍。
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** 未登录：这一下先去登录。草稿留在页面上没意义（跳走就没了），所以不做任何保留。 */
  const toLogin = () => router.push('/login');

  const togglePanel = (panel: ComposePanel) =>
    setOpen(current => (current === panel ? null : panel));

  /** 切去向：**只换去向**（并收起菜单），空输入时也点得动。切过去时重置成该模式的默认引擎与参数。 */
  function pickMode(next: ComposeMode) {
    setOpen(null);
    setMode(next);
    setError('');
    const nextEngine = defaultEngine(next);
    setEngine(nextEngine);
    setParams(defaultParams(next, nextEngine));
  }

  function pickEngine(next: ComposeEngine) {
    if (!isCanvasMode(mode)) return;
    setEngine(next);
    setParams(defaultParams(mode, next));
  }

  function setParam(key: 'ratio' | 'resolution' | 'duration', next: string) {
    setParams(current => ({ ...current, [key]: next }));
  }

  function addFiles(list: readonly File[] | FileList | null) {
    if (!list?.length) return;
    const room = MAX_REFS - files.length;
    if (room <= 0) { setError(`最多 ${MAX_REFS} 张参考图。`); return; }
    const accepted = Array.from(list)
      .filter(file => file.type.startsWith('image/'))
      .slice(0, room)
      .map(file => ({ file, preview: URL.createObjectURL(file) }));
    if (!accepted.length) { setError('参考图得是图片文件。'); return; }
    setFiles(current => [...current, ...accepted]);
    setError('');
  }

  function removeFile(preview: string) {
    URL.revokeObjectURL(preview);
    setFiles(current => current.filter(item => item.preview !== preview));
  }

  /**
   * 粘贴图片：剪贴板里的图直接收成参考图（参考图和那段描述往往是一起复制来的，
   * 让人再点一次「参考图」去硬盘里找同一张图纯属多余）。
   *
   * ⚠️ 只拦**带图片**的粘贴：不带图时必须原样 `return`，把事件交回浏览器的默认行为 ——
   *    否则在这张输入框里 Ctrl+V 一段文案会失效（连粘贴 succeeded 的提示都没有）。
 * ⚠️ 两个去向（出图 / 出视频）都带得走参考图 —— 2026-09-21 砍掉「和 AI 对话」之后，
 *    这里不再需要「顺手切去向」那一手。
   */
  function pasteFiles(event: ClipboardEvent<HTMLDivElement>) {
    const data = event.clipboardData;
    if (!data) return;
    /* 优先读 `files`（现代浏览器都有）；读不到再退回逐个 `items` 取 —— 老 Safari 只给后者。 */
    const picked: File[] = Array.from(data.files ?? []);
    if (!picked.length) {
      Array.from(data.items ?? []).forEach(item => {
        if (item.kind !== 'file') return;
        const file = item.getAsFile();
        if (file) picked.push(file);
      });
    }
    const images = picked.filter(file => file.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    addFiles(images);
  }

  async function openCanvas(target: CanvasMode) {
    if (!value || busy) return;
    if (!signedIn) { toLogin(); return; }
    setBusy(true); setError(''); setOpen(null);
    try {
      /*
       * 参考图与项目在**同一次请求**里落地：图存不下来时服务端会把刚建的项目一起撤掉，
       * 用户看到的就是「这次没发生」。分成两次请求的话，失败会留下一个有项目没图的空画布。
       */
      const form = new FormData();
      form.set('prompt', value);
      files.forEach(item => form.append('files', item.file));
      const response = await fetch('/api/projects/quick', { method: 'POST', body: form });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || '创建失败，请重试。');
      router.push(canvasHref(body.id, {
        prompt: value,
        mode: target,
        engine,
        ...params,
        refs: Array.isArray(body.refs) ? body.refs : [],
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败，请重试。');
      setBusy(false);
    }
  }

  /* 出发一律按**选中的去向**走：选择与出发是两颗不同的控件，这里不会有第二种解释。 */
  const go = () => void openCanvas(mode);

  /** 生成偏好里的第二、三组：档位由「模式 + 引擎」决定，出图没有时长（空数组 = 不出这一行）。 */
  const paramGroups: { key: 'ratio' | 'resolution' | 'duration'; label: string; options: ComposeOption[] }[] =
    isCanvasMode(mode) ? [
      { key: 'ratio' as const, label: '选择比例', options: ratioOptions(mode, engine) },
      { key: 'resolution' as const, label: '分辨率', options: resolutionOptions(mode, engine) },
      { key: 'duration' as const, label: '时长', options: durationOptions(mode) },
    ].filter(row => row.options.length > 0) : [];

  const ModeIcon = MODE_ICON[mode];

  /* 粘贴挂在**整张卡片**上而不是 textarea 上：事件从里层冒泡上来都能接住，
     焦点在工具行某一颗胶囊上时贴的图也一样收得到。 */
  return <div className="home-compose">
    <div className="home-compose-box" ref={boxRef} onPaste={pasteFiles}>
      <Sparkles size={16} className="home-compose-glyph" aria-hidden />
      {/* 第 2 列 = 参考图 + 写字区。图在上、字在下，图就落在这一列偏上的位置。 */}
      <div className="home-compose-field">
        {canvas && files.length > 0 && <div className="home-refs">
          {files.map(item => <span className="home-ref" key={item.preview}>
            {/* eslint-disable-next-line @next/next/no-img-element -- 本地 blob 预览，next/image 用不了 */}
            <img src={item.preview} alt="" />
            <button type="button" onClick={() => removeFile(item.preview)} aria-label="移除这张参考图">
              <X size={11} />
            </button>
          </span>)}
        </div>}

        <textarea
          ref={areaRef}
          className="home-compose-input"
          rows={4}
          maxLength={PROMPT_MAX}
          value={text}
          aria-label="想创作什么"
          placeholder="描述你想要的画面，或者想让模型帮你做的事…（可以直接粘贴图片；Enter 开始，Shift + Enter 换行）"
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); go(); }
          }}
        />
      </div>

      <div className="home-tools">
        {/* 参考图只在「会去画布」的去向出现 —— 现在两个去向都是，判断恒真，留着是给将来的非生成去向留口子。 */}
        {canvas && <button
          className="home-tool"
          type="button"
          onClick={() => fileRef.current?.click()}
          title={`参考图（最多 ${MAX_REFS} 张，可选，也可以直接粘贴）`}
        ><ImagePlus size={14} />参考图{files.length > 0 && <em>{files.length}</em>}</button>}

        <button
          className={`home-tool ${open === 'mode' ? 'on' : ''}`}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open === 'mode'}
          title={signedIn ? QUICK_TARGETS[mode].hint : GUEST_HINT}
          onClick={() => togglePanel('mode')}
        ><ModeIcon size={14} /><span className="home-tool-label">{QUICK_TARGETS[mode].label}</span>
          <ChevronDown size={13} className="home-tool-caret" /></button>

        {canvas && <button
          className={`home-tool ${open === 'params' ? 'on' : ''}`}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open === 'params'}
          title="生成偏好"
          onClick={() => togglePanel('params')}
        ><SlidersHorizontal size={14} />
          <span className="home-tool-label">{paramSummary(mode, engine, params)}</span></button>}

        <button
          className="home-send"
          type="button"
          disabled={busy || !value}
          aria-label="开始创作"
          title={signedIn ? QUICK_TARGETS[mode].hint : GUEST_HINT}
          onClick={go}
        >{busy ? <Loader2 size={16} className="asset-spin" /> : <ArrowUp size={16} />}</button>
      </div>

      {/* 去向菜单：两颗按钮收进来的那一份列表。选它是纯选择，出发在右边那颗圆键上。 */}
      {open === 'mode' && <div className="home-pop home-mode-menu" role="menu" aria-label="选择去向">
        {COMPOSE_MODES.map(item => {
          const Icon = MODE_ICON[item];
          const active = item === mode;
          return <button
            key={item}
            className={`home-mode-item ${active ? 'on' : ''}`}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            data-mode={item}
            onClick={() => pickMode(item)}
          >
            <span className="home-mode-icon"><Icon size={16} /></span>
            {/* 菜单里**只写名字**：那句说明只留在胶囊的 title 上（悬停能看到），
                常驻在每一项下面会变成两行灰字，菜单一眼看上去像一段文档而不是两个选项。 */}
            <strong className="home-mode-name">{QUICK_TARGETS[item].label}</strong>
            {active && <Check size={15} className="home-mode-check" />}
          </button>;
        })}
      </div>}

      {/* 生成偏好：参数默认就收在这里面，点那颗胶囊才展开。 */}
      {open === 'params' && canvas && <div className="home-pop home-prefs" role="dialog" aria-label="生成偏好">
        <div className="home-prefs-head">
          <strong>生成偏好</strong>
          <span className="muted">按当前去向可选的参数</span>
        </div>

        <label className="home-prefs-row">
          <span>生成分类</span>
          <select
            value={engine}
            onChange={event => pickEngine(event.target.value as ComposeEngine)}
            title={ENGINE_META[engine].hint}
          >
            {ENGINES_FOR[mode].map(item =>
              <option key={item} value={item}>{ENGINE_META[item].label}</option>)}
          </select>
        </label>

        {paramGroups.map(group => <div className="home-prefs-row" key={group.key}>
          <span>{group.label}</span>
          <div className="home-opts">
            {group.options.map(item => <button
              key={item.value}
              className={`home-opt ${params[group.key] === item.value ? 'on' : ''}`}
              type="button"
              aria-pressed={params[group.key] === item.value}
              onClick={() => setParam(group.key, item.value)}
            >{item.label}</button>)}
          </div>
        </div>)}
      </div>}
    </div>

    {/* 选图入口藏在外面：它是隐藏的原生 input，触发点是上面那颗「参考图」。 */}
    <input
      ref={fileRef}
      className="home-ref-input"
      type="file"
      accept="image/*"
      multiple
      onChange={event => { addFiles(event.target.files); event.target.value = ''; }}
    />

    {error && <p className="home-compose-error" role="alert">{error}</p>}
    {/* 未登录：先说清楚这一下会去哪儿，别让用户以为按钮坏了。 */}
    {!signedIn && <p className="home-compose-guest">{GUEST_HINT}</p>}

    <div className="home-chips">
      <span className="muted">不知道写什么，试试：</span>
      {QUICK_CHIPS.map(chip => <button
        key={chip.id}
        className="home-chip"
        type="button"
        onClick={() => { pickMode(chip.mode); setText(chip.text); areaRef.current?.focus(); }}
      >{chip.label}</button>)}
    </div>
  </div>;
}
