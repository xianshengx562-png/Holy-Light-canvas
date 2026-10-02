'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, MonitorSmartphone, Moon, RotateCcw, Sun, Trash2, Upload } from 'lucide-react';
import { useAppearance } from '@/components/theme/ThemeProvider';
import {
  isHexColor, isLightColor, NODE_ACCENT_PRESETS, NODE_BG_PRESETS,
  NODE_LINE_PRESETS, normalizeHex, PALETTE_OPTIONS,
  SITE_ACCENT_PRESETS, SITE_BG_PRESETS, THEME_OPTIONS, UI_SCALE,
  type ThemeMode,
} from '@/lib/appearance';
import { canSetWallpaper } from '@/lib/wallpaper';

const THEME_ICON: Record<ThemeMode, typeof Moon> = {
  dark: Moon,
  light: Sun,
  system: MonitorSmartphone,
};

/**
 * 「外观设计」= 两套作用域：**主界面**和**画布**。
 *
 * 组织方式（2026-09-22 徐先要求）：每一层都给**一套统一的预设**，选预设或自己挑；
 * 每一支颜色都长成同一个样子 —— 一排预设色块 + 一个「自定义」开关，
 * 点开自定义才露出色轮和色值框。
 *
 * 「主题模式」那一排（2026-09-22 第二次改）：三张预设卡后面多一张**「自定义」卡** ——
 * 主题配色、底色、强调色、背景图这些细活全都收在它后面，点了才露出来。
 * 为什么：这三张卡是"日常在做的事"（换深浅），后面那几支颜色是"偶尔的细调"，
 * 平铺在一起会让每天只点一次的东西淹在十几支色号里。
 * ⚠️ 但**用户已经改过的那些仍然默认展开**（`autoOpen`）—— 否则他调完回来
 * 只剩下一张「自定义」卡，会以为设置丢了、跑去重挑一遍。
 */

/** 每支颜色的预设 + 默认值。`attr` 是探针用的 data-* 前缀。 */
type Slot = {
  /** 段标题，例如「底色」 */
  label: string;
  /** 右侧状态文案里的「跟随」对象，例如「跟随主题」 */
  follow: string;
  presets: { label: string; value: string }[];
  /** 取色器在「还没自定义」时显示的初始色 */
  fallback: string;
  /** 预设色块的选中判定用值（null = 跟随） */
  value: string | null;
  onPick: (next: string | null) => void;
  /** 探针钩子前缀，例如 site-bg → data-site-bg-option */
  attr: string;
  /** 这一支留空时的语义注释（可省） */
  note?: string;
};

