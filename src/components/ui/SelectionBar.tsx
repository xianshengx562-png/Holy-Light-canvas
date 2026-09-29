'use client';

/*
 * 批量选择的工具条 —— 项目页与资产页共用（2026-09-26）。
 *
 * 两页要的是同一件事：一条横条，左边说「选了几项」+ 全选/清除，中间是这一页自己的批量动作
 * （项目只有删除；资产有「打分类」和「删除」），右边退出选择。文案与布局统一在这里，
 * 两页只决定 `children` 放什么。
 *
 * 为什么把「进入选择」也做成同一个组件（`SelectionBar.Enter`）：
 * 那个入口按钮的措辞、位置、以及「未进入选择时旁边写什么」在两页应该长得一样 ——
 * 各写一遍的话，一处写「选择」另一处写「批量选择」，用户会以为是两个功能。
 */
import type { ReactNode } from 'react';
import './selection-bar.css';

/** 还没进入选择模式时那条：一句提示 + 一颗「选择」。 */
export function SelectionEnter({ title, hint, onEnter, testId }: {
  /** 按钮文案，默认「选择」。 */
  title?: string;
  hint?: string;
  onEnter: () => void;
  testId: string;
}) {
  return (
    <div className="sb sb-idle" data-sb={testId} data-sb-mode="idle">
      {hint && <span className="sb-hint muted">{hint}</span>}
      <span className="sb-spacer" />
      <button className="button secondary small" type="button" data-sb-enter onClick={onEnter}>
        {title ?? '选择'}
      </button>
    </div>
  );
}

export function SelectionBar({
  count, total, busy, onAll, onNone, onExit, children, testId,
}: {
  count: number;
  /** 当前列表里一共几项 —— 「全选」选的是**看得见的这些**（资产一次只给 60 条）。 */
  total: number;
  busy?: boolean;
  onAll: () => void;
  onNone: () => void;
  onExit: () => void;
  /** 这一页自己的批量动作。 */
  children?: ReactNode;
  testId: string;
}) {
  return (
    <div className="sb" data-sb={testId} data-sb-mode="picking">
      <strong className="sb-count" data-sb-count>{count ? `已选 ${count} 项` : '还没选'}</strong>
      <button className="subtle" type="button" data-sb-all
        disabled={busy || count === total} onClick={onAll}>全选</button>
      <button className="subtle" type="button" data-sb-none
        disabled={busy || count === 0} onClick={onNone}>清除</button>
      <span className="sb-spacer" />
      {children}
      <button className="subtle" type="button" data-sb-exit disabled={busy} onClick={onExit}>退出选择</button>
    </div>
  );
}
