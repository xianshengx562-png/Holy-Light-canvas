/* 外观设置：主题模式 + 画布底色。
   这套偏好只存在浏览器 localStorage 里（不发数据库）——它是设备级 UI 偏好，
   登录页也要能生效，走服务端存储反而要读库、要迁移，收益不划算。 */
import { syncTitlebarTheme } from '@/lib/desktop-titlebar';

export const APPEARANCE_KEY = 'frame.appearance';

export type ThemeMode = 'dark' | 'light' | 'system';

/**
 * 配色：只换「强调色那一支」，底色 / 描边 / 文字 / 语义色不动。
 * 深浅两套各有一档（深底要提亮、浅底要压暗），CSS 里按 `[data-theme][data-palette]`
 * 两套选择器挂着（globals.css 与 canvas.css 各一份）。
 *
 * ⚠️ 2026-09-29：默认那一档从 `moss`（墨绿）换成 **`mono`（黑白）**。
 *    （中间还做过一版 `snow` 雪蓝，同一天被换成黑白，没发布过，所以不保留。）
 *    `moss` / `snow` 都不在表里 —— 老偏好里存着它们的会被 `isPaletteId()` 判成
 *    不合法、回落到新默认 mono，**升一次级就自动变色**，不需要额外的迁移代码。
 *    想留住旧色的机器：设置页「自定义强调色」填 #1f7a5c / #1f7a99（预设里都有）。
 *    黑白这一档的语义：**强调色就是黑白本身**（白底用黑、黑底用白），灰只做层次。
 */
export type CanvasTheme = 'minimal' | 'tech-cold' | 'warm-soft' | 'custom';

export const CANVAS_THEME_OPTIONS: { value: CanvasTheme; label: string }[] = [
  { value: 'minimal', label: '简约' },
  { value: 'tech-cold', label: '科技冷感' },
  { value: 'warm-soft', label: '温暖柔和' },
  { value: 'custom', label: '自定义' },
];

export type PaletteId =
  | 'mono' | 'amber' | 'indigo' | 'graphite'
  | 'aurora' | 'sunset' | 'ocean';

export const PALETTE_IDS: PaletteId[] = [
  'mono', 'amber', 'indigo', 'graphite',
  /* 后三套是渐变：只有「当背景」的那一路（`--accent-fill`）是渐变，
     文字 / 描边 / 图标仍然走实色的 `--accent`。 */
  'aurora', 'sunset', 'ocean',
];

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && (PALETTE_IDS as string[]).includes(value);
}

/** 设置页里那一排色块的预览色。和 CSS 里那两份必须一致 —— 改一边忘另一边，
    表现是「选了琥珀，色块自己还是绿的」（色块是内联样式，不吃 CSS 变量）。 */
export const PALETTE_OPTIONS: {
  value: PaletteId; label: string; hint: string; chipDark: string; chipLight: string;
}[] = [
  { value: 'mono', label: '黑白', hint: '默认', chipDark: '#f2f2f2', chipLight: '#111111' },
  { value: 'amber', label: '琥珀', hint: '暖', chipDark: '#e8b44a', chipLight: '#a16207' },
  { value: 'indigo', label: '靛蓝', hint: '冷', chipDark: '#8b9cf7', chipLight: '#4356c7' },
  { value: 'graphite', label: '石墨', hint: '中性', chipDark: '#b6bec7', chipLight: '#4b5a68' },
  /* 渐变三套：chip 给的是 CSS `background` 的值 —— 纯色写色号、渐变写 linear-gradient。
     预览块用的是**背景**那一路，所以这里如实画成渐变，和实际效果一致。 */
  {
    value: 'aurora', label: '极光', hint: '渐变',
    chipDark: 'linear-gradient(100deg, #34b98d 0%, #6b7ef7 100%)',
    chipLight: 'linear-gradient(100deg, #2f9e78 0%, #4f68dd 100%)',
  },
  {
    value: 'sunset', label: '晚霞', hint: '渐变',
    chipDark: 'linear-gradient(100deg, #f0913f 0%, #e0508c 100%)',
    chipLight: 'linear-gradient(100deg, #d9762f 0%, #c33a70 100%)',
  },
  {
    value: 'ocean', label: '深海', hint: '渐变',
    chipDark: 'linear-gradient(100deg, #2ea9c8 0%, #4f6ef2 100%)',
    chipLight: 'linear-gradient(100deg, #1f8fae 0%, #3a5cd8 100%)',
  },
];

/**
 * 画布背景图（用户自己传的一张图，垫在无限画布下面）。
 *
 * ⚠️ 图片本体**存在数据目录里**（`data/wallpaper.png`，由主进程落盘），
 *    这里只存文件名 + 几个显示参数。把 base64 塞进 localStorage 是不行的 ——
 *    一张 2MB 的图转成 dataURL 会撑到 2.7MB，而 localStorage 的额度通常只有 5MB，
 *    存两张就写不进去了，而且每次读写都要解析这一大坨字符串。
 *    `name` 为空表示没有背景图。
 */