export default function AppearanceForm() {
  const {
    appearance, themeMode, setTheme, setPalette, setCanvasBg,
    setNodeBg, setNodeLine, setNodeAccent,
    setSiteBg, setSiteAccent, setSiteWallpaper, uploadSiteWallpaper, clearSiteWallpaper,
    setUiScale, reset,
  } = useAppearance();
  const [wallBusy, setWallBusy] = useState(false);
  const [wallNotice, setWallNotice] = useState('');
  /**
   * 「自定义」那张卡是展开还是收起。
   *
   * 默认值算在**首次拿到偏好那一刻**（`null` = 还没算）：已经改过任何一支颜色的用户
   * 进来就该看到自己那几支，而不是先去点一下「自定义」。
   *
   * ⚠️ 这里必须有一个「用户亲手点过」的标记（`touched`）。
   *    光靠 `customOpen === null` 判"还没算过"是不够的：用户点一下把 `customOpen`
   *    设成 `true` 之后，偏好只要**变一次**（挑个颜色、换个背景图都算）这个 effect
   *    就会重跑，而 `customTouched()` 此时已经为真 —— 于是"展开"这件事被**粘住**，
   *    用户再也收不回去（一收就被顶回来）。
   *    2026-09-22 实测：`pref.siteBg` 已经是自定义值的情况下点收起，面板纹丝不动。
   */
  const [customOpen, setCustomOpen] = useState<boolean | null>(null);
  const customTouchedByUser = useRef(false);
  useEffect(() => {
    if (customTouchedByUser.current) return;
    if (customOpen === null && appearance) setCustomOpen(customTouched(appearance));
  }, [appearance, customOpen]);
  const toggleCustom = () => {
    customTouchedByUser.current = true;
    setCustomOpen(prev => !(prev === true));
  };


  async function pickSite() {
    setWallBusy(true);
    setWallNotice('');
    const result = await uploadSiteWallpaper();
    setWallBusy(false);
    setWallNotice(result.ok ? '背景图已保存到本机。' : result.message || '没有设置成功。');
  }

  async function dropSite() {
    setWallBusy(true);
    const result = await clearSiteWallpaper();
    setWallBusy(false);
    setWallNotice(result.ok ? '已移除背景图。' : result.message || '移除失败。');
  }

  // 首帧：ThemeProvider 用 useLayoutEffect 在绘制前就填好，这里只是注水匹配用的占位
  if (!appearance) return <div className="appearance-card appearance-loading" aria-hidden />;

  /* 夜间 / 日间下「还没自定义」时的取色器初始值。
     ⚠️ 用 `themeMode` 而不是 `resolved`：选「跟随系统」时 resolved 会跟着系统走，
     外面那张卡上的勾也会跟着跳档 —— 用户点的是「跟随系统」，勾却跑到「夜间」上。
     只有 `resolved` 真的不在 `themeMode` 里（即 system）时才退回实际生效那一档兜底。 */
  const themeIsLight = themeMode === 'light' || (themeMode === 'system' && document.documentElement.dataset.theme === 'light');
  const SITE_BG_DEFAULT = themeIsLight ? '#ffffff' : '#0a0a0a';
  const SITE_ACCENT_DEFAULT = themeIsLight ? '#111111' : '#f2f2f2';
  /*
   * 下面这四个是「还没自定义时，取色器该从哪个色开挑」。必须和 canvas.css 里
   * 日间 / 夜间那两份对齐（地板 --cv-bg → --app-bg、卡片 --cv-node-bg → --app-surface、
   * 强调 --cv-node-accent → --app-accent）—— 否则用户点开取色器看到的初始色，
   * 和旁边画面上正在用的不是同一个，随手一拉就会以为自己改坏了。
   */
  const CANVAS_BG_DEFAULT = themeIsLight ? '#ffffff' : '#000000';
  const NODE_BG_DEFAULT = themeIsLight ? '#ffffff' : '#141414';
  const NODE_LINE_DEFAULT = themeIsLight ? '#b8b8b8' : '#2f333a';
  const NODE_ACCENT_DEFAULT = themeIsLight ? '#111111' : '#f2f2f2';

  /** 这套作用域里有没有动过（动过就把「自定义」那张卡默认展开）。 */
  function customTouched(a: typeof appearance): boolean {
    return !!a && (!!a.siteBg || !!a.siteAccent
      || !!a.canvasBg || !!a.nodeBg || !!a.nodeLine || !!a.nodeAccent
      || !!a.siteWallpaper.name);
  }

  /* ---------- 主界面 ---------- */
  const siteSlots: Slot[] = [
    {
      label: '底色', follow: '跟随主题', attr: 'site-bg',
      presets: SITE_BG_PRESETS, fallback: SITE_BG_DEFAULT,
      value: appearance.siteBg, onPick: setSiteBg,
      note: '面板、描边、正文都按它派生，不用挨个调。',
    },
    {
      label: '强调色', follow: '跟随配色', attr: 'site-accent',
      presets: SITE_ACCENT_PRESETS, fallback: SITE_ACCENT_DEFAULT,
      value: appearance.siteAccent, onPick: setSiteAccent,
      note: '按钮、页签、选中态那一支，优先于上面的配色。',
    },
  ];

  /* ---------- 画布 ---------- */
  /*
   * 只有**节点卡片**这三支。「地面」为什么要从中删掉：它和上面「画布底色」那段
   * 指路的话互相打架 —— 那段明说「去画布右下角那个面板里调」，紧接着又摆一排
   * 同样的色块，用户不知道该看哪一个。一个东西一个入口：
   * 底色（连同背景图 / 淡化 / 模糊）在画布面板里，这里只管节点。
   */
  const canvasSlots: Slot[] = [
    {
      label: '卡片底色', follow: '跟随主题', attr: 'node-bg',
      presets: NODE_BG_PRESETS, fallback: NODE_BG_DEFAULT,
      value: appearance.nodeBg, onPick: setNodeBg,
      note: '留空＝日间白卡片、夜间深卡片。挑了就把这一支钉住，切主题也不再动它。',
    },
    {
      label: '卡片描边', follow: '跟随主题', attr: 'node-line',
      presets: NODE_LINE_PRESETS, fallback: NODE_LINE_DEFAULT,
      value: appearance.nodeLine, onPick: setNodeLine,
    },
    {
      label: '强调色', follow: '跟随主题', attr: 'node-accent',
      presets: NODE_ACCENT_PRESETS, fallback: NODE_ACCENT_DEFAULT,
      value: appearance.nodeAccent, onPick: setNodeAccent,
      note: '选中态与卡片里的强调元素。卡片内的文字与次级面板由底色自动派生。',
    },
  ];

  const siteCustom = !!appearance.siteBg || !!appearance.siteAccent;
  const canvasCustom = !!appearance.canvasBg || !!appearance.nodeBg
    || !!appearance.nodeLine || !!appearance.nodeAccent;
  const custom = customOpen === true;

  return <div className="appearance-stack">
    {/* ============ 主界面 ============ */}
    <section className="appearance-card appearance-scope" data-scope="site">
      <div className="appearance-head">
        <div>
          <h2>主界面</h2>
        </div>
      </div>

      <div className="appearance-sub">
        <div className="appearance-sub-head">
          <span className="appearance-sub-label">主题模式</span>
        </div>
        <div className="theme-grid" role="radiogroup" aria-label="主题模式">
          {THEME_OPTIONS.map(option => {
            const Icon = THEME_ICON[option.value];
            const active = themeMode === option.value;
            return <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              className={`theme-option${active ? ' active' : ''}`}
              onClick={() => setTheme(option.value)}
            >
              <span className={`theme-swatch ${option.value}`} aria-hidden>
                <span className="theme-swatch-bar" />
                <span className="theme-swatch-body" />
              </span>
              <span className="theme-option-text">
                <strong><Icon size={14} strokeWidth={1.9} aria-hidden /> {option.label}</strong>
                <em>{option.hint}</em>
              </span>
              {active && <Check className="theme-check" size={15} strokeWidth={2.4} aria-hidden />}
            </button>;
          })}

          {/* 第四张卡：不是第四个主题档，而是「下面那些细活」的开关。
              长相刻意和前三张一样 —— 用户在这一排里找的正是「还有别的吗」。 */}
          <button
            type="button"
            className={`theme-option theme-option-custom${custom ? ' active' : ''}`}
            data-custom-mode
            aria-expanded={custom}
            onClick={toggleCustom}
          >
            <span className="theme-swatch custom" aria-hidden>
              <span className="theme-swatch-bar" />
              <span className="theme-swatch-body" />
              <span className="theme-swatch-chip">
                <i style={{ background: SITE_ACCENT_DEFAULT }} />
                <i style={{ background: appearance.siteBg ?? SITE_BG_DEFAULT }} />
              </span>
            </span>
            <span className="theme-option-text">
              <strong>自定义</strong>
              <em>{custom ? '收起细项' : '配色与色值'}</em>
            </span>
            {custom && <Check className="theme-check" size={15} strokeWidth={2.4} aria-hidden />}
          </button>
        </div>
      </div>

      {/* 界面大小（2026-10-02 徐先："可以设置改变这些选项卡的大小，在外观中设置"）。
          和画布右下角那个「画布外观」里的是**同一份偏好**，改哪边都一样。
          ⚠️ 刻意**不收进「自定义」后面**：那张卡装的是颜色这类细活，
             而界面大小是"屏幕 / 视力 / 习惯"层面天天可能动一下的东西。
             `step={1}` = 无级：能拖到任意一格，不是三档跳。 */}
      <div className="appearance-sub" data-ui-scale-block>
        <div className="appearance-sub-head">
          <span className="appearance-sub-label">界面大小</span>
          <span className="muted">按钮 / 输入框 / 顶栏一起变</span>
        </div>
        <label
          className="appearance-slider"
          data-ui-scale
          title="整个软件的按钮、输入框、顶栏跟着一起变大变小"
        >
          <span>
            <output data-ui-scale-value>{appearance.uiScale}%</output>
          </span>
          <input
            type="range"
            min={UI_SCALE.min}
            max={UI_SCALE.max}
            step={1}
            value={appearance.uiScale}
            aria-label="界面大小"
            data-ui-scale-range
            onChange={event => setUiScale(Number(event.target.value))}
          />
        </label>
        {appearance.uiScale !== UI_SCALE.default && (
          <button
            type="button"
            className="button subtle"
            data-ui-scale-reset
            onClick={() => setUiScale(UI_SCALE.default)}
          >
            回到标准（100%）
          </button>
        )}
      </div>

      {custom && <div className="custom-panel" data-custom-panel>
        <div className="appearance-sub">
          <div className="appearance-sub-head">
            <span className="appearance-sub-label">主题配色</span>
            <span className="muted">只换强调色那一支</span>
          </div>
          <div className="swatch-row">
            {PALETTE_OPTIONS.map(option => {
              const active = appearance.palette === option.value;
              return <button
                key={option.value}
                type="button"
                className={`swatch${active ? ' active' : ''}`}
                aria-pressed={active}
                data-palette-option={option.value}
                title={`${option.label} · ${option.hint}`}
                onClick={() => setPalette(option.value)}
              >
                <span
                  className="swatch-chip"
                  style={{ background: themeIsLight ? option.chipLight : option.chipDark }}
                >
                  {active && <Check size={13} strokeWidth={2.6} aria-hidden />}
                </span>
                <span className="swatch-label">{option.label}</span>
              </button>;
            })}
          </div>
        </div>

        {siteSlots.map(slot => <SlotRow key={slot.attr} slot={slot} />)}

        <div className="appearance-sub">
          <div className="appearance-sub-head">
            <span className="appearance-sub-label">背景图</span>
            <span className="muted">
              {!appearance.siteWallpaper.name ? '没有图' : appearance.siteWallpaper.enabled ? '已启用' : '已停用（图还在）'}
            </span>
          </div>
          {!canSetWallpaper() ? (
            <p className="muted">只有桌面版能上传背景图。</p>
          ) : (
            <>
              <div className="appearance-row">
                <button
                  className="button subtle"
                  type="button"
                  data-site-wall-upload
                  disabled={wallBusy}
                  onClick={() => void pickSite()}
                >
                  <Upload size={14} aria-hidden /> {wallBusy ? '处理中…' : appearance.siteWallpaper.name ? '换一张' : '上传图片'}
                </button>
                {appearance.siteWallpaper.name && <>
                  <button
                    className="button subtle"
                    type="button"
                    data-site-wall-toggle
                    onClick={() => setSiteWallpaper({ enabled: !appearance.siteWallpaper.enabled })}
                  >
                    {appearance.siteWallpaper.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    className="button subtle"
                    type="button"
                    data-site-wall-remove
                    disabled={wallBusy}
                    onClick={() => void dropSite()}
                  >
                    <Trash2 size={14} aria-hidden /> 移除
                  </button>
                </>}
              </div>
              {appearance.siteWallpaper.name && appearance.siteWallpaper.enabled && (
                <div className="appearance-sliders">
                  {([
                    ['fade', '淡化', 95, '%'],
                    ['blur', '模糊', 12, 'px'],
                  ] as const).map(([key, label, max, unit]) => (
                    <label
                      className="appearance-slider"
                      key={key}
                      title={key === 'fade' ? '越淡化越透，正文越读得清' : '柔化，让画面不抢内容'}
                    >
                      <span>
                        {label}
                        <output>{appearance.siteWallpaper[key]}{unit}</output>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={max}
                        step={1}
                        value={appearance.siteWallpaper[key]}
                        onChange={event => setSiteWallpaper({ [key]: Number(event.target.value) } as never)}
                      />
                    </label>
                  ))}
                </div>
              )}
              {wallNotice && <p className="muted" role="status" data-site-wall-notice>{wallNotice}</p>}
            </>
          )}
        </div>
      </div>}

      <div className="appearance-scope-foot">
        <button
          type="button"
          className="button subtle"
          data-scope-reset="site"
          onClick={() => { setSiteBg(null); setSiteAccent(null); }}
          disabled={!siteCustom}
        >
          <RotateCcw size={14} aria-hidden /> 主界面恢复默认
        </button>
      </div>
    </section>

    {/* ============ 画布 ============ */}
    <section className="appearance-card appearance-scope" data-scope="canvas">
      <div className="appearance-head">
        <div>
          <h2>画布</h2>
          <p className="muted">
            跟随主题换档，挑过自定义就不再跟着动。要钉住底色用画布右下角的「画布外观」。
          </p>
        </div>
      </div>

      {/* 画布底色不在这里给预设：它和「背景图」是一件事的两半 —— 图垫在上面、
          底色在下面，而"图淡到几成"这个滑杆只在画布上一边看一边调才有意义。
          所以这一支统一收在画布右下角那个「画布外观」里，这里只负责指个路。 */}
      <div className="appearance-sub">
        <div className="appearance-sub-head">
          <span className="appearance-sub-label">画布底色</span>
          <span className="muted" data-canvas-bg-hint>{appearance.canvasBg ? `自定义 ${appearance.canvasBg}` : '跟随主题'}</span>
        </div>
      </div>

      <div className="appearance-sub">
        <div className="appearance-sub-head">
          <span className="appearance-sub-label">节点卡片</span>
        </div>
        {!custom ? (
          <p className="muted" data-canvas-custom-hint>要单独指定，先打开上面的「自定义」。</p>
        ) : (
          <div className="custom-panel" data-canvas-custom-panel>
            {canvasSlots.map(slot => <SlotRow key={slot.attr} slot={slot} />)}
          </div>
        )}
      </div>

      <div className="appearance-scope-foot">
        <button
          type="button"
          className="button subtle"
          data-scope-reset="canvas"
          onClick={() => {
            setCanvasBg(null); setNodeBg(null); setNodeLine(null); setNodeAccent(null);
          }}
          disabled={!canvasCustom}
        >
          <RotateCcw size={14} aria-hidden /> 画布恢复默认
        </button>
      </div>
    </section>

    {/* ============ 预览 + 全局重置 ============ */}
    <section className="appearance-card">
      <div className="appearance-head">
        <div>
          <h2>预览</h2>
        </div>
        <button type="button" className="button subtle" data-appearance-reset onClick={reset}>
          <RotateCcw size={14} aria-hidden /> 全部恢复默认
        </button>
      </div>
      <div className="appearance-preview" style={{
        // 用 backgroundColor（长写属性）而不是 background 简写：
        // 简写会被内联样式整体接管，把样式表里的网格 background-image 一起清掉。
        backgroundColor: appearance.canvasBg ?? CANVAS_BG_DEFAULT,
        ['--preview-dot' as string]: isLightColor(appearance.canvasBg ?? CANVAS_BG_DEFAULT)
          ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.12)',
      }}>
        <div className="preview-node">
          <span className="preview-head">✦ 视频生成</span>
          <span className="preview-frame" />
        </div>
        <div className="preview-bar">
          <span className="preview-slot" />
          <span className="preview-slot" />
          <span className="preview-run" />
        </div>
      </div>
    </section>
  </div>;
}

