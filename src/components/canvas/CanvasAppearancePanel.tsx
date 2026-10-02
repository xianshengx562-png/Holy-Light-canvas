'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Info, Palette, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import { useAppearance } from '@/components/theme/ThemeProvider';
import {
  CANVAS_BG_PRESETS, isHexColor, NODE_ACCENT_PRESETS, NODE_BG_PRESETS, NODE_LINE_PRESETS,
  normalizeHex, UI_SCALE, WALLPAPER_LIMITS,
} from '@/lib/appearance';
import { canSetWallpaper } from '@/lib/wallpaper';
import { CANVAS_THEME_MODES } from '@/lib/themeModes';

/**
 * 画布外观面板（右下角那个圆形按钮点开的东西）。
 *
 * 为什么要在画布上再放一份「主题 + 背景」：改画布背景是**看着画布调**的动作 ——
 * 让用户跳去设置页、调完再跳回来，每次都要重新找视角，等于没法调。
 * 设置页那份仍然保留（两处共用同一份偏好，见 `ThemeProvider`）。
 *
 * 面板本身不用 portal：它挂在 `.flow-shell` 里、用 fixed 定位，
 * 而 `.flow-shell` 没有 transform（这一条很关键 —— 带 transform 的祖先会让 fixed 失效）。
 *
 * 2026-09-22 改成「预设优先」：主题两档、背景两档都做成并排的预设按钮，
 * 点一下直接换（原先就是分段控件，这里只是把它做成一排更宽的卡）。
 *
 * 2026-09-22 第三次：**自定义是单独一档**，排在「夜间 / 日间」后面第三张卡。
 * 模型（徐先定的）：日间 / 夜间是两档**固定预设**（本身也是被保存下来的配置），
 * 自定义是**另一个选项** —— 四支颜色各自一个字段，非 null 才算启用，
 * 而且**换主题冲不掉它**（CSS 里 `--cv-node-bg` 读的是 `--cv-node-bg-custom, <主题那一档>`，
 * 换主题只是换那个 fallback）。所以「夜间 + 米白卡片」这种组合是留得住的。
 * 这也是为什么每张色块行右边都有一颗「跟随主题」：那是"把这支退回预设"的唯一开关。
 *
 * 2026-09-23 第五次（徐先："有点乱，优化一下布局，我要平面效果"）：**排版与视觉重做**。
 * 乱在三处：① 五张预设卡全挤在同一列里（主题三张 + 背景两张，长得一模一样，读不出分组）；
 * ② 四支颜色每支两行、各自一块背景，摞起来八行；③ 上传 / 移除 / 滑杆也塞在同一列，列宽被顶炸。
 * 改法：
 *   · 面板加宽到 320px，左栏收窄到 96px —— 左栏只留**五张竖排预设卡**（小样在上、名字在下），
 *     右栏放自定义四支颜色，背景图那一摊搬到两栏下面独占整行；
 *   · 一支颜色 = 两行：第一行名字 + 「跟随主题」（只在这一支被钉住时出现），第二行七个色块一次排开；
 *   · 长解释搬进「i」气泡（`Tip`）、保存提示搬进悬停（title），正文之内不留说明书。
 * 平面效果落在 CSS 那边（去毛玻璃、收阴影、hover 只换描边不位移），组件只负责结构：
 *   · 左右分栏（`cv-ap-grid` / `cv-ap-side` / `cv-ap-main`）
 *   · 「i」气泡（`Tip`）
 *   · 每支颜色一行 `DotRow`（`data-ap-item`），带 `data-ap-follow` 退回预设
 */
