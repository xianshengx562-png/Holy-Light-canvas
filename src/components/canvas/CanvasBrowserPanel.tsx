'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Images, RotateCw } from 'lucide-react';
import {
  CLOSED_BROWSER_STATE, browserCommand, closeBrowser, grabBrowserImage, navigateBrowser,
  normalizeTypedAddress, onBrowserState, openBrowser, readBrowserPageImages, setBrowserBounds,
  type BrowserPageImage, type BrowserRect, type BrowserState,
} from '@/lib/desktop-browser';

/**
 * 画布里的内置浏览器面板。
 *
 * ⚠️ 面板里**没有** `<webview>` / `<iframe>`：网页跑在主进程创建的另一个
 * `WebContentsView` 里，这个组件只负责画外壳（工具条 + 边框），
 * 中间那块 `cv-browser-slot` 是一个**空的占位区**，网页视图由主进程盖在它上面。
 *
 * 这么绕一圈唯一的理由是不可信内容：网页必须待在一个没有 preload、没有 Node、
 * 拿不到本应用 Cookie 的独立分区里。塞进 iframe 就做不到这几点
 * （同源策略保护的是网站，不是宿主应用）。
 *
 * 代价是两边得一直对齐位置 —— 所以下面有一整套「量矩形 → 报给主进程」的逻辑，
 * 而且必须在**每次布局变化**时重报，否则网页会停在旧位置、和面板错开。
 */

/**
 * 关闭不归这个面板管 —— 它住在右侧抽屉里，关抽屉是 `CanvasDrawer` 头部的那个 X。
 * 以前这里自己带一个关闭按钮，抽屉上再加一个就是两个 X 并排，用户会猜哪个关的是「整个」。
 */