/**
 * 一支颜色 = 一行：标题 + 状态 + 一排预设色块 + 「自定义」开关（点开才出取色器）。
 *
 * 六支颜色全靠这一副长相，加第七支就是多加一条 `Slot` 数据 —— 不用再抄一遍
 * 「选中态要不要打勾」「取色器初始值取哪一档」。
 */
function SlotRow({ slot }: { slot: Slot }) {
  const { label, follow, presets, fallback, value, onPick, attr, note } = slot;
  return <div className="appearance-sub">
    <div className="appearance-sub-head">
      <span className="appearance-sub-label">{label}</span>
      <span className="muted">{value ? '自定义' : follow}</span>
    </div>
    <div className="swatch-row">
      {presets.map(preset => {
        const active = value === preset.value;
        const probe = { ['data-' + attr + '-option']: preset.value } as Record<string, string>;
        return <button
          key={preset.value}
          type="button"
          className={`swatch${active ? ' active' : ''}`}
          aria-pressed={active}
          {...probe}
          title={`${preset.label} ${preset.value}`}
          onClick={() => onPick(preset.value)}
        >
          <span className="swatch-chip" style={{ background: preset.value }}>
            {active && <Check size={13} strokeWidth={2.6} aria-hidden />}
          </span>
          <span className="swatch-label">{preset.label}</span>
        </button>;
      })}
    </div>
    <ColorPick
      label={`自定义${label}`}
      value={value}
      fallback={fallback}
      onChange={onPick}
      note={note}
    />
  </div>;
}

