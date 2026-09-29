'use client';

/*
 * 画布右上角的运行计时（2026-09-28）。
 *
 * 记的是**这一轮的耗时**：从第一个节点动起来（或点「启动」）到最后一个停下。
 * 跑完**定格留着**，不像提示条那样几秒就没 —— 要的是「记录」，而「刚刚那一轮跑了多久」
 * 正是跑完之后才想看的那个数。下一次运行开始时重新从 0 走。
 *
 * ⚠️ 每秒走字**必须关在这个组件里**：画布是个巨型组件（React Flow 整棵树都在它下面），
 *    在父层为了走字每秒 setState，等于每秒把整块画布重渲染一遍 —— 节点一多就是肉眼可见的卡。
 *    所以父层只在「开始 / 结束」那两个瞬间收到通知，中间的秒数由这个小组件自己 tick。
 *
 * `data-cv-run-clock` / `data-cv-run-clock-value` 留给探针读：探针量的是 DOM 上的字，
 * 不去猜 React 的 state。
 */
import { useEffect, useState } from 'react';

/** 这一轮运行的计时。`endedAt` 为 `null` 表示还在跑。 */
export type RunClockState = { startedAt: number; endedAt: number | null };

/**
 * `mm:ss`；超过一小时才引出小时位（`h:mm:ss`）。
 *
 * 用 `Math.max(0, …)` 兜负数：跑的过程中系统时间被改过（或休眠唤醒）时差值会是负的，
 * 直接格式化会显示成 `-01:-3` 这种东西。
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export default function RunClock({ clock }: { clock: RunClockState | null }) {
  const [, bump] = useState(0);
  const running = !!clock && clock.endedAt === null;

  useEffect(() => {
    if (!running) return;
    /*
     * 500ms 一跳，不是 1000ms：走字只要秒级就够，但定时器和真实秒的相位是对不齐的 ——
     * 1 秒一跳最多会让数字「晚将近一秒」才翻。半秒一跳把这点迟滞压到看不出来，
     * 代价只是多一次（只重渲染这十几行的）重渲染。
     */
    const timer = window.setInterval(() => bump(count => count + 1), 500);
    return () => window.clearInterval(timer);
  }, [running]);

  /* 还没跑过任何一轮就不占位 —— 顶栏不该平白多一颗「00:00」。 */
  if (!clock) return null;

  const elapsed = (clock.endedAt ?? Date.now()) - clock.startedAt;
  return (
    <div
      className={`cv-run-clock ${running ? 'running' : 'done'}`}
      data-cv-run-clock
      title={running
        ? '这一轮从开始跑到现在用了多久'
        : '上一轮运行的总用时（下次运行开始时重新计时）'}
    >
      <span className="cv-run-clock-label">{running ? '运行中' : '用时'}</span>
      <strong data-cv-run-clock-value>{formatDuration(elapsed)}</strong>
    </div>
  );
}
