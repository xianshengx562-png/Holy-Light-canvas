import { readWorkflowOperation } from './operation';
import type { GeneratorKind } from './purpose';

/**
 * 「超清」按钮要用哪一份工作流（2026-10-03 从 `src/components/canvas/nodeMeta.ts` 搬到这里）。
 *
 * 为什么必须在 `lib` 里：超清现在有**两个入口** —— 画布节点上的按钮、以及资产页里
 * 「导入的素材也要能超清」那颗（后者是服务端接口在挑）。两边各写一份筛法的话，
 * 迟早出现「画布上点得动、资产页却说没配工作流」（或者反过来），而那句报错还长得一模一样。
 *
 * 这里**不碰数据库、不引 server-only**：接口、页面下拉、回归脚本都要用同一份。
 */

/** 只要能读出这几个字段就能参与筛选 —— 画布的 `WorkflowOption` 与服务端的草稿摘要都符合。 */
export type UpscaleWorkflowLike = {
  workflowId: string;
  kind?: unknown;
  operation?: unknown;
  provider?: unknown;
};

/** 本地那一档的认法只有一处：`provider` 写着 `local` 才算本机，其余一律按云端算。 */
function providerOf(value: unknown): 'local' | 'runninghub' {
  return String(value ?? '') === 'local' ? 'local' : 'runninghub';
}

/**
 * 超清工作流的候选池：同用途 + 工序是超清（+ 来源对得上）。
 *
 * 排序沿用调用方给的顺序（两边都是「最近改过的在前」），所以「取第一条」就是取最近那份。
 *
 * 🔴 `source` 指定了某一来源却一份都没有时**返回空，不回退**：用户选了「本地 ComfyUI」，
 * 我们不该悄悄拿云端那份去跑 —— 那一路花的是他自己账号里的钱。
 * `follow` 且这一档不经过工作流（`provider` 为 null）时同样不筛。
 */
export function upscaleWorkflowsFor<T extends UpscaleWorkflowLike>(
  workflows: T[],
  purpose: GeneratorKind,
  source: string = 'follow',
  provider: 'local' | 'runninghub' | null = null,
): T[] {
  const pool = workflows.filter(
    item => String(item.kind ?? '') === purpose && readWorkflowOperation(item.operation) === 'upscale',
  );
  const wanted = source === 'follow' ? provider : (source as 'local' | 'runninghub' | null);
  if (!wanted) return pool;
  return pool.filter(item => providerOf(item.provider) === wanted);
}

/**
 * 这一趟真正用哪一份。`chosenId` 是用户点名的那一份（节点上的「超清工作流」那一行）。
 *
 * 它**只在那批候选里挑**：点名了一份来源对不上的，等于想绕开「来源」那一档，不给。
 * 点名的那份不在了就退回自动挑（`pool[0]`）—— 那一刻界面那一行会说出「不在了」，
 * 所以这里安静退回不算静默失败。
 */
export function upscaleWorkflowFor<T extends UpscaleWorkflowLike>(
  workflows: T[],
  purpose: GeneratorKind,
  source: string = 'follow',
  provider: 'local' | 'runninghub' | null = null,
  chosenId: unknown = '',
): T | undefined {
  const pool = upscaleWorkflowsFor(workflows, purpose, source, provider);
  const wanted = String(chosenId ?? '').trim();
  return (wanted ? pool.find(item => String(item.workflowId) === wanted) : undefined) ?? pool[0];
}
