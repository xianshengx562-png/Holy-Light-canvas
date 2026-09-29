'use client';

import { useEffect } from 'react';
import Link from 'next/link';

/**
 * 原来那张营销首页（2026-09-17 让位给主界面）。
 *
 * `/` 现在是登录后的创作空间，所以这份介绍文案挪到了这里：内容一字未改，
 * 只是不再占着入口。它**不占导航**（侧栏里没有它），要靠地址直接进来 ——
 * 留着是为了「以后要对外说这个站点是干什么的」时有一段现成的文案，
 * 而不是为了让人在站内点进来逛。样式沿用 `app/globals.css` 里的 `.landing` 一族。
 */
const features = [
  ['01 · 组织', '每个灵感，都有自己的空间', '以项目整理创作，从一个想法开始，随时回来继续。'],
  ['02 · 连接', '让创作，自然连接', '节点画布把提示词、参考图、续接片段与视频生成串成一条工作流。'],
  ['03 · 掌控', '你的账户，你的算力', '接入 RunningHub，使用自己的 API Key 与工作流配置。'],
];

export default function About() {
  /* 原来靠 Next 的 `export const metadata` 写标题；桌面版是单页应用，标题得自己设。 */
  useEffect(() => {
    document.title = 'Holy Light画布 — 关于这个创作空间';
  }, []);

  return (
    <div className="landing">
      <header className="topbar">
        <Link className="brand" href="/">
          <span className="brand-mark">✦</span> Holy Light画布
        </Link>
        <nav>
          <a href="#features">探索创作空间</a>
          <Link href="/login">登录</Link>
          <Link className="button" href="/">
            进入创作空间
          </Link>
        </nav>
      </header>

      <main>
        <section className="hero">
          <div>
            <div className="eyebrow">A space for your next idea</div>
            <h1>
              灵感，不该
              <br />
              止步于<span>一张画布。</span>
            </h1>
            <p className="muted">从一句想法，到完整作品。让图片、视频与 AI 工作流在同一个创作空间里，自由连接。</p>
            <div className="actions">
              <Link className="button" href="/">
                进入创作空间
              </Link>
              <Link className="button secondary" href="/settings/model-services">
                连接 RunningHub
              </Link>
            </div>
            <p className="muted" style={{ fontSize: 13, marginTop: 20 }}>
              自带 RunningHub 账户 · 算力费用由你的账户承担
            </p>
          </div>

          <div className="visual" aria-label="无限画布的概念示意">
            <div className="visual-label">Connected ideas / 01</div>
            <div className="concept-card">
              <h3>一句灵感</h3>
              <p>晨雾中的山谷，柔和的自然光，安静而辽阔的电影感。</p>
            </div>
            <div className="concept-card second">
              <h3>一帧想象</h3>
              <div className="landscape" aria-hidden />
            </div>
            <div className="visual-note">节点画布 · 把提示词、参考图与生成串成一条链路</div>
          </div>
        </section>

        <section id="features" className="features">
          {features.map(([tag, title, desc]) => (
            <article key={title}>
              <b>{tag}</b>
              <h3>{title}</h3>
              <p className="muted">{desc}</p>
            </article>
          ))}
        </section>
      </main>

      <footer>
        <span>Holy Light画布 © 2026</span>
        <span>用你自己的算力，做你自己的想法</span>
      </footer>
    </div>
  );
}
