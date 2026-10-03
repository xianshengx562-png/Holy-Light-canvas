import type { FramePick, InputSlot, LatentRecord, ParamRow, WorkflowOption, NodeData } from './types';
import type { GeneratorKind } from '@/lib/workflows/purpose';
/*
 * 本模块内部也要用 `generatorKindLabel`，而 `export ... from` 只转出、不在本地建立绑定，
 * 所以这一条 import 是必需的（少写它会得到 "Cannot find name"）。
 */
import { generatorKindLabel } from '@/lib/workflows/purpose';
/* 同上：`workflowLabel` 内部要用 `workflowDisplayName`，所以得在本地也建立绑定。 */
import { workflowDisplayName } from '@/lib/workflows/label';
/* 同上：**凡是要读值的**都得在本地建立绑定，光有末尾那批 `export ... from` 是不够的。 */
import { defaultWorkflowIdFor } from '@/lib/workflows/defaults';
import { DEFAULT_IMAGE_ENGINE, imageEngineProvider } from '@/lib/workflows/imageEngine';
import { IMAGE2_DEFAULTS } from '@/lib/workflows/image2Params';
import { VIDEO_API_DEFAULTS } from '@/lib/workflows/videoApiParams';
import { DEFAULT_VIDEO_ENGINE, videoEngineProvider } from '@/lib/workflows/videoEngine';
import { ASPECT_RATIOS, DEFAULT_RATIO, defaultImageRatioForEngine, IMAGE_DEFAULTS } from '@/lib/workflows/imageParams';
import { initialDirectorScene } from '@/lib/director';
import { isRunningHubAppWorkflowId } from '@/lib/workflows/runninghubApp';
/* 文本链那条取值规则在 `./textChain`（纯函数层），「哪些节点算文本」是它的一部分。 */
import { isTextValueKind } from './textChain';
/*
 * 媒体链同理：哪些节点能给图 / 能给视频、给的是哪几个地址、哪个地址服务端取得到字节 ——
 * **全部在 `./mediaChain` 里定**（纯函数层，能单独跑断言）。
 *
 * 🔴 这里一律**转出、不重写**：提交时收参考图与「看图 / 看视频反推提示词」必须用同一把尺子量，
 * 两处各写一份的后果是「卡片上看得到图，点反推却说没有图」，而全程不报错。
 */
import {
  imageUrlsOf as referenceUrlsIn, isImageSourceKind, isVideoSourceKind,
  isResolvableUrl as isResolvableUrlIn, isVideoUrl as isVideoUrlIn, isImageUrl as isImageUrlIn,
} from './mediaChain';

/**
 * 生成下拉里能选的工作流：**同用途，且工序是普通生成**。
 *
 * 超清工作流也有用途（视频超清属于 `video`），如果只按用途过滤，它就会出现在生成节点的
 * 下拉里 —— 选中它的症状和「选错用途」一模一样：任务照样成功，产出的是一份从头生成的新媒体，
 * 而不是被超清的那份。所以这一层过滤不能少，而且参数条与属性面板必须走同一个函数。
 *
 * 老 `workflow` 节点没有用途（传 null），仍然列全部 —— 它是历史遗留节点，列全部才有意义。
 */
export function workflowsForGeneration<T extends WorkflowOption>(
  workflows: T[], purpose: GeneratorKind | GeneratorKind[] | null,
): T[] {
  if (!purpose) return workflows;
  /* 「视频 / 音频生成」节点两种都列 —— 出什么由选中的那份工作流决定。 */
  const allowed = Array.isArray(purpose) ? purpose : [purpose];
  if (!allowed.length) return workflows;
  return workflows.filter(item => allowed.includes(item.kind) && item.operation === 'generate');
}

/**
 * 再按**来源**筛一道：引擎选了「RunningHub」就只列云端的，选了「本地 ComfyUI」就只列本机的。
 *
 * 为什么必须筛（而不是混着列、靠名字前缀区分）：这两份工作流的图在哪、跑在哪完全不同 ——
 * 云端的图在 RunningHub 那边、按点扣费；本机的图在本地库里、跑在用户自己的显卡上。
 * 混着列的时候，用户选中那行到底会把活交给谁，界面上一个字都不说。
 *
 * `provider` 传 null 表示「这一档不经过工作流」（视频网关 / 自定义接口出图）——
 * 那种情况下调用方根本不该渲染这个下拉，返回空数组比返回全部安全。
 */
export function workflowsForProvider<T extends WorkflowOption>(workflows: T[], provider: 'local' | 'runninghub' | null): T[] {
  if (!provider) return [];
  return workflows.filter(item => (item.provider === 'local' ? 'local' : 'runninghub') === provider);
}

/**
 * 把一份列表按来源分组，给下拉的 `<optgroup>` 用。
 *
 * 生成节点的下拉已经按引擎筛过来源了，所以这里通常只有一组 —— **但那一组也要带标题**：
 * 「这一行到底是云端的还是本机的」是这份下拉里最要紧的一条信息，让用户从分组标题上读到，
 * 比在每行前面挂两个字更不容易看漏（也省掉了每行的重复字样）。
 *
 * `purpose` 只影响分组标题里的那个词（「视频 / 图片」），不参与筛选 —— 筛选在调用方做完了。
 */
export function groupWorkflowsByProvider<T extends WorkflowOption>(workflows: T[]): { provider: 'local' | 'runninghub'; label: string; items: T[] }[] {
  const cloud = workflows.filter(item => item.provider !== 'local');
  const local = workflows.filter(item => item.provider === 'local');
  const groups: { provider: 'local' | 'runninghub'; label: string; items: T[] }[] = [];
  if (cloud.length) groups.push({ provider: 'runninghub', label: 'RunningHub（云端）', items: cloud });
  if (local.length) groups.push({ provider: 'local', label: '本地 ComfyUI', items: local });
  return groups;
}

/**
 * 「超清」这一道的**触发方式**（2026-10-02 徐先）。
 *
 * 默认 `manual`：加这个字段之前，只要配了同用途的超清工作流，卡片上就会出那颗按钮 ——
 * 老画布上已经跑过一轮的节点不能因为升级就突然少一个入口，所以「没填」等于「手动」。
 */
export const UPSCALE_MODES = ['off', 'manual', 'auto'] as const;
export type UpscaleMode = (typeof UPSCALE_MODES)[number];
export const DEFAULT_UPSCALE_MODE: UpscaleMode = 'manual';

export function readUpscaleMode(value: unknown): UpscaleMode {
  const text = String(value ?? '').trim();
  return (UPSCALE_MODES as readonly string[]).includes(text) ? (text as UpscaleMode) : DEFAULT_UPSCALE_MODE;
}

/** 胶囊上那三个档的名字。**「关闭」要说成「关闭」而不是「不超清」**：跟「手动 / 自动」并列时，
 *  前两个是做法、这一个是不做，说法上必须一眼能分出它是第三种。 */
export const UPSCALE_MODE_LABELS: Record<UpscaleMode, string> = {
  off: '关闭',
  manual: '手动',
  auto: '自动',
};

/**
 * 超清工作流从哪一边挑。`follow` = 跟这个节点当前的引擎走（引擎换档它跟着换）；
 * 另两档是**指定**，选中那一档没有就直接是没有。
 */
