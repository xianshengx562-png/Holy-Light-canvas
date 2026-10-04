import { workflowSideOf, type RunSide } from './engineSide';
import { nodeEngineProvider } from './nodeEngine';
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
 * 排序沿用调用方给的顺序（两边都是「最近改过的在前」）。
 *
 * 🔴 `source` 指定了某一来源却一份都没有时**返回空，不回退**：用户选了「本地 ComfyUI」，
 * 我们不该悄悄拿云端那份去跑 —— 那一路花的是他自己账号里的钱。
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
  if (wanted) return pool.filter(item => providerOf(item.provider) === wanted);
  /** 「跟随」但调用方拿不到该跟哪一边（导入素材且没连节点）—— **不筛**，让上层用「上一次那份」定。 */
  return pool;
}

/**
 * 这一趟真正用哪一份。`chosenId` 是用户点名的那一份（节点上的「超清工作流」那一行）。
 *
 * 它**只在那批候选里挑**：点名了一份来源对不上的，等于想绕开「来源」那一档，不给。
 * 点名的那份不在了就退回自动挑（`pool[0]`）—— 那一刻界面那一行会说出「不在了」，
 * 所以这里安静退回不算静默失败。
 */
/**
 * Which side this upscale run goes to — reported to the server as `engine`.
 *
 * 🔴 The upscale submitter **must** send it (2026-10-04): without it the server's
 * "engine ↔ workflow" check reads the engine as absent, and every local upscale gets
 * rejected with a message telling the user to switch the engine to the value it
 * already has (see `lib/workflows/engineSide.ts`).
 *
 * The side is whatever picked the workflow in the first place: an explicit
 * `local` / `runninghub` upscale source wins; "follow" means the node's current
 * engine, and a node with no engine dropdown (imported media) falls back to the
 * side the chosen workflow itself belongs to — which is exactly what the server
 * derives from that workflow, so the two can never disagree.
 */
export function upscaleEngineOf(
  source: unknown,
  nodeSide: RunSide | null,
  workflowProvider: unknown,
): RunSide {
  const asked = String(source ?? '').trim();
  if (asked === 'local' || asked === 'runninghub') return asked;
  return nodeSide ?? workflowSideOf(workflowProvider);
}

export function upscaleWorkflowFor<T extends UpscaleWorkflowLike>(
  workflows: T[],
  purpose: GeneratorKind,
  source: string = 'follow',
  provider: 'local' | 'runninghub' | null = null,
  chosenId: unknown = '',
): T | undefined {
  const pool = upscaleWorkflowsFor(workflows, purpose, source, provider);
  return pickFrom(pool, chosenId) ?? pool[0];
}

/** 在候选里点名一份；没点名 / 点名的那份不在候选里 → `undefined`（由调用方决定回落）。 */
function pickFrom<T extends UpscaleWorkflowLike>(pool: T[], id: unknown): T | undefined {
  const wanted = String(id ?? '').trim();
  return wanted ? pool.find(item => String(item.workflowId) === wanted) : undefined;
}

/* ── 导入的素材（图片 / 视频输入节点）───────────────────────────────────────
 *
 * 这类节点**没有引擎下拉**，所以「跟随」在它们身上必须另有一条说法（2026-10-04 徐先）：
 *
 *   「超清工作流引擎跟随连接的节点；如果没有，默认使用上一次超清的工作流」
 *
 * 也就是三条，按顺序：
 *   1. 顺着**连出去**的那根线往下找第一个有引擎的节点，跟它那一边（他的例子里是
 *      一张 `pasted.png` 连着「图片生成」，引擎是 RunningHub → 超清也走 RunningHub）；
 *   2. 一个都找不到（这张画布上它就是孤立的）→ 用**上一次超清用过的那份**工作流；
 *   3. 连「上一次」都没有（第一次用）→ 候选里最近改过的那份（老行为）。
 *
 * 为什么第 1 条是「顺线找」而不是「看节点自己」：导入的素材身上压根没有引擎这个字段，
 * 而它打算喂给谁是完全看得出的一件事 —— 让用户再挑一遍等于把已经画在图上的信息问一遍。
 */

