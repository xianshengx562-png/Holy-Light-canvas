import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { callApi, transportState } from './api';
import { dataRoot, dbDir } from './runtime';
import { dbEngine } from '@/lib/db';
import {
  ACCEPTS, CREATE_KINDS, NODE_META, canConnect, connectionHint, newNodeData, purposeOfNode,
  upscaleWorkflowFor, type NodeKind,
} from '@/src/components/canvas/nodeMeta';
import { readInstanceType } from '@/lib/workflows/instanceType';

/*
 * 工具的实现。**这里没有一条业务规则是 MCP 自己写的** —— 连线合法性用 `canConnect`、
 * 新节点的默认值用 `newNodeData`、超清工作流的挑选用 `upscaleWorkflowFor`、
 * 生成请求最终仍然是 `server/api/projects/[id]/generation` 那条路由在校验和提交，
 * 全都是 Holy Light画布自己正在用的那一处定义。
 *
 * ⚠️ 唯一属于 MCP 自己的逻辑是「读—改—写」这一段（`mutateCanvas`）：
 *    它是「外部编辑器」这个身份绕不开的动作 —— 应用自己的编辑器是在内存里改完整个 state 再发一次整张画布，
 *    而 MCP 只能通过接口拿到那份快照，必须先读回来、改完再整张写回去。
 */

export type ToolInput = Record<string, unknown>;

export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: ToolInput) => Promise<unknown>;
};

/* ------------------------------------------------------------------ 取值辅助 */

class BadInput extends Error {}

function text(input: ToolInput, key: string): string | undefined {
  const raw = input[key];
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value || undefined;
}

function needed(input: ToolInput, key: string): string {
  const value = text(input, key);
  if (!value) throw new BadInput(`缺少必填参数 ${key}。`);
  return value;
}

function number_(input: ToolInput, key: string): number | undefined {
  const raw = input[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new BadInput(`参数 ${key} 必须是数字，收到的是 ${JSON.stringify(raw)}。`);
  return value;
}

function record(input: ToolInput, key: string): Record<string, unknown> | undefined {
  const raw = input[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadInput(`参数 ${key} 必须是一个对象。`);
  return raw as Record<string, unknown>;
}

function truthy(input: ToolInput, key: string): boolean {
  return input[key] === true || input[key] === 'true';
}

/* ------------------------------------------------------------------ 画布读写 */

type Point = { x: number; y: number };
type CanvasNode = { id: string; type?: string; position: Point; data: Record<string, unknown> };
type CanvasEdge = { id: string; source: string; target: string; type?: string };
type CanvasDoc = { nodes: CanvasNode[]; edges: CanvasEdge[]; viewport: { x: number; y: number; zoom: number }; version?: number };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nodeName(node: CanvasNode): string {
  const label = String(node.data?.label || '').trim();
  if (label) return label;
  const kind = String(node.data?.kind || '') as NodeKind;
  return NODE_META[kind]?.label || kind || '未命名节点';
}

function nodeKind(node: CanvasNode): string {
  return String(node.data?.kind || '');
}

async function readCanvas(projectId: string): Promise<CanvasDoc> {
  const result = await callApi('GET', `/api/projects/${projectId}/canvas`);
  const body = result.body as Partial<CanvasDoc>;
  if (!Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
    throw new BadInput('这份画布的格式不对（没有 nodes / edges），先打开 Holy Light画布新建一个项目试试。');
  }
  return {
    nodes: body.nodes as CanvasNode[],
    edges: body.edges as CanvasEdge[],
    viewport: body.viewport ?? { x: 0, y: 0, zoom: 1 },
    version: typeof body.version === 'number' ? body.version : undefined,
  };
}

/**
 * 读—改—写。
 *
 * `version` 必须原样带回去：服务端拿它做乐观锁（`updateMany where version`），对不上回 409。
 * 这一步不能省 —— MCP 和开着的 Holy Light画布窗口是**两个独立的编辑者**，没有它就变成后写的静默覆盖先写的。
 *
 * 409 时**重试一次**（拿新的 version 重算），而不是直接报「保存失败」：
 * 碰撞大多来自「Holy Light画布刚自动保存了一下」，重试就过去了，让用户收一个可重试的错误没意义。
 */
async function mutateCanvas(projectId: string, mutate: (doc: CanvasDoc) => void): Promise<{ saved: boolean; version: number | null; nodes: number; edges: number }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readCanvas(projectId);
    const next = clone(current);
    mutate(next);
    if (JSON.stringify({ n: next.nodes, e: next.edges }) === JSON.stringify({ n: current.nodes, e: current.edges })) {
      return { saved: false, version: current.version ?? null, nodes: next.nodes.length, edges: next.edges.length };
    }
    try {
      const saved = (await callApi('PATCH', `/api/projects/${projectId}/canvas`, {
        nodes: next.nodes,
        edges: next.edges,
        viewport: next.viewport,
        version: current.version,
      })).body as { version?: number };
      return { saved: true, version: saved?.version ?? null, nodes: next.nodes.length, edges: next.edges.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 只有「画布在别处被改过」这一次才值得重来，别的错误（格式不对、超上限）重试也是同样的错。
      if (attempt === 0 && message.includes('画布已在其他窗口被修改')) continue;
      throw error;
    }
  }
  throw new BadInput('画布刚被别的窗口改过，自动重试了一次还是冲突 —— 请再调用一次。');
}

/**
 * `source → target` 会不会把图画成环。
 *
 * 判法：从 `target` 出发沿**出边**走一遍，能走回 `source` 就说明 `source` 本来就是 `target` 的下游，
 * 这条边一加，环就闭上了。方向千万别写反 —— 反过来测会把合法的并行边当成成环。
 */
function wouldCycle(edges: CanvasEdge[], source: string, target: string): boolean {
  if (source === target) return true;
  const seen = new Set<string>();
  const queue = [target];
  while (queue.length) {
    const id = queue.shift() as string;
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of edges) if (edge.source === id) queue.push(edge.target);
  }
  return false;
}