export const UPSCALE_SOURCES = ['follow', 'runninghub', 'local'] as const;
export type UpscaleSource = (typeof UPSCALE_SOURCES)[number];
export const DEFAULT_UPSCALE_SOURCE: UpscaleSource = 'follow';

export function readUpscaleSource(value: unknown): UpscaleSource {
  const text = String(value ?? '').trim();
  return (UPSCALE_SOURCES as readonly string[]).includes(text) ? (text as UpscaleSource) : DEFAULT_UPSCALE_SOURCE;
}

export const UPSCALE_SOURCE_LABELS: Record<UpscaleSource, string> = {
  follow: '跟随节点',
  runninghub: 'RunningHub',
  local: '本地 ComfyUI',
};

/**
 * 这个节点**当前**会把活交给哪一边（`local` / `runninghub`）。
 *
 * 视频网关 / 自定义接口那两档不经过工作流，返回 `null` = 「这一档不按来源筛」。
 * 抽出来是因为「引擎 ↔ 工作流来源」这道对账在生成、超清、按钮可见性三处都要用，
 * 各写一遍迟早会有一处漏掉应用节点（`app-generate` 没有引擎这一说）。
 */
export function nodeEngineProvider(kind: unknown, engine: unknown): 'local' | 'runninghub' | null {
  if (kind === 'image-generate') return imageEngineProvider(engine);
  if (kind === 'video-generate') return videoEngineProvider(engine);
  return null;
}

/**
 * 「超清」按钮要用的那份工作流：同用途 + 工序是超清（+ 来源对得上）。
 *
 * 与上面那条是**同一个维度的两面**：一份工作流属于哪一种工序，决定了它出现在哪个入口。
 * 万一一个用途下配了多份超清工作流，取最近改过的那份（列表已经按 `updatedAt` 倒序）。
 *
 * 🔴 `source` 指定了某一来源却一份都没有时**返回 undefined，不回退**：用户选了
 * 「本地 ComfyUI」，我们不该悄悄拿云端那份去跑 —— 那一路花的是他自己账号里的钱。
 * `follow` 且这一档不经过工作流（`provider` 为 null）时同样不筛，取第一份。
 */
export function upscaleWorkflowsFor<T extends WorkflowOption>(
  workflows: T[], purpose: GeneratorKind,
  source: UpscaleSource = DEFAULT_UPSCALE_SOURCE, provider: 'local' | 'runninghub' | null = null,
): T[] {
  const pool = workflows.filter(item => item.kind === purpose && item.operation === 'upscale');
  const wanted = source === 'follow' ? provider : source;
  if (!wanted) return pool;
  return pool.filter(item => (item.provider === 'local' ? 'local' : 'runninghub') === wanted);
}

/**
 * `chosenId` 是用户在「超清工作流」那一行点名的哪一份（见 `NodeData.upscaleWorkflowId`）。
 * 它**只在那批候选里挑**：点名了一份来源对不上的，等于想绕开「来源」那一档，不给。
 * 点名的那份不在了就退回自动挑（`pool[0]`）—— 那一刻界面那一行会说出「不在了」，
 * 所以这里安静退回不算静默失败。
 */
export function upscaleWorkflowFor<T extends WorkflowOption>(
  workflows: T[], purpose: GeneratorKind,
  source: UpscaleSource = DEFAULT_UPSCALE_SOURCE, provider: 'local' | 'runninghub' | null = null,
  chosenId: unknown = '',
): T | undefined {
  const pool = upscaleWorkflowsFor(workflows, purpose, source, provider);
  const wanted = String(chosenId ?? '').trim();
  return (wanted ? pool.find(item => String(item.workflowId) === wanted) : undefined) ?? pool[0];
}

export type { NodeData, InputSlot, LatentRecord, ParamRow, WorkflowOption } from './types';

export type NodeKind = 'text' | 'image' | 'latent' | 'latent-relay' | 'workflow' | 'params'
  | 'video-generate' | 'image-generate' | 'video' | 'video-input' | 'audio-input' | 'image-out' | 'frame-extract'
  | 'director' | 'app-generate' | 'prompt-optimize';

export const NODE_META: Record<NodeKind, {
  label: string;
  tag: string;
  color: string;
  input?: string;
  output?: string;
}> = {
  /* 2026-09-29 改名「文本」，并且**能接上游**了：文本 → 优化提示词 → 文本 这条路要走通。 */
  text: { label: '文本', tag: 'TEXT', color: '#6c8cff', input: 'text', output: 'prompt' },
  image: { label: '图片输入', tag: 'IMAGE', color: '#22d3ee', output: 'image' },
  /** 视频输入：把一段本地视频拖进画布，预览播放；连到生成节点时取它的首帧当参考图 / 首帧。 */
  'video-input': { label: '视频输入', tag: 'VIDEO', color: '#fb7185', output: 'video' },
  /** 音频输入：把一段本地音频拖进画布直接播；连到视频生成节点后，可在工作流里绑到 LoadAudio 那类节点。 */
  'audio-input': { label: '音频输入', tag: 'AUDIO', color: '#f0abfc', output: 'audio' },
  /**
   * 首尾帧：从一段视频里取出**第一帧与最后一帧**两张图。
   *
   * 它接的是视频（视频输入节点、或者视频生成节点生成出来的那段），吐出来的是图 ——
   * 下游拿它当参考图用（续拍要让下一段接上上一段的最后一帧，图生图要一张起手图）。
   * 一个节点出两张图，给谁由节点上的「取用」开关决定（`framePick`），
   * 不做两个输出口：画布里存的连线只有 source/target，没有 handle 编号，
   * 分两个口存下来再读回来就分不清连的是哪一张了。
   */
  'frame-extract': { label: '首尾帧', tag: '帧', color: '#0ea5e9', input: 'video', output: '首帧 / 尾帧' },
  latent: { label: '接续上一段', tag: 'LATENT', color: '#a78bfa', output: 'latent' },
  /** latent 中转：接住上游的 latent 再转给下一个生成节点，编号决定它写进哪个参数位。 */
  'latent-relay': { label: 'Latent 中转', tag: 'RELAY', color: '#c084fc', input: 'latent', output: 'latent' },
  // 工作流选择已并入视频生成节点的参数条；这个类型只为老画布保留（`LEGACY_KINDS`）。
  workflow: { label: '工作流配置', tag: 'WORKFLOW', color: '#f472b6', output: 'workflow' },
  /** 自定义参数块：直接写工作流节点 id + 字段名，像搭积木一样往生成里叠参数。 */
  params: { label: '自定义参数', tag: 'PARAMS', color: '#fb923c', input: '自定义参数', output: 'params' },
  'video-generate': { label: '视频/音频生成', tag: 'GENERATE', color: '#4ade80', input: 'prompt / 图 / 视频 / 音频 / latent / 工作流 / 自定义参数', output: 'video / audio / image' },
  /** 图片生成：结构与视频生成一致，但不吃 latent、不提交时长与接续，参数换成出图那一套。 */
  'image-generate': { label: '图片生成', tag: 'IMG-GEN', color: '#a3e635', input: '提示词 / 参考图 / 工作流 / 自定义参数', output: 'image' },
  /**
   * RunningHub **应用**：跑的是一个打包好的 AI 应用（`ai-detail/<id>`），不是一份 ComfyUI 图。
   *
   * 它出图还是出片**由那个应用自己决定**（导入时选的用途），所以 output 两种都写 ——
   * 这也是它必须单独成一种节点的原因：套在「图片生成」里的话，一个出片的应用会跑出
   * 一段视频却挂在出图节点上，而用途那一栏还写着「图片」。
   */
  'app-generate': { label: 'RunningHub 应用', tag: 'APP', color: '#38bdf8', input: '提示词 / 参考图 / 自定义参数', output: 'image / video' },
  // 老画布里可能还留着独立的视频输出节点；新建节点里已经不再提供，输出直接落在视频生成节点上。
  video: { label: '视频输出', tag: 'OUTPUT', color: '#fbbf24', input: 'video' },
  /*
   * 2026-10-01：补上 `output` —— 把手是照 `input` / `output` 画的（`NodeCard`），
   * 没有它就没有右侧那个输出点，从「图片输出」出发的线根本拉不出来。
   * 有了它，这一张图才能再往下连一个图片生成 / 视频生成节点（徐先要的就是这条）。
   */
  'image-out': { label: '图片输出', tag: 'OUTPUT', color: '#2dd4bf', input: 'image', output: 'image' },
  /**
   * 3D 导演台：摆灰模的站位、调机位，存一张**构图参考图**给下游当参考图用。
   * 它自己不跑模型（`output` 是那张参考图，不是生成结果）。
   */
  director: { label: '3D 导演台', tag: 'DIRECTOR', color: '#94a3b8', output: '构图参考图' },
  /**
   * 优化提示词（2026-09-29）：把上游那句大白话，扩写成能直接喂给生成模型的提示词。
   *
   * 它**不出任何媒体** —— 跑的是文本模型（「设置 · 模型服务」里指定的那家），
   * 跟图片工作室里那个 ✦ 是同一个接口。所以它必须能被「启动」串进去跑：
   * 一键运行时它排在下游生成节点之前，否则下游拿到的还是优化前的那句。
   */
  'prompt-optimize': { label: '优化提示词', tag: 'OPTIMIZE', color: '#f59e0b', input: 'text', output: '优化后的提示词' },
};