/** 画布上一条线的最小形状（React Flow 的 `Edge` 与存库格式都符合）。 */
export type CanvasEdgeLike = { source?: unknown; target?: unknown };
/** 画布上一个节点的最小形状 —— 只要认得出「它有没有引擎」和「它叫什么」。 */
export type CanvasNodeLike = {
  id?: unknown;
  data?: { kind?: unknown; engine?: unknown; label?: unknown } | null;
};

/**
 * 顺着线往**下游**找第一个有引擎的节点（广度优先，跳过中间那些没引擎的节点 ——
 * 素材先接一个中转、再进生成节点，跟的应该是生成节点那一边）。
 * 找不到返回 `null`。
 *
 * 只看下游：素材节点是**源头**（`ACCEPTS` 里 `image` / `latent` 都不接上游），
 * 所以「它要喂给谁」全在出边上。
 */
function downstreamEngineNode(
  nodeId: unknown,
  nodes: readonly CanvasNodeLike[],
  edges: readonly CanvasEdgeLike[],
): CanvasNodeLike | null {
  const from = String(nodeId ?? '').trim();
  if (!from) return null;
  const byId = new Map(nodes.map(node => [String(node?.id ?? ''), node]));
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift() as string;
    for (const edge of edges) {
      if (String(edge?.source ?? '') !== current) continue;
      const next = String(edge?.target ?? '');
      if (!next || seen.has(next)) continue;
      seen.add(next);
      const node = byId.get(next);
      if (!node) continue;
      if (nodeEngineProvider(node.data?.kind, node.data?.engine) !== null) return node;
      queue.push(next);
    }
  }
  return null;
}

/**
 * 「跟随」在这一节点上跟到的那一边（`''` = 一个都没跟到）。
 *
 * ⚠️ 调用方常常拿它在 `useStore` 的选择器里算 —— **必须返回字符串这种原始值**：
 * 返回对象的话每次 store 变化都是新引用，拖一下节点就整屏重渲染。
 */
export function upscaleFollowedSide(
  nodeId: unknown,
  nodes: readonly CanvasNodeLike[],
  edges: readonly CanvasEdgeLike[],
): RunSide | '' {
  const node = downstreamEngineNode(nodeId, nodes, edges);
  return node ? nodeEngineProvider(node.data?.kind, node.data?.engine) ?? '' : '';
}

/** 跟到的那个节点叫什么（给界面写提示用：`跟随「图片生成」的引擎`）。空串 = 没跟到。 */
export function upscaleFollowedLabel(
  nodeId: unknown,
  nodes: readonly CanvasNodeLike[],
  edges: readonly CanvasEdgeLike[],
): string {
  return String(downstreamEngineNode(nodeId, nodes, edges)?.data?.label ?? '').trim();
}

/**
 * 导入素材那一档的挑法（「超清来源」下拉在它们身上才渲染，见 `NodeParamBar`）。
 *
 * 三条按顺序，**一条都不许互相顶替**：
 *
 *   1. 跟到了某个节点（`followedSide` 非空）→ **只用那一边那份**；那一边一份都没配
 *      → **就是没有**（返回 `undefined`，由界面说清"缺的是哪一边"）。
 *      🔴 这里绝不悄悄换边：他库里就是这种情况（图超清只有本机一份，而下游「图片生成」
 *      走 RunningHub）—— 换边跑等于**他配的那个引擎被无视**，而且下一次换个配置就变成扣钱。
 *   2. 一个都没跟到（画布上它就是孤立的）→ 用**上一次超清用过的那份**；
 *   3. 连「上一次」都没有（第一次用）→ 候选里最近改过的那份。
 *
 * 指定「RunningHub / 本地 ComfyUI」那两档同样不兜底（同一条理由）。
 */
export function upscaleWorkflowForImported<T extends UpscaleWorkflowLike>(
  workflows: T[],
  purpose: GeneratorKind,
  source: string = 'follow',
  followedSide: 'local' | 'runninghub' | null = null,
  chosenId: unknown = '',
  lastUsedId: unknown = '',
): T | undefined {
  if (source !== 'follow') return upscaleWorkflowFor(workflows, purpose, source, null, chosenId);
  const pool = upscaleWorkflowsFor(workflows, purpose, 'follow', followedSide);
  const chosen = pickFrom(pool, chosenId);
  if (chosen) return chosen;
  if (followedSide !== null) return pool[0];
  const whole = upscaleWorkflowsFor(workflows, purpose, 'follow', null);
  return pickFrom(whole, lastUsedId) ?? whole[0];
}