/**
 * 界面大小（2026-10-02 徐先："可以设置改变这些选项卡的大小，在外观中设置"）。
 *
 * 一个**百分比**：100 = 现在这个样子，往小拉到 80、往大拉到 130。
 * 它不是"字号"也不是"缩放窗口"，是**控件尺寸的乘数** —— 顶栏高度、按钮高度、
 * 输入框内距、左轨 / 视口条那些圆钮，全都乘同一个数。
 *
 * ⚠️ 落在 CSS 上就是一个变量 `--ui`（写在 `<html>` 上，全站继承）：
 *    所有跟着变的尺寸都写成 `calc(36px * var(--ui))` 这种形状。
 *    **写死 px 的地方不会跟着变** —— 这是一条约定，加新控件尺寸时请照抄这个形状，
 *    别再写死一个数（写死 = 用户拉滑杆时那一处纹丝不动，看着像坏了）。
 *
 * ⚠️ 边框一律 1px、**不乘**：发丝级描边是这个设计系统的立身之本，
 *    拉到 130% 变成 1.3px 就糊了。圆角同理，只有少数几处跟着走。
 */
export const UI_SCALE = {
  min: 80,
  max: 130,
  /** 100 = 原始尺寸。往下拉是"紧凑"，往上拉是"放大"。 */
  default: 100,
} as const;

/** 百分比 → CSS 乘数。坏值（NaN / 越界）一律夹回范围，绝不让界面算出个 0 高度。 */
export function uiScaleFactor(uiScale: unknown): number {
  const n = typeof uiScale === 'number' ? uiScale : Number(uiScale);
  if (!Number.isFinite(n)) return UI_SCALE.default / 100;
  const clamped = Math.min(UI_SCALE.max, Math.max(UI_SCALE.min, Math.round(n)));
  return clamped / 100;
}

export type Wallpaper = {
  /** 数据目录里的文件名，空 = 没有背景图 */
  name: string;
  /** 关掉之后图还在，只是不显示（「保留已上传图片，方便再次启用」） */
  enabled: boolean;
  /** 淡化：0 = 原样，95 = 几乎看不见 */
  fade: number;
  /** 柔化模糊，px */
  blur: number;
};

/*
 * 这套偏好的模型（2026-09-22 徐先定的）：
 *
 *   日间 / 夜间是**固定预设** —— 它们本身就是一份被保存下来的配置（`theme` 字段），
 *     不同的是这一档里每一支颜色都是定死的、UI 上不给改；
 *   自定义是**单独一个选项** —— 每支颜色各自一个字段，**非 null 才算启用**。
 *     它压在预设上面：换主题只是换那支颜色的 fallback，动不到这里的值，
 *     所以「挑了自定义再切日间 / 夜间，颜色不会被冲掉」，反过来也成立。
 *
 *   换主题动的是 CSS 里那一整套 fallback，不是这些字段 —— 这也是为什么本文里
 *   `canvasBg` 之类没有一个 companion 字段记「日间用哪个、夜间用哪个」。
 */
export type Appearance = {
  theme: ThemeMode;
  /** 画布主题预设（简约/科技冷感/温暖柔和/自定义）。老数据里没有这个字段 → parseAppearance 兜回默认。 */
  canvasTheme?: CanvasTheme;
  /** 配色。老数据里没有这个字段 → parseAppearance 兜回默认，不判成坏数据。 */
  palette: PaletteId;
  /** 画布底色；null = 跟随主题 */
  canvasBg: string | null;
  /**
   * 画布节点卡片的三支颜色：底色 / 描边 / 强调色（选中态与卡片里的强调元素）。
   * null = 跟随画布本身那一支（七套配色里的那一档）。
   *
   * ⚠️ 派生值（卡内的正文、次级面板、输入框底）**不在这里算**，交给 canvas.css
   * 的 `color-mix()` —— JS 只写三个原始色加「往哪边提亮」这一件事，理由写在
   * applyAppearance 里节点那段注释上，和全站底色是同一个道理。
   */
  nodeBg: string | null;
  nodeLine: string | null;
  nodeAccent: string | null;
  /**
   * 全站底色；null = 跟随主题。
   * ⚠️ 面板 / 描边 / 正文这些派生值**不在这里算**，由 globals.css 用 `color-mix()` 从
   * `--site-bg` 现算 —— 这样防闪脚本只要写两个原始颜色，不用把整套算法再抄一遍。
   */
  siteBg: string | null;
  /** 全站强调色；null = 跟随配色（palette）。自定义优先于那 7 套预设。 */
  siteAccent: string | null;
  /** 左侧导航是否收起。和主题一样是**设备级**偏好，不进库。 */
  navCollapsed: boolean;
  /**
   * 界面大小，百分比（见 `UI_SCALE`）。100 = 原始尺寸。
   * 老偏好里没有这个字段 → parseAppearance 兜回 100，不判成坏数据。
   */
  uiScale: number;
  /** 画布背景图 */
  wallpaper: Wallpaper;
  /** 全站背景图：垫在首页 / 设置 / 列表这些页面最底下那一层 */
  siteWallpaper: Wallpaper;
};