export default function CanvasBrowserPanel() {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<BrowserState>(CLOSED_BROWSER_STATE);
  /** 地址栏里显示的字。它和 `state.url` 是两回事：用户正在敲的时候不能被推送覆盖掉。 */
  const [address, setAddress] = useState('');
  /** 本页图片列表。`null` = 没展开；关掉也回 null，不留上一页的旧图。 */
  const [images, setImages] = useState<BrowserPageImage[] | null>(null);

  const rectOf = useCallback((): BrowserRect | null => {
    const el = slotRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    /* 取整：小数坐标来回上报会让视图每帧抖一次（亚像素累积）。 */
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }, []);

  /*
   * 打开、订阅、跟随尺寸 —— 三件事都在挂载时做一次，卸载时一起收掉。
   *
   * `useLayoutEffect` 而不是 `useEffect`：占位区要先有真实的几何位置才能把矩形报过去，
   * 用 useEffect 会先画一帧空面板，主进程那边的视图就会有一次可见的错位。
   */
  useLayoutEffect(() => {
    const rect = rectOf();
    if (!rect) return;
    void openBrowser(rect).then(next => { if (next) setState(next); });

    const off = onBrowserState(setState);

    /*
     * 尺寸跟随。**只 observe 占位区本身**而不是整个面板：面板宽高变化时占位区一定跟着变，
     * 而反过来（比如工具条里出现加载动画）占位区没变，就不必白报一次。
     */
    const observer = new ResizeObserver(() => {
      const next = rectOf();
      if (next) setBrowserBounds(next);
    });
    if (slotRef.current) observer.observe(slotRef.current);

    /* 窗口缩放时占位区的 rect 也会变，但 ResizeObserver **不保证**在这种情况下触发
       （元素相对窗口的位置变了，尺寸可能没变）—— 所以补一个 window resize。 */
    const onWindowResize = () => {
      const next = rectOf();
      if (next) setBrowserBounds(next);
    };
    window.addEventListener('resize', onWindowResize);

    /*
     * **抽屉滑完之后必须再量一次。**
     *
     * 挂载那一刻抽屉还在屏幕外（`translateX(100%)`），占位区量出来的坐标也在屏幕外 ——
     * 主进程会老老实实把网页视图放到那儿，然后就再也没人通知它「现在到位了」：
     * 滑入动画是 transform，元素的**尺寸**一点没变，ResizeObserver 不会响，
     * window resize 也不会响。结果就是抽屉里空着一块，网页停在屏幕外。
     *
     * `transitionend` 会从抽屉那一层冒泡上来，正好是「滑完了」这个时刻。
     */
    const onSettled = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.classList || !target.classList.contains('cv-drawer')) return;
      const next = rectOf();
      if (next) setBrowserBounds(next);
    };
    /* 抽屉的进出场是 CSS animation（不是 transition），但两种事件都收：
       万一哪天改回 transition，这里不用跟着改一遍。 */
    window.addEventListener('animationend', onSettled);
    window.addEventListener('transitionend', onSettled);
    /* 兜底：动画被打断（比如开着抽屉又点了入口）时 transitionend 不一定来， settled 自己量一次。 */
    const settle = setTimeout(() => {
      const next = rectOf();
      if (next) setBrowserBounds(next);
    }, 360);

    return () => {
      off();
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('animationend', onSettled);
      window.removeEventListener('transitionend', onSettled);
      clearTimeout(settle);
      /*
       * 卸载即关闭：这条是整个生命周期里最容易漏、漏了后果最严重的一条。
       * 面板关了而视图还挂在窗口上 → 用户看到一块死掉的网页浮在画布上，
       * 而主进程那边还以为它开着。hash 路由下切页面不会触发整页导航事件，
       * 所以主进程兜不住，只能靠这里。
       */
      void closeBrowser();
    };
  }, [rectOf]);

  /** 地址栏跟着真实页面走 —— 但用户正在输入时不抢。 */
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    setAddress(state.url || '');
  }, [state.url]);

  const go = useCallback(() => {
    const target = normalizeTypedAddress(address);
    if (!target) return;
    void navigateBrowser(target).then(next => { if (next) setState(next); });
  }, [address]);

  const command = useCallback((name: 'back' | 'forward' | 'reload' | 'stop') => {
    void browserCommand(name).then(next => { if (next) setState(next); });
  }, []);

  const toggleImages = useCallback(() => {
    if (images) {
      setImages(null);
      return;
    }
    void readBrowserPageImages().then(setImages);
  }, [images]);

  /** 展开着的时候换页要重列一次：留着上一页的图，点下去取到的还是旧页的地址。 */
  useEffect(() => {
    if (!images) return;
    void readBrowserPageImages().then(setImages);
    /* 只在地址变化时重列：把 `images` 放进依赖会因为 setState 再触发一次，来回打转。 */
  }, [state.url]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cv-browser" role="region" aria-label="内置浏览器">
      <div className="cv-browser-head">
        <button
          className="cv-browser-btn"
          type="button"
          aria-label="后退"
          data-tip="后退"
          disabled={!state.canGoBack}
          onClick={() => command('back')}
        >
          <ArrowLeft size={14} strokeWidth={2} aria-hidden />
        </button>
        <button
          className="cv-browser-btn"
          type="button"
          aria-label="前进"
          data-tip="前进"
          disabled={!state.canGoForward}
          onClick={() => command('forward')}
        >
          <ArrowRight size={14} strokeWidth={2} aria-hidden />
        </button>
        {/* 加载中变成「停止」，加载完变回「刷新」：两个状态共用一个位置，
            用户不用在停/刷之间猜现在该点哪个。 */}
        <button
          className="cv-browser-btn"
          type="button"
          aria-label={state.loading ? '停止' : '刷新'}
          data-tip={state.loading ? '停止' : '刷新'}
          onClick={() => command(state.loading ? 'stop' : 'reload')}
        >
          <RotateCw size={14} strokeWidth={2} aria-hidden className={state.loading ? 'cv-spin' : ''} />
        </button>

        <input
          ref={inputRef}
          className="cv-browser-addr"
          value={address}
          spellCheck={false}
          placeholder="输入网址或搜索词，回车打开"
          aria-label="网址"
          onChange={event => setAddress(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            go();
          }}
        />

        {/* 本页图片：网页上右键单张图也能「发送到画布」，这里是「一次铺开挑」。 */}
        <button
          className="cv-browser-btn"
          type="button"
          aria-label="本页图片"
          data-tip="本页图片 · 点一张进画布"
          data-browser-images=""
          aria-pressed={Boolean(images)}
          onClick={toggleImages}
        >
          <Images size={14} strokeWidth={2} aria-hidden />
        </button>
        {/*
          这里**没有**关闭按钮：面板现在住在右侧抽屉里，关闭由抽屉头部的那个 X 负责
          （见 CanvasDrawer）。留两个 X 并排，用户只会猜哪个是「关掉整个」。
          `onClose` 仍然保留 —— 抽屉的关闭走的是同一个回调。
        */}
      </div>

      {/*
        占位区。**里面什么都不放** —— 网页是主进程盖在它上面的一层，不是它的子节点。
        给一个背景色是为了开面板到网页画出来之间那几十毫秒不闪白。
      */}
      <div className="cv-browser-slot" ref={slotRef} />

      {images ? (
        <div className="cv-browser-images" data-browser-image-list="">
          {images.length ? (
            images.map((image, index) => (
              <button
                key={`${image.url}-${index}`}
                className="cv-browser-thumb"
                type="button"
                data-browser-thumb=""
                aria-label={`把第 ${index + 1} 张图放进画布`}
                data-tip="放进画布"
                onClick={() => grabBrowserImage(image.url)}
              >
                {/* 缩略图只是「看一眼」：真正取字节的是主进程，所以这里加载失败
                    （比如站点不允许外链）也不影响点下去那一下。 */}
                <img
                  src={image.url}
                  alt=""
                  loading="lazy"
                  onError={event => { event.currentTarget.dataset.failed = '1'; }}
                />
              </button>
            ))
          ) : (
            <p className="cv-browser-images-empty">这一页没找到能用的图片（小于 64px 的不算）。</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
