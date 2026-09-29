'use client';

/*
 * 路由入口。全部状态都在 `VideoJoiner` 里，这一层刻意什么都不做 ——
 * 理由与另外几个工具页一致：以后「在项目里选中几段视频 → 送去拼接」
 * 要复用的是组件，不是带着路由状态的一整页。
 */
import VideoJoiner from '@/components/tools/VideoJoiner';

export default function VideoPage() {
  return <VideoJoiner />;
}