/**
 * 「自定义」开关 + 取色器 + 色值框。
 *
 * ⚠️ 两条都是必须的：
 * 1. **默认收起**：六支颜色各挂两行输入框，一屏全是控件，而日常真正在用的只有预设。
 * 2. **已经自定义过就一直展开**（`value !== null`）：否则回来只看到「自定义」三个字，
 *    看不到自己挑的色值，会以为设置丢了、跑去重挑一遍。
 *
 * 手输时只有合法的十六进制才往偏好里写：输到一半的 `#111` 会被当成 `#111111`
 * 才算数，否则每敲一个键都会写一版脏数据。
 */
function ColorPick({ label, value, fallback, onChange, note }: {
  label: string;
  value: string | null;
  fallback: string;
  onChange: (next: string | null) => void;
  note?: string;
}) {
  const [toggled, setToggled] = useState(false);
  const [draft, setDraft] = useState(value ?? fallback);
  useEffect(() => { if (value) setDraft(value); }, [value]);
  const valid = isHexColor(draft);
  const open = toggled || value !== null;

  function commit(next: string) {
    setDraft(next);
    if (isHexColor(next)) onChange(normalizeHex(next));
  }

  return <div className="custom-color">
    <button
      type="button"
      className={`custom-toggle${open ? ' on' : ''}`}
      aria-expanded={open}
      data-custom-toggle={label}
      onClick={() => setToggled(prev => !prev)}
    >
      <span className="custom-toggle-switch" aria-hidden />
      自定义
    </button>

    {open && <div className="custom-body">
      <label className="field">
        <span>{label}</span>
        <span className="color-input-row">
          <input
            type="color"
            aria-label={label}
            data-color={label}
            value={valid ? normalizeHex(draft) : fallback}
            onChange={event => commit(event.target.value)}
          />
          <input
            type="text"
            className="color-hex"
            spellCheck={false}
            value={draft}
            onChange={event => commit(event.target.value)}
            onBlur={() => { if (!valid) setDraft(value ?? fallback); }}
            placeholder={fallback}
          />
        </span>
      </label>
      {!valid && <p className="muted">请输入 3 位或 6 位十六进制色值，例如 <code>#101013</code>。</p>}
      {valid && value && <p className="muted">
        当前：<code>{value}</code>{isLightColor(value) ? '（浅色，压在上面的字会转深）' : ''}
      </p>}
      {!value && note && <p className="muted">{note}</p>}
    </div>}
  </div>;
}
