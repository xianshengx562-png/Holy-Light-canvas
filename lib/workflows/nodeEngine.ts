import type { RunSide } from './engineSide';
import { imageEngineProvider } from './imageEngine';
import { videoEngineProvider } from './videoEngine';

/**
 * 这个节点**当前**会把活交给哪一边（`local` / `runninghub`）。
 *
 * 视频网关 / 自定义接口那两档不经过工作流，返回 `null` = 「这一档不按来源筛」。
 * 抽出来是因为「引擎 ↔ 工作流来源」这道对账在生成、超清、按钮可见性三处都要用，
 * 各写一遍迟早会有一处漏掉应用节点（`app-generate` 没有引擎这一说）。
 *
 * 2026-10-04 从 `src/components/canvas/nodeMeta.ts` 搬到这里：超清那一档新的
 * 「跟随连出去的那个节点」规则（`lib/workflows/upscale.ts` 的 `upscaleFollowedSide`）
 * 也要认引擎，而 **`lib` 绝不能反过来 import `src`**（服务端也加载这些模块）。
 * `nodeMeta` 原样转出，所有既有 import 点不用改 —— 实现仍然只有一份。
 */
export function nodeEngineProvider(kind: unknown, engine: unknown): RunSide | null {
  if (kind === 'image-generate') return imageEngineProvider(engine);
  if (kind === 'video-generate') return videoEngineProvider(engine);
  return null;
}