/** Kinds offered by the toolbar and the right-click menu (legacy kinds are excluded). */
/**
 * 「添加节点」那一栏里能挑的类型。
 *
 * 图片输入 / 视频输入 / 音频输入**故意不在里面**：它们的入口是「把文件交给画布」
 * （拖进来、Ctrl+V 粘、右键「上传文件」），节点由内容决定该长出哪一种 ——
 * 让人先想清楚「我要建的是图片输入还是视频输入」再去找节点，是白绕一圈。
 * 它们仍然能被建出来（`newNodeData` / `ACCEPTS` / 图标都在），只是不在这一栏里列。
 *
 * 🔴 **这一行的顺序 = 「添加节点」菜单里从上到下的顺序**（`CanvasEditor` 直接 `.map` 它）。
 * 2026-10-01 徐先要的顺序：**上传文件 → 文本 → 图片生成 → 视频生成**打头，
 * 其余按「先素材、后生成」排下去。改这里之前先想清楚菜单长什么样：
 * 这一列是让用户从上往下扫的，前三屏之外的东西等于不存在。
 */
export const CREATE_KINDS: NodeKind[] = ['text', 'image-generate', 'video-generate', 'prompt-optimize', 'frame-extract', 'latent', 'latent-relay', 'params', 'app-generate', 'image-out', 'director'];

/** Kept only so that older canvases keep rendering: the video output and the workflow picker
 *  both live on the generator node now. */
export const LEGACY_KINDS: NodeKind[] = ['video', 'workflow'];

/**
 * 新建一个节点时它该带哪些字段 —— **UI 与 MCP 共用这一份**。
 *
 * 以前它是 `CanvasEditor` 里的一个 `useCallback`（`nodeData`）。抽到这里是因为发生了第二处
 * **也得建节点**的地方：Codex 通过 MCP 往画布上加节点。两处各写一份默认值的话，
 * 迟早出现「MCP 建出来的节点少一个 `engine` 字段，界面上一次调用 `readImageEngine` 就走了另一个分支」——
 * 而这类差异**不报错**，只是行为悄悄不同，是最难查的一类。
 *
 * 这里的每个字段都有存在理由，删之前先看 `CanvasEditor.nodeData` 那边的注释。
 */
export function newNodeData(kind: NodeKind): NodeData {
  const label = NODE_META[kind].label;
  /** 优化提示词：只带一个默认标签 —— 它没有工作流 / 步数 / 比例那一套。 */
  if (kind === 'prompt-optimize') return { kind, label };
  /** 视频输入 / 音频输入节点不需要任何生成参数，只带一个默认标签。 */
  if (kind === 'video-input' || kind === 'audio-input' || kind === 'image-out') return { kind, label };
  /** 首尾帧：默认两张都给下游（续拍最常用的是「尾帧接下一段」，但首帧留着能当起手图）。 */
  if (kind === 'frame-extract') return { kind, label, framePick: 'both' as FramePick };
  if (kind === 'params') return { kind, label, paramRows: [] as ParamRow[] };
  /** 导演台：带一份初始场景（两个人对站着 + 平视中景），打开面板就能直接调，不用先摆。 */
  if (kind === 'director') return { kind, label, directorScene: initialDirectorScene() };
  if (kind === 'latent-relay') return { kind, label, latentIndexes: [] as number[] };
  /*
   * 应用节点：默认**不预填**任何工作流（哪一份应用只有用户知道），
   * 引擎固定走云端（应用只存在于 RunningHub 上，本机 ComfyUI 没有对应的东西）。
   * 步数 / CFG / 采样器那一套**没有**：应用的参数是它自己公开的那些字段，在配置页里勾。
   */
  if (kind === 'app-generate') {
    return { kind, label, workflowId: '', engine: DEFAULT_IMAGE_ENGINE };
  }
  if (kind === 'image-generate') {
    return {
      /* 不预填默认工作流：那条默认是视频工作流，出图节点指向它只会跑出一段视频。 */
      kind, label, workflowId: '',
      /*
       * 引擎默认「RunningHub」（`readImageEngine` 对缺省值也是这个判断）：老画布上没有这个字段，
       * 必须继续按云端工作流跑。同步出图那三个参数照样写好默认值 —— 切过去时界面才有得显示。
       */
      engine: DEFAULT_IMAGE_ENGINE,
      aspectRatio: IMAGE_DEFAULTS.ratio, megapixels: IMAGE_DEFAULTS.megapixels,
      steps: IMAGE_DEFAULTS.steps, cfg: IMAGE_DEFAULTS.cfg, seed: IMAGE_DEFAULTS.seed,
      batchSize: IMAGE_DEFAULTS.batchSize, sampler: IMAGE_DEFAULTS.sampler,
      image2Ratio: IMAGE2_DEFAULTS.ratio, image2Resolution: IMAGE2_DEFAULTS.resolution,
      image2Background: IMAGE2_DEFAULTS.background,
    };
  }
  /*
   * 视频生成节点（以及其余旧类型）走这条。引擎默认是 RunningHub（云端工作流）；
   * 想跑本机那份就把 `engine` 改成 `'local'` 并换一个 `local-` 前缀的 `workflowId`。
   * `videoApiModel` 留空 = 用 `.env` 里配的那个。
   */
  return {
    kind, label, duration: '6', aspectRatio: DEFAULT_RATIO, megapixels: '0.2',
    workflowId: defaultWorkflowIdFor(kind),
    engine: DEFAULT_VIDEO_ENGINE,
    videoApiModel: '', videoApiDuration: String(VIDEO_API_DEFAULTS.duration),
    videoApiResolution: VIDEO_API_DEFAULTS.resolution, videoApiRatio: VIDEO_API_DEFAULTS.ratio,
  };
}

