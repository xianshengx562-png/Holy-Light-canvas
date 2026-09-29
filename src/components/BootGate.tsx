'use client';

/*
 * 启动画面（徐先 2026-09-26：「添加打开软件的加载界面（如果需要加载的话）」）。
 *
 * 这一层只负责**收尾**：告诉 `index.html` 里那块牌子「可以撤了」。牌子本身是**内联**的
 * （HTML + CSS + 一小段脚本），不等 JS bundle —— 2MB 的包还在解析的时候它就已经画在屏幕上了，
 * 这正是它能盖住「窗口出来了、界面还是空的」那一段的原因。
 *
 * 撤牌子的判据是**会话第一问回来了**：那个请求在冷启动实测要 1300ms 才回来
 * （见 `client.ts` 里 `DESKTOP_PLACEHOLDER` 那段），回来之前页面自己也不确定现在是谁，
 * 于是会先画出一整块登录引导 —— 牌子要盖的就是这段。
 *
 * ⚠️ 另有两道兜底，缺一不可：
 *   - 这个组件自己有一个 2500ms 的上限：万一某一页根本没问会话（比如登录页），
 *     牌子不会一直挂着；
 *   - `index.html` 里那段内联脚本有 6000ms 的硬撤 —— 连 JS 都挂了它也照撤
 *     （它不依赖 bundle）。
 */
import { useEffect } from 'react';
import { whenSessionReady } from '@/lib/client';

declare global {
  // eslint-disable-next-line no-var
  interface Window {
    /** 由 `index.html` 的内联脚本定义 —— 它不依赖 JS bundle，所以永远在。 */
    __frameBootReady?: () => void;
  }
}

/** 牌子最长挂多久（没人来报「好了」时自己撤）。 */
const FALLBACK_MS = 2500;

export default function BootGate() {
  useEffect(() => {
    let raf = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      /*
       * 撤之前先让浏览器**真的画出一帧**首屏。
       * 不然会出现「牌子没了、底下还是空的」—— 那比不盖还难看。
       */
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => window.__frameBootReady?.());
      });
    };
    const off = whenSessionReady(finish);
    const timer = window.setTimeout(finish, FALLBACK_MS);
    return () => {
      off();
      window.clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return null;
}