export default function CanvasAppearancePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    appearance, resolved, themeMode, setThemeMode,
    setCanvasBg, setNodeBg, setNodeLine, setNodeAccent,
    setWallpaper, uploadWallpaper, clearWallpaper, setUiScale, reset,
  } = useAppearance();
  const boxRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  /**
   * 「自定义」那张卡的开合。
   *
   * `null` = 用户还没动过 —— 那就按"有没有自定义色"自动决定（已经钉过几支的
   * 进来就该看见自己那几支，而不是先去找「自定义」两个字）。
   * 一旦点过就以用户那次为准 —— 否则"有自定义值"会把面板永久粘在展开态，
   * 用户再也收不回去（设置页那张卡踩过同一条，见 AppearanceForm 的 `customTouchedByUser`）。
   */
  const [customPick, setCustomPick] = useState<boolean | null>(null);

  useEffect(() => {
    document.addEventListener('mousedown', outside);
    function outside(event: MouseEvent) {
      if (!open) return;
      /* 右下角那个开面板的圆钮不算「点在外面」：它的 mousedown 先到这儿、
         click 再翻一次 state，两边都处理就会一开一关、按了跟没按一样。 */
      if (event.target instanceof Element && event.target.closest('[data-ap-toggle]')) return;
      if (event.target instanceof Node && !boxRef.current?.contains(event.target)) onClose();
    }
    return () => document.removeEventListener('mousedown', outside);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        const t = event.target as HTMLElement | null;
        /* 同上：输入框里的 Esc 归输入框，别顺手把面板关了。 */
        if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
        event.stopPropagation();
        onClose();
      }
    }
    /* 捕获阶段接：画布的快捷键监听在冒泡阶段，先在这里把 Escape 吃掉，
       否则关面板的同时还会顺手清掉选中节点。 */
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open || !appearance) return null;
  const wall = appearance.wallpaper;

  const canvasCustom = !!appearance.canvasBg || !!appearance.nodeBg
    || !!appearance.nodeLine || !!appearance.nodeAccent;
  const customCount = [appearance.canvasBg, appearance.nodeBg, appearance.nodeLine, appearance.nodeAccent]
    .filter(Boolean).length;
  const custom = customPick === null ? canvasCustom : customPick;
  const toggleCustom = () => setCustomPick(!custom);

  /** 悬浮说明的内容（原来直接摊在面板里那三行）。 */
  const TIP = '日间 / 夜间是固定预设，选了就存下来。自定义是单独一档：挑过的颜色换主题也不会被冲掉，点每行的「跟随主题」才退回预设。';

  /* 「还没自定义」时取色器 / 小样显示成当前那一档实际在用的色。
     ⚠️ 这四个必须和 canvas.css 里日间 / 夜间那两份令牌对齐（见 appearance.ts 那几个
        PRESET 上的注释）：地板 --cv-bg → --app-bg、卡片 --cv-node-bg → --app-surface、
        强调 --cv-node-accent → --app-accent。
        差一个色阶的表现是"点开取色器的一瞬间颜色跳了"，看着像 bug。 */
  const light = resolved === 'light';
  const floorNow = appearance.canvasBg ?? (light ? '#ffffff' : '#000000');
  const nodeNow = appearance.nodeBg ?? (light ? '#ffffff' : '#141414');
  const accentNow = appearance.nodeAccent ?? (light ? '#111111' : '#f2f2f2');

  async function pick() {
    setBusy(true);
    setNotice('');
    const result = await uploadWallpaper();
    setBusy(false);
    setNotice(result.ok ? '背景图已保存到本机。' : result.message || '没有设置成功。');
  }

  async function drop() {
    setBusy(true);
    const result = await clearWallpaper();
    setBusy(false);
    setNotice(result.ok ? '已移除背景图。' : result.message || '移除失败。');
  }

  /** 只把「自定义」那四支退回预设 —— 主题档位、背景图都不动。 */
  function unscrew() {
    setCanvasBg(null);
    setNodeBg(null);
    setNodeLine(null);
    setNodeAccent(null);
    setNotice('自定义已清空，现在跟日间 / 夜间走。');
  }

  return (
    <div className="cv-appearance" ref={boxRef} role="dialog" aria-label="画布外观">
      <div className="cv-ap-head">
        <strong>画布外观</strong>
        <Tip text={TIP} />
        <button className="cv-ap-x" type="button" onClick={onClose} aria-label="关闭">
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>

      {/* 滚动层：面板内容超过 max-height 时由这一层滚。
          ⚠️ 不能直接给 `.cv-appearance` 加 `overflow-y` —— 面板里的 `.cv-ap-tip`
          气泡是绝对定位、要浮到面板外面去的，面板一旦成为滚动容器就会顺手
          成为裁剪容器，气泡在边缘会被切半截。多包一层之后滚动只发生在这里。
          标题那一行留在层外，滚的时候一直看得见。 */}
      <div className="cv-ap-scroll" data-ap-scroll>
      <div className="cv-ap-grid">
        <div className="cv-ap-side">
          {/* 一组一行（标签在上、卡串在下、卡串通宽）。截图里五张卡各占一行、
              右半列空着、"纯色"比"图片"凸出来一截 —— 那正是"两列 + 卡宽跟着
              小样内容走"的结果。 */}
          <div className="cv-ap-group" role="radiogroup" aria-label="界面主题">
            <span className="cv-ap-label">主题</span>
            <div className="cv-ap-presets">
            {CANVAS_THEME_MODES.map(mode => {
              const active = themeMode === mode.value;
              return (
                <button
                  key={mode.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-ap-theme={mode.value}
                  className={`cv-ap-preset${active ? ' on' : ''}`}
                  title={mode.hint}
                  onClick={() => setThemeMode(mode.value)}
                >
                  <span className={`cv-ap-mini ${mode.value}`} aria-hidden>
                    <span className="cv-ap-mini-bar" />
                    <span className="cv-ap-mini-body" />
                  </span>
                  <span className="cv-ap-preset-text">
                    <strong>{mode.label}</strong>
                    <em>{mode.hint}</em>
                  </span>
                  {active && <Check className="cv-ap-check" size={13} strokeWidth={2.6} aria-hidden />}
                </button>
              );
            })}

            {/* 第三张卡不是第三档主题，是**另一个选项**：右栏那四支自定义色的开关。
                长相刻意和前两张一样 —— 用户在这一排里找的正是「除了日/夜还有别的吗」。
                ⚠️ 不用 data-ap-theme：那两张是二选一，探针也按"恰好两张"验的。 */}
            <button
              type="button"
              className={`cv-ap-preset${custom ? ' on' : ''}`}
              data-ap-custom
              aria-expanded={custom}
              title="自定义是单独一档：四支颜色各自一个值，换主题也不会被冲掉"
              onClick={toggleCustom}
            >
              <span className="cv-ap-mini custom" aria-hidden>
                <span className="cv-ap-mini-bar" />
                <span
                  className="cv-ap-mini-body"
                  style={{ background: floorNow }}
                />
                <span className="cv-ap-mini-card" style={{ background: nodeNow, borderColor: accentNow }} />
              </span>
              <span className="cv-ap-preset-text">
                <strong>自定义</strong>
                <em>{customCount ? `已钉住 ${customCount} 支` : '固定颜色'}</em>
              </span>
              {custom && <Check className="cv-ap-check" size={13} strokeWidth={2.6} aria-hidden />}
            </button>
            </div>
          </div>

          <div className="cv-ap-group">
            <span className="cv-ap-label">背景</span>
            <div className="cv-ap-presets">
              <button
                type="button"
                data-ap-bg-mode="plain"
                className={`cv-ap-preset${!wall.enabled ? ' on' : ''}`}
                aria-pressed={!wall.enabled}
                onClick={() => setWallpaper({ enabled: false })}
              >
                <span className="cv-ap-mini plain" aria-hidden><span className="cv-ap-mini-body" /></span>
                <span className="cv-ap-preset-text">
                  <strong>纯色</strong>
                  <em>只用底色</em>
                </span>
                {!wall.enabled && <Check className="cv-ap-check" size={13} strokeWidth={2.6} aria-hidden />}
              </button>
              <button
                type="button"
                data-ap-bg-mode="image"
                className={`cv-ap-preset${wall.enabled ? ' on' : ''}`}
                aria-pressed={wall.enabled}
                disabled={!wall.name}
                title={wall.name ? undefined : '先上传一张图片'}
                onClick={() => setWallpaper({ enabled: true })}
              >
                <span className="cv-ap-mini image" aria-hidden><span className="cv-ap-mini-body" /></span>
                <span className="cv-ap-preset-text">
                  <strong>图片</strong>
                  <em>{wall.name ? '已上传' : '先上传一张'}</em>
                </span>
                {wall.enabled && <Check className="cv-ap-check" size={13} strokeWidth={2.6} aria-hidden />}
              </button>
            </div>
          </div>

        </div>{/* /cv-ap-side */}

        {/* 右栏那一列：颜色 / 背景图 / 底栏。
            截图里这三块横跨整个面板、而左栏一个人摞了五张卡比它们高出一倍 ——
            右栏底下于是拖着一整片空白（截图里最大那处空）。
            搬进右栏之后，左右两栏的底边终于对得齐。 */}
        <div className="cv-ap-col-main">
        {/* 界面大小（2026-10-02 徐先："可以设置改变这些选项卡的大小，在外观中设置"）。
            一整根滑杆就是全部内容 —— 说明进 title，正文里不留字。
            放在右栏第一组：它是这一屏里唯一一个"改了立刻全站都动"的东西，
            比起挑颜色那类细活，找它的人更多。
            ⚠️ `step={1}` 是"无级"：他要的是能拖到任意一格，不是三档跳。
               代价是拖回准确的 100 有点费劲 —— 所以数值旁边那颗「回到标准」只在
               偏离 100 时才出现（和「跟随主题」同一个规矩：默认态不必天天念）。 */}
        <div className="cv-ap-group">
          <span className="cv-ap-label">界面大小</span>
          <div className="cv-ap-main">
            <label
              className="cv-ap-slider"
              data-ap-ui-scale
              title="整个软件的按钮、输入框、顶栏跟着一起变大变小"
            >
              <span>
                <output data-ap-ui-scale-out>{appearance.uiScale}%</output>
                {appearance.uiScale !== UI_SCALE.default && (
                  <button
                    type="button"
                    className="cv-ap-follow"
                    data-ap-ui-scale-reset
                    aria-label="界面大小回到标准"
                    onClick={() => setUiScale(UI_SCALE.default)}
                  >
                    回到标准
                  </button>
                )}
              </span>
              <input
                type="range"
                min={UI_SCALE.min}
                max={UI_SCALE.max}
                step={1}
                value={appearance.uiScale}
                aria-label="界面大小"
                data-ap-ui-scale-range
                onChange={event => setUiScale(Number(event.target.value))}
              />
            </label>
          </div>
        </div>{/* /cv-ap-group 界面大小 */}

        {/* 颜色那一组：跟左栏两组同一个样子（标签在上、一行控件在下），
            所以「主题 / 背景 / 颜色 / 背景图」四个标签的左边缘是同一条线。
            「跟随主题」时下面必须还是**一条横线**（一行灰字），不能塌成一段正文 ——
            截图里它把这块撑成了一整片空白。 */}
        <div className="cv-ap-group">
          <span className="cv-ap-label">颜色</span>
          <div className="cv-ap-main">
          {!custom ? (
            <p className="cv-ap-hint" data-ap-custom-hint>
              地板与卡片跟着日间 / 夜间走。要钉住某个色，点左边「自定义」。
            </p>
          ) : (
            <div className="cv-ap-sect" data-ap-custom-panel>
              <DotRow
                label="地板" attr="bg" initial={floorNow}
                presets={CANVAS_BG_PRESETS}
                value={appearance.canvasBg}
                onPick={setCanvasBg}
              />
              <DotRow
                label="卡片底色" attr="node-bg" initial={nodeNow}
                presets={NODE_BG_PRESETS}
                value={appearance.nodeBg}
                onPick={setNodeBg}
              />
              <DotRow
                label="卡片描边" attr="node-line" initial={light ? '#c8cdd2' : '#2f333a'}
                presets={NODE_LINE_PRESETS}
                value={appearance.nodeLine}
                onPick={setNodeLine}
              />
              <DotRow
                label="强调色" attr="node-accent" initial={accentNow}
                presets={NODE_ACCENT_PRESETS}
                value={appearance.nodeAccent}
                onPick={setNodeAccent}
              />
              {/* 一键退回预设 —— 各行的「跟随主题」是单支的，这颗是四支一起。 */}
              <button
                className="cv-btn ghost sm"
                type="button"
                data-ap-custom-reset
                disabled={!canvasCustom}
                onClick={unscrew}
              >
                <RotateCcw size={13} strokeWidth={2} aria-hidden /> 全部跟随主题
              </button>
            </div>
          )}
          </div>
          </div>{/* /cv-ap-group 颜色 */}

        {/* 背景图那一摊：它是"传个文件"这种一次性动作，跟上面"选这一档"的预设卡
            不是一类东西，但都归右栏（右栏比左栏矮，正好补平两栏的底边）。 */}
        <div className="cv-ap-group">
          <span className="cv-ap-label">背景图</span>
          {/* 分成两行而不是一行五件套：上传 / 移除 / 状态是"选文件"那一刻的事，
              滑杆是"有了图之后调"。原来挤在一行里，一折行就变成
              "上传 / 移除 / 仅桌面版 / 滑杆 / 滑杆"这样的乱序。 */}
          <div className="cv-ap-line">
            <button
              className="cv-btn sm"
              type="button"
              data-ap-upload
              disabled={busy || !canSetWallpaper()}
              onClick={() => void pick()}
            >
              <Upload size={13} strokeWidth={2} aria-hidden /> {busy ? '处理中…' : wall.name ? '换一张' : '上传图片'}
            </button>
            {wall.name && (
              <button className="cv-btn ghost sm" type="button" disabled={busy} onClick={() => void drop()}>
                <Trash2 size={13} strokeWidth={2} aria-hidden /> 移除
              </button>
            )}
            {wall.name && wall.enabled && <span className="cv-ap-hint">当前在用这张</span>}
            {!canSetWallpaper() && <span className="cv-ap-hint">只有桌面版支持</span>}
          </div>

        {/* 淡化 / 模糊只在"图片 + 已启用"时才有意义 —— 没图就压根别占地方。 */}
        {wall.name && wall.enabled && (
          <div className="cv-ap-sliders">
            {([
              ['fade', '淡化', 95, '%'],
              ['blur', '模糊', 12, 'px'],
            ] as const).map(([key, label, max, unit]) => (
              <label className="cv-ap-slider" key={key} title={key === 'fade' ? '越淡化越透，底下底色越主导' : '柔化，让画面不抢节点'}>
                <span>
                  {label}
                  <output>{wall[key]}{unit}</output>
                </span>
                <input
                  type="range"
                  min={0}
                  max={max}
                  step={1}
                  value={wall[key]}
                  onChange={event => setWallpaper({ [key]: Number(event.target.value) } as never)}
                />
              </label>
            ))}
          </div>
        )}
        </div>

        {/* 底栏：「恢复默认 + 状态」一行、「关闭」一行，都贴着右栏左端起排。
            截图里那两颗被 `space-between` 拉到面板两端、中间一整行空档，
            看着不像一组；而面板连一个"关"的入口都没有（触屏上等于困住）。 */}
        <div className="cv-ap-line">
          <button
            className="cv-btn ghost sm cv-ap-foot-btn"
            type="button"
            onClick={() => { reset(); setNotice('已恢复默认（图片保留，可再次启用）'); }}
          >
            <RotateCcw size={13} strokeWidth={2} aria-hidden /> 恢复默认
          </button>
          <span className="cv-ap-hint cv-ap-status" role="status">{notice || '自动保存'}</span>
        </div>
        <div className="cv-ap-line">
          <button className="cv-btn ghost sm cv-ap-foot-btn" type="button" onClick={onClose}>
            <X size={13} strokeWidth={2} aria-hidden /> 关闭
          </button>
        </div>{/* /cv-ap-line 关闭 */}
        </div>{/* /cv-ap-col-main */}
      </div>{/* /cv-ap-grid */}
      </div>{/* /cv-ap-scroll */}
    </div>
  );
}