/**
 * 切换出图引擎时**连带要改写哪些字段**（2026-09-24）。
 *
 * 背景：本机 ComfyUI 那一档的默认比例是 16:9，RunningHub 那一档是 1:1
 * （见 `defaultImageRatioForEngine`）。节点建出来时是「RunningHub + 1:1」，
 * 用户把引擎切到本机之后如果比例还停在 1:1，出图就是方的 —— 而这件事**没有任何报错**，
 * 只能等出图结果不对才发现。
 *
 * 只在「比例**还是上一档引擎的默认值**」时才跟着换：用户自己挑过比例的一律不动，
 * 否则等于把他的选择悄悄改掉。字段缺失（老节点）也按上一档的默认值算。
 */
export function engineSwitchPatch(data: NodeData, nextEngine: string): Partial<NodeData> {
  /* 下拉给回来的是普通字符串，`NodeData.engine` 是个字面量联合 —— 这里收紧一次，
     三处 return 才不用各写一遍断言。 */
  const engine = nextEngine as NodeData['engine'];
  if (data.kind !== 'image-generate') return { engine };
  const before = String(data.engine || DEFAULT_IMAGE_ENGINE);
  const current = String(data.aspectRatio || defaultImageRatioForEngine(before));
  if (current !== defaultImageRatioForEngine(before)) return { engine };
  return { engine, aspectRatio: defaultImageRatioForEngine(nextEngine) };
}

/** Which upstream node kinds each node accepts. Output nodes only take the media they can render. */
export const ACCEPTS: Record<NodeKind, NodeKind[]> = {
  /* 文本节点能再接文本 / 优化节点：下游那个文本节点要展示上游优化后的结果。 */
  text: ['text', 'prompt-optimize'],
  image: [],
  latent: [],
  /*
   * 中转换着接：latent 节点 → 中转 → 中转 → 生成节点，值一路透传下去。
   * 还能接**视频生成节点** —— 它每次生成完会归档 latent，中转可以把那一份传给下一个节点，
   * 省掉「先去 latent 节点上手动选归档」这一步（选哪一份由中转节点上的下拉决定）。
   */
  'latent-relay': ['latent', 'latent-relay', 'video-generate', 'video-input'],
  workflow: [],
  // 参数块可以再接参数块：串在后面的覆盖前面的，越靠近生成节点优先级越高。
  params: ['params'],
  /* 优化节点也能直接当提示词来源：不想再多一个文本节点的时候，优化完直接喂给生成节点。 */
  /*
   * 2026-10-01 末尾那个 `video-generate`：视频生成节点可以直接串在另一个视频生成节点后面，
   * 上游那**整段视频**进下游的「画布 · 视频输入」位（见 `CanvasEditor` 的 `videoInputs`）。
   * ⚠️ 走的是**视频输入**这条路，不是参考图：生成节点身上只存了整段视频的地址，
   * 没有封面帧，塞进参考图位等于把一段视频交到「图」的槽里 —— 那是静默的坏结果。
   */
  'video-generate': ['text', 'prompt-optimize', 'image', 'video-input', 'audio-input', 'frame-extract', 'latent', 'latent-relay', 'workflow', 'params', 'image-generate', 'image-out', 'director', 'video-generate'],
  // 出图不吃 latent：接续是视频链路的概念，图片工作流里没有对应的参数位。
  // 视频输入节点的首帧图也能当图生图的参考图一并发走（需已上传完成）。
  /*
   * 2026-10-01：`image-generate` / `image-out` 也能当上游 —— 图生图再图生图。
   * 下游拿它当**参考图**：这两个 kind 本来就在 `isReferenceSource` 里，
   * 提交时 `imageUrls` 自动收，连线一拉上就生效，不用额外配置。
   */
  'image-generate': ['text', 'prompt-optimize', 'image', 'video-input', 'frame-extract', 'workflow', 'params', 'director', 'image-generate', 'image-out'],
  /* 应用节点：吃提示词与参考图（它的参数位由应用自己公开），但不吃 latent —— 接续是视频链路的概念。 */
  'app-generate': ['text', 'prompt-optimize', 'image', 'video-input', 'frame-extract', 'workflow', 'params', 'director'],
  /*
   * 优化节点原来只接**文本**：上游文本节点，或者串在前面的另一个优化节点。
   *
   * 2026-10-03 徐先：「优化提示词节点也支持反推提示词，如果左边的接口输入了图片，
   * 那么自动反推提示词」→ **图片来源能连进来**；同一天追加「也支持视频，
   * 如果接入了视频，那进行视频反推」→ **视频来源也能连进来**（`video-generate` / `video-input`）。
   *
   * 接上之后走哪条路由 `./mediaChain` 的 `pickMediaInput()` 定：
   *   左边有视频 → 视频反推（抽若干帧）；有图 → 看图反推；都没有 → 原来那条「把一句话扩写」。
   */
  'prompt-optimize': ['text', 'prompt-optimize', 'image', 'image-generate', 'image-out',
    'video-input', 'video-generate', 'frame-extract', 'director', 'app-generate'],
  video: ['video-generate'],
  'video-input': [],
  'audio-input': [],
  'image-out': ['video-generate', 'image-generate', 'image', 'frame-extract', 'director'],
  /*
   * 首尾帧只吃**视频**：本地拖进来的（视频输入）与生成出来的（视频生成）都行。
   * 不收图片 —— 「一张图的首尾帧」就是它自己，接上去只是多一次上传。
   */
  'frame-extract': ['video-input', 'video-generate'],
  /* 导演台不接上游：它的输入是用户在舞台上手摆的，不是别的节点给的。 */
  director: [],
};

/**
 * 能真正跑一次生成的节点。
 *
 * 凡是「画布里只有一个生成节点就自动连上去」这类判断都要用这个，别只写 `video-generate`
 * —— 加了图片生成节点之后，只认视频会让用户拖进来的图连不上那个唯一的出图节点。
 */
export function isGeneratorKind(kind: unknown) {
  return kind === 'video-generate' || kind === 'image-generate' || kind === 'app-generate';
}

/**
 * 「启动」要**依次跑**的节点：生成节点 + 优化提示词节点（2026-09-29）。
 *
 * 优化节点必须算进来：它下游那个生成节点要的是**优化后**的提示词，
 * 而它在画布上又不是「生成节点」—— 漏掉它的症状是「一键运行跑完了，
 * 出来的画面还是优化前那句写的」，全程不报错。
 */
