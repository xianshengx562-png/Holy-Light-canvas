import type { Node } from '@xyflow/react';
import { NODE_META, isVideoUrl, type NodeKind } from './nodeMeta';
import { defaultWorkflowId } from '@/lib/workflows/defaults';
import type { GenerationRun, NodeData } from './types';

/**
 * 汇总一张画布上所有节点的生成记录，最新的排在最前。
 *
 * 老画布上只有 `resultUrl`（还没有生成记录这一说），这里为它补一条「第 1 次」，
 * 免得升级之后以前生成的东西全部消失。
 *
 * ⚠️ 它待在自己的文件里，是因为**两个地方要用同一套汇总规则**：
 * 画布自己那一份（`CanvasEditor`），和右上角「生成结果」侧边栏里那一份
 * （`CanvasResultsPanel`，要按这个规则去汇总**别的**画布）。两边各写一份的话，
 * 迟早会出现「同一张画布在两处列出的次数不一样」。
 */
export function collectRuns(nodes: Node<NodeData>[]): GenerationRun[] {
  const runs: GenerationRun[] = [];
  for (const node of nodes) {
    const label = String(node.data.label || NODE_META[node.data.kind as NodeKind]?.label || '');
    const own = (node.data.runs || []) as GenerationRun[];
    if (own.length) {
      /* `nodeId` 只在这里补：历史浮层要靠它「点一项回到那个节点」，而存进画布的那份不带。 */
      runs.push(...own.map(run => ({ ...run, nodeLabel: label, nodeId: node.id })));
      continue;
    }
    const url = String(node.data.resultUrl || '');
    if (!url) continue;
    runs.push({
      id: `${node.id}-legacy`,
      index: 1,
      workflowId: String(node.data.workflowId || defaultWorkflowId),
      at: '',
      ts: 0,
      status: 'success',
      results: [{ url, kind: isVideoUrl(url) ? 'video' : 'image' }],
      nodeLabel: label,
      nodeId: node.id,
    });
  }
  return runs.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}