/** 标着「i」的说明气泡：点开才显示，点面板别处就收（说明只在第一次看时有用）。 */
function Tip({ text }: { text: string }) {
  const [on, setOn] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!on) return;
    function away(event: MouseEvent) {
      if (event.target instanceof Node && !box.current?.contains(event.target)) setOn(false);
    }
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [on]);
  return <span className="cv-ap-tip" ref={box}>
    <button type="button" data-ap-tip aria-expanded={on} aria-label="说明" onClick={() => setOn(!on)}>
      <Info size={11} strokeWidth={2} aria-hidden />
    </button>
    {on && <span className="cv-ap-tipbody" role="note">{text}</span>}
  </span>;
}

/**
 * 一支颜色 = **两行**：第一行是名字（左）+ 「跟随主题」（右，仅被钉住时），第二行是色块串。
 *
 * 上一版是"名字 + 状态一行、下一行色块"，四支摞起来八行；本版把名字和动作并到一行、
 * 色块串独占整行（不会再折成两三段）。
 * 色块数**一个没砍**（四支各 6 个预设 + 取色器）—— 那是挑色的主要入口，
 * 砍了每次都得开取色器。窄的是行高，不是宽度。
 *
 * ⚠️ `initial` 是"还没自定义时取色器该显示哪个色"：必须是当前主题那一档实际在用的值，
 *    否则用户点开看见的是别的颜色，随手一拉就以为自己改坏了。
 */