export function isRunnableKind(kind: unknown) {
  return isGeneratorKind(kind) || kind === 'prompt-optimize';
}

/*
 * 只在这里转出，**不在这里再写一遍**：链上认这个节点、别处不认，是最难查的一类错
 * （不报错，只是行为悄悄不同）。画布其余各处继续从 `nodeMeta` 引，路径不变。
 */
export { isTextValueKind };

/**
 * 节点名字的**兼容表**：老画布上存下来的旧默认名 → 现在这套默认名。
 *
 * 为什么需要它：节点的 `label` 是**建节点那一刻写进画布数据**的字符串，
 * 后来改了 `NODE_META` 里的字，老画布上那个名字**不会跟着变**。
 * （`文本提示词` 是 2026 早期的叫法；`续接上一段` 是 2026-10-01 统一改名前的叫法。）
 *
 * 🔴 **只在读的时候认，不往库里写回**（跟 `LEGACY_VIDEO_ENGINES` 一个道理）：
 * 每开一次画布写一次盘没必要；更要紧的是**用户自己起过的名字一个字都不能动** ——
 * 所以判据是「名字正好等于旧默认名」**且**「种类也对得上」，两个条件缺一不可。
 */
const LEGACY_NODE_LABELS: Record<string, { kind: NodeKind; label: string }> = {
  文本提示词: { kind: 'text', label: NODE_META.text.label },
  续接上一段: { kind: 'latent', label: NODE_META.latent.label },
  /* 2026-10-02：这个节点开始吃音频工作流，名字改成「视频/音频生成」。 */
  视频生成: { kind: 'video-generate', label: NODE_META['video-generate'].label },
};

/** 老名字 → 新名字；不是旧默认名（或种类对不上）就原样返回，空值也原样返回。 */
export function readNodeLabel(label: unknown, kind: unknown): string {
  const raw = String(label ?? '').trim();
  const legacy = LEGACY_NODE_LABELS[raw];
  return legacy && legacy.kind === kind ? legacy.label : raw;
}

/**
 * 老节点上存的是改版前的默认名。显示时一律按现在这套名字走，**不写库** ——
 * 用户自己起过的名字一律不动，只把「系统当年自动填的那个旧默认名」翻过来。
 */
export function displayLabelOf(data: { label?: unknown; kind?: unknown }): string {
  return readNodeLabel(data.label, data.kind);
}

/**
 * 把一整份画布的节点名过一遍兼容表 —— **载入时调一次就够**，别到处补。
 *
 * 这一口的价值：下游有十几处直接读 `node.data.label`（卡片标题、参数条标题、
 * 「已选中「X」」、报错里的「上游「X」」），在载入处归一化就等于**一次性全修好**；
 * 逐个改成 `displayLabelOf` 迟早会漏一处，而漏掉的那处**不报错、只是偶尔冒出旧词**。
 * 顺带的：用户下次随便动一下画布，新名字就跟着自动保存落库了，不必专门做一次迁移。
 * 名字没变的节点**原对象返回**，省得平白多一轮渲染。
 */
/**
 * 载入时把「**不可能还在进行**」的状态复位（2026-10-02 徐先报的那个现象）。
 *
 * 🔴 `uploading` 必须复位，理由是它**根本不可能是真的**：上传是本机进程里的动作
 *    （把文件塞给上游那一秒），应用一重启它必然已经中断。可它被写进了画布数据，
 *    于是下次打开这张画布，节点永远停在「上传中」—— 卡片上那句「正在上传…」不会变，
 *    等待动效（光点）也一直在流。**「没点生成却在跑动画」就是这么来的**：
 *    不是动效的触发条件写宽了，是画布里存着一个永远为真的假状态。
 * 🔴 `running` **不复位**：那是上游的任务，真的可能还在跑，由「恢复未跑完的任务」
 *    那一支去问上游 —— 我们不许按等待时长自己下结论（项目那条业务口径）。
 *
 * 名字没变的节点**原对象返回**（和 `normalizeNodeLabels` 一个道理，省一轮渲染）。
 */
export function resetTransientStatus<T extends { data: { status?: unknown; result?: unknown } }>(nodes: T[]): T[] {
  return nodes.map(node => {
    if (String(node.data.status ?? '') !== 'uploading') return node;
    const data = { ...node.data, status: '' };
    /* 那句「正在上传…」是跟着状态一起写的（上传路径里 `result: undefined`），
       个别老数据把它写进了 `result`，一起清掉才不会剩半句没人收的话。 */
    if (String(node.data.result ?? '').trim() === '正在上传…') data.result = '';
    return { ...node, data };
  });
}

export function normalizeNodeLabels<T extends { data: { label?: unknown; kind?: unknown } }>(nodes: T[]): T[] {
  return nodes.map(node => {
    const next = readNodeLabel(node.data.label, node.data.kind);
    return next === node.data.label ? node : { ...node, data: { ...node.data, label: next } };
  });
}

/**
 * 这个节点能不能当**参考图来源**。
 *
 * 提交时收参考图、参数条上数「几张图」、输入槽算不算就绪、反推时挑「左边那张」，
 * 四处必须用同一个判断 —— 各写一份的后果是参数条写着 2 图、实际只提交 1 张，
 * 而界面上一句话都没有。所以正文在 `./mediaChain`，这里只转出。
 *
 * 🔴 `video-input` 在 `mediaChain` 里归到了**视频**那一组（连到优化节点上时走视频反推），
 * 但它在**提交生成时仍然是参考图来源**（工作流收的是它的封面帧）—— 所以这里要把它加回来。
 */
export function isReferenceSource(kind: unknown) {
  return isImageSourceKind(kind) || kind === 'video-input';
}

/**
 * 一个上游节点这次能给下游贡献**哪几张**参考图。正文在 `./imageChain`。
 *
 * `mode` 是给同步出图与反推那条路准备的：那边要的是**服务端能取到字节的地址**
 * （上传后的 http 地址或本站资产路径），而工作流那条路认的是 RunningHub 的文件名。
 * 同一个节点在两条路上交出去的值不一样，这是它们各自的协议决定的，不是写错了。
 */
export function referenceUrlsOf(data: NodeData, mode: 'submit' | 'bytes' = 'submit'): string[] {
  return referenceUrlsIn(data, mode);
}

/** 这个值**服务端能取到字节**吗（正文在 `./imageChain`）。 */
export function isResolvableUrl(value: unknown) {
  return isResolvableUrlIn(value);
}

/**
 * 一个上游节点**在参考图之外**还能不能给这一轮贡献东西。
 *
 * 视频输入节点交出去的是整段视频（`videoInput`，绑到工作流里的 LoadVideo 那类节点），
 * 不是参考图，所以 `referenceUrlsOf()` 对它判空**不代表它没准备好** ——
 * 从资产库导入的视频连上来之后点运行，会被那句「尚未上传完成」拦住，
 * 而它其实什么都不缺（服务端提交时会读盘重传，见 `resolveVideoInput`）。
 */
export function mediaReadyForRun(data: NodeData) {
  if (data.kind !== 'video-input') return false;
  return Boolean(String(data.videoRemoteFile || '').trim())
    || isResolvableUrl(data.videoRemoteUrl)
    || isResolvableUrl(data.videoUrl);
}

