'use client';

/*
 * 路由入口。工具的全部状态都在 `MosaicTool` 里，这一层刻意什么都不做 ——
 * 理由与另外两个工具页一致：以后「从资产右键 → 给人脸打码」要复用的是组件，
 * 不是带着路由状态的一整页。
 */
import MosaicTool from '@/components/tools/MosaicTool';

export default function MosaicPage() {
  return <MosaicTool />;
}
