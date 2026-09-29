'use client';

/*
 * 路由入口。工具的全部状态都在 `MotionTool` 里，这一层刻意什么都不做 ——
 * 理由与分割页那一层一致：以后「从资产里选一张图 → 加运镜」要复用的是组件，
 * 不是带着路由状态的一整页。
 */
import MotionTool from '@/components/tools/MotionTool';

export default function MotionPage() {
  return <MotionTool />;
}