export function canConnect(sourceKind: unknown, targetKind: unknown) {
  const accepts = ACCEPTS[targetKind as NodeKind];
  if (!accepts) return false;
  return accepts.includes(sourceKind as NodeKind);
}

/** Human readable hint used by the connection feedback. */
export function connectionHint(targetKind: unknown) {
  const accepts = ACCEPTS[targetKind as NodeKind] || [];
  if (!accepts.length) return '该节点只输出，不能接收连线';
  return `只能连接：${accepts.map(kind => NODE_META[kind].label).join(' / ')}`;
}

/*
 * 工作流的「用途」值域搬到了 `lib/workflows/purpose.ts`——接口出参、服务端校验、画布下拉
 * 必须用同一份定义。这里原样转出，UI 的 import 不用改。
 *
 * **`isGeneratorKind` 不在这里转出**：本文件已经有一个同名的、意思是「是不是生成节点」的函数，
 * 那个判的是画布节点 kind（`video-generate` / `image-generate`），而 purpose.ts 那个判的是用途值域
 * （`video` / `image`）。两者同名不同义，转出会让 import 方拿到哪一个全看运气 ——
 * 要用值域校验的地方直接从 `@/lib/workflows/purpose` 引。
 */
export {
  DEFAULT_GENERATOR_KIND, GENERATOR_KINDS, GENERATOR_KIND_OPTIONS, generatorKindLabel, generatorKindNoun,
  readGeneratorKind,
} from '@/lib/workflows/purpose';
export type { GeneratorKind } from '@/lib/workflows/purpose';

/*
 * `workflowLabel` 要用 `workflowDisplayName`（本地已 import），这里顺手转出给别的画布组件用 ——
 * 名字的回落规则只能有一处，UI 一律从 nodeMeta 引，跟 purpose / imageParams 一个路子。
 */
export { workflowDisplayName };

/**
 * 画布节点 → 工作流用途。非生成节点返回 null。
 *
 * 这是**唯一**一处把「节点 kind」翻译成「用途」的地方：画布上的下拉过滤、提交时带上的
 * `kind`、以及「这个节点上的 workflowId 到底该是哪一类」都从这里取，避免三处各写一遍 if。
 */
export function purposeOfNode(kind: unknown): GeneratorKind | null {
  if (kind === 'video-generate') return 'video';
  if (kind === 'image-generate') return 'image';
  return null;
}

/**
 * 这个节点**允许**哪些用途（2026-10-02）。
 *
 * 视频节点现在也吃音频工作流 —— 它出视频还是出音频，取决于此刻选中的那份工作流，
 * 而不是节点自己的种类。所以「筛选下拉」问的是这里（一组），
 * 而「提交 / 参数显示」问的是下面那个 `purposeForNode`（一个）。
 */
export function purposesOfNode(kind: unknown): GeneratorKind[] {
  if (kind === 'video-generate') return ['video', 'audio'];
  if (kind === 'image-generate') return ['image'];
  return [];
}

/**
 * 这个节点**此刻**实际要用哪个用途：跟着它选中的那份工作流走。
 *
 * 为什么不继续用 `purposeOfNode`：同一个节点上挑了音频工作流，用途却还报「视频」的话，
 * 提交会带上时长 / 比例 / latent 这些音频工作流根本没有的参数，
 * 界面上还会弹「这份工作流不是视频用的」—— 明明是它自己列出来让人选的。
 * 没选工作流时退回节点自己的默认用途。
 */
export function purposeForNode(
  kind: unknown, workflows: WorkflowOption[], workflowId: unknown,
): GeneratorKind | null {
  const allowed = purposesOfNode(kind);
  if (!allowed.length) return purposeOfNode(kind);
  const chosen = String(workflowId || '').trim();
  if (chosen) {
    const hit = workflows.find(item => String(item.workflowId || '') === chosen);
    if (hit && allowed.includes(hit.kind)) return hit.kind;
  }
  return allowed[0];
}

/**
 * 工作流里能接 latent 的参数位数量。
 *
 * 默认绑定只有 `latent_1`（节点 210，粗采样）与 `latent_2`（节点 278，精采样），
 * 所以编号就这两个；`configuration.ts` 里 `binding: 'latent_N'` 取的是 `values.latents[N-1]`。
 * 编号是**显式指定**的——在此之前第几个生效纯看连线顺序，改一下连线就悄悄换了槽位。
 */
export const LATENT_SLOTS = 2;

/** 中转节点与普通 latent 节点在「收集 / 计数 / 显示」上是一类，别在多处各写一遍判断。 */
export function isLatentKind(kind: unknown) {
  return kind === 'latent' || kind === 'latent-relay';
}

/**
 * 中转节点能从哪些节点取到 latent：`latent` / `latent-relay` 是透传，
 * `video-generate` 是拿它自己生成出来的那份（归档在 `Asset(type='latent')` 上）。
 *
 * 只用于「沿上游找值」这一步 —— 计数、槽位、上传那些仍然只认 `isLatentKind`：
 * 视频节点本身不是 latent 输入，它只是 latent 的**产地**。
 */
export function isLatentSourceKind(kind: unknown) {
  return isLatentKind(kind) || kind === 'video-generate';
}

/**
 * 粗 / 精采样节点号的默认值 —— 来自 RunningHub 那份默认工作流（`210.手动上传` / `278.手动上传`）。
 *
 * 换一份工作流，编号多半就对不上了，所以「接续上一段 / Latent 中转」节点上可以改
 * （`NodeData.latentCoarseNodeId` / `latentFineNodeId`）。留空即回落这两个值。
 */
export const DEFAULT_LATENT_NODE_IDS = { coarse: '210', fine: '278' } as const;

/**
 * 参数位落在哪个节点上、属于哪一类采样。
 *
 * `nodeId` 传的是**节点上填的号**，不传才用默认值 —— 否则改了号界面还在说 210，
 * 那句话就变成假话了，而用户正是照着这句话去判断 latent 写到了哪儿。
 */
export function latentSlotHint(index: number, nodeId?: string) {
  const id = String(nodeId || '').trim()
    || (index === 1 ? DEFAULT_LATENT_NODE_IDS.coarse : DEFAULT_LATENT_NODE_IDS.fine);
  return index === 1 ? `节点 ${id}（粗采样）` : index === 2 ? `节点 ${id}（精采样）` : `latent_${index}`;
}

/**
 * 节点上**填的**那个号（可能为空 —— 空表示「沿用配置页的绑定」，不是「用 210 / 278」）。
 *
 * 提交时要用这个值本身：回落成默认值等于把「没填」当成「强制写 210 / 278」，
 * 那些已经在配置页绑到别的节点号的工作流会被悄悄改掉落点。
 */
export function latentNodeIdOf(data: { latentCoarseNodeId?: string; latentFineNodeId?: string }, slot: number) {
  return String((slot === 1 ? data.latentCoarseNodeId : data.latentFineNodeId) || '').trim();
}

/**
 * 「latent 解析不出值」的两种**结构性**原因，卡片 / 参数条 / 输入槽 / 属性面板四处共用同一套说法。
 *
 * 必须和「未选择 / 尚未上传」区别开：链断了的时候补文件完全没用，
 * 而在这之前所有情况都只说「未选择」，用户会一直重新上传到放弃。
 */
