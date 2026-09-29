'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Megaphone, X } from 'lucide-react';
import '@/app/announcement.css';
import {
  announcementFeatures, ANNOUNCEMENT_KEY, ANNOUNCEMENT_META, ANNOUNCEMENT_ORIGIN,
  ANNOUNCEMENT_VERSION,
} from '@/lib/announcement';
import { isDesktop } from '@/lib/edition';

/*
 * 功能清单按版本取：桌面版没有「余额与账单」这类条目，出图出视频的说法也要换成走本机 ComfyUI。
 * 放在模块顶层而不是每次渲染算一遍 —— `isDesktop` 是构建期内联的常量，结果不会变。
 */
const FEATURES = announcementFeatures(isDesktop);

type Tab = 'origin' | 'features';

const TABS: { id: Tab; label: string }[] = [
  { id: 'origin', label: '为什么做这个' },
  { id: 'features', label: '能做什么' },
];

/**
 * 进站公告弹窗。挂在根 layout 上，所以**进站第一屏就会弹**，不管落在哪个路由。
 *
 * 三条要紧的取舍：
 *
 * 1. **只在挂载后读 localStorage**。这一步绝不能放进 SSR：服务端压根没有 localStorage，
 *    先读再渲染必然和客户端第一帧对不上，React 会报水合不一致。所以 `open` 由 effect 决定，
 *    服务端永远渲染 null（弹窗本来也不该出现在 SSR 的 HTML 里 —— 它是客户端行为）。
 * 2. **已读记录带版本号**（`ANNOUNCEMENT_VERSION`）。存的是版本号而不是 `true`：
 *    否则改了文案也没人看得到，等于白改。
 * 3. **怎么关都算已读** —— 点按钮、按 Esc、点遮罩都一样。这只是个进站说明，
 *    不需要强扭着让人非点那颗按钮；真把人卡在弹窗里，只会让人想关掉整个站。
 *
 * 文案全在 `lib/announcement.ts`，改文案别动这里。
 */
export default function AnnouncementModal() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('origin');
  const primaryRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    try {
      localStorage.setItem(ANNOUNCEMENT_KEY, ANNOUNCEMENT_VERSION);
    } catch {
      /* 隐私模式下 localStorage 会直接抛 —— 那就不记，这次关掉下次还会弹，总比崩了强。 */
    }
    setOpen(false);
  }, []);

  useEffect(() => {
    let read = '';
    try {
      read = localStorage.getItem(ANNOUNCEMENT_KEY) || '';
    } catch {
      /* 同上：读不到就当没读过。 */
    }
    if (read !== ANNOUNCEMENT_VERSION) setOpen(true);
  }, []);

  /* Esc 关闭 + 弹窗期间锁住页面滚动（否则背后的画布能滚，视觉上很怪）。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    primaryRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="ann-overlay">
      {/* 遮罩是弹窗的**兄弟**而不是父级：点遮罩关闭时，弹窗内部的点击不会冒到这里。 */}
      <div className="ann-scrim" onClick={close} aria-hidden />
      <div className="ann-modal" role="dialog" aria-modal="true" aria-labelledby="ann-title">
        <header className="ann-head">
          <span className="ann-kicker"><Megaphone size={13} aria-hidden />{ANNOUNCEMENT_META.kicker}</span>
          <h2 id="ann-title">{ANNOUNCEMENT_META.title}</h2>
          <button type="button" className="ann-close" onClick={close} aria-label="关闭公告">
            <X size={16} aria-hidden />
          </button>
        </header>

        <nav className="ann-tabs" role="tablist" aria-label="公告内容">
          {TABS.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`ann-tab ${tab === item.id ? 'on' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="ann-body">
          {tab === 'origin' && (
            <div className="ann-section">
              {ANNOUNCEMENT_ORIGIN.map(line => <p key={line}>{line}</p>)}
            </div>
          )}

          {tab === 'features' && (
            <div className="ann-section">
              <ul className="ann-features">
                {FEATURES.map(feature => (
                  <li key={feature.title}>
                    <strong>{feature.title}</strong>
                    <span>{feature.desc}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <footer className="ann-foot">
          <span className="ann-meta">
            {ANNOUNCEMENT_META.kicker} · 更新于 {ANNOUNCEMENT_META.updatedAt}
          </span>
          <div className="ann-actions">
            <button type="button" className="ann-primary" onClick={close} ref={primaryRef}>
              知道了，开始使用
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