export const WALLPAPER_LIMITS = {
  /** 上传上限。再大就不是「画布背景」而是素材了，该走素材库。 */
  maxBytes: 20 * 1024 * 1024,
  /** 像素上限（3200 万）。手机直出的大图会超，超了要拦下来并把尺寸报给用户。 */
  maxPixels: 32_000_000,
  mimes: ['image/jpeg', 'image/png', 'image/webp'],
  accept: 'image/jpeg,image/png,image/webp',
};

export const DEFAULT_WALLPAPER: Wallpaper = { name: '', enabled: true, fade: 45, blur: 4 };

/**
 * 全站背景图的默认值与画布那份**不是同一组数**：
 * 画布上节点本身就占满画面，淡化 45 够了；全站背景垫在正文底下，
 * 再淡一点（55）才不至于让文字压在花图上读不清。
 */
export const DEFAULT_SITE_WALLPAPER: Wallpaper = { name: '', enabled: true, fade: 55, blur: 0 };

/** 底色的几个起手式。都是「挑完就不用再调」的中性色，深浅各三档。 */
export const SITE_BG_PRESETS: { label: string; value: string }[] = [
  { label: '米白', value: '#f6f3ec' },
  { label: '雾灰', value: '#e9ebee' },
  { label: '冷灰', value: '#cfd4da' },
  { label: '墨黑', value: '#101215' },
  { label: '深夜蓝', value: '#111823' },
  { label: '黛绿', value: '#0f1a16' },
];

/** 强调色的几个起手式，和预设配色那 7 套是同一批色相（挑一个等于换一次配色）。 */
export const SITE_ACCENT_PRESETS: { label: string; value: string }[] = [
  { label: '墨绿', value: '#1f7a5c' },
  { label: '琥珀', value: '#a16207' },
  { label: '靛蓝', value: '#4356c7' },
  { label: '石墨', value: '#4b5a68' },
  { label: '玫红', value: '#c33a70' },
  { label: '湖青', value: '#1f8fae' },
  /* 2026-09-29：默认那支（墨黑）。放在最后 —— 上面那六条是「换一个色相」，
     它只是「回到默认」，不该抢在最前面。 */
  { label: '墨黑', value: '#111111' },
];

export const DEFAULT_APPEARANCE: Appearance = {
  /* 2026-09-22：日间（极简）成为默认。
     画布跟着一起切换 —— canvas.css 里「画布跟着主题走」那一段把整套 `--cv-*`
     接到 globals 的 `--app-*` 别名上，所以除了 `theme` / `palette` 这两个档位开关，
     下面这几支自定义色**不受主题影响**，默认全是 null = 跟随当前那一档预设。 */
  theme: 'light',
  canvasTheme: 'minimal',
  palette: 'mono',
  canvasBg: null,
  /* 节点默认全都跟随画布那一支 —— 只有用户挑了才覆盖。 */
  nodeBg: null,
  nodeLine: null,
  nodeAccent: null,
  /* 默认都是 null —— 底色与强调色跟着「主题 + 配色」走，用户挑了才覆盖。 */
  siteBg: null,
  siteAccent: null,
  navCollapsed: false,
  uiScale: UI_SCALE.default,
  wallpaper: { ...DEFAULT_WALLPAPER },
  siteWallpaper: { ...DEFAULT_SITE_WALLPAPER },
};

/** 淡化 / 模糊都是滑杆，越界或坏值一律夹回范围，不让一个脏字段把画布搞成全糊或全黑。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export const THEME_OPTIONS: { value: ThemeMode; label: string; hint: string }[] = [
  { value: 'dark', label: '夜间', hint: '深色界面' },
  { value: 'light', label: '日间', hint: '浅色界面，默认' },
  { value: 'system', label: '跟随系统', hint: '随系统深浅色切换' },
];

/*
 * 画布底色的几个起手式（**这是自定义档**，`appearance.canvasBg` 非 null 时才生效）。
 * 不跟主题分两组：挑了就是挑了，切日间 / 夜间都不会把它冲掉 —— 想要浅色 MV 那种
 * 「日间 + 墨黑地板」的用法正是靠这一点。
 * 深浅都在同一排里，是为了岔开两种用法：挑色时看的是色本身，
 * 而不是当前处在第几档 —— 日间配墨黑地板、夜间配雾白地板都做得到。
 * 网格点与连线由 `floorDerivedVars` 自动换成看得清的那支。
 */
