'use client';
import {
  AppWindow,
  Blocks,
  Clapperboard,
  Film,
  Frame,
  Image as ImageIcon,
  ImageDown,
  Images,
  Layers,
  Move3d,
  Music,
  Type,
  Video,
  Wand2,
  Waypoints,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { NodeKind } from './nodeMeta';

/**
 * 节点用什么符号。
 *
 * ⚠️ 这里挑图标的标准是**一眼能认出来**，不是「别致」：图片给带山和太阳的方框，
 * 视频给方框 + 播放三角，音频给音符。2026-09-20 之前音频用的是 `AudioLines`
 * （三根竖条），和「图片减号」「图片加号」那一类分不开，用户看不到是音频。
 *
 * 同一张表被三处复用：卡片标题、左侧悬浮工具条、右键「添加节点」菜单。
 * 后两处**只画图标、不写文字**（用户明确要求），所以这里的图标必须自己把意思说清楚 ——
 * 挑一个抽象的符号（`Sparkles`）配上没有文字的按钮，就等于什么都没有。
 * 卡片标题和状态栏仍然用 `NODE_META.label`，那是给人读的名字，不是按钮上的说明。
 */
export const NODE_ICON: Record<NodeKind, LucideIcon> = {
  text: Type,
  image: ImageIcon,
  latent: Layers,
  'latent-relay': Waypoints,
  workflow: Workflow,
  params: Blocks,
  'video-generate': Clapperboard,
  'image-generate': Images,
  'app-generate': AppWindow,
  video: Film,
  'video-input': Video,
  'audio-input': Music,
  'image-out': ImageDown,
  'frame-extract': Frame,
  /* 导演台 = 在三维里挪东西：立方体带三根轴的那个符号，一眼能认出「3D」。 */
  director: Move3d,
  /* 优化提示词 = 一句话被「点一下」变成另一段：魔法棒最贴切（星星那颗太抽象）。 */
  'prompt-optimize': Wand2,
};

export function NodeGlyph({ kind, size = 13 }: { kind: NodeKind; size?: number }) {
  const Icon = NODE_ICON[kind] || ImageIcon;
  return <Icon size={size} strokeWidth={1.75} aria-hidden />;
}