export function latentBrokenLabel(broken?: 'cycle' | 'upstream' | 'empty' | 'unpicked' | null) {
  if (broken === 'cycle') return '接续链成环';
  if (broken === 'upstream') return '中转未接上游';
  if (broken === 'empty') return '上游还没有 latent';
  if (broken === 'unpicked') return '还没选 latent';
  return '';
}

/** 上面那句的长解释，给有空间写一句话的地方用。 */
export function latentBrokenHint(broken?: 'cycle' | 'upstream' | 'empty' | 'unpicked' | null) {
  if (broken === 'cycle') return '连线连成环了，取不到 latent —— 检查 latent / 中转节点之间的连线';
  if (broken === 'upstream') return '中转节点还没接上任何 latent，透传不出值';
  if (broken === 'empty') return '上游视频节点一次都还没生成过（也就没归档出 latent）—— 先在它上面跑一次生成';
  if (broken === 'unpicked') return '上游视频节点产出过多份 latent（粗 / 精、或多轮）—— 请在「取自哪次生成」里指定一份';
  return '';
}

/*
 * 比例档位搬去了 `lib/workflows/imageParams.ts` —— 首页那个大输入框也要用它，
 * 而 lib 不该反向 import components。这里原样转出，画布侧的 import 不用改。
 */
export { ASPECT_RATIOS, DEFAULT_RATIO, defaultImageRatioForEngine } from '@/lib/workflows/imageParams';

export const LATENT_ACCEPT = '.latent,.pt,.safetensors,.bin,.zip,.tar';

/*
 * 出图参数的默认值与上下限搬到了 `lib/workflows/imageParams.ts`——生成接口要用同一份定义
 * 在服务端校验，不能只有 UI 知道边界。这里原样转出，UI 的 import 不用改。
 */
export {
  IMAGE_DEFAULTS, MAX_BATCH, MAX_CFG, MAX_MEGAPIXELS, MAX_STEPS, MIN_MEGAPIXELS, SAMPLERS, samplerLabel, deriveImageSize,
  IMAGE_SIZE_MODES, MAX_CUSTOM_SIDE, MIN_CUSTOM_SIDE, readImageSizeMode, resolveImageSize, validateCustomSize,
} from '@/lib/workflows/imageParams';

/**
 * 这两种节点选中时给的是**画布底部那个生成对话框**（`GenerateDock`），
 * 不是卡片下方那条参数条（2026-09-21）。
 *
 * 判定放在这里而不是组件里：`NodeCard` 要拿它决定「这一颗还要不要浮参数条」，
 * `CanvasEditor` 要拿它决定「要不要把底部那块抬出来」—— 两边判的是同一件事，
 * 各写一份就会出现「浮条没了但对话框也没出来」这种两边都空的状态。
 */
export function usesGenerateDock(kind: string | undefined | null) {
  return kind === 'image-generate' || kind === 'video-generate' || kind === 'app-generate';
}

/**
 * 应用节点的下拉里该列哪些 —— **只看 ID 前缀**（`app-<数字>`）。
 *
 * 与「按用途筛」那条路不冲突：一个应用出图还是出片是导入时定的，节点上没选应用之前
 * 无从知道该按哪个用途筛，所以这里**先全列**，等选好了再由 `appPurposeOf` 定用途。
 */
export function workflowsForApp<T extends WorkflowOption>(workflows: T[]): T[] {
  return workflows.filter(item => isRunningHubAppWorkflowId(item.workflowId) && item.operation === 'generate');
}

/**
 * 应用节点这一次提交该报哪个用途 —— **跟着选中的那份应用走**。
 *
 * 服务端会拿它跟草稿的用途对账（选错的症状是「任务成功、产出另一种媒体」，全程不报错），
 * 所以这里不能写死成一个值。没选 / 选的那份不在清单里时回落到「图片」：
 * 大多数应用是出图的，而回落成视频会把一次出图跑成出片。
 */
export function appPurposeOf<T extends WorkflowOption>(workflows: T[], workflowId: string): 'image' | 'video' {
  const hit = workflows.find(item => item.workflowId === workflowId);
  return hit?.kind === 'video' ? 'video' : 'image';
}

/*
 * 图片生成节点的「引擎」值域，以及同步出图那几个参数，同样搬到了 `lib/workflows/*`：
 * 服务端那条提交通道要用同一份定义校验。这里原样转出，画布组件的 import 都从本文件走。
 *
 * 注意 `readImage2Params` 与 `validateImage2Params` 的分工：前者给默认值（没填也能提交），
 * 后者只管「填了但填错」。**提交前两个都要用**，只用一个就会出现「没填的参数空着发出去」
 * 或者「手改的脏值被静默改成默认值」。
 */
export {
  DEFAULT_IMAGE_ENGINE, IMAGE_ENGINE_OPTIONS, IMAGE_ENGINES, imageEngineLabel, imageEngineOptions,
  imageEngineProvider, isImageEngine, readImageEngine, usesWorkflowEngine as imageUsesWorkflow,
} from '@/lib/workflows/imageEngine';
export type { ImageEngine } from '@/lib/workflows/imageEngine';
export {
  IMAGE2_BACKGROUNDS, IMAGE2_DEFAULTS, IMAGE2_FIXED_RATIO, IMAGE2_RATIO_AUTO, IMAGE2_RATIOS,
  IMAGE2_RESOLUTIONS, IMAGE2_SIZE_AUTO, image2Size, readImage2Params, validateImage2Params,
} from '@/lib/workflows/image2Params';
export type { Image2ParamValues, Image2Request } from '@/lib/workflows/image2Params';
export {
  DEFAULT_VIDEO_ENGINE, VIDEO_ENGINE_OPTIONS, VIDEO_ENGINES, readVideoEngine, videoEngineLabel,
  videoEngineOptions, videoEngineProvider,
} from '@/lib/workflows/videoEngine';
export type { VideoEngine } from '@/lib/workflows/videoEngine';
export {
  VIDEO_API_DEFAULTS, VIDEO_API_RATIOS, VIDEO_API_RESOLUTIONS, readVideoApiParams, validateVideoApiParams,
} from '@/lib/workflows/videoApiParams';
export type { VideoApiParamValues, VideoApiRequest } from '@/lib/workflows/videoApiParams';
export {
  DEFAULT_INSTANCE_TYPE, INSTANCE_TYPE_OPTIONS, RUNNINGHUB_INSTANCE_TYPES, instanceTypeHint,
  instanceTypeLabel, isDefaultInstanceType, isInstanceType, readInstanceType,
} from '@/lib/workflows/instanceType';
export type { RunningHubInstanceType } from '@/lib/workflows/instanceType';

export const latentAssetPrefix = 'asset:';

/* 地址后缀的三个判定同样搬去了 `./mediaChain`（反推要认「这是图还是视频」），这里只转出。 */
export function isVideoUrl(value: unknown) {
  return isVideoUrlIn(value);
}

export function isImageUrl(value: unknown) {
  return isImageUrlIn(value);
}