export const CANVAS_BG_PRESETS: { value: string; label: string }[] = [
  { value: '#000000', label: '纯黑' },
  { value: '#0e0e12', label: '墨黑' },
  { value: '#141a24', label: '深夜蓝' },
  { value: '#0f1a16', label: '墨绿' },
  { value: '#1c1917', label: '暖褐' },
  { value: '#2a2a31', label: '石墨' },
  { value: '#e8e8ea', label: '浅灰' },
  { value: '#f4f1ea', label: '米白' },
];

/*
 * 节点卡片底色的几个起手式（同样是**自定义档**）。
 * 不写（null）时：日间 = 白卡片、夜间 = 深卡片，跟着主题自动换。
 * 挑了之后就把那一支钉住了，日间 / 夜间都不再动它；
 * 卡内的正文、次级面板、输入框由 `data-node-tone` + canvas.css 里的 `color-mix()`
 * 自动推到看得清的那一边（浅底会转深字，深底会转浅字）。
 */
export const NODE_BG_PRESETS: { value: string; label: string }[] = [
  { value: '#14161a', label: '石墨' },
  { value: '#000000', label: '纯黑' },
  { value: '#111823', label: '深夜蓝' },
  { value: '#1c1917', label: '暖褐' },
  { value: '#ececf0', label: '雾白' },
  { value: '#f7f5ef', label: '米白' },
];

/* 节点描边（自定义档，同上）。用实色而不是 rgba：用户要挑的是「那根线本身什么颜色」，
   半透明得靠混合算。 */
export const NODE_LINE_PRESETS: { value: string; label: string }[] = [
  { value: '#2f333a', label: '隐线' },
  { value: '#3f434b', label: '石墨' },
  { value: '#6b7280', label: '亮银' },
  { value: '#33404f', label: '蓝灰' },
  { value: '#4a4038', label: '暖褐' },
  { value: '#ffffff', label: '白描边' },
];

/* 节点强调色（自定义档，同上）。和画布那七套配色同口径：深色档挑过的那几个色相，
   压在上面的字用黑还是白由 `--cv-node-accent-ink-custom` 现算。 */
export const NODE_ACCENT_PRESETS: { value: string; label: string }[] = [
  { value: '#4fb38a', label: '墨绿' },
  { value: '#e8b44a', label: '琥珀' },
  { value: '#8b9cf7', label: '靛蓝' },
  { value: '#f2896f', label: '珊瑚' },
  { value: '#5a9ceb', label: '湖青' },
  { value: '#b6bec7', label: '石灰' },
  { value: '#f2f2f2', label: '月白' },
];

/**
 * 单个节点可以挑的卡片色（2026-10-01，徐先："同时也可以改变画布选项卡的颜色"）。
 *
 * 与上面那几份「全局预设」的区别：这里是**每个节点各挑一支**，存节点自己的 data 上，
 * 不是整块画布一个色。前三支是中性色（跟没挑过几乎一样，用来把某个节点压回常态），
 * 后面六支是彩色 —— 用途是把一条链上的节点分出组别，扫一眼就知道谁是素材、谁在生成。
 */
export const NODE_CARD_COLORS: { value: string; label: string }[] = [
  { value: '#14161a', label: '石墨' },
  { value: '#000000', label: '纯黑' },
  { value: '#ececf0', label: '雾白' },
  { value: '#4fb38a', label: '墨绿' },
  { value: '#e8b44a', label: '琥珀' },
  { value: '#8b9cf7', label: '靛蓝' },
  { value: '#f2896f', label: '珊瑚' },
  { value: '#5a9ceb', label: '湖青' },
  { value: '#a97bd6', label: '紫藤' },
];

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value.trim());
}

/** 把 #abc 展开成 #aabbcc */
export function normalizeHex(value: string): string {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return v;
}

