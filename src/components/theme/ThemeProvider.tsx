'use client';

import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import {
  APPEARANCE_KEY, applyAppearance, DEFAULT_APPEARANCE, isPaletteId, parseAppearance,
  type Appearance, type PaletteId, type ThemeMode, type Wallpaper,
} from '@/lib/appearance';
import { pickWallpaperFile, removeWallpaperFile } from '@/lib/wallpaper';

type AppearanceContextValue = {
  /** null = 还没从 localStorage 读出来（首帧，防 SSR 注水不一致） */
  appearance: Appearance | null;
  /** 实际生效的深浅色，system 已经解析过 */
  resolved: 'dark' | 'light';
  /** 用户选的那一档（可能是 `system`）。判断「选了哪一档」要用它，不能用 `resolved`。 */
  themeMode: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  /** `setTheme` 的别名，语义更直白：点的是「模式」而不是「主题」。 */
  setThemeMode: (theme: ThemeMode) => void;
  /** 换配色（只换强调色那一支）。 */
  setPalette: (palette: PaletteId) => void;
  setCanvasBg: (color: string | null) => void;
  /** 画布节点的底色 / 描边 / 强调色。null = 跟随画布那一支。 */
  setNodeBg: (color: string | null) => void;
  setNodeLine: (color: string | null) => void;
  setNodeAccent: (color: string | null) => void;
  /** 全站底色 / 强调色。null = 跟随主题（由配色那一档决定强调色）。 */
  setSiteBg: (color: string | null) => void;
  setSiteAccent: (color: string | null) => void;
  /** 全站背景图的淡化 / 模糊 / 启停。图片本体由 uploadSiteWallpaper / clearSiteWallpaper 管。 */
  setSiteWallpaper: (patch: Partial<Omit<Wallpaper, 'name'>>) => void;
  /** 选一张本机图片当全站背景。 */
  uploadSiteWallpaper: () => Promise<{ ok: boolean; message?: string }>;
  clearSiteWallpaper: () => Promise<{ ok: boolean; message?: string }>;
  /** 收 / 展左侧导航。 */
  setNavCollapsed: (collapsed: boolean) => void;
  /**
   * 界面大小（百分比，见 `UI_SCALE`）。100 = 原始尺寸。
   * ⚠️ 这个值**不从 `<html>` 上反读**（`readFromDom` 里没有它）：DOM 上的 `--ui`
   *    是本次会话早先写上去的，而 localStorage 可能刚被别人改过 —— 反读会让旧值赢，
   *    正是 `readFromDom` 那条注释里记的那个坑。整份偏好里只有它走"永远以盘为准"。
   */
  setUiScale: (uiScale: number) => void;
  /** 背景图的淡化 / 模糊 / 启停。图片本体由 uploadWallpaper / clearWallpaper 管。 */
  setWallpaper: (patch: Partial<Omit<Wallpaper, 'name'>>) => void;
  /** 选一张本机图片当背景。会做格式 / 体积 / 像素校验并把字节交给主进程落盘。 */
  uploadWallpaper: () => Promise<{ ok: boolean; message?: string }>;
  /** 删掉背景图（连文件一起删）。 */
  clearWallpaper: () => Promise<{ ok: boolean; message?: string }>;
  reset: () => void;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

/* useLayoutEffect 在客户端要先于绘制跑，才能在首帧就换上正确的选中态；
   服务端渲染阶段它会报警告，所以降级成 useEffect。 */
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function prefersDark(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 从 <html> 上反读当前状态——防闪脚本已经把它写好了，不必再算一遍。
   读不到就返回 null，让调用方退回 localStorage 里的值。 */
function readFromDom(): {
  theme: ThemeMode | null; palette: PaletteId | null; canvasBg: string | null;
  nodeBg: string | null; nodeLine: string | null; nodeAccent: string | null;
  siteBg: string | null; siteAccent: string | null; nav: boolean | null;
} {
  const root = document.documentElement;
  const mode = root.dataset.themeMode;
  const theme: ThemeMode | null =
    mode === 'light' || mode === 'system' || mode === 'dark' ? mode : null;
  const palette: PaletteId | null = isPaletteId(root.dataset.palette) ? root.dataset.palette : null;
  const bg = root.style.getPropertyValue('--cv-floor-custom').trim();
  const nodeBg = root.style.getPropertyValue('--cv-node-bg-custom').trim() || null;
  const nodeLine = root.style.getPropertyValue('--cv-node-line-custom').trim() || null;
  const nodeAccent = root.style.getPropertyValue('--cv-node-accent-custom').trim() || null;
  const siteBg = root.style.getPropertyValue('--site-bg').trim() || null;
  const siteAccent = root.style.getPropertyValue('--site-accent').trim() || null;
  const nav = root.dataset.nav;
  return {
    theme,
    palette,
    canvasBg: bg || null,
    nodeBg,
    nodeLine,
    nodeAccent,
    siteBg,
    siteAccent,
    nav: nav === 'collapsed' ? true : nav === 'expanded' ? false : null,
  };
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance | null>(null);
  const [resolved, setResolved] = useState<'dark' | 'light'>('dark');
  // 只在「用户自己改」时才写盘；初始化那一次不要回写，否则会覆盖掉别的标签页。
  const hydrated = useRef(false);
  /*
   * 当前偏好的**最新值**（不是 state）。
   *
   * 必须留这份：一个点击事件里连着调两个 setter 时（比如「跟随主题」要同时把
   * 底色和强调色清成 null），React 会把两次更新批处理，两个 setter 闭包里读到的
   * `appearance` 是**同一个旧值** —— 后一次 commit 会把前一次改的东西原样盖回去。
   * 实测症状就是「点了跟随主题，强调色清了、底色还在」。
   * 所有 setter 都从这份 ref 取基准，连续调用就不会互相吃掉。
   */
  const latest = useRef<Appearance>(DEFAULT_APPEARANCE);

  useIsoLayoutEffect(() => {
    const stored = parseAppearance(window.localStorage.getItem(APPEARANCE_KEY));
    const initial = readFromDom();
    /*
     * ⚠️ Next 版这里读的是「防闪内联脚本写在 <html> 上的值」，所以 `??` 是对的：
     *    DOM 上有的就是**这一次页面加载**真正解析出来的东西。
     *
     *    桌面版（纯客户端渲染，`src/main.tsx`）没有那个脚本，`applyAppearance` 只在
     *    module 初始化时跑一次，于是有一个很隐蔽的坑：
     *    **运行中手写 localStorage 之后 reload，`readFromDom()` 拿到的仍是这一次会话
     *    早先那个值**（`<html>` 上的属性是 React 自己写的，没人再重读过 localStorage），
     *    而 localStorage 里已经是新值了 —— `??` 会让旧值赢，新值被原样吞掉。
     *
     *    这一条不是理论：探针里 `setPref()` 之后接着 reload，本来该生效的改动总是
     *    「没反应」，一路看起来像产品坏了（"预设没写进去""跟随系统的勾不听话"）。
     *    真相是它生效不了：React 挂载时用一个更旧的快照把 localStorage 又盖了回去。
     *
     *    所以这里要**先比一遍**：两边对得上就照旧信 DOM（它能表达比 localStorage 更多
     *    的东西，比如系统深浅），对不上说明有人绕过 React 改了盘，那就以盘为准。
     */
    const normalized = (a: Appearance) => JSON.stringify({
      theme: a.theme, palette: a.palette, canvasBg: a.canvasBg,
      nodeBg: a.nodeBg, nodeLine: a.nodeLine, nodeAccent: a.nodeAccent,
      siteBg: a.siteBg, siteAccent: a.siteAccent, navCollapsed: a.navCollapsed,
      wallpaper: a.wallpaper, siteWallpaper: a.siteWallpaper,
    });
    const domMatchesStored = normalized({
      theme: initial.theme ?? stored.theme,
      palette: initial.palette ?? stored.palette,
      canvasBg: initial.canvasBg ?? stored.canvasBg,
      nodeBg: initial.nodeBg ?? stored.nodeBg,
      nodeLine: initial.nodeLine ?? stored.nodeLine,
      nodeAccent: initial.nodeAccent ?? stored.nodeAccent,
      navCollapsed: initial.nav ?? stored.navCollapsed,
      siteBg: initial.siteBg ?? stored.siteBg,
      siteAccent: initial.siteAccent ?? stored.siteAccent,
      /* 界面大小不从 DOM 反读（见 `setUiScale` 注释），两边取的都是盘上那份 ——
         所以它**不影响**上面这个"对不对得上"的判断。 */
      uiScale: stored.uiScale,
      wallpaper: stored.wallpaper,
      siteWallpaper: stored.siteWallpaper,
    }) === normalized(stored);
    /* 对不上就整份以盘为准（连背景图一起）—— 盘上那份才是完整的偏好。 */
    const dom = domMatchesStored ? initial : null;

    const merged: Appearance = {
      theme: dom?.theme ?? stored.theme,
      palette: dom?.palette ?? stored.palette,
      canvasBg: dom?.canvasBg ?? stored.canvasBg,
      nodeBg: dom?.nodeBg ?? stored.nodeBg,
      nodeLine: dom?.nodeLine ?? stored.nodeLine,
      nodeAccent: dom?.nodeAccent ?? stored.nodeAccent,
      /* 防闪脚本会把 dataset.nav 写好，对得上时优先信它。 */
      navCollapsed: dom?.nav ?? stored.navCollapsed,
      /* 界面大小**只从盘上读**（见 `setUiScale` 那条注释）：DOM 上的 `--ui` 是本会话
         早先写上去的，拿它跟盘比会让旧值赢。 */
      uiScale: stored.uiScale,
      /* 背景图不需要从 <html> 上反读：它的变量是整体写在 dataset.wallpaper 上的，
         而这一层本来就保存着 image 的全部参数。 */
      siteBg: dom?.siteBg ?? stored.siteBg,
      siteAccent: dom?.siteAccent ?? stored.siteAccent,
      wallpaper: stored.wallpaper,
      siteWallpaper: stored.siteWallpaper,
    };
    latest.current = merged;
    setAppearance(merged);
    applyAppearance(merged, prefersDark());
    setResolved(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    hydrated.current = true;
  }, []);

  // 跟随系统：系统深浅色变了要跟着变
  useEffect(() => {
    if (appearance?.theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      applyAppearance(appearance, mq.matches);
      setResolved(mq.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [appearance]);

  // 多标签页同步
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_KEY) return;
      const next = parseAppearance(event.newValue);
      latest.current = next;
      setAppearance(next);
      applyAppearance(next, prefersDark());
      setResolved(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const commit = useCallback((next: Appearance) => {
    latest.current = next;
    setAppearance(next);
    const dark = prefersDark();
    applyAppearance(next, dark);
    setResolved(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    try {
      window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式下写不了盘：本次会话照样生效，刷新会丢，不值得吵用户 */
    }
  }, []);

  const value = useMemo<AppearanceContextValue>(() => {
    /* 取**最新**那份（见 `latest` 那条注释）：同一个事件里连调两个 setter 才不会互相盖。 */
    const base = () => latest.current;
    return {
      appearance,
      resolved,
      themeMode: appearance?.theme ?? DEFAULT_APPEARANCE.theme,
      setTheme: (theme: ThemeMode) => commit({ ...base(), theme }),
      setThemeMode: (theme: ThemeMode) => commit({ ...base(), theme }),
      setPalette: (palette: PaletteId) => commit({ ...base(), palette }),
      setCanvasBg: (canvasBg: string | null) => commit({ ...base(), canvasBg }),
      setNodeBg: (nodeBg: string | null) => commit({ ...base(), nodeBg }),
      setNodeLine: (nodeLine: string | null) => commit({ ...base(), nodeLine }),
      setNodeAccent: (nodeAccent: string | null) => commit({ ...base(), nodeAccent }),
      setSiteBg: (siteBg: string | null) => commit({ ...base(), siteBg }),
      setSiteAccent: (siteAccent: string | null) => commit({ ...base(), siteAccent }),
      setSiteWallpaper: (patch) => commit({ ...base(), siteWallpaper: { ...base().siteWallpaper, ...patch } }),
      async uploadSiteWallpaper() {
        const picked = await pickWallpaperFile('site');
        if (!picked.ok) return { ok: false, message: picked.message };
        /* 和画布那份同一个顺序：先落盘再写偏好，否则会出现「偏好里有文件名、盘上没有图」。 */
        commit({ ...base(), siteWallpaper: { ...base().siteWallpaper, name: picked.name, enabled: true } });
        return { ok: true };
      },
      async clearSiteWallpaper() {
        const removed = await removeWallpaperFile('site');
        commit({ ...base(), siteWallpaper: { ...base().siteWallpaper, name: '' } });
        return removed.ok ? { ok: true } : { ok: true, message: removed.message };
      },
      setNavCollapsed: (navCollapsed: boolean) => commit({ ...base(), navCollapsed }),
      setUiScale: (uiScale: number) => commit({ ...base(), uiScale }),
      setWallpaper: (patch) => commit({ ...base(), wallpaper: { ...base().wallpaper, ...patch } }),
      async uploadWallpaper() {
        const picked = await pickWallpaperFile();
        if (!picked.ok) return { ok: false, message: picked.message };
        /* 先落盘再改偏好：写偏好是**同步并且会被吞掉异常的**（隐私模式、超额），
           反过来的话就会出现「偏好里写了文件名、数据目录里没有这张图」——
           画布上是一片空白，而查起来毫无线索。 */
        commit({ ...base(), wallpaper: { ...base().wallpaper, name: picked.name, enabled: true } });
        return { ok: true };
      },
      async clearWallpaper() {
        const removed = await removeWallpaperFile();
        /* 文件删不掉也要把偏好清掉：用户点的是「移除」，界面上就该没有这张图了。
           残留的文件在下一次上传时会被同名覆盖。 */
        commit({ ...base(), wallpaper: { ...base().wallpaper, name: '' } });
        return removed.ok ? { ok: true } : { ok: true, message: removed.message };
      },
      reset: () => commit({
        ...DEFAULT_APPEARANCE,
        wallpaper: { ...DEFAULT_APPEARANCE.wallpaper },
        siteWallpaper: { ...DEFAULT_APPEARANCE.siteWallpaper },
      }),
    };
  }, [appearance, resolved, commit]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error('useAppearance 必须在 ThemeProvider 内使用');
  return ctx;
}