/**
 * 音频地址（2026-10-02）。
 *
 * 为什么非得有它：好几处「这个结果该画成什么」的判定写的是
 * **`isVideoUrl()` 为假就当图片**。音频既不落在视频那一支、也不该当图片画
 * —— 拿 `xxx.mp3` 去喂 `<img>` 得到的是一张打不开的坏图，而 node 卡片 /
 * 参数条 / 底栏的「预览」都在走这条判定。三个地方一律改成「不是视频也不是音频才当图片」。
 */
export function isAudioUrl(value: unknown) {
  return /\.(mp3|wav|m4a|aac|ogg|flac)(\?|#|$)/i.test(String(value ?? ''));
}

export function formatSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * 只吃这三个字段是有意的：除了项目里那份 `LatentRecord`，
 * 从资产库带回来的那几份 latent 也走这里（它们没有 `createdAt` / `sourceTaskId`）。
 */
/**
 * 「上游这一次生成归档了几份 latent，中转节点要其中哪一份」—— 两处共用的那一段判定。
 *
 * 两个入口都走它：视频生成节点（按 `data.runs` 找自己的归档）和从资产库放进来的
 * 视频节点（按导入时记下的那份快照）。**别在两头各写一遍** ——
 * 一边判定成 `empty`、另一边判定成 `unpicked`，界面上就成了同一件事两种说法。
 *
 * 🔴 `unpicked` 不是「没有」：没选哪一份时**不能**悄悄挑第一份。一次生成归档两份
 * （粗 / 精），跑多轮又有好几组，猜错的症状是接续悄悄喂了错的 latent ——
 * 任务照样成功、产出和上一段毫无关系，界面上什么都不说。
 */
export function resolvePickedLatent(ids: string[], pick: string, from: string): {
  value: string; from: string; broken: 'empty' | 'unpicked' | null;
} {
  if (!ids.length) return { value: '', from, broken: 'empty' };
  if (!pick || !ids.includes(pick)) return { value: '', from, broken: 'unpicked' };
  return { value: pick, from, broken: null };
}

/**
 * 这个节点能不能当中转节点的 latent 源头（2026-10-02）。
 *
 * 除了 `latent` / `latent-relay` / `video-generate`，**从资产库放进来的视频也算** ——
 * 它身上带着「那次生成归档了哪几份」的快照（`sourceTaskId` + `relayLatents`），
 * 于是「拿库里那段视频续接下一段」不必回到原来的画布去找那个视频生成节点
 * （它可能已经删了，也可能在别的项目里）。
 */
export function isRelayLatentSource(data: { kind?: unknown; sourceTaskId?: unknown }) {
  return data.kind === 'video-input' && !!data.sourceTaskId;
}

/**
 * 只吃这三个字段是有意的：除了项目里那份 `LatentRecord`，
 * 从资产库带回来的那几份 latent 也走这里（它们没有 `createdAt` / `sourceTaskId`）。
 */
export function latentLabel(item: { sequence: string; kind: string; size: number }) {
  return `${item.sequence} · ${item.kind === 'fine' ? '精采样' : '粗采样'} · ${formatSize(item.size)}`;
}

/**
 * 显示名之后要不要再补一段工作流编号：**起了名字才补**（没起名字时显示名本身就是编号）。
 *
 * 认人靠名字，但排查问题时（日志、另一台机器上的同一份配置、跟 RunningHub 对上）需要编号，
 * 只显示名字会让现场对不上。卡片和下拉都用这一条，别在各自那儿再拼一遍。
 */
export function workflowIdNote(item: WorkflowOption) {
  return workflowDisplayName(item) === item.workflowId ? '' : ` · ${item.workflowId}`;
}

/**
 * 下拉里的一行。`withPurpose` 只在**混着列**的时候用（老画布那个遗留的 workflow 节点，
 * 它没有用途，列全部）；生成节点的下拉已经按用途过滤过，再打一遍用途标签是噪音。
 *
 * 显示的是**用户起的名字**，没起名字回落 `workflowId`（回落规则在 `lib/workflows/label.ts`）。
 */
/**
 * 下拉里一行的文案。
 *
 * **不再带「本机 · 」前缀**（2026-09-21）：来源现在由下拉的**分组标题**（`<optgroup>`）说，
 * 每行再挂一遍字样就是同一句话说两次 —— 而且它还把真正要认的东西（名字）挤到了后面。
 * 只在**不分来源**的场合（老画布那个遗留的 workflow 节点混着列）才补前缀，
 * 那种情况由调用方传 `withProvider` 打开。
 */
export function workflowLabel(item: WorkflowOption, withPurpose = false, withProvider = false) {
  return `${item.isDefault ? '★ ' : ''}${withProvider && item.provider === 'local' ? '本机 · ' : ''}${workflowDisplayName(item)}${workflowIdNote(item)} · ${item.enabledCount} 项启用${withPurpose ? ` · ${generatorKindLabel(item.kind)}` : ''}`;
}

/**
 * 「这个节点上选的工作流不在本用途的列表里」时的说明。
 *
 * 这种情况来自历史数据（加用途之前，图片节点也可能被选上了视频工作流）或有人手改了画布，
 * 所以**必须把当前值显示出来并说清问题**，不能让下拉静默跳到第一项 ——
 * 界面显示 A、节点里其实是 B 是这套 UI 反复踩过的坑。
 */
export function workflowMismatchHint(purpose: GeneratorKind, chosen: WorkflowOption) {
  return `当前选的工作流「${workflowDisplayName(chosen)}」是${generatorKindLabel(chosen.kind)}生成用的，而这个节点是${generatorKindLabel(purpose)}生成 —— 生成会被服务端拦下。请换一个${generatorKindLabel(purpose)}工作流，或到「设置 · 工作流列表与配置」把这份工作流的用途改成${generatorKindLabel(purpose)}`;
}

/** 一个参数块里最多几行：再多参数条也放不下，而且一次提交几百个参数没有意义。 */
export const MAX_PARAM_ROWS = 40;

/**
 * 拖节点右下角改尺寸时的边界。
 *
 * 下限 160×110 是「看」的门槛：再小的话标题行和状态条会把画框挤没。
 * 上限 1200 只是防止失手拖出一个盖住整张画布的巨块。
 *
 * ⚠️ 2026-09-20：中途为「参数区占据卡片正面」把 minHeight 提到过 190，
 * 那个方案已经撤回（参数区又回到卡片下方的浮层了），所以这里也回到 110。
 * 只有文本节点例外：它的正面是个文本框，`min-height` 由 CSS 的 74px 撑着，
 * 不需要把整个节点类型的最小高度一起抬高。
 */
export const NODE_SIZE = {
  minWidth: 160,
  minHeight: 110,
  maxWidth: 1200,
  maxHeight: 1200,
  /** CSS 里的默认宽度（`.cv-node`），「恢复默认尺寸」要用。 */
  defaultWidth: 240,
} as const;

/** 参数行在界面上的显示名：没起名就退回「节点号.字段名」。 */
export function paramRowLabel(row: ParamRow) {
  const name = String(row.name || '').trim();
  return name || `${row.nodeId}.${row.fieldName}`;
}

export function workflowUpdatedAt(item: WorkflowOption) {
  const date = new Date(item.updatedAt);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}