/** WCAG 相对亮度，用来决定点阵/连线该用深色还是浅色。 */
export function relativeLuminance(hex: string): number {
  const v = normalizeHex(hex);
  if (!isHexColor(v)) return 0;
  const channels = [1, 3, 5].map(i => {
    const c = parseInt(v.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function isLightColor(hex: string): boolean {
  return relativeLuminance(hex) > 0.45;
}

/**
 * 单个节点挑了色之后，卡内那几个派生色（文字 / 次级面板 / 描边）。
 *
 * ⚠️ 写的是 `--cv-node-*` 而不是 `--cv-node-*-custom`：后者只有 <html> 上的那份
 *    会被 `.canvas-studio { --cv-node-bg: var(--cv-node-bg-custom, …) }` 读到 ——
 *    自定义属性是在**声明它的那个元素**上解析 var() 的，在节点上改 `-custom`
 *    不会让祖先已经算好的 `--cv-node-bg` 重新求值（这是 CSS 变量最容易踩的一条）。
 *    直接把算好的值写到节点元素上，子树里读到的就是它。
 *
 * 六个派生比例与 canvas.css 里 `:root[data-node-bg='custom']` 那一段**必须一致**，
 * 否则「全局自定义」与「单个节点挑色」两档同一个色会渲染成两个样子。
 */
export function nodeTintVars(color: string): Record<string, string> {
  const bg = normalizeHex(String(color || ''));
  if (!isHexColor(bg)) return {};
  /** 派生往哪一头推：浅色卡片往黑里推（字才压得住），深色卡片往白里提。 */
  const opposite = isLightColor(bg) ? '#101215' : '#ffffff';
  const mix = (percent: number) => `color-mix(in oklab, ${bg} ${percent}%, ${opposite})`;
  return {
    '--cv-node-bg': bg,
    '--cv-node-ink': mix(6),
    '--cv-node-dim': mix(48),
    '--cv-node-mute': mix(66),
    '--cv-node-elev': mix(90),
    '--cv-node-field': mix(84),
    '--cv-node-line': mix(78),
    '--cv-node-line-hover': mix(55),
    '--cv-node-opposite': opposite,
  };
}

/** 画布底色定下来之后，网格点与连线要跟着走，否则浅底上根本看不见。 */
export function floorDerivedVars(bg: string): { dot: string; edge: string; edgeActive: string } {
  return isLightColor(bg)
    ? { dot: 'rgba(0, 0, 0, 0.20)', edge: '#a8a8b0', edgeActive: '#71717a' }
    : { dot: 'rgba(255, 255, 255, 0.10)', edge: '#3f3f46', edgeActive: '#6f6f7a' };
}

/** 容错读取：任何字段坏了都退回默认值，不要让一个脏 localStorage 把页面搞白。 */
export function parseAppearance(raw: string | null): Appearance {
  if (!raw) return { ...DEFAULT_APPEARANCE };
  try {
    const data = JSON.parse(raw) as Partial<Appearance>;
    const theme: ThemeMode =
      data.theme === 'dark' || data.theme === 'light' || data.theme === 'system'
        ? data.theme
        : DEFAULT_APPEARANCE.theme;
    const canvasBg = isHexColor(data.canvasBg) ? normalizeHex(data.canvasBg) : null;
    /* 节点颜色：老偏好里没有这三个字段，缺了就是「跟随画布」，别判成坏数据。 */
    const nodeBg = isHexColor(data.nodeBg) ? normalizeHex(data.nodeBg) : null;
    const nodeLine = isHexColor(data.nodeLine) ? normalizeHex(data.nodeLine) : null;
    const nodeAccent = isHexColor(data.nodeAccent) ? normalizeHex(data.nodeAccent) : null;
    const palette = isPaletteId(data.palette) ? data.palette : DEFAULT_APPEARANCE.palette;
    /* 老数据里没有这个字段。缺了就当「展开」——**不能因此把整份偏好判成坏的**，
       否则升一次级，所有人的主题都会被重置回默认。 */
    const navCollapsed = typeof data.navCollapsed === 'boolean' ? data.navCollapsed : false;
    const siteBg = isHexColor(data.siteBg) ? normalizeHex(data.siteBg) : null;
    const siteAccent = isHexColor(data.siteAccent) ? normalizeHex(data.siteAccent) : null;
    return {
      theme,
      palette,
      canvasBg,
      nodeBg,
      nodeLine,
      nodeAccent,
      siteBg,
      siteAccent,
      navCollapsed,
      uiScale: clampInt(data.uiScale, UI_SCALE.min, UI_SCALE.max, UI_SCALE.default),
      wallpaper: parseWallpaper(data.wallpaper),
      siteWallpaper: parseWallpaper(data.siteWallpaper),
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/** 背景图字段的容错：整块缺了（老版本写的偏好）就用默认值，不判定为坏数据。 */
export function parseWallpaper(raw: unknown): Wallpaper {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_WALLPAPER };
  const data = raw as Partial<Wallpaper>;
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  return {
    /* 只认纯文件名：带路径分隔符的直接丢掉（这是会被拼进文件路径的值） */
    name: /^[A-Za-z0-9._-]+$/.test(name) ? name : '',
    enabled: typeof data.enabled === 'boolean' ? data.enabled : DEFAULT_WALLPAPER.enabled,
    fade: clampInt(data.fade, 0, 95, DEFAULT_WALLPAPER.fade),
    blur: clampInt(data.blur, 0, 12, DEFAULT_WALLPAPER.blur),
  };
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): 'dark' | 'light' {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/** 把偏好写进 <html> 的属性与 CSS 变量。provider 与"防闪"内联脚本共用同一套规则。
 *
 *  只写 --cv-*-custom 这几个名字：canvas.css 里 `--cv-dot: var(--cv-dot-custom, …)`
 *  读的就是它们。千万不要在这里直接写 --xy-background-pattern-color 之类的"终值"变量——
 *  .flow-shell 自己也声明了同名变量，子树里的声明会盖掉写在 <html> 上的值，
 *  结果就是自定义底色在画布上完全看不到（踩过一次）。 */
export function applyAppearance(appearance: Appearance, prefersDark: boolean): void {
  const root = document.documentElement;
  const theme = resolveTheme(appearance.theme, prefersDark);
  root.dataset.theme = theme;
  root.dataset.themeMode = appearance.theme;
  root.dataset.palette = appearance.palette;

  /*
   * 界面大小。
   *
   * 写成 `<html>` 上的 `--ui`：它是**全站继承**的，各页面（首页 / 设置 / 画布）与
   * 各个组件都不必各拿一份 state。默认值（1）由 globals.css 的 `:root` 提供，
   * 所以防闪脚本还没跑、或者偏好里没有这个字段时，界面就是原始尺寸。
   * ⚠️ 改的是**乘数**不是字号 —— 见 `UI_SCALE` 上那条说明。
   */
  root.style.setProperty('--ui', String(uiScaleFactor(appearance.uiScale)));

  /* 桌面版：窗口右上角那三个系统按钮现在是**浮在页头上**的，符号颜色得跟着日/夜换 ——
     浅色页头配浅色符号等于没有按钮。web 版里这是一个空操作。 */
  syncTitlebarTheme(theme === 'dark');

  /* 左侧导航的收 / 展。写在 <html> 上而不是某个页面的 state 里：侧栏是**全局**的，
     首页要它收起、内页要它展开，各存一份必然打架。 */
  root.dataset.nav = appearance.navCollapsed ? 'collapsed' : 'expanded';

  if (appearance.canvasBg) {
    const derived = floorDerivedVars(appearance.canvasBg);
    root.dataset.canvasBg = 'custom';
    root.style.setProperty('--cv-floor-custom', appearance.canvasBg);
    root.style.setProperty('--cv-dot-custom', derived.dot);
    root.style.setProperty('--cv-edge-custom', derived.edge);
    root.style.setProperty('--cv-edge-active-custom', derived.edgeActive);
  } else {
    delete root.dataset.canvasBg;
    root.style.removeProperty('--cv-floor-custom');
    root.style.removeProperty('--cv-dot-custom');
    root.style.removeProperty('--cv-edge-custom');
    root.style.removeProperty('--cv-edge-active-custom');
  }

  /*
   * 背景图。三件事都写在这里（而不是组件里）的原因和主题一样：防闪脚本要与它
   * 用**同一套规则**，否则「有图」这件事会被算成两种。
   *
   * 图片地址走 `app://app/wallpaper`（主进程那条协议里拦下来）。刻意**不做成
   * 文件路径**：渲染进程拿到本机绝对路径没有意义，而且一旦被写进 DOM 就是泄漏。
   */
  const wall = appearance.wallpaper;
  if (wall.name && wall.enabled) {
    root.dataset.wallpaper = 'on';
    root.style.setProperty('--cv-wall-image', `url("app://app/wallpaper?v=${encodeURIComponent(wall.name)}")`);
    /* 淡化做成「不透明度」：越淡化越透，垫在下面的底色就越主导，符合那个滑杆的直觉。 */
    root.style.setProperty('--cv-wall-opacity', String((100 - wall.fade) / 100));
    root.style.setProperty('--cv-wall-blur', `${wall.blur}px`);
  } else {
    delete root.dataset.wallpaper;
    root.style.removeProperty('--cv-wall-image');
    root.style.removeProperty('--cv-wall-opacity');
    root.style.removeProperty('--cv-wall-blur');
  }

  /*
   * 全站底色 / 强调色。
   *
   * 这里**只写原始值**，派生（面板、描边、正文、hover）交给 globals.css 的 `color-mix()`：
   * 防闪脚本那段字符串因此不必再抄一遍整套明度算法 —— 两处算法漂移是这类"自定义主题"
   * 最容易长歪的地方（颜色算在 JS 里，改一次要同时改防闪脚本）。
   *
   * 只有两个方向需要 JS 拍板，因为它们**不是混合比例、而是往哪边走**：
   *   - hover 往深里压还是往亮里提（取决于强调色本身亮不亮）
   *   - 压在强调色上的字用黑还是白（同上）
   */
  if (appearance.siteBg) {
    root.dataset.siteBg = 'custom';
    root.dataset.siteTone = isLightColor(appearance.siteBg) ? 'light' : 'dark';
    root.style.setProperty('--site-bg', appearance.siteBg);
  } else {
    delete root.dataset.siteBg;
    delete root.dataset.siteTone;
    root.style.removeProperty('--site-bg');
  }
  if (appearance.siteAccent) {
    const light = isLightColor(appearance.siteAccent);
    root.dataset.siteAccent = 'custom';
    root.style.setProperty('--site-accent', appearance.siteAccent);
    root.style.setProperty('--site-accent-hover-mix', light ? '#000000' : '#ffffff');
    root.style.setProperty('--site-accent-ink', light ? '#14181c' : '#ffffff');
  } else {
    delete root.dataset.siteAccent;
    root.style.removeProperty('--site-accent');
    root.style.removeProperty('--site-accent-hover-mix');
    root.style.removeProperty('--site-accent-ink');
  }

  /*
   * 画布节点的三支颜色。
   *
   * 只写 `-custom` 后缀的原始色 —— canvas.css 里 `--cv-node-bg: var(--cv-node-bg-custom, …)`
   * 读的就是它们。名字照抄上面的规矩：绝不能在这里写 `--cv-node-bg` 那种终值变量，
   * `.canvas-studio` 自己也声明着同名变量，子树里的声明会盖掉写在 <html> 上的值，
   * 结果就是自定义在画布上完全看不到（画布底色那次已经踩过一回）。
   *
   * 派生同样交出去，理由和全站底色一致。这里**只留两个方向判断**：`data-node-tone`
   * （卡内的字往哪边推）和压在强调色上的字用黑还是白 —— 它们不是混合比例，
   * 是「往哪一头走」，只能由 JS 拍板。
   */
  if (appearance.nodeBg) {
    root.dataset.nodeBg = 'custom';
    root.dataset.nodeTone = isLightColor(appearance.nodeBg) ? 'light' : 'dark';
    root.style.setProperty('--cv-node-bg-custom', appearance.nodeBg);
  } else {
    delete root.dataset.nodeBg;
    delete root.dataset.nodeTone;
    root.style.removeProperty('--cv-node-bg-custom');
  }
  if (appearance.nodeLine) {
    root.dataset.nodeLine = 'custom';
    root.style.setProperty('--cv-node-line-custom', appearance.nodeLine);
  } else {
    delete root.dataset.nodeLine;
    root.style.removeProperty('--cv-node-line-custom');
  }
  if (appearance.nodeAccent) {
    root.dataset.nodeAccent = 'custom';
    root.style.setProperty('--cv-node-accent-custom', appearance.nodeAccent);
    /* 压在这个强调色上的字用黑还是白 —— 这是「往哪边走」，只能是 JS 拍板。 */
    root.style.setProperty(
      '--cv-node-accent-ink-custom',
      isLightColor(appearance.nodeAccent) ? '#14181c' : '#ffffff',
    );

  /* 鐢诲竷涓婚棰勮 */
  if (appearance.canvasTheme) {
    root.dataset.canvasTheme = appearance.canvasTheme;
  } else {
    root.dataset.canvasTheme = 'minimal';
  }

  /* 全站背景图。URL 与画布那份只差一个 `slot` —— 主进程按它决定读哪个文件。 */
  const siteWall = appearance.siteWallpaper;
  if (siteWall.name && siteWall.enabled) {
    root.dataset.appWall = 'on';
    root.style.setProperty(
      '--app-wall-image',
      `url("app://app/wallpaper?slot=site&v=${encodeURIComponent(siteWall.name)}")`,
    );
    root.style.setProperty('--app-wall-opacity', String((100 - siteWall.fade) / 100));
    root.style.setProperty('--app-wall-blur', `${siteWall.blur}px`);
  } else {
    delete root.dataset.appWall;
    root.style.removeProperty('--app-wall-image');
    root.style.removeProperty('--app-wall-opacity');
    root.style.removeProperty('--app-wall-blur');
  }
}

/* 防闪：必须同步跑在 <head> 里，晚一步就会先画一帧深色再跳成日间。
   这里刻意不用模板字符串 / 反引号，避免被外层打包或转义咬到。 */
export const APPEARANCE_INIT_SCRIPT = [
  '(function(){',
  '  try {',
  '    var raw = localStorage.getItem(' + JSON.stringify(APPEARANCE_KEY) + ');',
  '    var data = raw ? JSON.parse(raw) : {};',
  '    var mode = data && (data.theme === "dark" || data.theme === "system") ? data.theme : "light";',
  '    var bg = data && typeof data.canvasBg === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(data.canvasBg)',
  '      ? data.canvasBg : null;',
  '    var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;',
  '    var root = document.documentElement;',
  '    root.dataset.theme = (mode === "system") ? (dark ? "dark" : "light") : mode;',
  '    root.dataset.themeMode = mode;',
  '    root.dataset.palette = (data && /^(mono|amber|indigo|graphite|aurora|sunset|ocean)$/.test(data.palette)) ? data.palette : "mono";',
  '    root.dataset.nav = (data && data.navCollapsed === true) ? "collapsed" : "expanded";',
  /* 界面大小：必须和 applyAppearance 同一套夹取规则，否则首帧会先画成 100% 再跳一下。 */
  '    var s = Math.round(Number(data && data.uiScale));',
  '    root.style.setProperty("--ui", String((isFinite(s) ? Math.min(130, Math.max(80, s)) : 100) / 100));',
  '    if (bg) {',
  '      if (/^#[0-9a-f]{3}$/i.test(bg)) bg = "#" + bg[1]+bg[1]+bg[2]+bg[2]+bg[3]+bg[3];',
  '      var n = bg.toLowerCase();',
  '      var ch = [1,3,5].map(function(i){',
  '        var c = parseInt(n.slice(i, i + 2), 16) / 255;',
  '        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);',
  '      });',
  '      var lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];',
  '      var light = lum > 0.45;',
  '      root.dataset.canvasBg = "custom";',
  '      root.style.setProperty("--cv-floor-custom", n);',
  '      root.style.setProperty("--cv-dot-custom", light ? "rgba(0, 0, 0, 0.20)" : "rgba(255, 255, 255, 0.10)");',
  '      root.style.setProperty("--cv-edge-custom", light ? "#a8a8b0" : "#3f3f46");',
  '      root.style.setProperty("--cv-edge-active-custom", light ? "#71717a" : "#6f6f7a");',
  '    }',
  '    var tone = function(x) { var n = String(x).toLowerCase();'
  + ' var ch = [1,3,5].map(function(i){ var c = parseInt(n.slice(i,i+2),16)/255;'
  + ' return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); });'
  + ' return (0.2126*ch[0] + 0.7152*ch[1] + 0.0722*ch[2]) > 0.45 ? "light" : "dark"; };',
  '    var hx = function(v) { return (typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v))',
  + ' ? (/^#[0-9a-f]{3}$/i.test(v) ? "#" + v[1]+v[1]+v[2]+v[2]+v[3]+v[3] : v).toLowerCase() : ""; };',
  '    var sb = (data && typeof data.siteBg === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(data.siteBg)) ? data.siteBg : "";',
  '    if (sb) {',
  '      if (/^#[0-9a-f]{3}$/i.test(sb)) sb = "#" + sb[1]+sb[1]+sb[2]+sb[2]+sb[3]+sb[3];',
  '      sb = sb.toLowerCase();',
  '      root.dataset.siteBg = "custom";',
  '      root.dataset.siteTone = tone(sb);',
  '      root.style.setProperty("--site-bg", sb);',
  '    }',
  '    var sa = (data && typeof data.siteAccent === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(data.siteAccent)) ? data.siteAccent : "";',
  '    if (sa) {',
  '      if (/^#[0-9a-f]{3}$/i.test(sa)) sa = "#" + sa[1]+sa[1]+sa[2]+sa[2]+sa[3]+sa[3];',
  '      sa = sa.toLowerCase();',
  '      var saLight = tone(sa) === "light";',
  '      root.dataset.siteAccent = "custom";',
  '      root.style.setProperty("--site-accent", sa);',
  '      root.style.setProperty("--site-accent-hover-mix", saLight ? "#000000" : "#ffffff");',
  '      root.style.setProperty("--site-accent-ink", saLight ? "#14181c" : "#ffffff");',
  '    }',
  '    var w = data && data.wallpaper;',
  '    if (w && typeof w.name === "string" && w.name && w.enabled !== false) {',
  '      var fade = Math.min(95, Math.max(0, Math.round(Number(w.fade)) || 0));',
  '      var blur = Math.min(12, Math.max(0, Math.round(Number(w.blur)) || 0));',
  '      root.dataset.wallpaper = "on";',
  '      root.style.setProperty("--cv-wall-image", "url(\\"app://app/wallpaper?v=" + encodeURIComponent(w.name) + "\\")");',
  '      root.style.setProperty("--cv-wall-opacity", String((100 - fade) / 100));',
  '      root.style.setProperty("--cv-wall-blur", blur + "px");',
  '    }',
  '    var sw = data && data.siteWallpaper;',
  '    if (sw && typeof sw.name === "string" && sw.name && sw.enabled !== false) {',
  '      var fade2 = Math.min(95, Math.max(0, Math.round(Number(sw.fade)) || 0));',
  '      var blur2 = Math.min(12, Math.max(0, Math.round(Number(sw.blur)) || 0));',
  '      root.dataset.appWall = "on";',
  '      root.style.setProperty("--app-wall-image", "url(\"app://app/wallpaper?slot=site&v=" + encodeURIComponent(sw.name) + "\")");',
  '      root.style.setProperty("--app-wall-opacity", String((100 - fade2) / 100));',
  '      root.style.setProperty("--app-wall-blur", blur2 + "px");',
  '    }',
  '    var nb = hx(data && data.nodeBg);',
  '    if (nb) { root.dataset.nodeBg = "custom"; root.dataset.nodeTone = tone(nb); root.style.setProperty("--cv-node-bg-custom", nb); }',
  '    var nl = hx(data && data.nodeLine);',
  '    if (nl) { root.dataset.nodeLine = "custom"; root.style.setProperty("--cv-node-line-custom", nl); }',
  '    var na = hx(data && data.nodeAccent);',
  '    if (na) {',
  '      root.dataset.nodeAccent = "custom";',
  '      root.style.setProperty("--cv-node-accent-custom", na);',
  '      root.style.setProperty("--cv-node-accent-ink-custom", tone(na) === "light" ? "#14181c" : "#ffffff");',
  '    }',
  '  } catch (e) { /* 偏好坏了就当默认，绝不能因此白屏 */ }',
  '})();',
].join('\n');