/* ------------------------------------------------------------------ 生成开关 */

/**
 * 触发生成**默认关着**。
 *
 * 生成是这整套工具里唯一**会花钱 / 会跑 GPU**的动作，而且它的副作用不可逆（没法撤销一次已提交的任务）。
 * 所以要求两把锁都对上：
 *   1. 环境变量 `HOLYLIGHT_MCP_ALLOW_GENERATE=1`（挂在 config.toml 的 env 里，改一次长期有效）；
 *   2. 调用时 `confirm: true`（每次自己确认一次）。
 * 少一把就不许跑 —— Codex 是 LLM，一次误判的成本是一次真实的生成，而报错的成本是重说一句话。
 */
function generateAllowed(): boolean {
  const raw = String(process.env.HOLYLIGHT_MCP_ALLOW_GENERATE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/* ------------------------------------------------------------------ 工具表 */

export const TOOLS: Tool[] = [

  {
    name: 'frame_status',
    description: 'Holy Light画布 MCP 的当前状态：数据目录、用的是哪个存储引擎、Holy Light画布应用现在开着吗、这次调用走的哪条路、允不允许触发生成。排查「Codex 改了但界面没变」时先看这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const state = await transportState();
      return {
        transport: state.transport,
        appRunning: state.appRunning,
        dataDir: dataRoot,
        dbFile: path.join(dbDir, 'frame.db'),
        /* 转发模式下刻意不报引擎：那要去开一次库，而这条路本来就不该碰库。 */
        dbEngine: state.transport === 'in-process' ? dbEngine() : '未探测（转发模式不打开库）',
        node: process.version,
        allowGenerate: generateAllowed(),
        hint: state.appRunning
          ? 'Holy Light画布正在运行：工具调用转发给应用自己的后端进程，它是唯一的写者，改动立刻生效（打开着的窗口要重新进一次项目页才会重画）。'
          : 'Holy Light画布没有运行：工具调用在 MCP 进程里跑同一批路由，改动写进同一个数据库，下次打开 Holy Light画布就能看到。',
      };
    },
  },

  {
    name: 'frame_list_projects',
    description: '列出 Holy Light画布里的所有项目（id、名字、更新时间）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ({ projects: (await callApi('GET', '/api/projects')).body }),
  },

  {
    name: 'frame_create_project',
    description: '新建一个 Holy Light画布项目，返回它的 id。之后所有画布操作都用这个 id。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '项目名，不填就按内置规则起名。' } },
      additionalProperties: false,
    },
    run: async (input) => (await callApi('POST', '/api/projects', { name: text(input, 'name') ?? '' })).body,
  },

  {
    name: 'frame_get_project',
    description: '读一个项目的完整信息（含画布）。内容可能很大，只是想知道有哪些节点请用 frame_describe_canvas。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: '项目 id。' } },
      required: ['projectId'],
      additionalProperties: false,
    },
    run: async (input) => (await callApi('GET', `/api/projects/${needed(input, 'projectId')}`)).body,
  },

  {
    name: 'frame_get_canvas',
    description: '读某个项目的原始画布（nodes / edges / viewport / version）。要改动请用下面那些专门的工具，别自己拼这张图。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
      additionalProperties: false,
    },
    run: async (input) => readCanvas(needed(input, 'projectId')),
  },

  {
    name: 'frame_describe_canvas',
    description: '把画布压成一份好读的清单：每个节点的 id / 类型 / 名字 / 坐标 / 关键参数，每条连线的 source→target，以及哪些连线是画布里存在但不合法的。给模型看优先用这个。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
      additionalProperties: false,
    },
    run: async (input) => {
      const canvas = await readCanvas(needed(input, 'projectId'));
      const byId = new Map(canvas.nodes.map(node => [node.id, node]));
      const nodes = canvas.nodes.map(node => {
        const kind = nodeKind(node);
        const data = node.data || {};
        const brief: Record<string, unknown> = {};
        /** 每种节点「值得看一眼」的字段不一样，别的字段（predefined callbacks 那些）说出来是噪音。 */
        if (typeof data.text === 'string' && data.text) brief.text = data.text;
        if (data.imageUrl || data.previewUrl || data.remoteFile) brief.image = String(data.previewUrl || data.imageUrl || data.remoteFile);
        if (data.videoRemoteFile || data.videoRemoteUrl) brief.video = String(data.videoRemoteFile || data.videoRemoteUrl);
        if (data.audioRemoteFile || data.audioRemoteUrl) brief.audio = String(data.audioRemoteFile || data.audioRemoteUrl);
        if (data.workflowId) brief.workflowId = String(data.workflowId);
        if (data.duration) brief.duration = String(data.duration);
        if (data.aspectRatio) brief.aspectRatio = String(data.aspectRatio);
        if (data.megapixels) brief.megapixels = String(data.megapixels);
        if (data.status) brief.status = String(data.status);
        if (data.resultUrl) brief.resultUrl = String(data.resultUrl);
        if (Array.isArray(data.paramRows)) brief.paramRows = (data.paramRows as unknown[]).length;
        if (Array.isArray(data.latents)) brief.latents = (data.latents as unknown[]).length;
        return { id: node.id, kind, label: nodeName(node), position: node.position, ...brief };
      });
      const edges = canvas.edges.map(edge => {
        const legal = Boolean(byId.get(edge.source) && byId.get(edge.target))
          && canConnect(nodeKind(byId.get(edge.source) as CanvasNode), nodeKind(byId.get(edge.target) as CanvasNode));
        return { source: edge.source, target: edge.target, sourceLabel: nodeName(byId.get(edge.source) as CanvasNode), targetLabel: nodeName(byId.get(edge.target) as CanvasNode), legal };
      });
      return {
        version: canvas.version ?? null,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodes,
        edges,
        illegalEdges: edges.filter(edge => !edge.legal),
      };
    },
  },

  {
    name: 'frame_add_node',
    description: '往画布里加一个节点。默认值跟界面拖出来的完全一致（同一份 newNodeData）。kind 只能是 CREATE_KINDS 里的那些。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        kind: { type: 'string', description: '节点类型，例如 text / image / video-generate / image-generate / latent / latent-relay / params / image-out / video-input / audio-input。' },
        label: { type: 'string', description: '节点名字，不填用类型默认名。' },
        x: { type: 'number' },
        y: { type: 'number' },
        data: { type: 'object', description: '覆盖节点 data 里的字段（比如给 text 节点填 text）。' },
        connectTo: { type: 'string', description: '可选：加完之后把它连到这个已有节点上（方向由 canConnect 判定，两种都合法时新节点做输入源）。' },
      },
      required: ['projectId', 'kind'],
      additionalProperties: false,
    },
    run: async (input) => {
      const projectId = needed(input, 'projectId');
      const kind = needed(input, 'kind') as NodeKind;
      if (!CREATE_KINDS.includes(kind)) {
        throw new BadInput(`不能建这种节点：${kind}。可以是 ${CREATE_KINDS.join(' / ')}。`);
      }
      const override = record(input, 'data');
      const x = number_(input, 'x');
      const y = number_(input, 'y');
      const connectTo = text(input, 'connectTo');
      const id = randomUUID();
      const outcome = await mutateCanvas(projectId, (doc) => {
        const data: Record<string, unknown> = { ...newNodeData(kind), ...(override ?? {}) };
        data.kind = kind;
        const auto: Point = { x: 120 + doc.nodes.length * 30, y: 90 + doc.nodes.length * 24 };
        if (x !== undefined || y !== undefined) {
          const right = doc.nodes.reduce((max, node) => Math.max(max, node.position?.x ?? 0), 0);
          auto.x = x ?? right + 320;
          auto.y = y ?? 120;
        }
        doc.nodes.push({ id, type: 'frame', position: auto, data });
        if (!connectTo) return;
        const targetNode = doc.nodes.find(node => node.id === connectTo);
        if (!targetNode) throw new BadInput(`画布里没有 id 为 ${connectTo} 的节点。`);
        const forward = canConnect(kind, nodeKind(targetNode));
        const backward = canConnect(nodeKind(targetNode), kind);
        if (!forward && !backward) throw new BadInput(`连不上：${NODE_META[kind].label} 与 ${nodeName(targetNode)}。${connectionHint(targetNode.data?.kind)}`);
        const source = forward ? id : connectTo;
        const target = forward ? connectTo : id;
        doc.edges.push({ id: `${source}-${target}`, source, target, type: 'default' });
      });
      return { nodeId: id, kind, label: override?.label ?? NODE_META[kind].label, ...outcome };
    },
  },

  {
    name: 'frame_update_node',
    description: '改一个节点：名字、坐标、或者 data 里的任意字段（text 节点的文本、生成节点的 workflowId / duration / steps 等都在这里改）。传进来的 data 是覆盖：写了就换，没写的保持原样，想删某个字段传 null。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        nodeId: { type: 'string' },
        label: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        data: { type: 'object' },
      },
      required: ['projectId', 'nodeId'],
      additionalProperties: false,
    },
    run: async (input) => {
      const projectId = needed(input, 'projectId');
      const nodeId = needed(input, 'nodeId');
      const patch = record(input, 'data');
      const label = text(input, 'label');
      const x = number_(input, 'x');
      const y = number_(input, 'y');
      const outcome = await mutateCanvas(projectId, (doc) => {
        const node = doc.nodes.find(item => item.id === nodeId);
        if (!node) throw new BadInput(`画布里没有 id 为 ${nodeId} 的节点。`);
        if (label) node.data = { ...node.data, label };
        if (patch) {
          const next: Record<string, unknown> = { ...node.data };
          for (const [key, value] of Object.entries(patch)) {
            // null = 明确删除（界面上是「清空」），undefined 则是「没提」，二者不能混为一谈。
            if (value === null) delete next[key];
            else next[key] = value;
          }
          node.data = next;
        }
        if (x !== undefined) node.position = { ...node.position, x };
        if (y !== undefined) node.position = { ...node.position, y };
      });
      if (!outcome.saved) throw new BadInput('没有改动（新值和原来的完全一样，或者节点没找着）。');
      return { nodeId, ...outcome };
    },
  },

  {
    name: 'frame_remove_node',
    description: '删一个节点，顺带删掉挂在它身上的所有连线。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, nodeId: { type: 'string' } },
      required: ['projectId', 'nodeId'],
      additionalProperties: false,
    },
    run: async (input) => {
      const projectId = needed(input, 'projectId');
      const nodeId = needed(input, 'nodeId');
      let removedEdges = 0;
      const outcome = await mutateCanvas(projectId, (doc) => {
        const before = doc.nodes.length;
        doc.nodes = doc.nodes.filter(node => node.id !== nodeId);
        if (doc.nodes.length === before) throw new BadInput(`画布里没有 id 为 ${nodeId} 的节点。`);
        const beforeEdges = doc.edges.length;
        doc.edges = doc.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId);
        removedEdges = beforeEdges - doc.edges.length;
      });
      return { nodeId, removedEdges, ...outcome };
    },
  },

  {
    name: 'frame_connect',
    description: '连两个节点。方向和能否连接由应用自己的 ACCEPTS / canConnect 判定，成环也会被拦下（画布入口，不是 UI）。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, source: { type: 'string' }, target: { type: 'string' } },
      required: ['projectId', 'source', 'target'],
      additionalProperties: false,
    },
    run: async (input) => {
      const projectId = needed(input, 'projectId');
      const source = needed(input, 'source');
      const target = needed(input, 'target');
      const outcome = await mutateCanvas(projectId, (doc) => {
        const from = doc.nodes.find(node => node.id === source);
        const to = doc.nodes.find(node => node.id === target);
        if (!from) throw new BadInput(`画布里没有 id 为 ${source} 的节点。`);
        if (!to) throw new BadInput(`画布里没有 id 为 ${target} 的节点。`);
        if (!canConnect(nodeKind(from), nodeKind(to))) {
          throw new BadInput(`连不上：${nodeName(from)}（${nodeKind(from)}）→ ${nodeName(to)}（${nodeKind(to)}）。${connectionHint(to.data?.kind)}`);
        }
        if (doc.edges.some(edge => edge.source === source && edge.target === target)) throw new BadInput('这两个节点已经连上了。');
        if (wouldCycle(doc.edges, source, target)) throw new BadInput('这条线会把画布连成一个环，拦下了。');
        doc.edges.push({ id: `${source}-${target}`, source, target, type: 'default' });
      });
      return { source, target, ...outcome };
    },
  },

  {
    name: 'frame_disconnect',
    description: '断开一条连线。',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, source: { type: 'string' }, target: { type: 'string' } },
      required: ['projectId', 'source', 'target'],
      additionalProperties: false,
    },
    run: async (input) => {
      const projectId = needed(input, 'projectId');
      const source = needed(input, 'source');
      const target = needed(input, 'target');
      const outcome = await mutateCanvas(projectId, (doc) => {
        const before = doc.edges.length;
        doc.edges = doc.edges.filter(edge => !(edge.source === source && edge.target === target));
        if (doc.edges.length === before) throw new BadInput('这两个节点之间没有连线。');
      });
      return { source, target, ...outcome };
    },
  },

  {
    name: 'frame_list_workflows',
    description: '列出 Holy Light画布里配过的工作流（含用途 video/image/audio、工序 generate/upscale、来源 local/runninghub、启用字段数）。给生成节点选工作流时用这个拿 workflowId，别自己猜。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['video', 'image', 'audio'], description: '按用途过滤。' },
        provider: { type: 'string', enum: ['local', 'runninghub'] },
        operation: { type: 'string', enum: ['generate', 'upscale'] },
      },
      additionalProperties: false,
    },
    run: async (input) => {
      const query = new URLSearchParams();
      for (const key of ['kind', 'provider', 'operation'] as const) {
        const value = text(input, key);
        if (value) query.set(key, value);
      }
      const suffix = query.toString() ? `?${query}` : '';
      return (await callApi('GET', `/api/workflows${suffix}`)).body;
    },
  },

  {
    name: 'frame_get_task',
    description: '查一次生成任务的状态（running / success / failed）和结果。任务刚提交时用它轮询。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'frame_run_generation 返回的 taskId。' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    run: async (input) => (await callApi('GET', `/api/tasks/${needed(input, 'taskId')}`)).body,
  },

  {
    name: 'frame_run_generation',
    description: '在某个生成节点上跑一次生成（真提交：会走 RunningHub 或本机 ComfyUI，会花钱 / 占显卡）。默认拒绝，必须同时满足两点：环境变量 HOLYLIGHT_MCP_ALLOW_GENERATE=1，以及本次调用传 confirm:true。不传 confirm 可以先设 dryRun:true 看看这次到底会提交什么。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        nodeId: { type: 'string', description: '画布上那个 video-generate / image-generate 节点的 id。' },
        workflowId: { type: 'string', description: '不填就用节点上已经选好的那份。' },
        bindingValues: {
          type: 'object',
          description: '提交给工作流的画布值：prompt / duration / aspectRatio / referenceImages / latents / steps / cfg / seed 等。不写就从画布上游自动推一遍。',
        },
        paramRows: { type: 'array', description: '可选，额外的自定义参数行 {nodeId, fieldName, value}。' },
        operation: { type: 'string', enum: ['generate', 'upscale'], description: '默认 generate。选 upscale 时会自动挑这个用途的超清工作流，输入取节点已有的生成结果。' },
        instanceType: { type: 'string', enum: ['default', 'plus', 'ultra'], description: 'RunningHub 的运行规格（default 24G 显存 / plus 48G / ultra 84G）。不填就用节点上选的那一档。只对 RunningHub 云端有效，本机 ComfyUI 与网关那两档不适用。' },
        confirm: { type: 'boolean', description: '必须传 true 才会真的提交。' },
        dryRun: { type: 'boolean', description: 'true = 只算出并提交看看，不发请求。' },
      },
      required: ['projectId', 'nodeId'],
      additionalProperties: false,
    },
    run: async (input) => {
      const projectId = needed(input, 'projectId');
      const nodeId = needed(input, 'nodeId');
      const operation = text(input, 'operation') ?? 'generate';
      const canvas = await readCanvas(projectId);
      const node = canvas.nodes.find(item => item.id === nodeId);
      if (!node) throw new BadInput(`画布里没有 id 为 ${nodeId} 的节点。`);
      const purpose = purposeOfNode(node.data?.kind);
      if (!purpose) throw new BadInput(`id 为 ${nodeId} 的节点不是生成节点（它是 ${nodeKind(node)}），只有 video-generate / image-generate 能跑。`);

      const upstream = canvas.edges.filter(edge => edge.target === nodeId)
        .map(edge => canvas.nodes.find(item => item.id === edge.source))
        .filter((item): item is CanvasNode => Boolean(item));

      let workflowId = text(input, 'workflowId') || String(node.data?.workflowId || '').trim();
      if (operation === 'upscale' && !text(input, 'workflowId')) {
        /* 超清工作流不在「生成下拉」里（它的工序是 upscale），得按「同用途 + 超清工序」单独找一份。 */
        const listed = (await callApi('GET', `/api/workflows?kind=${purpose}`)).body as { workflows: unknown[] } | null;
        const target = upscaleWorkflowFor(listed?.workflows as never[], purpose as never) as { workflowId?: string } | undefined;
        if (!target?.workflowId) throw new BadInput(`还没有配${purpose === 'image' ? '图片' : '视频'}超清工作流 —— 到「设置 · 工作流」建一份并把工序改成「超清」。`);
        workflowId = String(target.workflowId);
      }
      if (!workflowId) throw new BadInput('这个节点上没选工作流，也没有传 workflowId —— 先用 frame_list_workflows 选一个。');

      const explicit = record(input, 'bindingValues');
      const values: Record<string, unknown> = explicit ? { ...explicit } : deriveBindingValues(node, upstream, purpose);
      if (operation === 'upscale' && !values.upscaleInput) {
        const source = String(node.data?.resultUrl || '').trim();
        if (!source) throw new BadInput('这个节点还没有生成结果 —— 超清的输入就是它自己生成出来的那份，先跑一次普通生成。');
        values.upscaleInput = source;
      }

      const body: Record<string, unknown> = {
        nodeId,
        workflowId,
        kind: purpose,
        bindingValues: values,
      };
      if (operation !== 'generate') body.operation = operation;
      /*
       * 运行规格（2026-09-30）—— **不传参数时也读节点上选的那一档**，用的是跟界面提交
       * 同一个 `readInstanceType`。这一个字段漏掉的后果是静默的：节点上写着 48G，
       * 这一次却按 24G 跑，任务照样成功 —— 只有账单和显存知道区别。
       */
      body.instanceType = readInstanceType(text(input, 'instanceType') ?? node.data?.instanceType);
      const rows = input['paramRows'];
      if (Array.isArray(rows)) body.paramRows = rows.map((row, index) => ({
        id: String((row as Record<string, unknown>)?.id ?? `row-${index + 1}`),
        nodeId: String((row as Record<string, unknown>)?.nodeId ?? ''),
        fieldName: String((row as Record<string, unknown>)?.fieldName ?? ''),
        value: String((row as Record<string, unknown>)?.value ?? ''),
        enabled: (row as Record<string, unknown>)?.enabled !== false,
      }));

      if (truthy(input, 'dryRun')) return { dryRun: true, wouldPost: `/api/projects/${projectId}/generation`, body, note: '没有真的提交。' };
      if (!generateAllowed()) throw new BadInput('这次拒绝了：环境变量 HOLYLIGHT_MCP_ALLOW_GENERATE 不是 1。到 ~/.codex/config.toml 的 [mcp_servers.frame.env] 里把它设成 "1" 再重启 Codex。');
      if (!truthy(input, 'confirm')) throw new BadInput('这次拒绝了：没有传 confirm:true。确认无误请带上 confirm:true 再调用一次。');

      const submitted = (await callApi('POST', `/api/projects/${projectId}/generation`, body)).body;
      return { submitted, requested: body, next: `用 frame_get_task 查这次的结果：taskId=${String((submitted as { taskId?: string })?.taskId ?? '')}` };
    },
  },
];