function DotRow({ label, attr, presets, initial, value, onPick }: {
  label: string;
  attr: string;
  presets: { value: string; label: string }[];
  initial: string;
  value: string | null;
  onPick: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? initial);
  useEffect(() => { if (value) setDraft(value); }, [value]);
  /* 一支颜色 = **一行**：名字 + 「跟随主题」（右）+ 色块串，三者同一条横线。
     上一版是"名字一行、色块串一行（拉满整列）"，四支摞起来像"一层名字一层色块"
     交替的八段 —— 截图里色块行的起点还比名字靠左，看着就是歪的。
     ⚠️ 前提是右栏得有 268px：最挤的地板那支 = 名字 42 + 间隔 8 + 9 块 212 = 262。
        面板宽度（`--cv-ap-w`）一收窄，这里就会折行 —— 改宽度前先回来算这笔账。
     ⚠️ `.cv-ap-item-body` 这个类名是 `_shot-nodecolor.js` 5-11 的锚点，别改名。 */
  return <div className={`cv-ap-item${value ? ' on' : ''}`} data-ap-item={attr}>
    <span className="cv-ap-item-name">{label}</span>
    {/* 只在被钉住时才出现 —— 常态下整行是干净的（"跟随主题"是默认态，不必天天念）。
        aria-label 带上支名：探针和读屏都靠它认这是哪一支的按钮。 */}
    {value !== null && (
      <button
        type="button"
        className="cv-ap-follow"
        data-ap-follow={attr}
        aria-label={`${label}跟随主题`}
        title={`把「${label}」退回日间 / 夜间那一档`}
        onClick={() => onPick(null)}
      >
        跟随主题
      </button>
    )}
    <div className="cv-ap-item-body">
      {presets.map(preset => {
        const active = value === preset.value;
        const probe = { ['data-ap-dot-' + attr]: preset.value } as Record<string, string>;
        return <button
          key={preset.value}
          type="button"
          className={`cv-ap-dot${active ? ' on' : ''}`}
          aria-pressed={active}
          {...probe}
          title={`${preset.label} ${preset.value}`}
          style={{ background: preset.value }}
          onClick={() => onPick(preset.value)}
        >
          {active && <Check size={11} strokeWidth={3} aria-hidden />}
        </button>;
      })}
      <label className="cv-ap-custom" title="自定义颜色">
        <input
          type="color"
          aria-label={`自定义${label}`}
          data-ap-color={attr}
          value={isHexColor(draft) ? normalizeHex(draft) : initial}
          onChange={event => {
            setDraft(event.target.value);
            onPick(normalizeHex(event.target.value));
          }}
        />
        <Palette size={12} strokeWidth={2} aria-hidden />
      </label>
    </div>
  </div>;
}