/**
 * 按画布上游把 bindingValues 推一遍。
 *
 * 只推**连线决定得了**的那几项（提示词来自 text 节点、参考图来自图片节点、视频 / 音频来自输入节点），
 * 步长 / CFG / 种子这类「节点自己 fields 里的值」也照搬节点上的 data —— 它们本来就在画布上，
 * 不需要 Codex 再复述一遍。凡是推理不出来的（比如 latent 到底用哪一次生成的那份）**不猜**，
 * 留给服务端报错，也比默默用一个错的强。
 */
function deriveBindingValues(node: CanvasNode, upstream: CanvasNode[], purpose: 'video' | 'image' | 'audio' | null): Record<string, unknown> {
  const data = node.data || {};
  const values: Record<string, unknown> = {};

  const prompts = upstream.filter(item => nodeKind(item) === 'text').map(item => String(item.data?.text || '').trim()).filter(Boolean);
  if (prompts.length) values.prompt = prompts.join(' ');

  const images = upstream
    .filter(item => nodeKind(item) === 'image' || nodeKind(item) === 'video-input' || nodeKind(item) === 'image-generate' || nodeKind(item) === 'image-out')
    .map(item => String(item.data?.remoteFile || item.data?.previewUrl || item.data?.imageUrl || item.data?.resultUrl || '').trim())
    .filter(Boolean);
  /* 上限与配置页能绑的槽位数一致（20 张参考图 / 10 份视频 / 10 份音频）。 */
  if (images.length) values.referenceImages = images.slice(0, 20);

  /* 视频 / 音频按**上游顺序**收成数组：配置页「视频输入 2」取的就是第 2 个。 */
  const videos: string[] = [];
  const audios: string[] = [];
  for (const item of upstream) {
    if (nodeKind(item) === 'video-input') {
      const file = String(item.data?.remoteFile || item.data?.previewUrl || '').trim();
      if (file) videos.push(file);
    }
    if (nodeKind(item) === 'audio-input') {
      const file = String(item.data?.audioRemoteFile || item.data?.remoteFile || '').trim();
      if (file) audios.push(file);
    }
  }
  if (videos.length) values.videoInputs = videos.slice(0, 10);
  if (audios.length) values.audioInputs = audios.slice(0, 10);

  /* 比例 / 分辨率这类节点自己的参数原样带上：服务端会拿它们跟工作流里的绑定对位。 */
  for (const key of ['aspectRatio', 'megapixels', 'duration', 'negativePrompt', 'steps', 'cfg', 'seed', 'batchSize', 'sampler'] as const) {
    const raw = data[key];
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') values[key] = String(raw);
  }
  if (purpose === 'image' && !values.megapixels) values.megapixels = String(data.megapixels ?? '');
  return values;
}

/** 给 tools/list 用的那一份（去掉实现）。 */
export function toolManifest() {
  return TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export async function runTool(name: string, input: ToolInput): Promise<unknown> {
  const tool = TOOLS.find(item => item.name === name);
  if (!tool) throw new BadInput(`没有这个工具：${name}。`);
  return tool.run(input ?? {});
}

export { BadInput };
