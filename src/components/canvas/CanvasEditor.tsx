'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap,
  addEdge, useEdgesState, useNodesState, useReactFlow, useStore, ConnectionLineType, SelectionMode,
  type Connection, type Edge, type EdgeTypes, type Node, type NodeTypes, type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ChevronDown, ChevronUp,
  Ban, ClipboardPaste, Copy, CopyPlus, Eye, EyeOff, GitBranch, Globe, History, LayoutGrid, Link2, Maximize2, Palette, Plus,
  Save, Scissors, SlidersHorizontal, Sparkles, Trash2, Unplug, Upload,
} from 'lucide-react';
import '@/app/canvas.css';
import NodeCard from './NodeCard';
import StarEdge from './StarEdge';
import { NodeGlyph } from './nodeIcons';
import CanvasRail from './CanvasRail';
import CanvasAssetPanel, { type CanvasAssetItem } from './CanvasAssetPanel';
/* 左轨五项弹出的那五张浮层。共用一个壳（`CanvasOverlay`），只有内容不同。 */
import CanvasSettingsPanel from './CanvasSettingsPanel';
import CanvasWorkflowPanel from './CanvasWorkflowPanel';
/* 「从工作流库选一份」时要按节点的引擎预置来源档（见 `pickSource`）。 */
import type { WorkflowSource } from '@/components/workflows/WorkflowLibrary';
import CanvasHistoryPanel from './CanvasHistoryPanel';
import CanvasSkillPanel from './CanvasSkillPanel';
import CanvasViewportBar from './CanvasViewportBar';
import CanvasContextMenu, { type CanvasMenuSpec, type MenuGroup, type MenuItem } from './CanvasContextMenu';
import CanvasWallpaper from './CanvasWallpaper';
import CanvasAppearancePanel from './CanvasAppearancePanel';
import CanvasBrowserPanel from './CanvasBrowserPanel';
import CanvasDrawer from './CanvasDrawer';
import CanvasCodexPanel from './CanvasCodexPanel';
import type { CodexSkill } from '@/lib/desktop-codex';
import CanvasResultsPanel from './CanvasResultsPanel';
/* 3D 导演台：加在画布里的那块舞台（存下来的构图参考图会落在这个节点上）。 */
import DirectorPanel from './DirectorPanel';
/* 右上角的运行计时（2026-09-28）。走字关在它自己里面 —— 画布不跟着每秒重渲染。 */
import RunClock, { type RunClockState } from './RunClock';
import GenerateDock, { type DockAnchor } from './GenerateDock';
import { ConfirmDialog } from '@/components/ui/ContextMenu';
import { collectRuns } from './collectRuns';
import { optimizeInputOf as optimizeInputIn, promptTextOf as promptTextIn, resolveTextChain } from './textChain';
import type { TextChainEdge, TextChainNode } from './textChain';
import { pickMediaInput as pickMediaInputIn } from './mediaChain';
import type { MediaChain, MediaChainEdge, MediaChainNode } from './mediaChain';
import { compositionPrompt, describeShot, readDirectorScene, type DirectorScene } from '@/lib/director';
import { buildArchiveForm } from '@/lib/image-tools';
import { NODE_CARD_COLORS } from '@/lib/appearance';
import { apiPost } from '@/lib/client';
/* 生成落终态时顺手刷站点余额（钱只在生成时变）。 */
import { refreshSiteAccount } from '@/lib/site-account';
/*
 * 抽帧只有一份实现（`./videoFrames`）：视频输入节点上传完取首帧、首尾帧节点取两张，
 * 两处各写一份的话，迟早出现「同一段视频在两处取到的帧不一样」——
 * 而那种差异不报错，只是画面悄悄差半秒。
 */
import { extractEdgeFrames, firstFrameBlob } from './videoFrames';
import { isDocumentFile, readDocumentText } from './docText';
import { browserSupported, grabBrowserImage, onBrowserImage, onBrowserImageDrop, onBrowserImageError } from '@/lib/desktop-browser';
import { codexSupported } from '@/lib/desktop-codex';
import { AUDIO_RESULT_RE, IMAGE_RESULT_RE, VIDEO_RESULT_RE, resultKindOf } from '@/lib/result-kind';
import {
  appPurposeOf, CREATE_KINDS, DEFAULT_RATIO, IMAGE_DEFAULTS, LATENT_SLOTS, NODE_META, resolveImageSize,
  usesGenerateDock, workflowsForApp,
  canConnect, connectionHint, isAudioUrl, isGeneratorKind, isLatentKind, isLatentSourceKind, isVideoUrl, latentAssetPrefix,
  isRunnableKind, isTextValueKind, displayLabelOf, normalizeNodeLabels, resetTransientStatus,
  latentBrokenHint, latentBrokenLabel, latentLabel, purposeOfNode, purposeForNode, workflowMismatchHint, upscaleWorkflowFor,
  nodeEngineProvider, readUpscaleMode, readUpscaleSource, UPSCALE_SOURCE_LABELS,
  isRelayLatentSource, latentPicksOf, resolvePickedLatents,
  workflowDisplayName, generatorKindLabel, newNodeData, isReferenceSource, referenceUrlsOf, latentNodeIdOf,
  mediaReadyForRun, isResolvableUrl, workflowsForProvider, engineSwitchPatch, readInstanceType,
} from './nodeMeta';
import type { NodeKind } from './nodeMeta';
import { validateImageParams } from '@/lib/workflows/imageParams';
/*
 * 参考图 / 视频 / 音频的槽位上限**与配置页能绑的绑定数同源**：
 * 两边不一致会出现「配置页绑得到第 12 张、提交时却只认前 9 张」这种谁也不报错的错。
 */
import { MAX_AUDIO_INPUTS, MAX_REFERENCE_IMAGES, MAX_VIDEO_INPUTS } from '@/lib/workflows/configuration';
/*
 * 同步出图（自定义接口）那套参数**直接从 lib 引**，不走 nodeMeta 的转出 —— 与上面 `validateImageParams`
 * 同一个路子：这个文件只用它们做「提交前的自查」，不需要 nodeMeta 里那套 UI 展示用的东西。
 */
import {
  IMAGE2_DEFAULTS, IMAGE2_MAX_REFERENCES, IMAGE2_SIZE_AUTO, readImage2Params, validateImage2Params,
} from '@/lib/workflows/image2Params';
import { DEFAULT_IMAGE_ENGINE, imageEngineProvider, readImageEngine } from '@/lib/workflows/imageEngine';
import { VIDEO_API_DEFAULTS, validateVideoApiParams } from '@/lib/workflows/videoApiParams';
import { abandonMessage, pollDelayMs } from '@/lib/taskPoll';
import { DEFAULT_VIDEO_ENGINE, readVideoEngine, videoEngineProvider } from '@/lib/workflows/videoEngine';
import { defaultWorkflowId, defaultWorkflowIdFor } from '@/lib/workflows/defaults';
import type { CanvasSeed } from '@/lib/start/compose';
import type { CanvasPayload, GenerationRun, InputSlot, LatentChain, LatentPickOption, LatentRecord, NodeData, ParamRow, RunResult, TextChain, WorkflowOption } from './types';

/**
 * 内置浏览器抽屉的宽度 —— **跟着窗口走**，不是一个固定值。
 *
 * 固定 460 时网页拿到的是一个**手机宽度的视口**：绝大多数站点（Bing 图片、
 * 花瓣、Pinterest 之类）在这个宽度下会切成移动端版式，或者内容横向溢出要来回滚，
 * 找参考图时看不清也点不准 —— 这个面板存在的理由就是「不切出去找图」。
 * 所以按窗口宽度的 42% 取，再夹在 [560, 900]：小窗口不把画布挤没，
 * 大窗口能把网页当正常桌面网页看。左边缘还能自己拖（见 CanvasDrawer 的 grip）。
 */
function browserDrawerWidth(windowWidth: number): number {
  return Math.round(Math.min(Math.max(windowWidth * 0.42, 560), 900));
}

/** Codex 对话抽屉的宽度。对话是窄长条更舒服。 */
const CODEX_DRAWER_WIDTH = 440;
/** 「生成结果」抽屉的宽度。里面是图 / 视频，比对话宽一点，比浏览器窄一点。 */
const RESULTS_DRAWER_WIDTH = 420;

/* ---------------- 生成对话框（`GenerateDock`）贴在节点下方的那套尺寸 ---------------- */
/** 常规宽度。窄到这个值以下就跟着画布缩，别撑出去。 */
const DOCK_WIDTH = 680;
const DOCK_MIN_W = 320;
/**
 * 高度上限：展开「自定义参数」之后很长，没上限会把画布整个吃掉。
 *
 * 🔴 这是**唯一还在管高度的数** —— 面板多高由它自己内容决定，只在这里封顶。
 * ⚠️ **别再拿「下方还剩多少」去压它**（2026-10-02 徐先：「不是压矮」）：压矮之后
 * 提示词只剩一条缝，比「往画布外面伸一截」难受得多。
 */
const DOCK_MAX_H = 460;
/**
 * 面板的「自然高度」≈ 240，**只作说明，不参与计算**。
 *
 * 组成：标题 20 + 参考图 44 + 提示词 56 + 操作排 81 + 间隙 24 + 内边距 12 ≈ 237。
 * 改任何一处内容高度都要回来改这句注释。
 *
 * ⚠️ 它以前当过「这一边放得下吗」的门槛（放不下就翻到节点上方）和面板高度的下限，
 * 那一支 2026-10-02 已删 —— 现在高度完全由内容决定，只受 `DOCK_MAX_H` 封顶。
 * 曾经写过 330（那时主层有 330 高），也写过 190：写太小会在下方只剩 200 出头时
 * 也照放不误 —— 面板被压得比内容矮，而那时操作排还没 sticky，底部那一排连同
 * 发送按钮被卷到可视区外，用户不滚一下根本看不见发送键。
 */
/** 与节点之间的空隙 / 左右两道安全边距（上下不夹，见下面第二条规则）。 */
const DOCK_GAP = 12;
const DOCK_EDGE = 12;
/** 量不到节点实测尺寸时的兜底（一张生成卡片的常规大小）。 */
const DOCK_FALLBACK_W = 220;
const DOCK_FALLBACK_H = 150;

/**
 * 画布当前的观察框：视口变换 + 画布**宽度**。
 * ⚠️ 没有 `height` —— 面板已经不做上下夹取了，画布多高跟它没关系（见下面第二条）。
 */
type DockFrame = { x: number; y: number; zoom: number; width: number };

/**
 * 对话框该钉在哪儿 —— **纯函数**，好读也好改。
 *
 * React Flow 把每个节点摆在自己的 flow 坐标上，整块画布再用
 * `translate(x, y) scale(zoom)` 变换一次，所以
 * `画布坐标 = flow 坐标 × zoom + 平移量`。
 *
 * 三条取值规则（2026-10-02 徐先定的）：
 *   1. **永远**贴在节点**正下方**，左右以节点为中心（不是跟画布对齐）；
 *   2. **高度不跟着下方剩余空间变** —— 下方装不下就让它**往下伸出画布**；
 *   3. 只有**左右**越界才往回收，**上下一律不夹**。
 *
 * 🔴 **不再「翻到节点上方」**（徐先：「如果节点移到下面，提示词参数框不用移到上方」）。
 * 老规则是「下方装不下主层就翻上去」—— 翻上去那一刻面板离节点一整屏远，
 * 而且是**bottom 定位、往上长**，一展开就占掉上半屏，看着跟那个节点没关系了。
 *
 * 🔴 **也不再「压矮」**（同一轮他的第二句：「不是压矮」）。为了不翻上去而想出的折中是
 * 「下方剩多少给多少、最多压到 120」—— 面板是没被裁了，可 120 高意味着提示词只剩
 * 一条缝，正是这块面板最没用的时候。他要的是**面板保持原样**，多出来的一截往画布外伸。
 *
 * ⚠️ 「往下伸出画布」是有代价的，别当成 bug 再修回去：
 *   - 最底下的**操作排连同发送键会被裁掉**，得把节点往上移一点才看得见；
 *   - 会压住左下角那条视口控制条 `.cv-vp`（`left:14 / bottom:14`、高 38px）。
 *   换来的是**位置永不跳动**：面板永远在节点正下方 12px，节点往上挪一点它就自己回来。
 */
function dockAnchorFor(
  node: Node<NodeData>,
  frame: DockFrame,
  /**
   * 这个节点的**实测**尺寸（DOM 量出来的，flow 坐标）。
   *
   * 🔴 见 `dockSize` 那段注释：`node.measured` 在用户拖宽节点之后会**停在旧值**，
   * 拿它算高度就会把面板贴进卡片中间。实测值优先，量不到才退回 `measured`。
   */
  size?: { w: number; h: number } | null,
): DockAnchor {
  const zoom = frame.zoom || 1;
  /* 画布还没量出来（首帧 width 是 0）时按窗口算 —— 不然会蹦到左上角一下。 */
  const paneW = frame.width || window.innerWidth;
  const nodeLeft = node.position.x * zoom + frame.x;
  const nodeTop = node.position.y * zoom + frame.y;
  const boxW = (size?.w || node.measured?.width || node.width || DOCK_FALLBACK_W) * zoom;
  const boxH = (size?.h || node.measured?.height || node.height || DOCK_FALLBACK_H) * zoom;

  const width = Math.max(DOCK_MIN_W, Math.min(DOCK_WIDTH, paneW - DOCK_EDGE * 2));
  const centered = nodeLeft + boxW / 2 - width / 2;
  const left = Math.max(DOCK_EDGE, Math.min(centered, paneW - width - DOCK_EDGE));

  /** 位置：节点下沿再往下 `DOCK_GAP`。**不加任何上下夹取** —— 见上面第二条。 */
  const top = nodeTop + boxH + DOCK_GAP;
  return { left, width, top, maxHeight: DOCK_MAX_H };
}

/**
 * 左轨五项弹出的那张浮层。五项共用一个 state（同时只开一个），
 * 所以「有哪几项」这件事要写在一处 —— 加一项时这里与 `CanvasRail.RAIL_ITEMS` 一起改。
 */
type CanvasOverlayKey = 'assets' | 'workflow' | 'skill' | 'history' | 'settings';

/**
 * 复制节点时要丢掉的字段。
 *
 * 分两类：`on*` 回调是 `hydrated` 现挂的（复制走了会指向旧节点），
 * 其余是注入的派生数据或「属于那一个节点的历史」——生成记录尤其不能跟着复制品走，
 * 否则新节点上会凭空多出几次它从没跑过的生成。
 */
const CLONE_SKIP = new Set([
  'runs', 'status', 'result',
  'latents', 'workflows', 'inputs', 'passthroughImage', 'workflowSource',
  'upstreamStatus', 'upstreamResult', 'upstreamLabel',
  'referenceCount', 'latentCount', 'paramCount',
  // 参数块用哪份工作流的候选，是每帧按当前连线现算的：复制品连的是另一条链，带过去会指向旧的那个生成节点
  'paramWorkflowId', 'paramWorkflowNote',
  // 中转值是每帧按当前连线算出来的，复制品会自己重算，带过去反而指向旧上游
  'relayValue', 'relayFrom', 'relayBroken',
]);

/** 没有鼠标位置可参照时，粘贴出来的节点整体往右下挪这么多。 */
const PASTE_OFFSET = 36;

/** Ctrl+D 的原地复制也要挪一点，完全重合的话看不出到底复制了没有。 */
const DUPLICATE_OFFSET = 24;

/** 光标是不是正在输入——快捷键不该劫持用户在输入框里的操作。 */
function isEditingField() {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

function cloneNodeData(data: NodeData): NodeData {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('on') || CLONE_SKIP.has(key)) continue;
    next[key] = value;
  }
  // 参数行的 id 是 React key，复制品换了新 id 免得两份共用
  if (Array.isArray(next.paramRows)) {
    next.paramRows = (next.paramRows as ParamRow[]).map(row => ({ ...row, id: crypto.randomUUID() }));
  }
  return next as NodeData;
}

/**
 * Turn the directly connected upstream nodes into slots the parameter node can render:
 * the reference image thumbnail, the prompt excerpt, the latent sequence and the workflow id.
 *
 * `continuationOn` is the generator node's own switch. A latent slot only blocks anything
 * while that switch is on — with continuation off the node is wired up but unused, so it is
 * reported as `skipped` instead of `pending` and never asks to be uploaded.
 */
/**
 * 一条 latent 链上只有**最靠近生成节点**的那个算数。
 *
 * `sources()` 是递归的，所以「latent → 中转 → 生成」会把 latent 和中转一起列为上游；
 * 不加这一条判断，同一份 latent 会占掉两个槽（一次以自己、一次以中转的身份）。
 * 同理，中转串中转时也只取最后那一节。
 */
function isTerminalLatent(id: string, upstream: Node<NodeData>[], edges: Edge[]) {
  const self = upstream.find(item => item.id === id);
  if (!self || !isLatentKind(self.data.kind)) return false;
  const ids = new Set(upstream.map(item => item.id));
  return !edges.some(edge => edge.source === id
    && ids.has(edge.target)
    && isLatentKind(upstream.find(item => item.id === edge.target)?.data.kind));
}

/**
 * 这批 latent 节点里有没有环（沿上游连线能不能走回自己）。
 *
 * 为什么不复用 `latentChainOf` 的 `broken`：那条解析是「遇到有值就停」的，
 * 环上只要还挂着一条有值的 latent，解析会绕开环直接把值取回来，
 * 于是 `broken` 是空的 —— **可环还在**。环的后果不是「取不到值」，
 * 而是「环上每个节点都成了别人的上游，`isTerminalLatent` 一个都不认」，
 * 最后一个槽位都排不出来。所以必须单独按结构判一次。
 */
function hasLatentCycle(ids: string[], edges: Edge[]) {
  const pool = new Set(ids);
  return ids.some(from => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const current = stack.pop() as string;
      for (const edge of edges) {
        if (edge.target !== current || !pool.has(edge.source)) continue;
        if (edge.source === from) return true;
        if (seen.has(edge.source)) continue;
        seen.add(edge.source);
        stack.push(edge.source);
      }
    }
    return false;
  });
}

/**
 * 沿**上游**连线走，`from` 能不能走回 `to`。
 *
 * 判断要不要添一条 `source → target` 时，问的是 **`source` 沿上游能不能摸到 `target`**
 * —— 摸得到说明 `target` 已经是 `source` 的上游了，再补这条就把两头接成一个圈。
 *
 * 别把两个参数写反：`target` 沿上游摸到 `source`（`source` 本来就在上游）只是多一条并联捷径，
 * 不构成圈，那种情况不该拦（ACCEPTS 里「多个上游接同一个节点」本来就是允许的用法）。
 *
 * 快捷键看不见嫁接的结果，不像拖端口那样「连错了用户一眼能看出来」，所以这条要替用户先看一遍。
 */
function isUpstreamOf(edges: Edge[], from: string, to: string) {
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length) {
    const current = stack.pop() as string;
    for (const edge of edges) {
      if (edge.target !== current || seen.has(edge.source)) continue;
      if (edge.source === to) return true;
      seen.add(edge.source);
      stack.push(edge.source);
    }
  }
  return false;
}

function inputSlots(
  list: Node<NodeData>[],
  archived: LatentRecord[],
  continuationOn: boolean,
  edges: Edge[] = [],
  /** 中转节点的值是沿链算出来的，这里得拿到同一个解析器，否则槽位会把它画成「未选择」。 */
  chainOf: (id: string) => LatentChain = () => ({ values: [], value: '', from: '', broken: null }),
): InputSlot[] {
  return list.map(node => {
    const kind = String(node.data.kind || 'text');
    const title = String(node.data.label || NODE_META[kind as NodeKind]?.label || kind);
    if (kind === 'image') {
      const thumb = String(node.data.imageUrl || node.data.previewUrl || '');
      return {
        id: node.id, kind, title, thumb, previewable: !!thumb,
        ready: !!node.data.remoteFile,
        note: node.data.remoteFile
          ? '已上传'
          : node.data.status === 'uploading'
            ? '上传中…'
            : thumb ? '需重新上传' : '未选图',
      };
    }
    if (kind === 'video-input') {
      const src = String(node.data.videoRemoteUrl || node.data.videoUrl || '');
      /** 首帧图当缩略图：接进生成节点时它跟参考图长得一样，一眼能看出这段视频已经连上了。 */
      const thumb = String(node.data.previewUrl || node.data.imageUrl || '');
      return {
        id: node.id, kind, title, thumb, previewable: !!thumb,
        ready: !!node.data.remoteFile,
        note: node.data.remoteFile
          ? '首帧已就绪'
          : node.data.status === 'uploading'
            ? '上传中…'
            : src ? '需重新上传' : '未选视频',
      };
    }
    if (kind === 'audio-input') {
      const src = String(node.data.audioRemoteUrl || node.data.audioUrl || '');
      return {
        id: node.id, kind, title, thumb: '', previewable: false,
        ready: !!node.data.audioRemoteFile,
        note: node.data.audioRemoteFile
          ? '音频已就绪'
          : node.data.status === 'uploading'
            ? '上传中…'
            : src ? '需重新上传' : '未选音频',
      };
    }
    if (kind === 'frame-extract') {
      /** 缩略图用首帧：两帧里它是「这一段从哪开始」，比尾帧更像这段视频的脸。 */
      const thumb = String(node.data.firstFrameUrl || '');
      const got = referenceUrlsOf(node.data).length;
      return {
        id: node.id, kind, title, thumb, previewable: !!thumb,
        ready: got > 0,
        note: got
          ? (got > 1 ? '首帧 + 尾帧已就绪' : '已提取 1 张')
          : node.data.status === 'running'
            ? '提取中…'
            : '还没提取出帧',
      };
    }
    /** 优化节点也能直接当提示词来源：它在槽位里显的是**改写后**那句。 */
    if (kind === 'prompt-optimize') {
      const text = String(node.data.optimizedText || node.data.textValue || '').trim();
      return {
        id: node.id, kind, title, ready: !!text, previewable: false,
        thumb: text ? (text.length > 26 ? `${text.slice(0, 26)}…` : text) : '',
        note: text ? '已改写' : '还没跑过',
      };
    }
    if (kind === 'text') {
      /** `textValue` 是沿链算出来的（上游可能是优化节点），没有它才看自己写的那句。 */
      const text = String(node.data.textValue || node.data.text || '').trim();
      return {
        id: node.id, kind, title, ready: !!text, previewable: false,
        thumb: text ? (text.length > 26 ? `${text.slice(0, 26)}…` : text) : '',
        note: text ? '已连接' : '未填写',
      };
    }
    if (isLatentKind(kind)) {
      const nodeOn = node.data.latentEnabled !== 'off';
      /** Only counts as "in use" when both the node switch and the generator's switch agree. */
      const used = continuationOn && nodeOn;
      const chain = chainOf(node.id);
      const value = String(chain.value || node.data.remoteFile || '');
      const match = archived.find(item => `${latentAssetPrefix}${item.id}` === value);
      const label = match ? match.sequence : value ? String(value).split('/').pop() || '' : '';
      const indexes = (node.data.latentIndexes || []).filter(index => index >= 1 && index <= LATENT_SLOTS);
      /** 已经被下游中转节点接走了：它自己不再占槽，卡片上要照实说，别画成「已就绪」。 */
      const relayed = !isTerminalLatent(node.id, list, edges);
      return {
        id: node.id, kind, title, previewable: false,
        ready: used && !!value && !relayed,
        skipped: !used || relayed,
        thumb: indexes.length ? `${label} → #${indexes.join('/#')}` : label,
        note: !nodeOn ? '已停用'
          : !continuationOn ? '接续已关 · 未参与'
            : relayed ? '已转交下游中转节点'
              : value ? '已就绪'
                : latentBrokenLabel(chain.broken) || '未选择',
      };
    }
    if (kind === 'params') {
      const rows = (node.data.paramRows || []) as ParamRow[];
      const usable = rows.filter(row => row.enabled && row.value.trim()).length;
      return {
        id: node.id, kind, title, previewable: false,
        ready: usable > 0,
        thumb: `${usable} 行`,
        note: usable ? `已就绪 · 共 ${rows.length} 行` : rows.length ? '没有可用行' : '未添加参数',
      };
    }
    if (kind === 'director') {
      const shot = String(node.data.imageUrl || '');
      return {
        id: node.id, kind, title, thumb: shot, previewable: !!shot, ready: !!shot,
        note: shot ? '构图参考图已就绪' : '还没存过参考图',
      };
    }
    /*
     * 上游是**另一个生成节点**（2026-10-01 起能直连）。
     * 这一格必须说清它此刻**有没有东西可交** —— 不然「线连上了、上游还没跑」
     * 和「连好了、会传下去」在界面上长得一模一样，而这两种状态差着一次生成。
     * 出图的给缩略图；出片的没封面帧（节点上只存了整段视频），就只用文字说清。
     */
    if (isGeneratorKind(kind)) {
      const url = String(node.data.resultUrl || '').trim();
      const asImage = url && !isVideoUrl(url) && !isAudioUrl(url) ? url : '';
      return {
        id: node.id, kind, title, thumb: asImage, previewable: !!asImage,
        ready: !!url,
        note: url
          ? (asImage ? '已出图 · 当参考图传下去' : isAudioUrl(url) ? '已出音频 · 整段交下去' : '已出片 · 整段交下去')
          : node.data.status === 'running' ? '生成中…' : '还没跑过',
      };
    }
    const id = String(node.data.workflowId || '');
    return { id: node.id, kind, title, ready: !!id, previewable: false, thumb: id, note: id ? '已选择' : '未选择' };
  });
}

const nodeTypes: NodeTypes = { frame: NodeCard };
/**
 * 连线只有一种（2026-10-01 起换成 `StarEdge`）：平时就是普通贝塞尔线，
 * 两端有节点在跑时才在上面撒流动的星星 —— 详见 StarEdge 里的注释。
 *
 * ⚠️ 必须和 `nodeTypes` 一样定义在**组件外面**：每次渲染新建一个对象会让 React Flow
 * 认为边类型整个换掉了，于是所有边全部重新挂载（动画从头开始、选中态也会掉）。
 */
const edgeTypes: EdgeTypes = { star: StarEdge };

/** A drag carrying files, as opposed to an internal React Flow drag. */
function carriesFiles(event: { dataTransfer?: DataTransfer | null }) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

/**
 * 抽帧的实现在 `./videoFrames`：seek 的超时、尾帧的偏移、跨域读不到像素时的说法
 * 都在那里。这个文件只管「取回来之后往哪儿传」。
 */

/**
 * 把抽出来的那一帧**存成项目资产**，换回两个值：能显示的地址、以及提交时用的值。
 *
 * 两个字段填的是**同一个**本地地址，不是偷懒：界面缩略图要它，提交生成时服务端也要它 ——
 * `resolveReferenceImages` 会读盘取字节再传到工作流那边（`lib/referenceImages.ts`）。
 * 所以这里不必先往 RunningHub 传一遍；传了反而让「取两帧」这件事依赖另一家平台的 Key。
 */
async function uploadFrameImage(blob: Blob, name: string, projectId: string) {
  const body = await apiPost<{ items: { url: string }[] }>(
    '/api/tools/archive',
    buildArchiveForm([{ name, blob, note: '视频首尾帧' }], projectId),
  );
  const url = String(body.items?.[0]?.url || '');
  if (!url) throw new Error('抽出来的帧没能存进项目，请重试。');
  return { url, fileName: url };
}

async function json(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
}

/**
 * 首页带过来的那份「预设」要变成哪些节点。
 *
 * 两套形状（调用方在没有 seed 时另有一套「示例节点」，不归这里管）：
 *   - `image`：提示词 → 图片生成 → 图片输出。出图**不吃 latent**（接续是视频链路的概念），
 *     所以不给 latent 节点 —— 给了也连不上，只是多一个要用户去理解空框；
 *   - `video`：提示词 + 参考图 + 接续 → 视频生成 → 图片输出。
 *
 * 参数写进生成节点的 `data`，字段名必须与参数条读的那套一致 —— **引擎决定写哪一组**
 * （`image2*` / `videoApi*` / 工作流那套裸字段），串着写会让参数条显示成「什么都没选」。
 *
 * 参考图已经是本站资产地址（`/api/assets/…`），所以直接落成图片输入节点并连上生成节点：
 * 服务端取字节和画布显示缩略图用的都是它，不需要再上传一次。
 */
function seedCanvas(seed: CanvasSeed): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const refs: Node<NodeData>[] = seed.refs.map((url, index) => ({
    id: `ref-${index}`,
    type: 'frame',
    position: { x: 40, y: 300 + index * 96 },
    data: { kind: 'image', label: `参考图 ${index + 1}`, previewUrl: url, result: '已上传' },
  }));
  const refEdges: Edge[] = seed.refs.map((_, index) => ({
    id: `e-ref-${index}`, source: `ref-${index}`, target: 'media-gen',
  }));
  const textNode: Node<NodeData> = {
    id: 'text',
    type: 'frame',
    position: { x: 40, y: 80 },
    data: { kind: 'text', label: NODE_META.text.label, ...(seed.prompt ? { text: seed.prompt } : {}) },
  };
  const outNode: Node<NodeData> = {
    id: 'image-out',
    type: 'frame',
    position: { x: 800, y: 240 },
    data: { kind: 'image-out', label: NODE_META['image-out'].label },
  };

  if (seed.mode === 'image') {
    /*
     * 出图节点只有工作流来源了（Image 2.0 那一档 2026-09-23 删了），
     * 所以 `workflowId` 这一档的态度不变：图片**没有**默认工作流
     * （`defaultWorkflowIdFor('image')` 故意回空串：拿视频那条兜底
     * 会跑出一段视频，而且是「成功」的那种），由用户进画布后在参数条上选，
     * 那条「还没选工作流」的提示本来就在。
     */
    const generator: NodeData = {
        kind: 'image-generate',
        label: NODE_META['image-generate'].label,
        /* 首页那个下拉选的是**来源**，节点上存的也是来源 —— 两边同一个值域，不用翻译。 */
        engine: seed.engine === 'local' ? 'local' : 'runninghub',
        aspectRatio: seed.ratio,
        megapixels: seed.resolution,
        /*
         * 默认工作流只在「云端」那一档填。本机那一档填了也没用：默认那条是 RunningHub 的纯数字 ID，
         * 服务端一比对来源就会拒掉 —— 不如留空，让用户自己去下拉里挑一份本机的。
         */
        workflowId: seed.engine === 'local' ? '' : defaultWorkflowIdFor('image'),
      };
    return {
      nodes: [textNode, ...refs, { id: 'media-gen', type: 'frame', position: { x: 400, y: 120 }, data: generator }, outNode],
      edges: [
        { id: 'e-text', source: 'text', target: 'media-gen' },
        ...refEdges,
        { id: 'e-out', source: 'media-gen', target: 'image-out' },
      ],
    };
  }

  const generator: NodeData = seed.engine === 'videoapi'
    ? {
      kind: 'video-generate',
      label: NODE_META['video-generate'].label,
      engine: 'videoapi',
      videoApiRatio: seed.ratio,
      videoApiResolution: seed.resolution,
      videoApiDuration: seed.duration,
    }
    : {
      kind: 'video-generate',
      label: NODE_META['video-generate'].label,
      /* 首页那个下拉选的是**来源**，节点上存的也是来源 —— 两边同一个值域，不用翻译。 */
      engine: seed.engine === 'local' ? 'local' : 'runninghub',
      duration: seed.duration,
      aspectRatio: seed.ratio,
      megapixels: seed.resolution,
      /*
       * 默认工作流只在「云端」那一档填：默认那条是 RunningHub 的纯数字 ID，
       * 本机那一档填了服务端一比对来源就会拒掉，不如留空让用户自己挑一份本机的。
       */
      workflowId: seed.engine === 'local' ? '' : defaultWorkflowIdFor('video'),
    };
  /*
   * 本机那一档**不摆 latent 节点**：latent 接续是 RunningHub 专属的做法，
   * 服务端会直接 400 拒掉（见 `/api/projects/[id]/generation` 里那条检查）。
   * 摆上去等于一进画布就带着一个注定跑不通的节点，用户得自己发现并删掉它。
   */
  const withLatent = seed.engine !== 'local';
  return {
    nodes: [
      textNode,
      ...refs,
      ...(withLatent ? [{ id: 'latent', type: 'frame', position: { x: 40, y: 300 + seed.refs.length * 96 }, data: { kind: 'latent' as const, label: NODE_META.latent.label } }] : []),
      { id: 'media-gen', type: 'frame', position: { x: 400, y: 120 }, data: generator },
      outNode,
    ],
    edges: [
      { id: 'e-text', source: 'text', target: 'media-gen' },
      ...refEdges,
      ...(withLatent ? [{ id: 'e-latent', source: 'latent', target: 'media-gen' }] : []),
      { id: 'e-out', source: 'media-gen', target: 'image-out' },
    ],
  };
}

function Studio({ projectId, projectName, initial, seed, seedPrompt }: { projectId: string; projectName?: string; initial: CanvasPayload; seed?: CanvasSeed | null; seedPrompt?: string }) {
  /*
   * 新项目的初始节点。首页带过来的 `seed` 优先 —— 它决定建哪种生成节点、参数是什么、
   * 参考图连到哪儿；没有 seed（老链接只带 `?prompt=`、或从别处新建的空画布）就用下面这套示例节点。
   *
   * `seedPrompt` 是**只看那句话**的老路：它落进提示词节点，节点结构完全不动。
   * 两条路都只在新项目（服务端画布为空）时生效 —— 老画布有自己的节点，不该被一段地址改写。
   */
  const seeded = seed ? seedCanvas(seed) : null;
  const seedText = seed?.prompt || seedPrompt || '';
  const defaults: Node<NodeData>[] = seeded ? seeded.nodes : [
    { id: 'text', type: 'frame', position: { x: 40, y: 80 }, data: { kind: 'text', label: NODE_META.text.label, ...(seedText ? { text: seedText } : {}) } },
    { id: 'image', type: 'frame', position: { x: 40, y: 300 }, data: { kind: 'image', label: '参考图 1' } },
    { id: 'latent', type: 'frame', position: { x: 40, y: 520 }, data: { kind: 'latent', label: NODE_META.latent.label } },
    { id: 'video-gen', type: 'frame', position: { x: 400, y: 120 }, data: { kind: 'video-generate', label: NODE_META['video-generate'].label, duration: '6', aspectRatio: DEFAULT_RATIO, megapixels: '0.2', workflowId: defaultWorkflowIdFor('video') } },
    { id: 'image-out', type: 'frame', position: { x: 800, y: 240 }, data: { kind: 'image-out', label: NODE_META['image-out'].label } },
  ];
  const defaultEdges: Edge[] = seeded ? seeded.edges : [
    { id: 'e1', source: 'text', target: 'video-gen' },
    { id: 'e2', source: 'image', target: 'video-gen' },
    { id: 'e5', source: 'video-gen', target: 'image-out' },
  ];

  /*
   * 「是不是空画布」必须对节点和连线一次判完 —— 不能用两把尺子：
   * `useNodesState(initial.nodes.length ? initial.nodes : defaults)` +
   * `useEdgesState(initial.edges.length ? initial.edges : defaultEdges)` 各判各的时候，
   * 会让「有节点、一条连线都没有」的画布走到一半 —— 节点用真实的那批，连线却落回模板，
   * 而模板那三条线指向 `text` / `image` / `video-gen` 这些本画布里根本不存在的节点 id。
   * 界面上看不见（React Flow 会把找不到两头的边丢掉），但下一次自动保存会把这几条悬空边写进库，
   * 每次打开这张画布都再写一遍。所以这里只用「节点是不是空」这把尺子。
   */
  const starter = initial.nodes.length === 0;
  /* 名字归一化放在这一个口（见 `nodeMeta.normalizeNodeLabels` 的注释）：
     下游十几处直接读 `node.data.label`，在这里过一遍就等于全修好。 */
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>(
    /* 两个归一化都在**这一个口**做（名字 / 假状态），下游十几处直接读 `data` 的地方
       就都跟着对了。⚠️ 只在这一处做复位，**不加到 MCP 那条刷新路径上** ——
       那条路随时可能在我们正上传的那一刻把画布整份换掉，复位会把**真的在传**的状态抹掉。 */
    starter ? defaults : resetTransientStatus(normalizeNodeLabels(initial.nodes)),
  );
  /*
   * 泛型要写 `Edge` 而不是靠推断：不写的话类型会缩成持久化用的那三个字段
   * （`{ id, source, target }`），而 React Flow 选中连线时写回来的 `selected`
   * 就变成了「运行时有、类型里没有」—— 按 X 断开连线要读它，读不到。
   */
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(starter ? defaultEdges : initial.edges);
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * 参数底栏贴的那个节点的**实测尺寸**（2026-10-03 徐先：「我放大节点之后，再点击节点，
   * 框直接到画面中了」）。
   *
   * 🔴 为什么不能读 `node.measured`：节点尺寸是 `data.width/height` 驱动出来的
   * （拖右下角把手、换比例、结果图/视频加载完都会改），而 React Flow 那份 `measured`
   * 只反映**它自己最近一次测量**的结果 —— 实测下来，把节点从 707×463 拖到 1157×716 之后，
   * `measured.height` 一直停在 463 不动（等 2 秒、取消选中再点，都不动）。
   * 于是面板还按旧高度往下贴，直接贴进了卡片中间（实测差 128px，视觉上就是「框跑到画面里」）。
   *
   * 所以这里**直接盯那个节点的 DOM**：尺寸一变就跟着走，跟 React Flow 的账本无关。
   * 只在有 dock 的时候观察（同时观察整块画布的每个节点没有必要，也很贵）。
   */
  const [dockSize, setDockSize] = useState<{ id: string; w: number; h: number } | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed' | 'conflict'>('saved');
  const [latents, setLatents] = useState<LatentRecord[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  /**
   * 右键菜单。`spec` 里带上「点在什么上面」与屏幕坐标，菜单条目按下文 `menuGroups` 现算 ——
   * 菜单内容取决于当前选了什么，快照在打开那一刻的旧数据会删错节点。
   */
  const [menu, setMenu] = useState<CanvasMenuSpec | null>(null);
  /* 小地图默认开着（和以前一致），左下角控制条上的按钮可以收掉它 ——
     窗口本来就不大的时候它只会挡着画布右下角那一片。 */
  const [miniMap, setMiniMap] = useState(true);
  /** 右下角「画布外观」面板。 */
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  /**
   * 无遮挡模式（2026-10-02 徐先）：「这些全部收起，只保留画布的功能和右上角那三个选项，
   * 切换快捷键为 Tab，按钮在画面右上角」。
   *
   * 收起的是**界面外壳**：左上项目名、顶栏那排（余额 / 已保存 / 保存 / 项目 / 启动 / 运行次数）、
   * 左侧工具轨、左下视口控制条、右下小地图、右下那颗「画布外观」圆钮。
   * 留着的是**画布自己**（节点、连线、参数底栏、右键菜单、浮层）+ 右上角那排圆钮
   * （生成结果 / 内置浏览器 / Codex）+ 这颗切换钮本身 —— 它是回来的唯一入口。
   *
   * ⚠️ 顶栏那一格**不清空、只清里面的东西**：它是画布页唯一的窗口拖拽区
   *    （`-webkit-app-region: drag`，见 canvas.css），也是给系统那三个按钮让位的；
   *    连它一起收掉就拖不动窗口了，而且右上角那排圆钮会跟着往上顶进系统按钮底下。
   *
   * 不落盘（和 `miniMap` / `appearanceOpen` 一样是**当前这一屏的视图状态**）：
   * 刷新或换项目回到正常模式。它把「保存」这类按钮一并藏了，默认回到能看见的那一档更安全。
   */
  const [zen, setZen] = useState(false);
  /**
   * 左轨五项弹出的那张**居中大浮层**开着的是哪一项（2026-09-21）。
   * `null` = 都关着；`'assets' | 'workflow' | 'skill' | 'history' | 'settings'`。
   *
   * 五项共用一个 state 而不是各开各的：它们占的是同一块屏幕，两个一起开谁也看不清；
   * 而且「点谁谁亮」这件事本来就该只有一处说了算。
   */
  const [overlay, setOverlay] = useState<CanvasOverlayKey | null>(null);
  /**
   * 工作流浮层**直接进哪一份**（2026-10-01 徐先）。
   *
   * 「打开工作流配置」原来是 `<a href="#/settings/providers/workflows?id=…">`。
   * 桌面版是单窗口 hash 路由，那一下点下去**画布就没了** —— 用户只是想改一下这份
   * 工作流的字段绑定，改完还得自己找路回来。现在开的是画布上的工作流浮层，
   * 并且**直接落在这一份的配置屏**（不是先给列表让他再点一次）。关掉即回画布。
   * `null` = 只开列表（左轨那一项、以及「还没选工作流」时）。
   */
  const [overlayWorkflow, setOverlayWorkflow] = useState<string | null>(null);
  /**
   * 这次开工作流库，是**替哪个节点挑一份**（2026-10-01 徐先：「可以下拉，也可以从工作流库中选择」）。
   *
   * 有值 = 列表里每行多一颗「用这一份」，点完写回这个节点并关掉浮层。
   * `null` = 纯浏览 / 配置，不出那颗按钮。
   */
  const [overlayPickNode, setOverlayPickNode] = useState<string | null>(null);
  /** 正在用 3D 导演台摆机位的那个节点。null = 面板关着。 */
  const [directorFor, setDirectorFor] = useState<string | null>(null);
  /** 「设置」浮层里现在看的是哪一页（值就是设置页的 href）。 */
  /** 默认落在「模型服务」：设置区第一页就是它（`SETTING_TABS[0]`），两处别各说一套。 */
  const [settingsTab, setSettingsTab] = useState('/settings/model-services');
  /**
   * 右上角第三个图标：生成结果侧边栏。**跨画布共通** —— 一张画布上能看到所有画布的
   * 生成结果（生成要排队，人不会盯着一张画布等，结果却只在产出它的那张上看得到）。
   * 原来是顶栏一个按钮 + 画布左上角一块浮层，2026-09-17 改成右上角图标 + 右侧抽屉，
   * 与内置浏览器、Codex 并排，三个抽屉同一时间只开一个。
   */
  const [resultsOpen, setResultsOpen] = useState(false);
  /**
   * 内置浏览器（找参考图不用切出去）。
   *
   * 只在**桌面版**才有入口 —— web 版没有那段 preload，按钮点了不会有任何反应，
   * 而一个点了没反应的按钮比没有这个按钮更糟（见 `browserSupported()`）。
   */
  const [browserOpen, setBrowserOpen] = useState(false);
  /**
   * 用户自己拖过的浏览器抽屉宽度（px）。**null = 自动**（跟着窗口走）。
   *
   * 分开存这两个值而不是「一打开就定死」：窗口拉宽之后自动值会跟着变宽，
   * 而一旦用户自己拖过一次，那就成了他的选择 —— 再跟着窗口变来变去是在跟用户抢。
   */
  const [browserWidth, setBrowserWidth] = useState<number | null>(null);
  /** Codex 抽屉的宽度：默认 440，用户拖过左边缘之后听用户的（与 browserWidth 同一条规矩）。 */
  const [codexWidth, setCodexWidth] = useState<number | null>(null);
  /** 窗口宽度，只为算上面那个自动值。**不进依赖数组的那种高频更新** —— 只在 resize 时动。 */
  const [winWidth, setWinWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const browserDrawerSize = browserWidth ?? browserDrawerWidth(winWidth);
  /**
   * Codex 对话侧栏（右上角第二个图标）。入口同样只在桌面版出现：
   * 对话跑在主进程的 `codex app-server` 里，web 版没有那一层（见 `codexSupported()`）。
   */
  const [codexOpen, setCodexOpen] = useState(false);
  /*
   * 挂在 Codex 上的技能。**存在画布这一层**，因为选它的地方有两个：
   * Codex 面板里那颗「SKILL 社区」按钮，和左轨那张 SKILL 浮层。
   */
  const [codexSkill, setCodexSkill] = useState<CodexSkill | null>(null);
  /** Node that a wire was dragged from, when the wire was dropped on empty canvas. */
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  /** Where the current wire drag started, so a plain handle click does not count as a drag. */
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  /** Ctrl+C 复制下来的节点与它们之间的连线，只在本页面内有效。 */
  const clipboard = useRef<{ nodes: Node<NodeData>[]; edges: Edge[] } | null>(null);
  /** 鼠标在画布上的位置，Ctrl+V 时当作落点。 */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  /**
   * 从内置浏览器**拖**过来的那张图，应该在哪个屏幕坐标落下来。
   *
   * 主进程的 `browser:image-drop` 只给「地址 + 落点」，字节要另走一次取图（异步），
   * 所以落点只能先存在这里，等图到了再从 `onBrowserImage` 那条路取用。
   * `url` 与 `at` 是用来认「到的是不是这次拖的那张」的 —— 不然两次操作会串。
   */
  const browserDropAt = useRef<{ url: string; x: number; y: number; at: number } | null>(null);
  /* ---------------- 一键运行（2026-09-27） ---------------- */
  /**
   * 「遍」：整条流程连着跑几遍，ComfyUI 的 Batch count 那个意思。
   * 不是「每个节点出几张」—— 那是每个生成节点自己的「张数」(`batchSize`)。
   */
  const [runTimes, setRunTimes] = useState(1);
  /** 设的遍数超过这个数（11~99）时点启动先弹一次确认，防误设大遍数把积分一次烧光。 */
  const RUN_TIMES_CONFIRM_THRESHOLD = 10;
  const [runTimesConfirm, setRunTimesConfirm] = useState<number | null>(null);
  const [runAllBusy, setRunAllBusy] = useState(false);
  /** 跑到第几遍 / 第几个了，只用来写在按钮上。 */
  const [runProgress, setRunProgress] = useState<{ round: number; times: number; done: number; total: number } | null>(null);
  /** 运行中点一下 = 停：循环每一步都看一眼这个标记。 */
  const runAllStop = useRef(false);

  /**
   * 这一轮运行的计时（2026-09-28）。
   *
   * 「一轮」= 从第一个节点动起来到最后一个停下。跑完**定格留着**、下次运行开始时重新从 0 走 ——
   * 徐先要的是「记录刚刚那一轮跑了多久」，跑完就消失的话等于没记。
   * 秒数交给 `RunClock` 自己 tick：在这里每秒 setState 会把整块 React Flow 树重渲染一遍。
   */
  const [runClock, setRunClock] = useState<RunClockState | null>(null);
  /**
   * 「这一轮还在跑」的判据 = 一键运行开着 **或者** 有节点处于运行态。
   *
   * 🔴 两个必须一起判，缺一个都有假象：
   *   - 只看节点：一键运行是**串行**的，上游跑完（`status → success`）到下游开始（`status → running`）
   *     之间有一瞬间哪个节点都没在跑 → 那一刻会被判成「跑完了」而定格，下一个节点起来又重新计时。
   *     `runAllBusy` 从 `setRunAllBusy(true)` 一直保持到整轮的 `finally`，正好堵住这道缝。
   *   - 只看 `runAllBusy`：又漏掉「只点单个节点的生成」—— 那也是「这个项目在跑」。
   */
  const anyNodeRunning = useMemo(() => nodes.some(node => node.data.status === 'running'), [nodes]);
  const runBusy = runAllBusy || anyNodeRunning;
  /** 上一次的判定值。只在**跨过边界**那两下打点，中间每秒不关这里的事。 */
  const wasRunBusy = useRef(false);
  useEffect(() => {
    if (runBusy && !wasRunBusy.current) {
      setRunClock({ startedAt: Date.now(), endedAt: null });
    } else if (!runBusy && wasRunBusy.current) {
      /* 已经是定格过的那一份就别再刷 `endedAt` —— 否则会把「上一轮的用时」越改越大。 */
      setRunClock(current => (current && current.endedAt === null ? { ...current, endedAt: Date.now() } : current));
    }
    wasRunBusy.current = runBusy;
  }, [runBusy]);
  /**
   * 每个生成节点**当前**的运行状态，从 `patch()` 里顺手记。
   *
   * 为什么不直接读 `nodes`：轮询回调活得比一次渲染长，闭包里的 `nodes` 是发起那一刻的快照 ——
   * 拿它判「跑完了没有」永远看到旧值。`nodesRef` 也要等到下一次渲染才刷新，
   * 而这里要的是「刚刚被写进去的那个状态」，所以单独记一份。
   */
  const runStatus = useRef<Record<string, string>>({});
  /**
   * 每个节点**当前**那一轮的任务号（2026-09-29）。
   *
   * 节点数据里没有 —— `data.runs` 只在成功 / 失败时才记一条，跑着的时候查不到。
   * 而放弃必须拿着任务号去通知服务端（结单是服务端的事），所以单独记一份。
   */
  const taskOfNode = useRef<Record<string, string>>({});
  /**
   * 轮询的「把手」，按任务号存（2026-09-29）。
   *
   * 原来 `poll()` 是一个纯 `for(;;)`，没有任何人能让它停下来：
   * 离开画布页之后它还会一直打接口，而且每轮 `patch()` 都在给一个
   * 已经卸载的组件写状态。有了把手，「放弃这一轮」和「组件卸载」两个时机都能掐断它。
   */
  const pollAbort = useRef<Record<string, { cancelled: boolean; controller: AbortController | null }>>({});
  /** Transient message explaining why a connection was refused. */
  const [notice, setNoticeText] = useState<string | null>(null);
  /**
   * 每条提示的编号。看着多余，其实必须有：连着两次提示文案一模一样时
   * （比如再按一次 Ctrl+D），`setNotice` 传相同字符串 React 会跳过重渲染，
   * 下面那个自动消失的 effect 也不会重跑 —— 第二次的提示会被第一次的定时器
   * 提前清掉，一闪就没了。靠这个自增的编号把定时器顶回 0。
   */
  const [noticeSeq, setNoticeSeq] = useState(0);
  const setNotice = useCallback((message: string | null) => {
    setNoticeText(message);
    setNoticeSeq(seq => seq + 1);
  }, []);
  /** True while image files are being dragged over the canvas. */
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const [zoom, setZoom] = useState(initial.viewport.zoom || 1);
  const viewport = useRef(initial.viewport);
  const first = useRef(true);
  /**
   * 服务端那份画布的版本号，每次保存成功后用返回值刷新。
   * 保存时带回去，服务端对不上就 409 —— 意思是「我们手上这份已经过期了」。
   */
  const versionRef = useRef<number | null>(typeof initial.version === 'number' ? initial.version : null);
  /**
   * 保存请求一次只允许一个在飞。
   * 两个请求同时带着同一个版本号出去，先落地的那个会把版本加一，
   * 后落地那个就必然 409 —— 自己跟自己冲突，纯属误报。
   */
  const saving = useRef(false);
  const queued = useRef(false);
  /** 一旦确认画布被别人改过就置上：自动保存停下，等用户明确选覆盖还是重载。 */
  const conflicted = useRef(false);
  /**
   * 本地有没有还没落库的改动。**只在节点 / 连线真的变了时置真**（自动保存那个 effect 里），
   * 保存成功再置回假。它是下面 `applyExternalCanvas` 判断「能不能直接拉新画布」的依据：
   * 有未保存改动时静默重拉，等于把用户正在改的东西抹掉 —— 那种情况只能走冲突条。
   */
  const dirty = useRef(false);
  /**
   * 跳过**下一次**自动保存。只在「刚把外部改过的画布读回来」时用一次：
   * 那次 setNodes 也是一次 nodes 变化，不跳的话会立刻再写回去 ——
   * 内容一模一样，但版本号每来回一次就 +1，纯属自我消耗。
   */
  const skipAutosave = useRef(false);
  const saveRef = useRef<(options?: { force?: boolean }) => void>(() => {});
  const { fitView, getViewport, screenToFlowPosition, setCenter } = useReactFlow();

  const patch = useCallback((id: string, part: Partial<NodeData>) => {
    /*
     * 顺手把状态记进 ref（一键运行要用）。
     * 写在 setNodes **外面**：函数式更新里那段要等 React 决定重渲染时才跑，
     * 而调用方紧接着就要读它（「提交出去了没有」），等不到那一刻。
     */
    if (part.status !== undefined) {
      runStatus.current[id] = String(part.status);
      /*
       * 一次生成真的结束了（成功 / 失败）→ 顺手把站点余额静默刷一次（2026-09-28）。
       * 只在这一档调：**自定义接口**才是「可能走站点中转账号」的那条路
       * （RunningHub / 本机 ComfyUI 都不碰站点余额）—— 不判这一下的话，批量跑一轮
       * 就会白打十几趟站点，撞上那边 20 次 / 20 分钟的限流。
       * `refreshSiteAccount` 自己还有 8 秒节流且保留最后一次，这里不用再判。
       */
      const node = nodesRef.current.find(item => item.id === id);
      if ((part.status === 'success' || part.status === 'failed') && node?.data.engine === 'custom') {
        void refreshSiteAccount();
      }
    }
    setNodes(ns => ns.map(node => node.id === id ? { ...node, data: { ...node.data, ...part } } : node));
  }, [setNodes]);

  /**
   * `nodes` 的最新值。
   *
   * 抽帧、存资产这类链路是**异步**的：`await` 之后再读闭包里的 `nodes`，看到的是发起那一刻的
   * 快照 —— 刚被 `patch` 写上去的地址根本不在里面。症状是「刚在卡片上选完视频 → 立刻提示
   * 还没接视频」。所以在这里直接赋值（不放 `useEffect`：同一次事件里后续的回调也要读得到）。
   */
  const nodesRef = useRef<Node<NodeData>[]>([]);
  nodesRef.current = nodes;

  /** `edges` 的最新值 —— 同上：`detachUpstreamOf` 要在同一次事件里读到刚改过的那份。 */
  const edgesRef = useRef<Edge[]>([]);
  edgesRef.current = edges;

  /**
   * 把一个文本节点**左边**的连线断开（2026-09-29）。
   *
   * 什么时候会走到这儿：用户在一个被上游接管的文本节点上打下了第一个字。
   * 「接了上游 → 上游说了算」那条规矩还在，不改图的话他改的那句根本显示不出来 ——
   * 所以改字这一下必须把线断掉，让那句固化成它自己的。
   *
   * 🔴 只断**文本链**上那几条（`source` 是文本 / 优化节点）：连到文本节点左边的
   * 现在只有这两类，但万一以后放宽了连线白名单，别把别的线一起弄断。
   * 🔴 断完**必须说一句**：线是自己没的，不说的话用户会以为刚才那一下把图画坏了。
   */
  const detachUpstreamOf = useCallback((id: string) => {
    const gone = edgesRef.current.filter(edge => {
      if (edge.target !== id) return false;
      const from = nodesRef.current.find(item => item.id === edge.source);
      return !!from && isTextValueKind(from.data.kind);
    });
    if (!gone.length) return;
    const ids = new Set(gone.map(edge => edge.id));
    setEdges(es => es.filter(edge => !ids.has(edge.id)));
    setNotice(ids.size > 1
      ? `改字 = 这句归它自己了 —— 已断开 ${ids.size} 条上游连线`
      : '改字 = 这句归它自己了 —— 已断开上游那条连线');
  }, [setEdges]);

  /**
   * 把一次生成追加到那个节点的 `runs` 上，随画布一起保存。
   * 用函数式更新而不是读闭包的 `nodes`：轮询回调活得比一次渲染长，闭包里的 nodes 会过期。
   */
  const pushRun = useCallback((id: string, run: Omit<GenerationRun, 'index'>) => {
    setNodes(ns => ns.map(node => {
      if (node.id !== id) return node;
      const previous = (node.data.runs || []) as GenerationRun[];
      return { ...node, data: { ...node.data, runs: [...previous, { ...run, index: previous.length + 1 }] } };
    }));
  }, [setNodes]);

  /**
   * 把一次**同步拿到结果**的生成落到画布上 —— 自定义接口出图走这条。
   *
   * 与 `poll()` 里那段的分工：那边是「远端还在跑，轮询到成功再落」，这边结果已经在响应里了，
   * 所以不需要任务编号、也没有中间态。落完之后要做的事完全一样：记一次生成记录、把图挂到本节点、
   * 再把图推给下游的图片输出节点 —— 少最后这一步，用户就会看到「生成成功但输出节点还是空的」。
   */
  const applyRun = useCallback((id: string, run: Omit<GenerationRun, 'index'>, results: RunResult[]) => {
    pushRun(id, run);
    const imageItem = results.find(item => item.kind === 'image');
    patch(id, {
      status: 'success',
      result: imageItem ? '生成完成' : '本次结果没有图片输出',
      resultUrl: imageItem?.url,
    });
    edges.filter(edge => edge.source === id).forEach(edge => {
      const target = nodes.find(item => item.id === edge.target);
      if (!target) return;
      /** 图片输出节点只认图片；视频输出节点在这条链路上本来也不会被接上。 */
      const wantsImage = target.data.kind === 'image-out';
      const media = wantsImage ? imageItem : (results.find(item => item.kind === 'video') || imageItem);
      patch(edge.target, {
        resultUrl: media?.url,
        result: media?.url ? (wantsImage ? '图片已就绪' : '生成完成') : '本次结果没有对应的输出',
      });
    });
  }, [edges, nodes, patch, pushRun]);

  /**
   * 从生成节点往上游走，只沿「自定义参数块」这条链收集参数行。
   *
   * 顺序是**越远的先、越近的后**：合并时后写的覆盖先写的，所以靠近生成节点的那一块优先级最高
   * —— 和「堆积木」的直觉一致，后放上去的那块盖住下面那块。
   */
  const collectParamRows = useCallback((rootId: string) => {
    const rows: ParamRow[] = [];
    const seen = new Set<string>();
    const walk = (id: string) => {
      edges.filter(edge => edge.target === id).forEach(edge => {
        if (seen.has(edge.source)) return;
        const node = nodes.find(item => item.id === edge.source);
        if (!node || node.data.kind !== 'params') return;
        seen.add(edge.source);
        walk(edge.source);
        rows.push(...((node.data.paramRows || []) as ParamRow[]));
      });
    };
    walk(rootId);
    return rows;
  }, [edges, nodes]);

  const refreshLatents = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/latents`);
      if (response.ok) setLatents((await response.json()).latents || []);
    } catch {
      setLatents([]);
    }
  }, [projectId]);

  useEffect(() => { void refreshLatents(); }, [refreshLatents]);

  const refreshWorkflows = useCallback(async () => {
    try {
      const response = await fetch('/api/workflows');
      if (response.ok) {
        const body = await response.json();
        setWorkflows(body.workflows || []);
      }
    } catch {
      setWorkflows([]);
    }
  }, []);

  useEffect(() => { void refreshWorkflows(); }, [refreshWorkflows]);

  /**
   * 画布里所有「打开工作流配置」的去处（2026-10-01 徐先）。
   *
   * 带 `workflowId` = 直接进那一份的配置屏；不带 = 开列表。
   * 之所以要它：那些入口以前写的是 `#/settings/providers/workflows?id=…`，
   * 在单窗口 hash 路由里点下去就是**离开画布**。用户要的是「配好直接回画布」，
   * 所以这件事必须由画布接管，卡片 / 参数条只负责喊一声。
   */
  const openWorkflowConfig = useCallback((workflowId?: string) => {
    setOverlayWorkflow(workflowId ? String(workflowId) : null);
    setOverlayPickNode(null);
    setOverlay('workflow');
  }, []);

  /**
   * 「从工作流库选一份」——给画布上某个**生成节点**挑工作流（2026-10-01 徐先）。
   *
   * 和上面那条的区别：那个是「去改这一份的配置」，这个是「换一份来用」。
   * 底栏那个下拉只列同用途、同来源的已保存配置，刚导入的 / 档位不一样的在里面看不见，
   * 所以这里把整张库打开、选完直接写回节点。
   */
  const openWorkflowPicker = useCallback((nodeId: string) => {
    setOverlayWorkflow(null);
    setOverlayPickNode(nodeId);
    setOverlay('workflow');
  }, []);

  /** 关工作流浮层：三条路（配置 / 挑一份 / 左轨浏览）都要顺手清干净。 */
  const closeWorkflowOverlay = useCallback(() => {
    setOverlay(null);
    setOverlayWorkflow(null);
    setOverlayPickNode(null);
    /* 刚在里面改过名字 / 启用项 —— 重取一次，别让底栏下拉继续显示旧的。 */
    void refreshWorkflows();
  }, [refreshWorkflows]);

  /** 「给某个节点挑一份」时，库里的用途筛选先落在那个节点的用途上（它要视频就先看视频那档）。 */
  const pickNode = overlayPickNode ? nodes.find(item => item.id === overlayPickNode) : undefined;
  const pickPurpose = pickNode ? purposeOfNode(String(pickNode.data.kind)) : null;
  /**
   * 「来源」那一档也要预置。默认档是「云端 RunningHub」，而这个节点很可能正用着本机 ComfyUI 的图
   * —— 不预置的话，用户点开「从工作流库中选择…」看到的是**空列表**，会以为那份工作流没了
   * （2026-10-01 真机第一遍就是这么空的）。判断与提交时那道「引擎 ↔ 来源」对账同一套。
   */
  const pickSource: WorkflowSource | undefined = !pickNode
    ? undefined
    : pickNode.data.kind === 'app-generate'
      ? 'app'
      : (pickNode.data.kind === 'image-generate'
        ? imageEngineProvider(pickNode.data.engine)
        : videoEngineProvider(pickNode.data.engine)) === 'local'
        ? 'local'
        : 'cloud';

  const sources = useCallback((target: string) => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const walk = (id: string) => edges.filter(edge => edge.target === id).forEach(edge => {
      if (!seen.has(edge.source)) { seen.add(edge.source); ids.push(edge.source); walk(edge.source); }
    });
    walk(target);
    /* 读 ref 不读闭包：抽帧 / 提交这些链路在 await 之后才调它，闭包里的 nodes 是旧的。 */
    return ids.map(id => nodesRef.current.find(node => node.id === id)).filter(Boolean) as Node<NodeData>[];
  }, [edges]);

  /**
   * 参数块里每一行要写的是**将被提交的那份工作流**里的节点字段，而那份工作流是它
   * **下游**那个生成节点选的 —— 参数块自己不存编号（它只是叠加层，换一条链路就得
   * 跟着新的生成节点走），所以这里顺着连线往下找一圈。
   *
   * 编号的取值顺序必须与 `generate()` 里那条**完全一致**
   * （老 workflow 节点 → 节点自己选的 → 按用途的默认工作流）：
   * 不一致的话这里列出的候选会是另一份工作流的字段，症状是「看着挑对了、提交出去却
   * 写在一个这份图里根本不存在的节点上」。
   *
   * 多个生成节点选了不同工作流时取第一个，并把「不一致」写进说明里：真要弹一个二选一
   * 的框，代价（一次额外的选择动作）远大于它解决的那种罕见情形。
   */
  const paramWorkflowOf = useCallback((rootId: string) => {
    const seen = new Set<string>([rootId]);
    const found: string[] = [];
    const labels: string[] = [];
    const walk = (id: string) => {
      edges.filter(edge => edge.source === id).forEach(edge => {
        if (seen.has(edge.target)) return;
        const next = nodes.find(item => item.id === edge.target);
        if (!next) return;
        seen.add(edge.target);
        /** 参数块可以串着接（越靠近生成节点优先级越高），所以路过时要继续往下走。 */
        if (next.data.kind === 'params') { walk(edge.target); return; }
        if (!isGeneratorKind(next.data.kind)) return;
        const workflowNode = sources(next.id).find(item => item.data.kind === 'workflow');
        const workflowId = String(workflowNode?.data.workflowId
          || next.data.workflowId
          || defaultWorkflowIdFor(purposeOfNode(next.data.kind) ?? 'video'));
        if (!workflowId) return;
        found.push(workflowId);
        labels.push(String(next.data.label || NODE_META[next.data.kind as NodeKind]?.label || next.data.kind || ''));
      });
    };
    walk(rootId);
    const unique = Array.from(new Set(found));
    /** 图片生成节点没有默认工作流（`defaultWorkflowIdFor('image')` 回空串），那种情况就取不到 —— 只能手填。 */
    const uniqueLabels = Array.from(new Set(labels));
    if (!unique.length) return { workflowId: '', note: '还没连到选好工作流的生成节点 · 只能手填一行' };
    if (unique.length > 1) {
      return { workflowId: unique[0], note: `下游 ${unique.length} 个生成节点选的工作流不一致 · 候选按「${uniqueLabels[0]}」那份列` };
    }
    return { workflowId: unique[0], note: `跟随「${uniqueLabels[0]}」选的工作流` };
  }, [edges, nodes, sources]);

  /**
   * 自动超清的待办队列（2026-10-02 徐先）。
   *
   * 🔴 为什么不能直接从 `poll()` 的 success 分支里调 `upscale()`：那一刻
   * `patch(id, { status: 'success' })` 只是**排进了** state 队列、还没重渲染，
   * `upscale` 闭包里的 `nodes` 仍是「运行中」—— 进去第一行就被挡回来，什么都不发生。
   * 交给 effect 在**提交之后**跑，读到的一定是已经落好的那次成功。
   */
  const [autoUpscaleQueue, setAutoUpscaleQueue] = useState<string[]>([]);

  const poll = useCallback(async (
    taskId: string, id: string, label: string,
    /** `operation` 决定这一轮成功后**要不要**接着自动超清 —— 超清自己跑完不能再接一道。 */
    meta: { externalTaskId?: string; workflowId: string; operation?: 'generate' | 'upscale' },
  ) => {
    /*
     * 越等越慢（规矩见 `lib/taskPoll`）：原来固定 3 秒一趟，一个任务跑满就是 240 次请求，
     * 批量跑十几个节点时把上游限流撞光的正是我们自己。
     */
    const startedAt = Date.now();
    taskOfNode.current[id] = taskId;
    const handle: { cancelled: boolean; controller: AbortController | null } = { cancelled: false, controller: null };
    pollAbort.current[taskId] = handle;
    for (;;) {
      if (handle.cancelled) return;
      /*
       * 一直问到有结果：`pollDelayMs` 永远给下一趟的间隔，这里不做任何「按等待时长下结论」的事。
       * 任务只有成功与失败两种结果 —— 想停由用户自己点「放弃这一轮」。
       */
      const delay = pollDelayMs(Date.now() - startedAt);
      await new Promise(resolve => setTimeout(resolve, delay));
      if (handle.cancelled) return;
      /*
       * 带上 signal：放弃 / 离开页面时能真的把这个请求掐掉，而不是等它自己回来。
       * ⚠️ 被 abort 时 fetch 会**抛**，那不是错误 —— 安静退出，别往节点上写任何东西。
       */
      let task: any = null;
      try {
        const controller = new AbortController();
        handle.controller = controller;
        task = await json(await fetch(`/api/tasks/${taskId}`, { signal: controller.signal }));
      } catch {
        delete pollAbort.current[taskId];
        return;
      } finally {
        handle.controller = null;
      }
      /*
       * 本机 ComfyUI 的实时进度（WebSocket 上收来的那几条消息，后端按任务归档）。
       * 轮询 3 秒一次，对「百分之几」这种信息足够了 —— 但它**不参与判定**：
       * 成功失败一律以 `task.status` 为准，进度只用来把「一直转圈」换成「正在跑第几步」。
       */
      if (task.status === 'running' && task.progress) {
        patch(id, { result: describeLocalProgress(task.progress) });
      }
      if (task.status === 'success') {
        const list: { url?: string; outputType?: string }[] = Array.isArray(task.result) ? task.result : [];
        const urls = list.filter(item => item?.url);
        const pick = (pattern: RegExp) => urls.find(item => pattern.test(`${item.outputType || ''} ${item.url}`));
        /* 三个正则与 `lib/runs.ts` 共用同一份（见 `lib/result-kind.ts`）：
           两边判得不一样的话，同一条结果在历史里是音频、回到节点上却画成了图片。 */
        const videoItem = pick(VIDEO_RESULT_RE);
        const imageItem = pick(IMAGE_RESULT_RE);
        const audioItem = pick(AUDIO_RESULT_RE);
        /** 既认不出 outputType 也没有扩展名时退回第一个结果，保持旧行为。 */
        const ambiguous = !videoItem && !imageItem && !audioItem ? urls[0] : undefined;
        const results: RunResult[] = [];
        if (videoItem?.url) results.push({ url: String(videoItem.url), kind: 'video' });
        if (imageItem?.url && imageItem.url !== videoItem?.url) results.push({ url: String(imageItem.url), kind: 'image' });
        if (audioItem?.url && audioItem.url !== videoItem?.url && audioItem.url !== imageItem?.url)
          results.push({ url: String(audioItem.url), kind: 'audio' });
        if (!results.length && ambiguous?.url)
          results.push({
            url: String(ambiguous.url),
            kind: resultKindOf(`${ambiguous.outputType || ''} ${ambiguous.url}`) ?? 'image',
          });
        pushRun(id, {
          id: taskId,
          taskId: meta.externalTaskId,
          workflowId: meta.workflowId,
          at: new Date().toLocaleString('zh-CN', { hour12: false }),
          ts: Date.now(),
          status: 'success',
          nodeLabel: label,
          results,
        });
        delete pollAbort.current[taskId];
        if (Array.isArray(task.latents)) setLatents(task.latents);
        /*
         * 出图节点的画框只认图片：视频工作流那种「优先视频」的顺序会把视频塞进图片卡片。
         * 应用节点按它**这次真的产出了什么**定 —— 只有图就当图，有视频就按视频。
         */
        const runKind = nodes.find(item => item.id === id)?.data.kind;
        const imageOnly = runKind === 'image-generate'
          || (runKind === 'app-generate' && !videoItem && Boolean(imageItem));
        const primary = imageOnly ? (imageItem || ambiguous) : (videoItem || audioItem || ambiguous || imageItem);
        patch(id, {
          status: 'success',
          result: imageOnly
            ? (primary ? '生成完成' : '本次结果没有图片输出')
            : videoItem || audioItem ? '生成完成' : imageItem ? '只返回了图片' : '生成完成',
          resultUrl: primary?.url,
        });
        /** Push the media each downstream node can actually show: image output takes the image, video output takes the video. */
        edges.filter(edge => edge.source === id).forEach(edge => {
          const target = nodes.find(node => node.id === edge.target);
          /*
           * 🔴 下游是**生成节点**时一个字都别推（2026-10-01：生成节点之间现在能直连了）：
           * 推过去等于**把它自己的结果覆盖掉** —— 它可能还没跑、也可能已经跑过一次，
           * 界面上会突然「变成上游那一份」，而用户什么都没点。
           * 生成节点要上游的素材是**提交那一刻从上游现读**的（参考图 / 视频输入那两条路），
           * 不需要往它身上写。这一下只服务于**输出节点** —— 它们自己不跑，靠它才有东西显示。
           */
          if (!target || isGeneratorKind(target.data.kind)) return;
          const wantsImage = target.data.kind === 'image-out';
          const media = wantsImage ? (imageItem || ambiguous) : (videoItem || audioItem || ambiguous);
          patch(edge.target, {
            resultUrl: media?.url,
            result: media?.url
              ? (wantsImage ? '图片已就绪' : !videoItem && audioItem ? '音频已就绪' : '视频生成完成')
              : '本次结果没有对应的输出',
          });
        });
        /*
         * 自动超清（2026-10-02 徐先）：这一轮**是普通生成**（不是超清自己）、
         * 这一节点把超清设成了「自动」、且真的出了一份结果 —— 三个都成立才接上去跑。
         *
         * 🔴 认「这一轮是不是超清」是防死循环的关键：超清跑完同样走这个 success 分支，
         * 不认出来的话它会再给自己来一道，一次生成变成一次次扣费，停不下来。
         */
        if (meta.operation !== 'upscale' && primary?.url) {
          const node = nodes.find(item => item.id === id);
          if (node && readUpscaleMode(node.data.upscaleMode) === 'auto') {
            setAutoUpscaleQueue(queue => queue.includes(id) ? queue : [...queue, id]);
          }
        }
        return;
      }
      if (task.status === 'failed') {
        delete pollAbort.current[taskId];
        patch(id, { status: 'failed', result: task.error || '生成失败' });
        pushRun(id, {
          id: taskId, taskId: meta.externalTaskId, workflowId: meta.workflowId,
          at: new Date().toLocaleString('zh-CN', { hour12: false }), ts: Date.now(),
          status: 'failed', nodeLabel: label, error: String(task.error || '生成失败'), results: [],
        });
        return;
      }
    }
  }, [edges, nodes, patch, pushRun]);

  /**
   * 放弃这一轮（2026-09-29）。
   *
   * 卡住的任务原来只能干等：发送按钮是灰的（`disabled={running}`），界面上
   * 却没有任何地方能说「我不等了」。点放弃时两件事同时发生：
   *   1. 通知服务端把它判失败 —— 结单是服务端的事，前端说了不算；
   *   2. 掐掉本地这一轮轮询 —— 不然它继续打接口、继续往节点上写状态。
   */
  const abandonNode = useCallback(async (id: string) => {
    const taskId = String(taskOfNode.current[id] || '');
    const handle = taskId ? pollAbort.current[taskId] : undefined;
    if (handle) {
      handle.cancelled = true;
      try { handle.controller?.abort(); } catch { /* 已经在别处掐掉了 */ }
      delete pollAbort.current[taskId];
    }
    if (taskId) {
      await fetch(`/api/tasks/${taskId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ abandon: true, reason: abandonMessage() }),
      }).catch(() => null);
    }
    delete taskOfNode.current[id];
    const why = abandonMessage();
    patch(id, { status: 'failed', result: why });
    pushRun(id, {
      id: taskId || `abandoned-${Date.now()}`,
      taskId: undefined,
      workflowId: '',
      at: new Date().toLocaleString('zh-CN', { hour12: false }),
      ts: Date.now(),
      status: 'failed',
      nodeLabel: String(nodes.find(item => item.id === id)?.data.label || '生成'),
      error: why,
      results: [],
    });
  }, [nodes, patch, pushRun]);

  /* 离开画布页：把还在跑的轮询全部掐掉（2026-09-29）。 */
  useEffect(() => () => {
    Object.values(pollAbort.current).forEach(handle => {
      handle.cancelled = true;
      try { handle.controller?.abort(); } catch { /* 已经掐掉了 */ }
    });
  }, []);

  /**
   * 一个**视频生成节点**自己生成出来、并归档下来的那些 latent。
   *
   * 归档挂在 `Asset(type='latent')` 上、用 `sourceTaskId` 指回那一次任务；
   * 而每一次生成又会在节点上记一条 `data.runs`（`id` 就是本地任务号）——两边对上，
   * 就是「这一次跑出来的」。只认**成功**的那几次：失败的任务留不下 latent，
   * 算进去只会让下拉里多出一个取不到的选项。
   *
   * 取哪几份由 `picks`（中转节点上的 `latentPicks`）决定 —— 没选时按**粗 / 精的对应关系**
   * 自动配最新那一组（徐先 2026-10-03 要的），**不是随手挑第一份**。
   * 一次生成会归档两份（粗 / 精），跑多轮又有好几组，配错的症状是接续悄悄喂了
   * 错的 latent —— 任务照样成功、产出和上一段毫无关系，界面上什么都不说。
   */
  const videoLatentsOf = useCallback((node: Node<NodeData>, picks: string[]): LatentChain => {
    const runIds = new Set(
      ((node.data.runs || []) as GenerationRun[])
        .filter(run => run.status === 'success')
        .map(run => String(run.id || '')),
    );
    const mine = runIds.size
      ? latents.filter(item => item.sourceTaskId && runIds.has(String(item.sourceTaskId)))
      : [];
    const from = String(node.data.label || NODE_META['video-generate'].label);
    /* `group` 用任务号：自动配对只在**同一次生成**归档的那两份之间进行（N-114）。 */
    const resolved = resolvePickedLatents(
      mine.map(item => ({ value: `${latentAssetPrefix}${item.id}`, kind: item.kind, group: String(item.sourceTaskId || '') })),
      picks,
      from,
    );
    return { values: resolved.values, value: resolved.values[0] || '', from, broken: resolved.broken };
  }, [latents]);

  /**
   * 一个**从资产库放进来的视频节点**身上记的那几份 latent（导入那一刻的快照）。
   *
   * 与 `videoLatentsOf` 唯一的区别是**不看 `data.runs`** —— 这种节点不是画布上跑出来的，
   * 它没有 runs，只有「我来自哪一次生成」（`sourceTaskId`）以及那次归档了什么。
   * 判定规则共用 `resolvePickedLatents`，界面上的说法才一致。
   */
  const assetLatentsOf = useCallback((node: Node<NodeData>, picks: string[]): LatentChain => {
    const mine = node.data.relayLatents || [];
    const from = String(node.data.label || NODE_META['video-input'].label);
    const resolved = resolvePickedLatents(
      mine.map(item => ({ value: `${latentAssetPrefix}${item.id}`, kind: item.kind, group: 'relay' })),
      picks,
      from,
    );
    return { values: resolved.values, value: resolved.values[0] || '', from, broken: resolved.broken };
  }, []);

  /**
   * 中转节点「取自上游哪一份 latent」下拉里的选项。
   *
   * 只列**上游视频节点自己**的归档，不掺项目里别的 latent —— 连线的意义
   * 恰恰在于把范围收窄到「这一段生成产出的东西」。多个上游视频节点时按节点名前缀区分，
   * 否则两份都叫「L001 · 粗采样」，选错了根本看不出来。
   */
  const latentPickOptionsOf = useCallback((id: string): LatentPickOption[] => {
    const options: LatentPickOption[] = [];
    for (const edge of edges) {
      if (edge.target !== id) continue;
      const from = nodes.find(item => item.id === edge.source);
      if (!from) continue;
      const who = String(from.data.label || NODE_META[from.data.kind as NodeKind]?.label || '');
      /*
       * 从资产库放进来的视频（2026-10-02）：它自己带着那次生成归档的 latent，
       * 不用去项目列表里筛 —— 那段视频可能属于**别的项目**，这边根本筛不到。
       */
      if (isRelayLatentSource(from.data)) {
        (from.data.relayLatents || []).forEach(item => options.push({
          value: `${latentAssetPrefix}${item.id}`,
          label: `${who} · ${latentLabel(item)}`,
        }));
        continue;
      }
      if (from.data.kind !== 'video-generate') continue;
      const runIds = new Set(
        ((from.data.runs || []) as GenerationRun[])
          .filter(run => run.status === 'success')
          .map(run => String(run.id || '')),
      );
      if (!runIds.size) continue;
      latents
        .filter(item => item.sourceTaskId && runIds.has(String(item.sourceTaskId)))
        .forEach(item => options.push({
          value: `${latentAssetPrefix}${item.id}`,
          label: `${who} · ${latentLabel(item)}`,
        }));
    }
    return options;
  }, [edges, latents, nodes]);

  /**
   * 解析一个 latent 节点真正要提交的值，以及这个值是从哪来的。
   *
   * 中转节点自己没选归档、也没上传文件时，**透传**上游那条 latent —— 这样
   * 「latent 节点 → 中转 → 生成节点」这条链才有意义。一路沿 latent / latent-relay
   * 的连线往上找，遇到有值的就停。
   *
   * 取不到值时要**说清原因**（返回值里的 `broken`）。以前这里只返回空值，
   * 于是「链断了」和「还没上传」在界面上长得一模一样，而前者怎么补文件都没用。
   */
  const latentChainOf = useCallback((id: string): LatentChain => {
    /*
     * `picks` 是**这个中转节点自己**上逐槽选的来源（不是上游那个节点上的）——
     * 一个节点供两份 latent 时，「谁选的」必须分清（2026-10-03，N-114）。
     */
    const start = nodes.find(item => item.id === id);
    const picks = latentPicksOf(start ? start.data : {});
    /**
     * 一次解析里的备忘表。结论与「从哪个入口进来」无关（见下面的判环说明），所以可以缓存；
     * 不缓存的话，菱形链（两条链汇到同一个上游）会按路径数重走，层数一多就是指数级。
     */
    const cache = new Map<string, LatentChain>();
    const walk = (current: string, path: Set<string>): LatentChain => {
      /**
       * 判环用的是**当前这条路径**（入口到当前节点的这一串），不是全局 visited。
       * 全局集合会把「两条链汇到同一个上游」的汇合点误报成环，而菱形在这个图里是正常连法。
       * 反过来说，`path` 里出现 `current` 就一定意味着沿上游走回了自己 —— 是真环。
       */
      if (path.has(current)) return { values: [], value: '', from: '', broken: 'cycle' };
      const hit = cache.get(current);
      if (hit) return hit;
      const done = (result: LatentChain) => { cache.set(current, result); return result; };
      const node = nodes.find(item => item.id === current);
      if (!node) return done({ values: [], value: '', from: '', broken: null });
      const own = String(node.data.remoteFile || '').trim();
      if (own) return done({ values: [own], value: own, from: '', broken: null });
      if (node.data.kind !== 'latent-relay') return done({ values: [], value: '', from: '', broken: null });
      const links: Node<NodeData>[] = [];
      for (const edge of edges) {
        if (edge.target !== current) continue;
        const from = nodes.find(item => item.id === edge.source);
        /* 从资产库放进来的视频也算一个源头 —— 值在它自己身上，不在上游。 */
      if (from && (isLatentSourceKind(from.data.kind) || isRelayLatentSource(from.data))) links.push(from);
      }
      if (!links.length) return done({ values: [], value: '', from: '', broken: 'upstream' });
      const next = new Set(path).add(current);
      /** 成环比「没接上游」更值得说，所以优先级压在它上面。 */
      let broken: LatentChain['broken'] = null;
      /** 越具体的诊断越该说：`empty` / `unpicked` 指明了该干什么，`upstream` 只是「没有」。 */
      const rank: Record<string, number> = { cycle: 4, unpicked: 3, empty: 2, upstream: 1 };
      for (const from of links) {
        /*
         * 上游是视频节点时，来源是**它自己生成出来并归档的那些** latent，
         * 取哪几份由本中转节点的 `latentPicks` 决定（见 `videoLatentsOf`）。
         * 这里不递归：视频节点那头没有更上游的 latent 链，它只有自己的产出。
         */
        const upper = from.data.kind === 'video-generate'
          ? videoLatentsOf(from, picks)
          : isRelayLatentSource(from.data)
            ? assetLatentsOf(from, picks)
            : walk(from.id, next);
        if (upper.values.length) return done({
          values: upper.values,
          value: upper.values[0] || '',
          from: String(from.data.label || NODE_META.latent.label),
          broken: null,
        });
        if (upper.broken && (rank[upper.broken] || 0) > (broken ? rank[broken] || 0 : 0)) broken = upper.broken;
      }
      return done({ values: [], value: '', from: '', broken });
    };
    return walk(id, new Set());
  }, [assetLatentsOf, edges, nodes, videoLatentsOf]);

  /**
   * 一个节点的显示名（卡片上那句「来自「X」」要用）：自己起过名就用那个，
   * 没起就退回这一类节点的默认名。纯函数层不知道 `NODE_META`，由这里传进去。
   */
  const nameOfNode = useCallback((item: TextChainNode) => String(item.data.label
    || NODE_META[item.data.kind as NodeKind]?.label || item.data.kind || ''), []);

  /**
   * 沿「文本 → 优化 → 文本」解析出一个节点**此刻**要交给下游的那段文字（2026-09-29）。
   *
   * 取值规矩（与 `latentChainOf` 同形，但规则不同）：
   *   · 接了上游文本 / 优化节点 → **上游说了算**（下游那个文本节点展示的正是上游那段）；
   *   · 优化节点**自己跑出来的那份优先**于它的上游 —— 它存在的理由就是把上游那句改写掉；
   *     一次都没跑过时回落到上游原句，于是下游看到的是「这一刻真会交出去的那句」，不是空白；
   *   · 都没有才看文本节点自己写的那句。
   *
   * 🔴 `optimizedText`（跑出来的结果，落库）与 `textValue`（此刻的值，现算、不写库）
   * **刻意分开**：断开连线之后用户原来写的那句话还得在 —— 把结果写回 `text` 等于删掉他的原稿。
   */
  const textChainOf = useCallback((id: string): TextChain => resolveTextChain(
    nodes as TextChainNode[], edges as TextChainEdge[], id, nameOfNode,
  ), [edges, nameOfNode, nodes]);

  /**
   * 优化节点这次要改写的**输入**（2026-09-29）。
   *
   * 🔴 刻意**不看它自己上一次的 `optimizedText`**：拿上一次的结果再去改写一遍，
   * 等于把同一句话反复「优化」，第二次起只会越来越浮夸 —— 而界面上看着全是成功。
   */
  const optimizeInputOf = useCallback((id: string): string => optimizeInputIn(
    nodes as TextChainNode[], edges as TextChainEdge[], id, nameOfNode,
  ), [edges, nameOfNode, nodes]);

  /**
   * 优化节点左边**此刻连着的那份媒体**（2026-10-03：看图 / 看视频反推提示词）。
   *
   * 与 `optimizeInputOf` 是一对：一个给「把一句话扩写」，一个给「看着这份媒体写」。
   * 返回 `null` = 左边没有可用的媒体 —— 那种情况照旧走改写那条路，
   * 于是**只接了文本的老画布一个字都不会变**。
   *
   * `kind` 由 `pickMediaInput` 定（视频优先于图），调用方不要再自己判一次 ——
   * 两处各判一次的话，「界面说是视频、发出去的是图」这种差异没有任何界面会说。
   */
  const describeInputOf = useCallback((id: string): MediaChain | null => pickMediaInputIn(
    nodes as MediaChainNode[], edges as MediaChainEdge[], id, nameOfNode,
  ), [edges, nameOfNode, nodes]);

  /**
   * 这一轮真正要提交的那句提示词（2026-09-29）。
   *
   * 上游可能是「文本 → 优化提示词 → 生成」：优化节点交的是**改写后**那份，
   * 所以必须优先取它 —— 只按「第一个上游文本节点」取的话，拿到的是改写前那句，
   * 而任务照样成功、画面却是照原话生成的，全程不报错。
   */
  const promptTextOf = useCallback((list: Node<NodeData>[]): string => promptTextIn(
    nodes as TextChainNode[], edges as TextChainEdge[], list as TextChainNode[], nameOfNode,
  ), [edges, nameOfNode, nodes]);

  /**
   * 跑一次「优化提示词」节点（2026-09-29）。
   *
   * 与生成节点的分工：它不出任何媒体，只把上游那句话交给文本模型改写一遍，
   * 结果写进 `optimizedText`。**绝不写回上游文本节点的 `text`** —— 断开连线之后，
   * 用户原来写的那句话还得在。
   */
  const optimizePromptNode = useCallback(async (id: string) => {
    const node = nodesRef.current.find(item => item.id === id);
    if (!node || node.data.kind !== 'prompt-optimize') return;
    const raw = optimizeInputOf(id);
    if (!raw) {
      patch(id, { status: 'failed', result: '还没接上游文本节点 —— 先把一个文本节点连到它左边' });
      return;
    }
    const model = String(node.data.promptModel || '').trim();
    const skill = String(node.data.promptSkill || '').trim();
    /* 节点上选过 / 填过才带：跟 `provider` / `skillId` 同一套语义 ——
       没动过就不发，后端据此判断「这项用户没选」。 */
    const strength = String(node.data.promptStrength || '').trim();
    const note = String(node.data.promptNote || '').trim();
    patch(id, { status: 'running', result: '正在改写提示词…' });
    try {
      const result = await apiPost<{ optimizedPrompt: string }>('/api/prompt/optimize', {
        prompt: raw,
        /* 节点上单独指定过才带：留空 = 跟随「设置 · 模型服务」里那一家（与 `GenerateDock` 同一套语义）。 */
        ...(model ? { provider: model } : {}),
        ...(skill ? { skillId: skill } : {}),
        ...(strength ? { strength } : {}),
        ...(note ? { note } : {}),
      });
      const optimized = String(result.optimizedPrompt || '').trim();
      if (!optimized) {
        patch(id, { status: 'failed', result: '文本模型没给出改写结果 —— 换一家再试' });
        return;
      }
      patch(id, { status: 'success', result: '已改写', optimizedText: optimized });
    } catch (error) {
      patch(id, { status: 'failed', result: error instanceof Error ? error.message : '提示词改写失败' });
    }
  }, [nodesRef, optimizeInputOf, patch]);

  /**
   * 跑一次「看图反推提示词」（2026-10-03 徐先）。
   *
   * 与上面那条是一对：它交出去的是**一句话**（要被扩写），这条交出去的是**一张图**
   * （要让模型看着它写出一句）。结果同样落在 `optimizedText` —— 下游取提示词的
   * 那一层（`textChain.resolveTextChain`）一个字都不用改。
   */
  const describePromptNode = useCallback(async (id: string) => {
    const node = nodesRef.current.find(item => item.id === id);
    if (!node || node.data.kind !== 'prompt-optimize') return;
    const media = pickMediaInputIn(
      nodesRef.current as MediaChainNode[], edgesRef.current as MediaChainEdge[], id, nameOfNode,
    );
    if (!media) {
      patch(id, { status: 'failed', result: '左边还没有一份能用的图或视频 —— 先连一个图片 / 视频节点，并让它出内容' });
      return;
    }
    const isVideo = media.kind === 'video';
    const model = String(node.data.promptModel || '').trim();
    const skill = String(node.data.promptSkill || '').trim();
    const note = String(node.data.promptNote || '').trim();
    /*
     * 🔴 **先**把「这一份已经在反推了」写进节点，再去发请求。
     *
     * 自动反推（下面那个 effect）的判据是「现在的媒体 ≠ `describedFrom`」：
     * 等到成功再写的话，请求在飞的那几十秒里 `nodes` 会重渲染好几次，
     * effect 每次都会「发现」这份还没反推过 —— 于是同一份被反复提交。
     * 手动点按钮也走这一句，于是「刚点过」同样不会被自动那一路再撞一次。
     */
    patch(id, {
      status: 'running',
      result: isVideo ? '正在看视频反推提示词…' : '正在看图反推提示词…',
      describedFrom: media.url,
      describedLabel: media.from,
    });
    try {
      const result = await apiPost<{ optimizedPrompt: string }>('/api/prompt/describe', {
        media: media.url,
        kind: media.kind,
        ...(model ? { provider: model } : {}),
        ...(skill ? { skillId: skill } : {}),
        ...(note ? { note } : {}),
      });
      const described = String(result.optimizedPrompt || '').trim();
      if (!described) {
        patch(id, { status: 'failed', result: `文本模型没为这份${isVideo ? '视频' : '图'}写出提示词 —— 换一家再试` });
        return;
      }
      patch(id, { status: 'success', result: '已反推', optimizedText: described });
    } catch (error) {
      patch(id, { status: 'failed', result: error instanceof Error ? error.message : '反推提示词失败' });
    }
  }, [edgesRef, nameOfNode, nodesRef, patch]);

  /**
   * 优化节点跑一次：**左边有图就反推，没图才改写**。
   *
   * 🔴 两条入口（卡片上那颗按钮、一键运行）必须都走这里 —— 各判一次的话，
   * 「点按钮是反推、一键运行却是改写」这种差异没有任何界面会说，
   * 用户只会发现「两种跑法出来的东西不一样」。
   */
  const runPromptNode = useCallback(async (id: string) => {
    const node = nodesRef.current.find(item => item.id === id);
    if (!node || node.data.kind !== 'prompt-optimize') return;
    const media = pickMediaInputIn(
      nodesRef.current as MediaChainNode[], edgesRef.current as MediaChainEdge[], id, nameOfNode,
    );
    if (media) await describePromptNode(id);
    else await optimizePromptNode(id);
  }, [describePromptNode, edgesRef, nameOfNode, nodesRef, optimizePromptNode]);

  /**
   * 「左边一接上图片就自动反推一次」（2026-10-03 徐先）。
   *
   * 判据是**图本身**，不是「有没有连线」：上游重新生成一次之后地址就变了，
   * 那时必须**再反推一遍**（拿上一张图的描述去喂下游是静默的坏结果）。
   * 反过来说，地址没变就**一次都不跑** —— 这才是这条 effect 不会空转的原因。
   *
   * 🔴 第二道闸是 `autoDescribeSeen`（一张图只认一次）：`patch` 排进 state 队列之后
   * 到下一次重渲染之间，`nodes` 还没变，effect 可能带着同一份旧数据再进一遍。
   * 只靠 `describedFrom` 挡，那一遍会重复提交一次。
   */
  const autoDescribeSeen = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const node of nodes) {
      if (node.data.kind !== 'prompt-optimize' || node.data.bypassed) continue;
      const media = pickMediaInputIn(nodes as MediaChainNode[], edges as MediaChainEdge[], node.id, nameOfNode);
      if (!media) continue;
      if (String(node.data.describedFrom || '').trim() === media.url) continue;
      if (node.data.status === 'running' || node.data.status === 'uploading') continue;
      if (autoDescribeSeen.current.get(node.id) === media.url) continue;
      autoDescribeSeen.current.set(node.id, media.url);
      void describePromptNode(node.id);
    }
  }, [describePromptNode, edges, nameOfNode, nodes]);

  const generate = useCallback(async (id: string) => {
    const node = nodes.find(item => item.id === id);
    if (!node) return;
    /*
     * 这个节点已经在跑了就别再提交一次（2026-09-29）：两笔提交 = 两次扣分。
     * 界面上那个 `disabled` 挡得住按钮，挡不住「一键运行」与手动点撞在一起、
     * 或者两个窗口各点一次 —— 服务端那道闸（60 秒窗口）是第二道，这是第一道。
     */
    if (runStatus.current[id] === 'running') return;
    /** 应用节点：它跑的不是一份 ComfyUI 图，而是 RunningHub 上的一个打包好的 AI 应用。 */
    const isApp = node.data.kind === 'app-generate';
    /**
     * 这次要用的工作流用途。视频与图片是两套工作流，选错的症状是「任务成功但产出是另一种媒体」，
     * 所以下拉要按用途过滤、提交时要带上它让服务端复核（服务端那道闸挡的是手改画布与老画布）。
     *
     * 应用节点的用途**跟着选中的那份应用走**：它出图还是出片是导入时定的，节点自己不知道。
     */
    const purpose = isApp
      ? appPurposeOf(workflows, String(node.data.workflowId || ''))
      : (purposeForNode(node.data.kind, workflows, node.data.workflowId) ?? 'video');
    /** 图片生成节点走同一条提交链路，但不吃 latent、不提交时长与接续，参数换成出图那一套。 */
    const isImage = node.data.kind === 'image-generate' || (isApp && purpose === 'image');
    /**
     * 图片生成节点的引擎。`runninghub` / `local` 走下面那一整条工作流链路，`custom` 走
     * 自定义接口（同步出图）—— 后者在提示词检查之后就直接分流出去了，跟工作流 / latent /
     * 步数那一套毫无关系。
     */
    const imageEngine = readImageEngine(node.data.engine);
    /**
     * 视频生成节点的引擎。`workflow` 走下面那一整条 RunningHub 链路，`videoapi` 直连通用视频网关。
     *
     * 与图片侧自定义接口出图的关键差别：**它是异步的**（提交只拿任务号，视频要等轮询），
     * 所以下面分流之后仍然要建任务并 `poll()`，不像同步出图那样当场拿结果。
     */
    const videoEngine = readVideoEngine(node.data.engine);
    /** 应用节点的下拉里列的是**应用**（`app-` 前缀），不是工作流。 */
    const workflowsForRun = isApp ? workflowsForApp(workflows) : workflows.filter(item => item.kind === purpose);
    const upstream = sources(id);
    const isLatentOn = (item: Node<NodeData>) => isLatentKind(item.data.kind) && item.data.latentEnabled !== 'off';
    const continuationOn = !isImage && node.data.continuationEnabled === 'on';
    /*
     * 参考图按 **URL** 收集，不按节点收集：首尾帧节点一个节点能出两张
     * （给它自己「取用」开关决定），按节点收集会把尾帧悄悄丢掉 ——
     * 「想要尾帧续拍却拿到首帧」是最难发现的错：任务成功、画面接不上、界面什么都不说。
     */
    const imageUrls = upstream
      .filter(item => isReferenceSource(item.data.kind))
      .flatMap(item => referenceUrlsOf(item.data))
      /* 「生成 → image-out → 视频」会让同一份图同时出现在两个上游节点上、URL 相同，去重避免占掉多个参考位。 */
      .filter((url, index, all) => all.indexOf(url) === index)
      .slice(0, MAX_REFERENCE_IMAGES);
    /*
     * 上游的视频 / 音频输入节点：提交的是**整份媒体**（不是首帧），给工作流里的
     * LoadVideo / LoadAudio 那类节点用 —— 前提是配置页把字段绑到了「画布 · 视频 / 音频输入」。
     * 没绑就不会进 nodeInfoList（`toNodeInfoList` 跳过没有字段承接的值），所以这里无条件带上不会出错。
     *
     * **可以有多份**：连了几个输入节点就交几份，配置页那边的「视频输入 2 / 音频输入 2」按顺序取用。
     * 早先这里用 `.find()` 只取一个 —— 第二个视频输入节点就成了「线连上了、参数里却没有它」，
     * 而界面上一句话都不会说。
     *
     * 从资产库导入的节点身上没有远端文件名，只有本站资产地址 —— 那也得交出去：
     * 服务端提交时会读盘重传（`/api/projects/[id]/generation` 里的 `resolveVideoInputs`），
     * 所以「地址是本地的」不构成少交一个值的理由。
     * `blob:` 那种取不到字节的地址不算（见 `isResolvableUrl`）。
     */
    /*
     * 2026-10-01：`video-generate` 也能当这一路的来源 —— 上一个视频节点跑出来的
     * **整段视频**交下来。它身上只有 `resultUrl`（远端地址或本站资产地址都可能是），
     * 两种都交给服务端 `resolveVideoInputs` 处理，这里只把取不到字节的那种（`blob:`）滤掉。
     */
    const videoInputs = upstream
      .filter(item => item.data.kind === 'video-input' || item.data.kind === 'video-generate')
      .map(item => item.data.kind === 'video-generate'
        ? String(isResolvableUrl(item.data.resultUrl) ? item.data.resultUrl : '').trim()
        : String(item.data.videoRemoteFile || item.data.videoRemoteUrl
          || (isResolvableUrl(item.data.videoUrl) ? item.data.videoUrl : '') || '').trim())
      .filter(Boolean)
      .slice(0, MAX_VIDEO_INPUTS);
    const audioInputs = upstream
      .filter(item => item.data.kind === 'audio-input')
      .map(item => String(item.data.audioRemoteFile || item.data.audioRemoteUrl
        || (isResolvableUrl(item.data.audioUrl) ? item.data.audioUrl : '') || '').trim())
      .filter(Boolean)
      .slice(0, MAX_AUDIO_INPUTS);
    /** 上游所有「开着且参与」的 latent 类节点，不管它是不是链的末端。 */
    const latentUpstream = continuationOn ? upstream.filter(isLatentOn) : [];
    const latentChains = latentUpstream.map(item => ({ item, chain: latentChainOf(item.id) }));
    const latentsForRun = latentChains
      .filter(entry => isTerminalLatent(entry.item.id, upstream, edges))
      .slice(0, LATENT_SLOTS)
      .filter(entry => entry.chain.value);
    /*
     * 「还没准备好」不能只拿 `referenceUrlsOf()` 那一把尺子量：
     * 视频输入节点交出去的是**整段视频**（`videoInput`，绑到工作流里 LoadVideo 那类节点），
     * 不是参考图。从资产库导入的视频身上只有本地地址，按参考图那把尺子量永远是空的，
     * 于是出现「连好了线、点运行却说尚未上传完成」，而它其实什么都不缺。
     */
    const pending = upstream.some(item => isReferenceSource(item.data.kind)
      ? referenceUrlsOf(item.data).length === 0 && !mediaReadyForRun(item.data)
      : continuationOn && isLatentOn(item) && isTerminalLatent(item.id, upstream, edges) && !latentChainOf(item.id).value);
    /**
     * 上游接着 latent、却一条值都没解析出来 —— 这是最危险的一档**静默失败**：
     * 提交会带着两个空槽位跑成功，出来的片段和上一段毫无关系，而界面上什么都不说。
     *
     * 环就是这种情形：环上每个节点都是别人的上游，`isTerminalLatent` 一个都不认，
     * 于是上面那个 `pending` 也漏过去了。所以这条判断不能靠 `pending` 兜。
     */
    const latentDeadEnd = latentUpstream.length > 0 && latentsForRun.length === 0;
    const latentBroken = latentChains.map(entry => entry.chain.broken).find(Boolean) || null;
    /** 环比「没接上游」更值得说：它藏得最深，界面上所有节点看起来都连好了。 */
    const latentIssue: LatentChain['broken'] =
      latentUpstream.length > 0 && hasLatentCycle(latentUpstream.map(item => item.id), edges) ? 'cycle' : latentBroken;
    /**
     * 编号决定这条 latent 写进哪个参数位（#1 → latent_1 → 节点 210）。
     * 没填编号的按连上的顺序填空位，跟加编号之前的行为一致。
     * **下标必须对齐**：`binding: latent_N` 取的是 `values.latents[N-1]`，
     * 所以中间空着的位置得留成空串，不能把数组压实。
     */
    const placed: string[] = [];
    /** 每个槽位**分别**要写进哪个工作流节点 —— 取自那条 latent 所在节点上填的号。 */
    const placedNodeIds: string[] = [];
    let cursor = 0;
    for (const entry of latentsForRun) {
      const picked = (entry.item.data.latentIndexes || []).filter(index => index >= 1 && index <= LATENT_SLOTS);
      /**
       * 一个中转节点可能同时带**两份**（粗 / 精，2026-10-03 N-114）——
       * 那就一份占一个槽位。**不能只放第一份**：第二份被丢掉是静默的，
       * 任务照样成功、出来的片段只用了一半的续接，界面上一个字都不说。
       */
      const values = entry.chain.values?.length
        ? entry.chain.values.filter(Boolean)
        : (entry.chain.value ? [entry.chain.value] : []);
      if (!values.length) continue;
      if (!picked.length) {
        for (const value of values) {
          while (placed[cursor]) cursor += 1;
          if (cursor >= LATENT_SLOTS) break;
          placed[cursor] = value;
          placedNodeIds[cursor] = latentNodeIdOf(entry.item.data, cursor + 1);
          cursor += 1;
        }
        continue;
      }
      /* 选中了槽位：第 i 份值 → 第 i 个选中的槽位；多出来的值依次填还没占的槽位（同样不许丢）。 */
      let spare = 0;
      values.forEach((value, offset) => {
        let index = picked[offset];
        if (!index) {
          while (spare < LATENT_SLOTS && placed[spare]) spare += 1;
          index = spare + 1;
          spare += 1;
        }
        if (index < 1 || index > LATENT_SLOTS) return;
        placed[index - 1] = value;
        placedNodeIds[index - 1] = latentNodeIdOf(entry.item.data, index);
      });
    }
    const latents = Array.from({ length: LATENT_SLOTS }, (_, index) => placed[index] || '');
    /**
     * 这两个号**只带填了的**：留空表示「沿用配置页的绑定」，不能在这里回落成 210 / 278
     * —— 那等于把「没填」说成「强制改写」，会在别人已经绑好的工作流上换掉落点。
     *
     * 两条 latent 抢同一个槽位时后写的赢，跟 `placed` 那条规则一致（值也是后写的覆盖先写的）。
     */
    const latentNodeIds = {
      coarse: String(placedNodeIds[0] || '').trim(),
      fine: String(placedNodeIds[1] || '').trim(),
    };
    /*
     * 提示词 = 上游文本节点 + 上游导演台的构图描述。
     *
     * 导演台那段是**追加**而不是替换：它说的是机位和站位，用户自己写的说的是画面内容，
     * 两件事都得讲，丢掉任何一半模型就只收到一半意图。
     * 多个导演台就按连线顺序依次拼上（谁先连谁在前面）。
     */
    const directorShots = upstream
      .filter(item => item.data.kind === 'director')
      .map(item => String(item.data.directorPrompt || '').trim())
      .filter(Boolean);
    const prompt = [
      promptTextOf(upstream),
      ...directorShots,
    ].filter(Boolean).join('\n') || String(node.data.text || '').trim();
    /** A connected workflow node wins; otherwise fall back to the id typed on the generator node itself. */
    const workflowNode = upstream.find(item => item.data.kind === 'workflow');
    /**
     * 图片生成节点**不回落到视频那条默认工作流**：那个 ID 是视频工作流，
     * 出图节点默认指向它只会让人跑出一段视频。这条规则在 `defaultWorkflowIdFor` 里，
     * 跟新建节点时填的默认值是同一处（见 lib/workflows/defaults.ts）。
     */
    /*
     * 应用节点**不回落到默认工作流**：那是一份普通的云端工作流，把它填进来会让节点
     * 拿着一个不是应用的 ID 去提交。没选就是没选，让用户自己挑一份应用。
     */
    const workflowIdForRun = isApp
      ? String(workflowNode?.data.workflowId || node.data.workflowId || '').trim()
      : String(workflowNode?.data.workflowId || node.data.workflowId || defaultWorkflowIdFor(purpose));
    /*
     * 视频网关是**另一条链路**，在这里就分出去，而且**要在 latent / 参考图那些检查之前** ——
     * 这个引擎没有 latent 接续、也不需要工作流，放下去只会撞上「请先选择一个工作流」这种
     * 在它这里根本不成立的检查，报错会指向一个用户根本不需要做的事。
     */
    /*
     * 上游图片的**可取字节地址**列表。取不到就返回一句文案（而不是静默跳过 ——
     * 那会变成「图出来了，但和我的参考图毫无关系」）。
     */
      const collectReferenceImages = (): string[] | string => {
        const wiredImages = upstream.filter(item => ['image', 'video-input', 'frame-extract'].includes(String(item.data.kind))).slice(0, IMAGE2_MAX_REFERENCES);
        const out: string[] = [];
        for (const item of wiredImages) {
          const preview = String(item.data.previewUrl || '').trim();
          const local = String(item.data.imageUrl || '').trim();
          /** 首尾帧节点没有 previewUrl：它那两张图的地址在自己的字段里，取字节要的是那个。 */
          const source = preview || (local.startsWith('/api/assets/') ? local : '') || referenceUrlsOf(item.data, 'bytes')[0] || '';
          if (!source) {
            return `第 ${out.length + 1} 张参考图只有本地预览，服务端取不到它的字节 —— 请等上传完成，或重新上传这张图`;
          }
          out.push(source);
        }
        return out;
      };

    /*
     * 自定义接口出片（2026-09-21）。与视频网关同一条**异步**节奏（提交拿号 → 轮询），
     * 差别只是凭据来自用户自己加的那条接口。**同样要在这里就分出去**：
     * 这一档没有工作流、没有 latent 接续，走下去只会撞上「请先选择一个工作流」。
     */
    if (node.data.kind === 'video-generate' && videoEngine === 'custom') {
      const customModel = String(node.data.customModel || '').trim();
      if (!prompt) return patch(id, { status: 'failed', result: '请输入提示词或连接文字节点' });
      if (!customModel) return patch(id, { status: 'failed', result: '还没选模型 —— 在「自定义接口」那个下拉里挑一个（接口在「设置 · 模型服务」里加）' });
      const customVideoValues = {
        duration: String(node.data.videoApiDuration || VIDEO_API_DEFAULTS.duration),
        resolution: String(node.data.videoApiResolution || VIDEO_API_DEFAULTS.resolution),
        aspectRatio: String(node.data.videoApiRatio || VIDEO_API_DEFAULTS.ratio),
      };
      const badCustomVideo = validateVideoApiParams(customVideoValues);
      if (badCustomVideo) return patch(id, { status: 'failed', result: badCustomVideo });
      patch(id, { status: 'running', result: '提交中 · 自定义接口' });
      try {
        const body = await json(await fetch(`/api/projects/${projectId}/custom-video`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            nodeId: id, nodeLabel: String(node.data.label || ''), prompt, model: customModel, ...customVideoValues,
            ...(imageUrls[0] ? { firstFrame: imageUrls[0] } : {}),
          }),
        }));
        patch(id, { result: '任务已提交' });
        void poll(body.taskId, id, String(node.data.label || '视频'), {
          externalTaskId: body.externalTaskId,
          workflowId: body.workflowId,
        });
      } catch (error) {
        patch(id, { status: 'failed', result: error instanceof Error ? error.message : '提交失败' });
      }
      return;
    }
    if (node.data.kind === 'video-generate' && videoEngine === 'videoapi') {
      if (!prompt) return patch(id, { status: 'failed', result: '请输入提示词或连接文字节点' });
      /*
       * 图生视频：上游第一张图当首帧。
       * **传的是能取到字节的地址，不是 `remoteFile`** —— 视频网关认不出 RunningHub 的远端文件名，
       * 本地资产由服务端读盘后转发出去（见 lib/providers/videoapi/reference.ts）。
       */
      const firstFrame = imageUrls[0];
      const videoApiValues = {
        model: String(node.data.videoApiModel || ''),
        duration: String(node.data.videoApiDuration || VIDEO_API_DEFAULTS.duration),
        resolution: String(node.data.videoApiResolution || VIDEO_API_DEFAULTS.resolution),
        aspectRatio: String(node.data.videoApiRatio || VIDEO_API_DEFAULTS.ratio),
      };
      /** 与服务端同一份定义先自查一遍，免得白跑一个来回才报错。 */
      const badVideoApi = validateVideoApiParams(videoApiValues);
      if (badVideoApi) return patch(id, { status: 'failed', result: badVideoApi });
      patch(id, { status: 'running', result: '提交中 · 视频网关' });
      try {
        const body = await json(await fetch(`/api/projects/${projectId}/videoapi`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            nodeId: id,
            nodeLabel: String(node.data.label || ''),
            prompt,
            ...videoApiValues,
            ...(firstFrame ? { firstFrame } : {}),
          }),
        }));
        patch(id, { result: '任务已提交' });
        /* 异步链路：这里只拿到任务号，视频由轮询取回（与工作流那条路同一个 poll）。 */
        void poll(body.taskId, id, String(node.data.label || '视频'), {
          externalTaskId: body.externalTaskId,
          workflowId: body.workflowId,
        });
      } catch (error) {
        patch(id, { status: 'failed', result: error instanceof Error ? error.message : '提交失败' });
      }
      return;
    }
    /**
     * 拦下来之后要**说清是哪种原因**。链断了却报「尚未上传完成」，
     * 用户会一直重新上传一个本来就没问题的文件，而且怎么传都不会好。
     */
    /*
     * 上游接了首尾帧却还没提取出来 —— 这种情况**不能**报「尚未上传完成」：
     * 用户会一直重新上传那段本来就没问题的视频，而且怎么传都不会好。
     */
    const frameMissing = upstream.find(item => item.data.kind === 'frame-extract' && referenceUrlsOf(item.data).length === 0);
    if (pending || latentDeadEnd) {
      return patch(id, {
        status: 'failed',
        result: latentBrokenHint(latentIssue)
          || (frameMissing
            ? `上游「${String(frameMissing.data.label || '首尾帧')}」还没有提取出帧 —— 选中它点「提取首尾帧」`
            : '参考图或 latent 尚未上传完成'),
      });
    }
    if (!prompt) return patch(id, { status: 'failed', result: '请输入提示词或连接文字节点' });
    /*
     * 自定义接口出图（2026-09-21）。**同步**形状（一次请求拿回图），
     * 所以**在「请先选择一个工作流」之前分出去** —— 这一档根本没有工作流。
     *
     * 参考图那一段抽成了函数（`collectReferenceImages`）：它是**唯一**还在走同步出图的
     * 那一档（Image 2.0 2026-09-23 删了），留着函数而不是摊平，是将来再加同步网关时不用重写。
     */
    if (isImage && imageEngine === 'custom') {
      const customModel = String(node.data.customModel || '').trim();
      if (!customModel) return patch(id, { status: 'failed', result: '还没选模型 —— 在「自定义接口」那个下拉里挑一个（接口在「设置 · 模型服务」里加）' });
      const collected = collectReferenceImages();
      if (typeof collected === 'string') return patch(id, { status: 'failed', result: collected });
      const customImageValues = {
        ratio: String(node.data.image2Ratio || IMAGE2_DEFAULTS.ratio),
        resolution: String(node.data.image2Resolution || IMAGE2_DEFAULTS.resolution),
      };
      const badCustomImage = validateImage2Params(customImageValues);
      if (badCustomImage) return patch(id, { status: 'failed', result: badCustomImage });
      /*
       * 🔴 把**这一次真正会发出去的尺寸**写进状态（2026-09-29）。
       *
       * 两件事靠它：① 同步接口出一张 4K 图常常要几十秒，界面上只有一圈转的话
       * 用户分不清「在算」和「卡死了」；② 出完图再原样写一次，他就能拿这张图去对
       * 「我选的是不是这个尺寸」—— 这正是「选 4K 却出 1K」最缺的那一条线索。
       */
      const submitted = readImage2Params(customImageValues);
      const sizeNote = submitted.size === IMAGE2_SIZE_AUTO
        ? '尺寸由接口决定（想固定就选一个比例）'
        : `${submitted.size}（${String(submitted.resolution).toUpperCase()}）`;
      patch(id, { status: 'running', result: `提交中 · 自定义接口 · ${sizeNote}` });
      const startedAt = Date.now();
      const ticker = window.setInterval(() => {
        patch(id, {
          status: 'running',
          result: `已等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒 · 自定义接口 · ${sizeNote}`,
        });
      }, 5000);
      try {
        const body = await json(await fetch(`/api/projects/${projectId}/custom-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            nodeId: id, nodeLabel: String(node.data.label || ''), prompt, model: customModel, ...customImageValues, referenceImages: collected,
          }),
        }));
        const results: RunResult[] = (Array.isArray(body.results) ? body.results : [])
          .filter((item: { url?: string } | null) => Boolean(item?.url))
          .map((item: { url: string }) => ({ url: String(item.url), kind: 'image' as const }));
        if (!results.length) return patch(id, { status: 'failed', result: '自定义接口没有返回可用的图片' });
        applyRun(id, {
          id: String(body.taskId || crypto.randomUUID()),
          workflowId: String(body.workflowId || customModel),
          at: new Date().toLocaleString('zh-CN', { hour12: false }),
          ts: Date.now(),
          status: 'success',
          results,
        }, results);
        /** 出完再写一次这次的尺寸：图对不对得上，用户拿这一行就能核对。 */
        patch(id, { result: `已出图 · ${sizeNote}` });
      } catch (error) {
        patch(id, { status: 'failed', result: error instanceof Error ? error.message : '提交失败' });
      } finally {
        window.clearInterval(ticker);
      }
      return;
    }
    if (!workflowIdForRun) return patch(id, {
      status: 'failed',
      result: isApp ? '请先在本节点上选择一个 RunningHub 应用' : '请先在本节点上选择一个工作流',
    });
    if (workflowNode && !workflowIdForRun) return patch(id, { status: 'failed', result: '上游的工作流节点还没有选择工作流' });
    /*
     * 引擎与工作流的来源必须对得上。
     *
     * 这一条**必须在这里拦**，不能只靠下拉过滤：切了引擎之后那份工作流可能还停在原处
     * （老画布、手改过的画布），于是两边说的不是同一条链路。而它照跑不误 ——
     * 只是活交给了另一边：选了「本地 ComfyUI」却跑了云端，用户以为没扣钱、其实扣了积分。
     * 服务端还会再拦一次（那是挡手改画布与直接打接口的），这里拦是为了把话说得更近、更早。
     */
    /*
     * 应用节点不参与「引擎 ↔ 工作流来源」这道对账：它只有云端一条路，引擎下拉在这个节点上
     * 根本不渲染。传 null 表示「这一档不按来源筛」，下面的列表本来就只装应用。
     */
    const engineProvider = isApp
      ? null
      : (node.data.kind === 'image-generate'
        ? imageEngineProvider(node.data.engine)
        : videoEngineProvider(node.data.engine));
    const chosenWorkflow = workflows.find(item => item.workflowId === workflowIdForRun);
    if (engineProvider && chosenWorkflow) {
      const chosenProvider = chosenWorkflow.provider === 'local' ? 'local' : 'runninghub';
      if (chosenProvider !== engineProvider) {
        return patch(id, {
          status: 'failed',
          result: `这个节点的引擎是「${engineProvider === 'local' ? '本地 ComfyUI' : 'RunningHub'}」，选中的工作流「${workflowDisplayName(chosenWorkflow)}」却是${chosenProvider === 'local' ? '本机 ComfyUI' : 'RunningHub（云端）'}的 —— 两者不是同一条链路。请换一份${engineProvider === 'local' ? '本机的' : '云端的'}工作流，或把引擎改回「${chosenProvider === 'local' ? '本地 ComfyUI' : 'RunningHub'}」。`,
        });
      }
    }
    /*
     * 先看用途，再看有没有配置。这两条的文案必须分开：选了一个「存在但用途不对」的工作流，
     * 报「尚未保存节点配置」会把用户支到设置页去存一份根本不该用的配置。
     */
    if (chosenWorkflow && chosenWorkflow.kind !== purpose) {
      return patch(id, { status: 'failed', result: workflowMismatchHint(purpose, chosenWorkflow) });
    }
    /*
     * 「这份工作流还没保存过配置」。只在**本用途 + 本来源**那一批里找 ——
     * 少了来源这一层，一份本机的工作流会被拿云端的名单去比，于是一个明明配好的工作流
     * 被告知「尚未保存节点配置」，用户去设置页看又明明在。
     */
    const runnableWorkflows = engineProvider
      ? workflowsForProvider(workflowsForRun, engineProvider)
      : workflowsForRun;
    if ((workflowNode || isImage) && runnableWorkflows.length && !runnableWorkflows.some(item => item.workflowId === workflowIdForRun)) {
      return patch(id, { status: 'failed', result: `工作流 ${workflowIdForRun} 尚未保存节点配置，请先到设置页保存` });
    }
    /** 种子允许 0，所以只把「没填」当没填，不能直接用 `||`。 */
    const rawSeed = String(node.data.seed ?? '').trim();
    /** 图片与视频各自的参数分开装，互不污染：视频工作流不该收到 steps，出图工作流也不该收到时长。 */
    const imageValues = isImage
      ? {
        negativePrompt: String(node.data.negativePrompt || '').trim(),
        steps: String(node.data.steps || IMAGE_DEFAULTS.steps),
        cfg: String(node.data.cfg || IMAGE_DEFAULTS.cfg),
        seed: rawSeed === '' ? IMAGE_DEFAULTS.seed : rawSeed,
        batchSize: String(node.data.batchSize || IMAGE_DEFAULTS.batchSize),
        sampler: String(node.data.sampler || IMAGE_DEFAULTS.sampler),
      }
      : {};
    const videoValues = isImage
      ? {}
      : {
        duration: String(node.data.duration || '6'),
        latents,
        continuation: continuationOn ? 'false' : 'true',
        videoInputs,
        audioInputs,
      };
    /*
     * 用 `resolveImageSize` 而不是 `deriveImageSize`：前者会先看这个节点「长宽」那一档
     * 是不是 `custom`（用户在底部对话框里手填了宽高），是就用他填的数。
     * 界面上显示的那两个数字也是同一个函数算出来的 —— 两边各算一次就会出现
     * 「面板写着 1024×1024、实际提交的是按 MP 算出来的另一个数」，而这件事没有任何报错。
     */
    const imageSize = isImage ? resolveImageSize(node.data) : null;
    const imageSizeValues = imageSize ? { width: String(imageSize.width), height: String(imageSize.height) } : {};
    /*
     * 出图参数的范围在这里先自查一遍：服务端会再查一次，但那要等一个来回，
     * 而且报错会晚到「任务已提交」之后。用同一份定义，两边结论一致。
     */
    const badParam = isImage
      ? validateImageParams({ ...imageValues, megapixels: String(node.data.megapixels || IMAGE_DEFAULTS.megapixels) })
      : null;
    if (badParam) return patch(id, { status: 'failed', result: badParam });
    /*
     * 连上来的自定义参数块，按顺序叠加（越靠近本节点的优先级越高）；
     * 应用节点自己那份「就地改过的应用参数」放在**最后** —— 它就长在本节点上，优先级最高。
     */
    const paramRows = [...collectParamRows(id), ...(isApp ? ((node.data.appRows || []) as ParamRow[]) : [])]
      .filter(row => row.enabled && row.value.trim());
    const custom = paramRows.length ? ` · ${paramRows.length} 行自定义参数` : '';
    patch(id, {
      status: 'running',
      result: isImage
        ? `提交中 · ${imageUrls.length} 图${custom}`
        : `提交中 · ${imageUrls.length} 图 · ${latentsForRun.length} latent${custom}`,
    });
    try {
      const body = await json(await fetch(`/api/projects/${projectId}/generation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodeId: id,
          nodeLabel: String(node.data.label || ''),
          workflowId: workflowIdForRun,
          kind: purpose,
          /*
           * 把引擎一并发上去。服务端用它核对「界面上说的那条链路」与「这份工作流实际属于哪边」
           * 是不是同一个 —— 不一致时两边都会成功，只是活交给了另一边（钱 / 算力都花错了地方），
           * 而界面上一个字都不会说。网关那两档（videoapi / custom）在服务端会被跳过。
           */
          engine: String(node.data.engine || ''),
          /*
           * RunningHub 的运行规格（2026-09-30）。**总是带上读出来的值**，而不是「非默认才带」：
           * 读法只有一个（`readInstanceType`，缺省 = default），带上去与老行为完全等价
           * （服务端本来也是 `instanceType || 'default'`），少一个分支就少一处会分叉的真相。
           */
          instanceType: readInstanceType(node.data.instanceType),
          paramRows,
          ...(latentNodeIds.coarse || latentNodeIds.fine ? { latentNodeIds } : {}),
          bindingValues: {
            prompt,
            aspectRatio: String(node.data.aspectRatio || (isImage ? IMAGE_DEFAULTS.ratio : DEFAULT_RATIO)),
            megapixels: String(node.data.megapixels || (isImage ? IMAGE_DEFAULTS.megapixels : '0.2')),
            /* 参考图既可能来自上传图节点（remoteFile），也可能来自「图片生成 / image-out」节点（resultUrl）。
               二者都已收进 `imageUrls`，这里直接用，别再回头读 remoteFile，否则生成图连不进视频。 */
            referenceImages: imageUrls,
            ...imageValues,
            ...videoValues,
            ...imageSizeValues,
          },
        }),
      }));
      patch(id, { result: '任务已提交' });
      void poll(body.taskId, id, String(node.data.label || '视频'), { externalTaskId: body.externalTaskId, workflowId: workflowIdForRun, operation: 'generate' });
    } catch (error) {
      patch(id, { status: 'failed', result: error instanceof Error ? error.message : '提交失败' });
    }
  }, [applyRun, collectParamRows, edges, latentChainOf, nodes, patch, poll, projectId, promptTextOf,
    sources, workflows]);

  /**
   * 「跑一个节点」的统一入口（2026-09-29）：优化节点走改写，其余走生成。
   *
   * 一键运行以前只认生成节点 —— 优化节点被整个跳过，于是下游拿到的还是改写前那句，
   * 而整条链看起来一路成功（`runAllNodes` 里那道「没跑起来」的闸也拦不住：
   * 它压根没被调用过）。
   */
  const runOne = useCallback(async (id: string) => {
    const node = nodesRef.current.find(item => item.id === id);
    if (!node) return;
    /* 被绕过的节点：按钮留着（不然用户找不着它去哪了），点了就说清为什么不跑。 */
    if (node.data.bypassed) {
      setNotice('这个节点被绕过了 —— 按 B（或右键 · 取消绕过）才跑得起来');
      return;
    }
    /* 优化节点：左边有图走反推、没图走改写 —— 两条入口共用 `runPromptNode`。 */
    if (node.data.kind === 'prompt-optimize') { await runPromptNode(id); return; }
    await generate(id);
  }, [generate, nodesRef, runPromptNode]);


  /*
   * generate 的**最新一份**（2026-09-27）。
   *
   * 一键运行一跑就是几十分钟，循环里那个 generate 必须是最新那份：它闭包里的 nodes
   * 是发起那一刻的快照，轮到下游节点时上游明明已经出图了，闭包里却还写着「没有」——
   * 下游就拿着空上游提交出去，任务成功、画面接不上、界面上还全是成功。
   * 这是最贵的一类错（钱花了、东西是废的、而且看不出来），所以单独存一份 ref。
   */
  const runOneRef = useRef(runOne);
  /*
   * 打开画布时扫一遍（2026-09-29）：把「上次没跑完就关掉软件」的那些任务接上或结掉。
   *
   * 关掉那段时间没人轮询，任务会永远停在 running；而重开之后**没有任何人会去查它** ——
   * 于是节点一直转圈、发送按钮是灰的，只能删节点重建。
   * 服务端那一趟（`POST /api/tasks/scan`）只报还在跑的 —— 不结单，
   * 任务只有成功与失败两种结果，这一趟不做任何结单。
   * 这里只负责两类动作：能接上的**接着轮询**，接不上的**就地写成失败**（别让它永远转圈）。
   */
  const resumed = useRef(false);
  useEffect(() => {
    /* 只跑一次；但也别在画布数据还没到（`nodes` 为空）时就把这趟机会用掉。 */
    if (resumed.current || !nodes.length) return;
    resumed.current = true;
    void (async () => {
      const scan = await fetch('/api/tasks/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      }).then(response => (response.ok ? response.json() : null)).catch(() => null);
      const runningByNode = new Map<string, { taskId: string; externalTaskId?: string; workflowId?: string }>(
        (Array.isArray(scan?.running) ? scan.running : []).map((item: { nodeId?: string; taskId?: string; externalTaskId?: string; workflowId?: string }) =>
          [String(item.nodeId || ''), {
            taskId: String(item.taskId || ''),
            externalTaskId: item.externalTaskId,
            workflowId: item.workflowId,
          }] as [string, { taskId: string; externalTaskId?: string; workflowId?: string }]),
      );
      const settledByNode = new Map<string, { taskId?: string; nodeId?: string; externalTaskId?: string; workflowId?: string }>(
        (Array.isArray(scan?.settled) ? scan.settled : []).map((item: { taskId?: string; nodeId?: string; externalTaskId?: string; workflowId?: string }) =>
          [String(item.nodeId || ''), item] as [string, { taskId?: string; nodeId?: string; externalTaskId?: string; workflowId?: string }]),
      );
      nodes.filter(node => node.data.status === 'running').forEach(node => {
        const alive = runningByNode.get(node.id);
        if (alive?.taskId) {
          /*
           * 上游还在跑 —— 接着查，一直查到它给出成功或失败。
           *
           * 这一轮**是超清还是普通生成**只能问它跑的那份工作流（任务号自己不带这个信息）：
           * 认不出来就会被当成普通生成，于是「上次没跑完的那道超清」成功后又自动接一道。
           */
          const resumedId = String(alive.workflowId || node.data.workflowId || '');
          const resumedOp = workflows.find(item => item.workflowId === resumedId)?.operation === 'upscale'
            ? 'upscale' : 'generate';
          void poll(alive.taskId, node.id, String(node.data.label || '生成'), {
            externalTaskId: alive.externalTaskId,
            workflowId: resumedId,
            operation: resumedOp,
          });
          return;
        }
        /*
         * 服务端扫尾时**已经把它问明白了**（2026-10-03，N-112）——
         * 那就照样走 `poll()` 那条路写节点：它去查这个任务号，库里已经是终态，
         * 立刻就会走成功 / 失败那两个分支，节点的图、历史、下游连线一条不落。
         * 🔴 别在这里自己写终态 —— 那会绕过落盘和下游那一整套。
         */
        const done = settledByNode.get(node.id);
        if (done?.taskId) {
          const doneId = String(done.workflowId || node.data.workflowId || '');
          const doneOp = workflows.find(item => item.workflowId === doneId)?.operation === 'upscale'
            ? 'upscale' : 'generate';
          void poll(done.taskId, node.id, String(node.data.label || '生成'), {
            externalTaskId: done.externalTaskId,
            workflowId: doneId,
            operation: doneOp,
          });
          return;
        }
        /*
         * 服务端那边也没有在跑的任务号 —— 这不是「判它失败」，是**查无可查**：
         * 不写个终态，节点会永远转圈、按钮永远灰着，比写失败更糟。
         */
        patch(node.id, { status: 'failed', result: '上次没跑完就关掉了 —— 这一轮没有可查的任务号，重新生成一次吧。' });
      });
    })();
  }, [nodes, patch, poll, projectId]);

  useEffect(() => { runOneRef.current = runOne; }, [runOne]);

  /*
   * 渲染计数（2026-09-27）。**只在 effect 里 +1**，所以「它变大了」的意思就是
   * 「React 已经把刚才那次 setNodes 渲染完、effect 也跑过了」—— `generateRef`
   * 正是在那个 effect 里刷新的。
   *
   * 为什么非有它不可：`waitNodeSettled` 读的是 ref（`patch` 里同步写进去的），
   * 上游一出图它**当轮就返回**，而那一刻 setNodes 只是排了个队、React 还没渲染。
   * 紧接着跑下游，下游闭包里的 nodes 还是「上游没出图」那一份 —— 于是撞上
   * 「参考图尚未上传完成」，整条链停在那儿。同步出图那一档（自定义接口，毫秒级）
   * 真跑一次就会踩到，不是只有探针造得出来。
   */
  const renderTick = useRef(0);
  useEffect(() => { renderTick.current += 1; });

  /** 等一个节点落到终态。读的是 `runStatus` 那份 ref（轮询回调活得比一次渲染长）。 */
  const waitNodeSettled = useCallback(async (id: string): Promise<'success' | 'failed' | 'stopped'> => {
    /*
     * 没有等待上限（2026-09-30 删）：任务只有成功与失败两种结果，跑多久是上游的事。
     * 这里只是「等它落终态」，到点也不替它判失败 —— 想停由用户自己点停止。
     */
    for (;;) {
      const status = runStatus.current[id] || '';
      if (status === 'success') return 'success';
      if (status === 'failed') return 'failed';
      if (runAllStop.current) return 'stopped';
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }, []);

  /** 等到「下一次渲染落地」（`renderTick` 变大）为止，最多 600ms。 */
  const waitRender = useCallback(async (since: number) => {
    for (let i = 0; i < 30 && renderTick.current <= since; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }, []);

  /**
   * 生成节点的**执行顺序**（2026-09-27，「启动」按钮要用）。
   *
   * 画布上常常是串起来的几条链（图片生成 → 视频生成 → 拼接上一段），顺序错了下游拿到的
   * 就是上一轮的结果 —— 而它**看起来是成功的**（任务成功、画面接不上），这是最难查的一类错。
   * 所以这里沿边往下游走：走到下一个生成节点就记一条「它依赖这个上游」，
   * 最后 Kahn 拓扑排序，入度为 0 的先跑。
   *
   * 环（用户真能连出来）不许把整条链拖死：剩下的一律按原顺序接在末尾，各自照跑一遍 ——
   * 总比点一下什么都不发生强，而且真有环这件事在画布上看得见。
   */
  const generationOrder = useCallback((): string[] => {
    /* 被绕过的**不进队列**：它这一轮什么都不做，这正是绕过存在的理由（不烧额度）。 */
    const gen = nodes.filter(node => isRunnableKind(node.data.kind) && !node.data.bypassed)
      .map(node => node.id);
    const genSet = new Set(gen);
    const deps = new Map<string, Set<string>>();
    for (const id of gen) deps.set(id, new Set());
    for (const start of gen) {
      const seen = new Set<string>([start]);
      const stack = edges.filter(edge => edge.source === start).map(edge => edge.target);
      while (stack.length) {
        const current = stack.pop() as string;
        if (seen.has(current)) continue;
        seen.add(current);
        /* 中间那些中转节点（图片输出 / latent 接力）不算终点，继续往下走。 */
        if (genSet.has(current)) {
          deps.get(current)?.add(start);
          continue;
        }
        edges.filter(edge => edge.source === current).forEach(edge => stack.push(edge.target));
      }
    }
    const order: string[] = [];
    const pending = new Set(gen);
    while (pending.size) {
      const ready = Array.from(pending).filter(id =>
        Array.from(deps.get(id) || []).every(dep => !pending.has(dep)));
      if (!ready.length) {
        order.push(...Array.from(pending));
        break;
      }
      for (const id of ready) {
        order.push(id);
        pending.delete(id);
      }
    }
    return order;
  }, [edges, nodes]);

  /**
   * 「启动」前的预先检查（2026-09-27）：把**跑不了**的那些节点一次性列出来。
   *
   * 为什么要有它：原来的形状是「跑到第 3 个才发现它没填提示词」—— 前两个已经跑完、
   * 钱已经花了，而界面一次只肯说一个，用户得一遍遍点才知道后面还有几个也缺。
   *
   * 🔴 **绝不能**把 `generate()` 里那套 `pending`（上游参考图 / latent 还没就绪）搬过来：
   * 「上游是另一个待跑的生成节点、它还没出图」会被判成不通过 —— 而那正是要跑它的**原因**。
   * 所以这里只查「与上游无关、用户必须自己动手填」的那几样。
   */
  const preflight = useCallback((): { id: string; label: string; why: string }[] => {
    const problems: { id: string; label: string; why: string }[] = [];
    for (const node of nodesRef.current) {
      /* 被绕过的节点**不查**：它这一轮根本不跑，报「还没接上游」是拿一把不存在的尺子量它。 */
      if (!isRunnableKind(node.data.kind) || node.data.bypassed) continue;
      const label = String(node.data.label || NODE_META[node.data.kind as NodeKind]?.label || node.data.kind || '这个节点');
      const upstream = sources(node.id);
      const isApp = node.data.kind === 'app-generate';
      const purpose = isApp
        ? appPurposeOf(workflows, String(node.data.workflowId || ''))
        : (purposeOfNode(node.data.kind) ?? 'video');
      const isImage = node.data.kind === 'image-generate' || (isApp && purpose === 'image');
      const imageEngine = readImageEngine(node.data.engine);
      const videoEngine = readVideoEngine(node.data.engine);
      /* 提示词：与 `generate()` 同一套算法 —— 上游文字节点 + 导演台，都没有才看节点自己填的。 */
      const prompt = [
        promptTextOf(upstream),
        ...upstream.filter(item => item.data.kind === 'director')
          .map(item => String(item.data.directorPrompt || '').trim()).filter(Boolean),
      ].filter(Boolean).join('\n') || String(node.data.text || '').trim();
      /*
       * 优化节点只查「有没有输入」—— 工作流 / 模型那几样它一概没有，
       * 接着往下查会指着一句它身上不存在的东西让用户去改。
       */
      if (node.data.kind === 'prompt-optimize') {
        /*
         * 左边有图就**不报**「还没接上游文本节点」—— 那种情况下它走的是反推那条路，
         * 本来就不需要文本。报了等于让他去补一个用不上的文本节点。
         */
        if (!optimizeInputOf(node.id) && !describeInputOf(node.id)) {
          problems.push({ id: node.id, label, why: '还没接上游文本节点（或图片节点）' });
        }
        continue;
      }
      const workflowId = String(node.data.workflowId || '').trim()
        || String(upstream.find(item => item.data.kind === 'workflow')?.data.workflowId || '').trim()
        || (isApp ? '' : defaultWorkflowIdFor(purpose));
      /* 自定义接口 / 视频网关那两档不经过工作流（`generate()` 里也是在选工作流之前就分出去了）。 */
      const needsWorkflow = !(isImage && imageEngine === 'custom')
        && !(node.data.kind === 'video-generate' && (videoEngine === 'custom' || videoEngine === 'videoapi'));
      const customModel = String(node.data.customModel || '').trim();
      /** 首尾帧没提取是**用户该手动做掉**的前置动作（那个节点不参与生成顺序），值得提前说。 */
      const frameMissing = upstream.find(item => item.data.kind === 'frame-extract' && referenceUrlsOf(item.data).length === 0);

      /* 一个节点只报头一个毛病：列一长串反而看不出先改哪个。 */
      if (!prompt) { problems.push({ id: node.id, label, why: '还没填提示词（也没连文字节点）' }); continue; }
      if (needsWorkflow && !workflowId) { problems.push({ id: node.id, label, why: '还没选工作流' }); continue; }
      if (isImage && imageEngine === 'custom' && !customModel) {
        problems.push({ id: node.id, label, why: '自定义接口还没选模型' }); continue;
      }
      if (node.data.kind === 'video-generate' && videoEngine === 'custom' && !customModel) {
        problems.push({ id: node.id, label, why: '自定义接口还没选模型' }); continue;
      }
      if (node.data.kind === 'video-generate' && videoEngine === 'videoapi'
        && !String(node.data.videoApiModel || '').trim()) {
        problems.push({ id: node.id, label, why: '视频网关还没选模型' }); continue;
      }
      if (frameMissing) {
        problems.push({
          id: node.id, label,
          why: `上游「${String(frameMissing.data.label || '首尾帧')}」还没提取出帧`,
        });
        continue;
      }
    }
    return problems;
  }, [describeInputOf, optimizeInputOf, promptTextOf, sources, workflows]);

  /**
   * 「启动」：把画布上所有生成节点按依赖顺序跑一遍，跑几遍由「遍」数决定。
   *
   * `await generate(id)` 返回时只有三种情况，靠 `runStatus` 分得开：
   * 走了提交（status 已经是 running / success）、同步出图（success）、或者**根本没提交**
   * （提示词没填、上游还没出图 —— 那些分支直接 return 了）。第三种必须停下来：
   * 接着跑下游，下游会拿着空上游一路「成功」下去。
   */
  const runAllNodes = useCallback(async (confirmed = false) => {
    if (runAllBusy) return;
    const order = generationOrder();
    if (!order.length) {
      setNotice('画布上还没有能跑的节点（生成节点 / 优化提示词）。');
      return;
    }
    /*
     * 先过一遍预检，有问题就**一个都不跑**。
     * 「跑一半才发现后面还有两个也跑不了」是最贵的失败形状：钱和时间都花在前半段上了，
     * 而且界面一次只肯说一个。
     */
    const problems = preflight();
    if (problems.length) {
      setNotice(`有 ${problems.length} 个节点还不能用，${problems.length > 1 ? '一个都没跑' : '没跑'}：`
        + problems.map(item => `「${item.label}」${item.why}`).join('；') + '。');
      /* 顺手把头一个有毛病的节点选中并带到眼前 —— 光报名字，用户还得自己在画布上找。 */
      const first = problems[0];
      /*
       * 两套选中都得置：React Flow 的 `node.selected`（画布上那圈高亮）和
       * 驱动参数抽屉的那个 `selected`。只置后一个的话画布上看着什么都没选。
       * 抽屉也顺手打开 —— 报了「缺什么」就是为了让人马上改。
       */
      setNodes(ns => ns.map(item => ({ ...item, selected: item.id === first.id })));
      setSelected(first.id);
      const at = nodesRef.current.find(node => node.id === first.id);
      if (at) void setCenter(at.position.x + 140, at.position.y + 90, { zoom: 1, duration: 300 });
      return;
    }
    const times = Math.max(1, Math.min(99, Math.round(runTimes) || 1));
    /* 大遍数先弹确认：还没真正开跑，用户取消就一个都不发。确认后走 `runAllNodes(true)` 跳过这关。 */
    if (!confirmed && times > RUN_TIMES_CONFIRM_THRESHOLD) {
      setRunTimesConfirm(times);
      return;
    }
    const labelOf = (id: string) => String(nodesRef.current.find(node => node.id === id)?.data.label || '这个节点');
    setRunAllBusy(true);
    runAllStop.current = false;
    let halted = '';
    try {
      for (let round = 1; round <= times && !halted; round++) {
        for (let index = 0; index < order.length; index++) {
          if (runAllStop.current) { halted = '用户停了'; break; }
          const id = order[index];
          setRunProgress({ round, times, done: index, total: order.length });
          runStatus.current[id] = '';
          try {
            await runOneRef.current(id);
          } catch {
            /* generate 自己会把失败写在节点上，这里只需要不再往下跑。 */
          }
          if (!runStatus.current[id]) {
            halted = `「${labelOf(id)}」没跑起来（多半是提示词没填、或上游还没出图）`;
            break;
          }
          const settled = await waitNodeSettled(id);
          if (settled === 'stopped') { halted = '用户停了'; break; }
          if (settled === 'failed') {
            halted = `「${labelOf(id)}」跑失败了`;
            break;
          }
          /*
           * 等 React 把**这一次的产出**渲染进去，再跑下一个（见 `renderTick` 那段注释）。
           *
           * 计数必须在 `waitNodeSettled` **之后**取：它读的是 ref，上游一出图当轮就返回，
           * 那一刻最后一次 patch 已经写进 ref 但还没渲染。取在 `generate` 之前就糟了 ——
           * 「提交中」那次渲染已经让计数变大了，这道闸会当场放行，
           * 于是下游读到的还是「上游没出图」，撞上「参考图或 latent 尚未上传完成」。
           */
          await waitRender(renderTick.current);
        }
      }
      if (halted === '用户停了') setNotice('已停止。');
      else if (halted) setNotice(`${halted} —— 就停在这一步，后面的没跑（继续跑只会拿着空上游）。`);
      else setNotice(times > 1 ? `跑完了 ${times} 遍。` : '跑完了一遍。');
    } finally {
      setRunAllBusy(false);
      setRunProgress(null);
    }
  }, [generationOrder, preflight, renderTick, runAllBusy, runTimes, setCenter, setNodes,     setNotice,
    setRunTimesConfirm,
    waitNodeSettled, waitRender]);

  /**
   * 超清：拿本节点**已经生成出来的那一份**结果，交给一份「超清」工序的工作流再加工一道。
   *
   * 它和普通生成的分工：`generate()` 是从无到有，这里是从有到更好 —— 所以不需要提示词、
   * 参考图、latent、出图参数那一整套，**唯一的输入就是 `resultUrl`**。
   * 落点与生成完全一致（也走 `poll()`），所以结果是**追加成一条新的生成记录**：
   * 原版还在历史里，超清版覆盖到画面上，两者能来回对照。
   */
  const upscale = useCallback(async (id: string, auto = false) => {
    const node = nodes.find(item => item.id === id);
    if (!node) return;
    /** 只有生成节点能超清：超清的输入是「这个节点自己生成出来的东西」。 */
    const purpose = purposeOfNode(node.data.kind);
    if (!purpose) return;
    if (node.data.status === 'running') return;
    const source = String(node.data.resultUrl || '').trim();
    if (!source) return patch(id, { status: 'failed', result: '这个节点还没有结果 —— 先生成一次，再点「超清」' });
    /*
     * 一份都没配时要把话说完整：「没有超清工作流」只是现象，用户要的是「去哪儿配」。
     * 少了后半句，用户会以为这是个没实现的功能，而不是一个两分钟就能配好的选项。
     */
    const asked = readUpscaleSource(node.data.upscaleSource);
    const target = upscaleWorkflowFor(
      workflows, purpose, asked, nodeEngineProvider(node.data.kind, node.data.engine),
      node.data.upscaleWorkflowId,
    );
    if (!target) {
      /*
       * 指定了来源时要把「哪一边没有」说进句子里：只说「还没有配视频超清工作流」，
       * 而用户明明配过一份云端的 —— 他会以为我们没读到，其实是他自己选了「本地」。
       */
      /*
       * 🔴 自动那一路（`auto`）没配就**什么都不做**，绝不写失败：那一刻节点上躺着的是一份
       * 刚刚生成成功的结果，把它改写成「还没有配超清工作流」等于用一次成功换一句报错。
       * 该说的话在配置那一刻就说过了 —— 胶囊弹层里就有一条「这一档还没有…超清工作流」。
       */
      if (auto) return;
      const side = asked === 'follow' ? '' : `${UPSCALE_SOURCE_LABELS[asked]} 的`;
      return patch(id, {
        status: 'failed',
        result: `还没有配${side}${generatorKindLabel(purpose)}超清工作流 —— 到「设置 · 工作流」新建一份工作流，把「工序」改成「超清」，再把工作流里那个上传段的「画布绑定」选成「画布 · 参考图 1」（图）或「画布 · 视频输入 1」（视频）`,
      });
    }
    patch(id, { status: 'running', result: `超清中 · ${workflowDisplayName(target)}` });
    try {
      const body = await json(await fetch(`/api/projects/${projectId}/generation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodeId: id,
          nodeLabel: String(node.data.label || ''),
          workflowId: target.workflowId,
          kind: purpose,
          operation: 'upscale',
          /* 超清跑的同样是一份 RunningHub 工作流，所以要跟节点上选的规格一致（本机那一档用不上它，服务端会跳过）。 */
          instanceType: readInstanceType(node.data.instanceType),
          bindingValues: { upscaleInput: source },
        }),
      }));
      patch(id, { result: '超清任务已提交' });
      void poll(body.taskId, id, String(node.data.label || '超清'), { externalTaskId: body.externalTaskId, workflowId: target.workflowId, operation: 'upscale' });
    } catch (error) {
      patch(id, { status: 'failed', result: error instanceof Error ? error.message : '提交失败' });
    }
  }, [nodes, patch, poll, projectId, workflows]);

  /**
   * 排掉「自动超清」的待办（见 `autoUpscaleQueue` 那条注释：必须等提交之后再跑）。
   *
   * 队列而不是直接调用，还顺带收掉一个重复：一次成功只排一个节点 id（`queue.includes`），
   * 于是「同一轮结果被两个地方同时看见」也只会接一道超清。
   */
  useEffect(() => {
    if (!autoUpscaleQueue.length) return;
    const ids = autoUpscaleQueue;
    setAutoUpscaleQueue([]);
    /* `true` = 这一道是自动接的：没配对应的超清工作流时安静跳过（见 upscale 里那条注释）。 */
    ids.forEach(id => void upscale(id, true));
  }, [autoUpscaleQueue, upscale]);


  /**
   * 把拖进来 / 粘进来 / 在卡片上选进来的媒体存成**本项目下的一份资产**（`/api/assets/...`）。
   *
   * 为什么不再当场传到 RunningHub（`upload` 那条路）：那条路要另一家平台的 Key 已经配好，
   * 没配的时候「往画布里粘一张参考图」也要弹「尚未配置 RunningHub API Key」——
   * 可用户只是想把这张图放进画布，传给谁跟他此刻要做的事无关。
   * 存成本站资产之后，提交生成时服务端自己读盘重传（`lib/referenceImages.ts`），
   * 于是「放进画布」不再依赖任何外部账号。
   *
   * 顺带修掉一个老毛病：`/api/assets/...` 是**持久地址**，重开项目还在；
   * 以前视频 / 音频给播放器的是 `blob:`，刷新一次就播不了了。
   */
  const archiveMedia = useCallback(async (id: string, file: File) => {
    const isVideo = file.type.startsWith('video/');
    const isAudio = file.type.startsWith('audio/');
    const localUrl = URL.createObjectURL(file);
    patch(id, isVideo
      ? { status: 'uploading', videoUrl: localUrl, result: undefined }
      : isAudio
        ? { status: 'uploading', audioUrl: localUrl, result: undefined }
        : { status: 'uploading', imageUrl: localUrl, imageSize: undefined, result: undefined });
    try {
      const body = await apiPost<{ items: { id: string; url: string; name: string }[] }>(
        '/api/tools/archive',
        buildArchiveForm([{ name: file.name || 'pasted-media', blob: file, note: '画布粘贴' }], projectId),
      );
      const saved = body.items?.[0];
      if (!saved?.url) throw new Error('没能存进项目资产，请重试。');
      /** 音频没有首帧那一说，也不进参考图那条路：存下来就能播、能绑到 LoadAudio 那类节点。 */
      if (isAudio) {
        patch(id, {
          status: 'idle',
          audioUrl: saved.url, audioRemoteUrl: saved.url, audioRemoteFile: saved.url,
          result: '已存入资产',
        });
      } else if (isVideo) {
        /*
         * 视频照旧顺手取一帧：它自己不进生成链路（网关只认图），
         * 但首帧图能当首帧 / 图生图的参考图，缺了它这段视频连上去也用不了。
         * 取不出来不算失败 —— 视频照常能播，只是还不能吃生成。
         */
        let frameUrl: string | undefined;
        try {
          const frameBlob = await firstFrameBlob(localUrl);
          const frame = await apiPost<{ items: { id: string; url: string; name: string }[] }>(
            '/api/tools/archive',
            buildArchiveForm([{ name: 'first-frame.jpg', blob: frameBlob, note: '视频首帧' }], projectId),
          );
          frameUrl = frame.items?.[0]?.url || undefined;
        } catch { /* 首帧取不出来：见上面的说明，不算失败。 */ }
        patch(id, {
          status: 'idle',
          videoUrl: saved.url, videoRemoteUrl: saved.url, videoRemoteFile: saved.url,
          ...(frameUrl ? { previewUrl: frameUrl, remoteFile: frameUrl } : {}),
          result: frameUrl ? '已存入资产' : '已存入资产，但首帧图没提取出来',
        });
      } else {
        patch(id, { status: 'idle', imageUrl: saved.url, previewUrl: saved.url, result: '已存入资产' });
      }
      setNotice(`「${file.name || '媒体'}」已存入项目资产`);
    } catch (error) {
      patch(id, { status: 'failed', result: error instanceof Error ? error.message : '存入资产失败' });
    }
  }, [patch, projectId, setNotice]);

  /**
   * latent 节点的「上传 latent」——**存进本站的 latent 库，不直传 RunningHub**。
   *
   * 徐先定的口径：画布上「把东西放进来」全都不该碰另一家平台的 Key，
   * Key 只在「生成节点选了 RunningHub 引擎、点发送」那一刻才需要。
   * 没配 Key 就直传的话，节点当场就废了，而文件从头到尾还在用户自己电脑上。
   *
   * 存下来拿到的是 `asset:<id>`（和「从 latent 库里挑一份」拿到的值同一种形状），
   * 提交生成时服务端读盘重传给工作流 —— 见 `resolveLatentValues()`。
   * 顺带一个好处：上传过的 latent 也会出现在 latent 库里，能再被别的节点挑走。
   */
  const uploadLatentFile = useCallback(async (id: string, file: File) => {
    patch(id, { status: 'uploading', result: undefined });
    try {
      const form = new FormData();
      form.set('file', file);
      const body = await apiPost<{ id: string; value: string }>(`/api/projects/${projectId}/latents`, form);
      if (!body?.value) throw new Error('没能存进项目 latent 库，请重试。');
      patch(id, { status: 'idle', remoteFile: body.value, result: '已存入资产' });
    } catch (error) {
      patch(id, { status: 'failed', result: error instanceof Error ? error.message : '存入失败' });
    }
  }, [patch, projectId]);


  /**
   * 把导演台视口里那一帧存成**本项目下的一张资产**，挂回这个节点上。
   *
   * 走 `/api/tools/archive`（实用工具入库那条路）而不是 RunningHub 的上传：
   * 那条路要配好另一家平台的 Key，还会把一张构图草图传到别人的服务器上 ——
   * 而这里要的只是一个「画布显示得出来、服务端取得到字节」的地址。
   * 提交生成时服务端按 `/api/assets/...` 读盘重传（`lib/referenceImages.ts`），
   * 所以不必在这里先传一遍。
   *
   * 图和提示词**一起写**：两者描述的是同一个机位，分两次写就会出现
   * 「图换了、词还是上一次的」——那种错在界面上看不出来。
   */
  const saveDirectorShot = useCallback(async (id: string, dataUrl: string, scene: DirectorScene) => {
    const blob = await (await fetch(dataUrl)).blob();
    const body = await apiPost<{ items: { id: string; url: string; name: string }[] }>(
      '/api/tools/archive',
      buildArchiveForm([{ name: '导演台参考图.png', blob, note: '3D 导演台 · 构图参考图' }], projectId),
    );
    const saved = body.items?.[0];
    if (!saved) throw new Error('参考图没能存进项目，请重试。');
    patch(id, {
      imageUrl: saved.url,
      directorScene: scene,
      directorPrompt: compositionPrompt(scene),
      label: `导演台 · ${describeShot(scene.camera)}`,
      status: 'idle',
      result: '已存为参考图',
    });
    setNotice('构图参考图已存到这个节点上');
    setDirectorFor(null);
  }, [patch, projectId, setNotice]);

  /**
   * 首尾帧节点该从哪段视频取帧。
   *
   * 顺序有讲究：**自己带的本地文件优先于上游，本地 blob 优先于远端地址**。
   * 后者是跨域那道坎 —— `blob:` 与本站的资产地址一定是同源的，画进 canvas 不会被拦；
   * 而 RunningHub 那个远端地址没有 CORS 头时，取帧会直接失败（失败原因在 `videoFrames` 里说清）。
   */
  const frameSourceOf = useCallback((node: Node<NodeData>): string => {
    const own = String(node.data.videoUrl || node.data.videoRemoteUrl || '').trim();
    if (own) return own;
    const feeder = sources(node.id).find(item => item.data.kind === 'video-input' || item.data.kind === 'video-generate');
    if (!feeder) return '';
    if (feeder.data.kind === 'video-input') return String(feeder.data.videoUrl || feeder.data.videoRemoteUrl || '').trim();
    return String(feeder.data.resultUrl || '').trim();
  }, [sources]);

  /**
   * 提取首帧与尾帧：抽两张 → 各存一份资产 → 落到节点上。
   *
   * 抽出来要**存进项目**，而不是只给个本地地址：提交生成时服务端按 `/api/assets/...`
   * 读盘取字节再重传（`lib/referenceImages.ts`），存一份就够。
   * 以前这一步是往 RunningHub 传的 —— 那条路要另一家平台的 Key，没配的人连「取两帧」
   * 都做不了，而这跟取帧本身毫无关系。
   *
   * `srcOverride` 给「刚在卡片上选完视频」那条路用：那一刻 `patch` 写下去的地址还没进
   * 闭包里的 `nodes`，不显式传进来就会读到「还没接视频」。
   *
   * 失败时把原因原样写到卡片状态上（`videoFrames` 里的说法已经能指回下一步动作），
   * 不笼统报「提取失败」——那句话用户什么也做不了。
   */
  const extractFrames = useCallback(async (id: string, srcOverride?: string) => {
    const node = nodesRef.current.find(item => item.id === id);
    if (!node) return;
    const src = srcOverride || frameSourceOf(node);
    if (!src) {
      patch(id, { status: 'failed', result: '先接一段视频（视频输入 / 视频生成），或在参数条里选一个本地视频' });
      return;
    }
    patch(id, { status: 'running', result: '正在提取首尾帧…' });
    try {
      const pair = await extractEdgeFrames(src);
      const [first, last] = await Promise.all([
        uploadFrameImage(pair.first.blob, 'first-frame.jpg', projectId),
        uploadFrameImage(pair.last.blob, 'last-frame.jpg', projectId),
      ]);
      patch(id, {
        status: 'idle',
        /** 记下这一轮用的是哪段视频：上游重新生成之后地址会变，靠它判断「手上的帧是旧的」。 */
        frameSource: src,
        firstFrameUrl: first.url, firstFrameFile: first.fileName,
        lastFrameUrl: last.url, lastFrameFile: last.fileName,
        result: `已提取 ${pair.first.width}×${pair.first.height}${pair.duration ? ` · ${pair.duration.toFixed(1)}s` : ''}`,
      });
      setNotice('首尾帧已提取');
    } catch (error) {
      patch(id, { status: 'failed', result: error instanceof Error ? error.message : '提取失败' });
    }
  }, [frameSourceOf, patch, projectId, setNotice]);

  /**
   * 首尾帧节点自己带的那段视频：存成资产，然后**立刻**接着提取。
   *
   * 不复用 `archiveMedia`：那个会顺手把首帧写进 `previewUrl` / `remoteFile`
   * （视频输入节点靠那两个字段当参考图），而首尾帧节点的两张图各有自己的四个字段，
   * 混着写会出现「卡片显示尾帧、提交的是首帧」。
   */
  const uploadFrameVideo = useCallback(async (id: string, file: File) => {
    const blobUrl = URL.createObjectURL(file);
    patch(id, { status: 'uploading', videoUrl: blobUrl, result: undefined, frameSource: undefined });
    try {
      const body = await apiPost<{ items: { url: string }[] }>(
        '/api/tools/archive',
        buildArchiveForm([{ name: file.name || 'frame-source.mp4', blob: file, note: '首尾帧源视频' }], projectId),
      );
      const url = String(body.items?.[0]?.url || '');
      if (!url) throw new Error('这段视频没能存进项目，请重试。');
      /** 地址换成资产地址（blob 刷新就没了）；抽帧读的就是它，同源、拿得到像素。 */
      patch(id, { status: 'idle', videoUrl: url, videoRemoteUrl: url, videoRemoteFile: url });
      await extractFrames(id, url);
    } catch (error) {
      patch(id, { status: 'failed', result: error instanceof Error ? error.message : '存入资产失败' });
    }
  }, [extractFrames, patch, projectId]);

  /**
   * Image / video files arriving from a drop or the clipboard become input nodes: they are
   * placed next to whatever they were dropped on (or to the left of the selected node),
   * **stored as a project asset** (`archiveMedia`, no third-party key needed), and wired up.
   * Dropping onto an empty input node of the same kind refills that node instead.
   */
  const pointFor = useCallback((screen?: { x: number; y: number }) => screenToFlowPosition(
    screen ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  ), [screenToFlowPosition]);

  /** Generic media-drop handler shared by image and video inputs. `typeTest` filters which files
   *  this call accepts; the created node kind is `kind`. */
  const addMedia = useCallback((files: File[], options: { screen?: { x: number; y: number }; nodeId?: string | null; kind: NodeKind; typeTest: (file: File) => boolean }) => {
    const { screen, kind, typeTest } = options;
    const filtered = files.filter(typeTest);
    if (!filtered.length) return;
    const hitId = options.nodeId ?? (screen && typeof document !== 'undefined'
      ? (document.elementFromPoint(screen.x, screen.y)?.closest('.react-flow__node') as HTMLElement | null)?.dataset.id || null
      : null);
    const hit = hitId ? nodes.find(node => node.id === hitId) : undefined;
    /** An empty input node of the same kind under the cursor is a drop target, not a place to add another node. */
    const hasMedia = (node: Node<NodeData>) => kind === 'image'
      ? !!(node.data.imageUrl || node.data.previewUrl)
      : kind === 'audio-input'
        ? !!(node.data.audioUrl || node.data.audioRemoteUrl)
        : !!(node.data.videoUrl || node.data.videoRemoteUrl);
    const reuse = hit?.data.kind === kind && !hasMedia(hit) ? hit : null;
    const generators = nodes.filter(node => isGeneratorKind(node.data.kind));
    const linkTarget = hit && canConnect(kind, hit.data.kind)
      ? hit.id
      : generators.length === 1 ? generators[0].id : null;

    const count = nodes.filter(node => node.data.kind === kind).length;
    /** Dropping onto a card that takes this kind parks the new cards in a column on its left,
     *  so the card you dropped on keeps showing its own inputs instead of being covered. */
    const asInput = !!(hit && canConnect(kind, hit.data.kind) && hit.data.kind !== kind);
    const existingInputs = asInput && hit ? edges.filter(edge => edge.target === hit.id).length : 0;
    const created: { id: string; file: File }[] = [];
    const added: Node<NodeData>[] = [];
    /** Clipboard paste has no cursor, so those nodes land in the middle of the viewport. */
    const point = pointFor(screen);
    const noun = kind === 'image' ? '参考图' : kind === 'audio-input' ? '音频' : '视频';
    filtered.forEach((file, index) => {
      if (reuse && index === 0) {
        created.push({ id: reuse.id, file });
        return;
      }
      const id = crypto.randomUUID();
      created.push({ id, file });
      added.push({
        id,
        type: 'frame',
        position: asInput && hit
          ? { x: hit.position.x - 300, y: hit.position.y + (existingInputs + index) * 92 }
          : { x: point.x + index * 26, y: point.y + index * 26 },
        data: { kind, label: `${noun} ${count + index + 1}` },
      });
    });
    if (added.length) setNodes(ns => [...ns, ...added]);

    if (linkTarget) {
      setEdges(es => created.reduce((next, entry) => {
        if (next.some(edge => edge.source === entry.id && edge.target === linkTarget)) return next;
        return addEdge({ id: `${entry.id}-${linkTarget}`, source: entry.id, target: linkTarget, type: 'default', animated: true } as Edge, next);
      }, es));
    } else if (generators.length > 1) {
      setNotice(`已添加${noun}输入节点 · 画布里有多个生成节点，请手动连线`);
    }
    created.forEach(entry => void archiveMedia(entry.id, entry.file));
    if (added.length) setSelected(added[added.length - 1].id);
  }, [archiveMedia, edges, nodes, pointFor, setEdges, setNodes]);

  /** Image files become 图片输入 nodes. */
  const addImages = useCallback((files: File[], options: { screen?: { x: number; y: number }; nodeId?: string | null }) =>
    addMedia(files, { ...options, kind: 'image', typeTest: file => file.type.startsWith('image/') }),
  [addMedia]);

  /** Video files become 视频输入 nodes. */
  const addVideos = useCallback((files: File[], options: { screen?: { x: number; y: number }; nodeId?: string | null }) =>
    addMedia(files, { ...options, kind: 'video-input', typeTest: file => file.type.startsWith('video/') }),
  [addMedia]);

  /** Audio files become 音频输入 nodes. */
  const addAudios = useCallback((files: File[], options: { screen?: { x: number; y: number }; nodeId?: string | null }) =>
    addMedia(files, { ...options, kind: 'audio-input', typeTest: file => file.type.startsWith('audio/') }),
  [addMedia]);

  /**
   * 把文字放进画布：直接落成**文本节点**并连到生成节点。
   *
   * 两条路都走它：粘一段纯文本进来，或者右键「上传文件」挑了一个文档（`addUploads`）。
   * 剪贴板里是一段纯文本时用户的意图基本只有一种 —— 那就是提示词；
   * 让他「新建文本节点 → 打开面板 → 粘贴 → 连线」走四步没有意义。
   * 落点规则与 `addMedia` 一致：选中了空文本节点就填进去，否则新建并连到唯一的生成节点。
   */
  const addText = useCallback((values: string[], options: { screen?: { x: number; y: number }; nodeId?: string | null } = {}) => {
    const list = values.map(value => String(value ?? '')).filter(value => value.trim());
    if (!list.length) return;
    const hitId = options.nodeId ?? (options.screen && typeof document !== 'undefined'
      ? (document.elementFromPoint(options.screen.x, options.screen.y)?.closest('.react-flow__node') as HTMLElement | null)?.dataset.id || null
      : null);
    const hit = hitId ? nodes.find(node => node.id === hitId) : undefined;
    /** 空的文本节点就是复用目标，与 `addMedia` 里「同类型的空节点」同一个道理。 */
    const reuse = hit?.data.kind === 'text' && !String(hit.data.text || '').trim() ? hit : null;
    const generators = nodes.filter(node => isGeneratorKind(node.data.kind));
    const linkTarget = hit && canConnect('text', hit.data.kind)
      ? hit.id
      : generators.length === 1 ? generators[0].id : null;
    /** 落在生成节点左边一整列（照 `addMedia` 的规矩）：新节点不该盖住它要连的那个节点。 */
    const asInput = !!(hit && canConnect('text', hit.data.kind) && hit.data.kind !== 'text');
    const existing = asInput && hit ? edges.filter(edge => edge.target === hit.id).length : 0;
    const point = pointFor(options.screen);
    const created: string[] = [];
    const added: Node<NodeData>[] = [];
    list.forEach((value, index) => {
      if (reuse && index === 0) {
        patch(reuse.id, { kind: 'text', text: value, status: 'idle' });
        created.push(reuse.id);
        return;
      }
      const id = crypto.randomUUID();
      created.push(id);
      added.push({
        id,
        type: 'frame',
        position: asInput && hit
          ? { x: hit.position.x - 300, y: hit.position.y + (existing + index) * 92 }
          : { x: point.x + index * 26, y: point.y + index * 26 },
        data: { ...newNodeData('text'), kind: 'text', text: value, status: 'idle' },
      });
    });
    if (added.length) setNodes(ns => [...ns, ...added]);
    if (linkTarget) {
      setEdges(es => created.reduce((next, id) => {
        if (next.some(edge => edge.source === id && edge.target === linkTarget)) return next;
        return addEdge({ id: `${id}-${linkTarget}`, source: id, target: linkTarget, type: 'default', animated: true } as Edge, next);
      }, es));
    } else if (generators.length > 1) {
      setNotice('已添加文本节点 · 画布里有多个生成节点，请手动连线');
    }
    setSelected(created[created.length - 1]);
  }, [edges, nodes, patch, pointFor, setEdges, setNodes, setNotice]);

  /** 右键「上传文件」用的那个 input。原生 picker 才能拿到**本机文件名**——
   *  扩展名只能从文件名取（`.docx` 与 `.txt` 的 `type` 都是空串），自绘对话框拿不到。 */
  const uploadInput = useRef<HTMLInputElement | null>(null);
  /** 右键点在哪儿：文件选回来之后按这个点落节点（系统对话框不会告诉我们位置）。 */
  const uploadAnchor = useRef<{ x: number; y: number } | null>(null);
  const openUpload = useCallback((at?: { x: number; y: number }) => {
    uploadAnchor.current = at ?? null;
    setMenu(null);
    const el = uploadInput.current;
    if (!el) return;
    /* 清掉 value：同一个文件连选两次也要有反应（不清的话第二次不触发 change）。 */
    el.value = '';
    el.click();
  }, []);

  /**
   * 「上传文件」进来的一批文件：**按类型分流**，一种类型一套节点。
   *
   * 图片 / 视频 / 音频各归各的输入节点（与拖进来、粘进来同一条路）；
   * 文档（txt / md / json / csv / srt / docx）读成文字落成**文本节点** ——
   * 用户挑的是「一段文字素材」，再让他自己去建文本节点、粘一遍没有意义。
   * 认不出的格式要**说出来**：静默什么都不发生是最难查的一种反馈。
   */
  const addUploads = useCallback((files: File[], at?: { x: number; y: number }) => {
    const place = at ? { screen: at } : {};
    const images = files.filter(file => file.type.startsWith('image/'));
    const videos = files.filter(file => file.type.startsWith('video/'));
    const audios = files.filter(file => file.type.startsWith('audio/'));
    const docs = files.filter(isDocumentFile);
    if (images.length) addImages(images, place);
    if (videos.length) addVideos(videos, place);
    if (audios.length) addAudios(audios, place);
    if (docs.length) {
      void Promise.all(docs.map(file => readDocumentText(file).then(text => ({ file, text }))))
        .then(results => {
          const texts = results.map(item => String(item.text || '')).filter(text => text.trim());
          if (texts.length) addText(texts, place);
          const empty = results.filter(item => !String(item.text || '').trim()).map(item => item.file.name);
          if (empty.length) setNotice(`${empty.join('、')} 里没读出文字（空文档，或者格式认不出）。`);
        });
    }
    const taken = new Set([...images, ...videos, ...audios, ...docs]);
    const skipped = files.filter(file => !taken.has(file));
    if (skipped.length) {
      setNotice(`这几个文件认不出类型（现在收图片 / 视频 / 音频 / 文本与 Word 文档）：${skipped.map(file => file.name).join('、')}`);
    }
  }, [addAudios, addImages, addText, addVideos, setNotice]);

  /**
   * 从资产库往画布里放一个资产（左轨「资产」浮层里点出来的那一件）。
   *
   * 落点规则与**拖文件进来**（`addMedia`）完全一致：选中了同类型的空节点就填进去，
   * 否则新建并连到唯一的生成节点。
   *
   * 唯一的区别是**不上传** —— 这里只写本站资产地址（`/api/assets/...`），卡片当场就能预览；
   * 传到 RunningHub 那一步由服务端在**提交生成时**做（`lib/referenceImages.ts` 读盘重传）。
   * 以前这两件事是绑在一起的，于是「从库里挑一张已经有的图」也得等一次上传。
   */
  const addAssetItem = useCallback((item: CanvasAssetItem) => {
    const kind: NodeKind = item.type === 'image' ? 'image'
      : item.type === 'video' ? 'video-input'
        : item.type === 'audio' ? 'audio-input' : 'latent';
    const hit = selected ? nodes.find(node => node.id === selected) : undefined;
    /** 与 `addMedia` 里同一个判断，只多一种 latent：它没有媒体地址，值是 `remoteFile`。 */
    const filled = (node: Node<NodeData>) => kind === 'image'
      ? !!(node.data.imageUrl || node.data.previewUrl)
      : kind === 'audio-input'
        ? !!(node.data.audioUrl || node.data.audioRemoteUrl)
        : kind === 'video-input'
          ? !!(node.data.videoUrl || node.data.videoRemoteUrl)
          : !!String(node.data.remoteFile || '').trim();
    const reuse = hit && hit.data.kind === kind && !filled(hit) ? hit : null;
    const generators = nodes.filter(node => isGeneratorKind(node.data.kind));
    const linkTarget = hit && canConnect(kind, hit.data.kind)
      ? hit.id
      : generators.length === 1 ? generators[0].id : null;
    const part: Partial<NodeData> = { kind, label: item.name, status: 'idle', result: '来自资产库' };
    if (kind === 'image') part.imageUrl = item.url;
    else if (kind === 'video-input') part.videoUrl = item.url;
    else if (kind === 'audio-input') part.audioUrl = item.url;
    /** latent 也不上传：它的值就是「库里那一份」的引用，与 latent 节点上那个下拉同一个形态。 */
    else part.remoteFile = `${latentAssetPrefix}${item.id}`;
    /*
     * 视频额外记下「它是哪次生成的、那次归档了哪几份 latent」（2026-10-02）。
     * 有了这个，画布上接一个「Latent 中转」就能拿它续接下一段 —— 不用回到原来那张画布
     * 去找把它跑出来的那个视频节点（它可能已经删了，也可能在别的项目里）。
     * 🔴 必须**当场记**：画布上的 `latents` 只有当前项目那一份，事后再查就查不到了。
     */
    if (kind === 'video-input' && item.sourceTaskId) {
      part.sourceTaskId = item.sourceTaskId;
      if (item.relayLatents.length) part.relayLatents = item.relayLatents;
    }
    /** 有 latent 才补这一句 —— 这是「接下去点哪儿」，不是装饰。 */
    const relayNote = kind === 'video-input' && item.relayLatents.length
      ? ` · 这次生成归档了 ${item.relayLatents.length} 份 latent，接一个「Latent 中转」就能续接`
      : '';

    if (reuse) {
      patch(reuse.id, part);
      setSelected(reuse.id);
      setNotice(`已把「${item.name}」放进选中的节点${relayNote}`);
      return;
    }
    const id = crypto.randomUUID();
    /** 落在生成节点左边一整列（照 `addMedia` 的规矩）：新节点不该盖住它要连的那个节点。 */
    const asInput = !!(hit && canConnect(kind, hit.data.kind) && hit.data.kind !== kind);
    const existing = asInput && hit ? edges.filter(edge => edge.target === hit.id).length : 0;
    const point = pointFor();
    setNodes(ns => [...ns, {
      id,
      type: 'frame',
      position: asInput && hit
        ? { x: hit.position.x - 300, y: hit.position.y + existing * 92 }
        : { x: point.x, y: point.y },
      data: part,
    }]);
    if (linkTarget) {
      setEdges(es => [...es, {
        id: `${id}-${linkTarget}`, source: id, target: linkTarget, type: 'default', animated: true,
      } as Edge]);
      setNotice(`已把「${item.name}」放进画布${relayNote}`);
    } else if (generators.length > 1) {
      setNotice(`已添加「${item.name}」 · 画布里有多个生成节点，请手动连线`);
    } else {
      setNotice(`已把「${item.name}」放进画布${relayNote}`);
    }
    setSelected(id);
  }, [edges, nodes, patch, pointFor, selected, setEdges, setNodes, setNotice]);

  /*
   * 内置浏览器送来的图 —— 网页上右键「发送到画布」、面板里的「本页图片」、
   * 以及从网页上直接**拖**到画布上，三条路最终都汇到 `browser:image` 这一个事件。
   *
   * 区别只在落点：
   * - 前两条没有「松手在哪」这个概念，落点**偏左**而不是正中 —— 面板自己占着右边那一列，
   *   放在正中会被面板盖住，用户看到的就是「图进画布了但看不见」。
   * - 拖拽那条路带落点，就用松手的位置（见 `browserDropAt`）。
   */
  useEffect(() => {
    const offImage = onBrowserImage(image => {
      /*
       * 复制一份字节再建 File：IPC 过来的那份是 `Uint8Array<ArrayBufferLike>`
       * （TS 5.7 起这个类型带 buffer 的泛型参数，可能是 SharedArrayBuffer），
       * 而 `File` 只收 `ArrayBuffer`。复制之后类型落回确定值，也断开了和 IPC 缓冲区的共享。
       */
      const file = new File([new Uint8Array(image.bytes)], image.name, { type: image.mime });
      /*
       * 落点只在「这张图确实是刚拖的那张」时才用：取图是异步的，
       * 期间用户完全可能又用右键放了一张别的图进来 —— 那时两条路的落点会串。
       * 认 `image.url`（主进程取的就是同一个地址），并给一个 30 秒的时效，
       * 免得一次失败的取图把落点挂在那儿污染后面所有的图。
       */
      const pending = browserDropAt.current;
      const fresh = pending && pending.url === image.url && Date.now() - pending.at < 30_000;
      if (fresh) browserDropAt.current = null;
      addImages([file], {
        screen: fresh && pending
          ? { x: pending.x, y: pending.y }
          : { x: Math.round(window.innerWidth * 0.32), y: Math.round(window.innerHeight * 0.42) },
      });
      setNotice(`已把「${image.name}」放进画布`);
    });
    /* 取图失败必须说出来：点了一张图、画布上没动静，是用户最难自己查明白的一类问题。 */
    const offError = onBrowserImageError(message => setNotice(message));
    /*
     * 从网页上拖过来的图：主进程只告诉「拖的是哪张 + 松手在哪」，
     * 字节还是要走 `grabBrowserImage()`（渲染层 fetch 会被同源策略挡住），
     * 所以这里先把落点记下来，等上面那条 `onBrowserImage` 收到图时再取用。
     */
    const offDrop = onBrowserImageDrop(drop => {
      browserDropAt.current = { url: drop.url, x: drop.x, y: drop.y, at: Date.now() };
      grabBrowserImage(drop.url);
    });
    return () => {
      offImage();
      offError();
      offDrop();
    };
  }, [addImages]);

  /**
   * 复制选中的节点（以及它们之间的连线）到内部剪贴板。
   * 走 `copy`/`paste` 事件而不是 keydown：这样「光标在输入框里」这类情况天然被 `isTyping` 挡掉，
   * 也不会去劫持用户从别处复制的文本。
   */
  const copyNodes = useCallback(() => {
    const picked = nodes.filter(node => node.selected);
    if (!picked.length) return 0;
    const ids = new Set(picked.map(node => node.id));
    clipboard.current = {
      nodes: picked.map(node => ({ ...node, data: cloneNodeData(node.data), selected: false })),
      // 只带「两头都在选中集合里」的连线，避免粘出一条指向不存在的节点的悬空边
      edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(edge => ({ ...edge })),
    };
    return picked.length;
  }, [edges, nodes]);

  /**
   * 把剪贴板里的节点粘到 `anchor`（不传就用鼠标位置，再没有就整体右下偏移），
   * 并选中粘出来的这批。
   */
  const pasteNodes = useCallback((anchor?: { x: number; y: number }) => {
    const source = clipboard.current;
    if (!source?.nodes.length) return 0;
    const map = new Map<string, string>();
    const created = source.nodes.map(node => {
      const id = crypto.randomUUID();
      map.set(node.id, id);
      return { ...node, id, selected: true, data: cloneNodeData(node.data) };
    });
    const minX = Math.min(...source.nodes.map(node => node.position.x));
    const minY = Math.min(...source.nodes.map(node => node.position.y));
    const at = anchor
      || (pointer.current ? screenToFlowPosition(pointer.current) : { x: minX + PASTE_OFFSET, y: minY + PASTE_OFFSET });
    const placed = created.map((node, index) => ({
      ...node,
      position: {
        x: at.x + (source.nodes[index].position.x - minX),
        y: at.y + (source.nodes[index].position.y - minY),
      },
    }));
    setNodes(ns => [...ns.map(node => ({ ...node, selected: false })), ...placed]);
    setEdges(es => [...es, ...source.edges.map(edge => ({
      ...edge,
      id: `${map.get(edge.source)}-${map.get(edge.target)}`,
      source: map.get(edge.source) as string,
      target: map.get(edge.target) as string,
    }))]);
    setSelected(placed[placed.length - 1].id);
    return placed.length;
  }, [screenToFlowPosition, setEdges, setNodes]);

  /** Ctrl+D：不经过系统剪贴板，复制选中节点后直接在原地旁边粘一份。 */
  const duplicateNodes = useCallback(() => {
    const count = copyNodes();
    if (!count) return;
    const source = clipboard.current;
    if (!source?.nodes.length) return;
    const minX = Math.min(...source.nodes.map(node => node.position.x));
    const minY = Math.min(...source.nodes.map(node => node.position.y));
    if (pasteNodes({ x: minX + DUPLICATE_OFFSET, y: minY + DUPLICATE_OFFSET })) {
      setNotice(`已原地复制 ${count} 个节点`);
    }
  }, [copyNodes, pasteNodes]);

  /** Ctrl+X：复制到内部剪贴板后把原件删掉；连线跟着一起走。 */
  const cutNodes = useCallback(() => {
    const count = copyNodes();
    if (!count) return;
    const ids = new Set(nodes.filter(node => node.selected).map(node => node.id));
    setNodes(ns => ns.filter(node => !ids.has(node.id)));
    setEdges(es => es.filter(edge => !ids.has(edge.source) && !ids.has(edge.target)));
    setSelected(null);
    setNotice(`已剪切 ${count} 个节点 · Ctrl+V 粘贴`);
  }, [copyNodes, nodes, setEdges, setNodes]);

  /**
   * 删掉一批节点。
   *
   * 由调用方决定删哪些：右键菜单给的是「当前选中的这批」，而从画布选区删，
   * 走的还是 React Flow 自己的 `deleteKeyCode` —— 两条路删出来的结果必须一致，
   * 所以这里不做「要不要连坐」的判断，只按传进来的 id 集合走。
   */
  const deleteNodes = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const gone = new Set(ids);
    setNodes(ns => ns.filter(node => !gone.has(node.id)));
    setEdges(es => es.filter(edge => !gone.has(edge.source) && !gone.has(edge.target)));
    if (selected && gone.has(selected)) setSelected(null);
    setNotice(ids.length > 1 ? `已删除 ${ids.length} 个节点` : '已删除节点');
  }, [selected, setEdges, setNodes]);

  /**
   * 让一颗节点「被选中并且看得见」（2026-10-02，历史浮层点一项时用）。
   *
   * 两件事都做才成立：
   * - `selected` 是 React Flow 节点上的那个标记（`.cv-node.selected` 读的就是它），
   *   画布自己的 `selected` state 只决定参数条挂在哪 —— 只设后者，画面上一点反应都没有；
   * - 节点在视口外时，光标选中也是看不见的，得把它挪到屏幕中间（**缩放不动**，
   *   突然拉近会让人失去方位感）。
   */
  const focusNode = useCallback((id: string) => {
    setNodes(ns => ns.map(node => ({ ...node, selected: node.id === id })));
    const target = nodesRef.current.find(node => node.id === id);
    if (!target) return;
    const view = getViewport();
    const zoom = view.zoom || 1;
    const w = (target.measured?.width || 240) * zoom;
    const h = (target.measured?.height || 140) * zoom;
    const x = (target.position?.x || 0) * zoom + view.x;
    const y = (target.position?.y || 0) * zoom + view.y;
    const inside = x > 40 && y > 40 && x + w < window.innerWidth - 40 && y + h < window.innerHeight - 40;
    if (!inside) {
      setCenter(
        (target.position?.x || 0) + (target.measured?.width || 240) / 2,
        (target.position?.y || 0) + (target.measured?.height || 140) / 2,
        { zoom, duration: 320 },
      );
    }
  }, [getViewport, setCenter, setNodes]);

  /** 拆掉一个节点上的所有连线，节点本身留着 —— 只想改接线的时候不用删了重建。 */
  const disconnectNode = useCallback((id: string) => {
    const count = edges.filter(edge => edge.source === id || edge.target === id).length;
    if (!count) { setNotice('这个节点上没有连线'); return; }
    setEdges(es => es.filter(edge => edge.source !== id && edge.target !== id));
    setNotice(`已断开 ${count} 条连线`);
  }, [edges, setEdges]);

  /**
   * 单键 X：断开连线。
   *
   * 从最具体到最宽泛三级兜底，是因为「用户按下 X 时到底选中了什么」有三种可能，
   * 而任何一种都该有反应 —— 默默什么都不做的话，用户只会以为快捷键坏了：
   *
   * 1. 选中了连线 → 只拆这几条，节点一个不动；
   * 2. 没选连线但选中了节点 → 拆掉这些节点身上的线，节点留着（跟右键菜单里
   *    「断开全部连线」一个意思，快捷键只是更快）；
   * 3. 什么都没选 → 说一句要先选什么。
   *
   * 走 `edges` 而不是 React Flow 的 `onSelectionChange`：这里只需要「按下那一刻
   * 哪些是选中的」，多一个订阅反而会让这个 callback 每次框选都重建。
   */
  const disconnectSelection = useCallback(() => {
    const picked = edges.filter(edge => edge.selected);
    if (picked.length) {
      const gone = new Set(picked.map(edge => edge.id));
      setEdges(es => es.filter(edge => !gone.has(edge.id)));
      setNotice(gone.size > 1 ? `已断开 ${gone.size} 条连线` : '已断开连线');
      return;
    }
    const targets = nodes.filter(node => node.selected);
    if (targets.length) {
      const ids = new Set(targets.map(node => node.id));
      const count = edges.filter(edge => ids.has(edge.source) || ids.has(edge.target)).length;
      if (!count) { setNotice('选中的节点上没有连线'); return; }
      setEdges(es => es.filter(edge => !ids.has(edge.source) && !ids.has(edge.target)));
      setNotice(`已断开 ${count} 条连线`);
      return;
    }
    setNotice('先点一条连线，或选中一个节点，再按 X 断开');
  }, [edges, nodes, setEdges]);

  /**
   * 选中两个节点后按 `I`（或右键菜单里的「连接」）直接连起来 —— 不用去拖端口。
   *
   * 这里唯一要想清楚的是**方向**，因为用户只说了「这两连线」，没说谁接谁：
   *
   * 1. 只有一个方向合法（绝大多数配对）→ 取那一个，没什么可犹豫的；
   * 2. 两个方向都合法 —— 只有 `params → params` 和 `latent-relay → latent-relay`
   *    这两类串联 -> 按画布上的左右站位，左边的当上游。这两条链本来就是从左往右摆的，
   *    跟用户心里那个方向一致；
   * 3. 两个方向都不合法 → 报 `connectionHint`，跟拖线接不上时是同一套说法。
   *
   * 剩下两道闸：已经连上的不重复连（`addEdge` 自己也会去重，但那里是静默跳过，
   * 用户按了没反应会以为快捷键坏了，所以这里提前说一句）；会把上游串回来的直接挡掉。
   */
  const connectSelected = useCallback(() => {
    const picked = nodes.filter(node => node.selected);
    if (picked.length !== 2) {
      setNotice(picked.length < 2
        /* 左键在空白处直接拖就能拉框（selectionOnDrag + SelectionMode.Partial，见 ReactFlow 上的注释），
           不必再按住 Shift —— 2026-09-26 之前这里写的是「Shift+拖拽框选」，会让人以为不按 Shift 框不动。 */
        ? '先选中两个节点（单击，或在空白处拖出框把两个一起框住；Shift 点选可以追加），再按 I 连接'
        : `请只选中两个节点，现在选了 ${picked.length} 个`);
      return;
    }
    const [a, b] = picked;
    const forward = canConnect(a.data.kind, b.data.kind);
    const backward = canConnect(b.data.kind, a.data.kind);
    if (!forward && !backward) { setNotice(connectionHint(b.data.kind)); return; }
    let source = forward ? a : b;
    let target = forward ? b : a;
    if (forward && backward) {
      const [left, right] = a.position.x <= b.position.x ? [a, b] : [b, a];
      source = left;
      target = right;
    }
    if (edges.some(edge => edge.source === source.id && edge.target === target.id)) {
      setNotice('这两个节点已经连上了');
      return;
    }
    /* target 已经是 source 的上游了 —— 补上这条就成一个圈，越权的事交给用户自己拖。 */
    if (isUpstreamOf(edges, source.id, target.id)) {
      setNotice('这样会把上游串成一个环，已跳过');
      return;
    }
    const name = (node: Node<NodeData>) => String(node.data.label || NODE_META[node.data.kind as NodeKind]?.label || node.data.kind);
    setEdges(es => addEdge(
      { id: `${source.id}-${target.id}`, source: source.id, target: target.id, type: 'default', animated: true } as Edge,
      es,
    ));
    setNotice(`已连接 ${name(source)} → ${name(target)}`);
  }, [edges, nodes, setEdges]);

  /**
   * 自动排列（L）：顺着连线把节点分成一层一层的，同一层竖着排。
   *
   * 刻意不引布局库：这里真正需要的只是「按上下游关系摊开」，几行松弛法就够；
   * 真上 dagre 那种最优布局，图是更匀了，但用户自己摆的相对位置会被大幅推倒，
   * 一次「自动整理」之后没人还想按第二次。
   *
   * 同一层里按**当前的 y** 排序：用户排过的上下顺序是有意思的信息，别为了好看打乱它。
   */
  /**
   * 绕过 / 取消绕过（2026-09-29）。
   *
   * 一次作用于**当前选中的全部节点** —— 画布上绕过常常是一批一起绕
   * （比如把一整段后处理都跳过去试试原片），一个个点太慢。
   *
   * 🔴 切完**必须说一句**：卡片上那个「绕过」角标只在这一个节点上，
   * 而这一次可能动了五六个，不看提示的人不知道自己刚才改了什么。
   */
  const toggleBypass = useCallback((ids?: string[]) => {
    const pickedIds = ids && ids.length
      ? ids
      : nodesRef.current.filter(node => node.selected).map(node => node.id);
    if (!pickedIds.length) { setNotice('先选中一个节点，再按 B 绕过它'); return; }
    const set = new Set(pickedIds);
    const picked = nodesRef.current.filter(node => set.has(node.id));
    /* 混合状态（有的绕过、有的没）按「有没绕过的就全部绕过」定方向。 */
    const turnOn = picked.some(node => !node.data.bypassed);
    setNodes(ns => ns.map(node => (set.has(node.id)
      ? { ...node, data: { ...node.data, bypassed: turnOn } }
      : node)));
    setNotice(turnOn
      ? `已绕过 ${picked.length} 个节点 —— 它不做自己那份活，上游的值直接传下去（按 B 取消）`
      : `已取消绕过 ${picked.length} 个节点`);
  }, [setNodes]);

  const autoLayout = useCallback(() => {
    /* 在 setNodes 的 updater 里做完整件事：拿的是最新那一份 nodes，
       不会踩「刚加完节点立刻排、排的是上一帧」这种差一格的问题。 */
    setNodes(ns => {
      if (!ns.length) return ns;
      const ids = new Set(ns.map(node => node.id));
      /* 每层深度 = 上游深度 + 1。松弛法最多推 ns.length 轮：
         图里就算有环也停得下来，不会在这儿死循环。 */
      const depth = new Map(ns.map(node => [node.id, 0]));
      for (let pass = 0; pass < ns.length; pass += 1) {
        let moved = false;
        for (const edge of edges) {
          if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
          const next = (depth.get(edge.source) || 0) + 1;
          if (next > (depth.get(edge.target) || 0)) { depth.set(edge.target, next); moved = true; }
        }
        if (!moved) break;
      }
      const columns = new Map<number, Node<NodeData>[]>();
      for (const node of ns) {
        const level = depth.get(node.id) || 0;
        if (!columns.has(level)) columns.set(level, []);
        columns.get(level)?.push(node);
      }
      const placed = new Map<string, { x: number; y: number }>();
      const gapX = 140;
      const gapY = 44;
      let x = 0;
      for (const level of [...columns.keys()].sort((a, b) => a - b)) {
        const column = columns.get(level) || [];
        const width = Math.max(...column.map(node => node.measured?.width ?? 240));
        let y = 0;
        for (const node of [...column].sort((a, b) => a.position.y - b.position.y)) {
          placed.set(node.id, { x, y });
          y += (node.measured?.height ?? 150) + gapY;
        }
        x += width + gapX;
      }
      return ns.map(node => {
        const at = placed.get(node.id);
        return at ? { ...node, position: at } : node;
      });
    });
    setNotice('已按连线自动排列');
    /* 排完肯定有节点跑到视口外面，等这一帧画完再收拢，不然 fitView 量到的是旧位置。 */
    window.setTimeout(() => fitView({ duration: 300, padding: 0.2 }), 30);
  }, [edges, fitView, setNodes]);

  /**
   * Ctrl+C / Ctrl+V 复制粘贴节点；剪贴板里的**媒体文件**优先走「加输入节点」那条路
   * （图片 / 视频 / 音频各归各的节点），纯文本则落成文本节点。
   * 内部剪贴板只在当前页面有效，不往外写真实内容——避免和用户在别处复制的东西互相覆盖。
   */
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      if (isEditingField()) return;
      const count = copyNodes();
      if (!count) return;
      event.clipboardData?.setData('text/plain', `frame-nodes:${count}`);
      event.preventDefault();
      setNotice(`已复制 ${count} 个节点 · Ctrl+V 粘贴`);
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isEditingField()) return;
      /*
       * 按剪贴板里的**内容**决定落什么节点：
       * 图片 → 图片输入、视频 → 视频输入、音频 → 音频输入、纯文本 → 文本节点。
       * 以前只认图片，粘一段视频 / 音频进来什么都不会发生（连个提示都没有），
       * 粘一段文字更是直接掉进「没有可粘贴的节点」那条静默分支。
       */
      const files = Array.from(event.clipboardData?.files || []);
      const images = files.filter(file => file.type.startsWith('image/'));
      const videos = files.filter(file => file.type.startsWith('video/'));
      const audios = files.filter(file => file.type.startsWith('audio/'));
      if (images.length || videos.length || audios.length) {
        event.preventDefault();
        if (images.length) addImages(images, { nodeId: selected });
        if (videos.length) addVideos(videos, { nodeId: selected });
        if (audios.length) addAudios(audios, { nodeId: selected });
        return;
      }
      /*
       * 内部剪贴板要在**读 text/plain 之前**判掉：复制节点时我们自己也往剪贴板里
       * 写了 `frame-nodes:N` 这串文本，它显然不是用户想粘进去的提示词。
       */
      if (!clipboard.current?.nodes.length) {
        const text = String(event.clipboardData?.getData('text/plain') || '').trim();
        if (!text) return;
        event.preventDefault();
        addText([text], { nodeId: selected });
        return;
      }
      event.preventDefault();
      const count = pasteNodes();
      if (count) setNotice(`已粘贴 ${count} 个节点`);
    };
    window.addEventListener('copy', onCopy);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('paste', onPaste);
    };
  }, [addAudios, addImages, addText, addVideos, copyNodes, pasteNodes, selected]);

  /**
   * Ctrl+D 原地复制、Ctrl+X 剪切、Ctrl+S 保存。
   * 这三个没有对应的原生事件（Ctrl+D 是收藏、Ctrl+X 只在选中文本时有意义、
   * Ctrl+S 是「保存网页」），只能走 keydown，所以要自己用 `isEditingField()` 挡掉输入态。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      /*
       * 左轨那五张浮层开着时键盘归浮层：里面有输入框、下拉，还有「按 Esc 取消改名」。
       * 画布的单键快捷键（F / L / I）这时候再响应，等于在人家打字时凭空挪一下视图。
       * （React Flow 自己的删除键在下面的 JSX 里也一起摘掉了。）
       */
      if (overlay !== null) return;
      if (isEditingField()) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (key === 'd') { event.preventDefault(); duplicateNodes(); return; }
        if (key === 'x') { event.preventDefault(); cutNodes(); return; }
        /* Ctrl+S 走自动保存那个同样的函数。浏览器默认的「保存网页」在画布页毫无意义，
           不拦掉的话用户会以为按了就存下来了。 */
        if (key === 's') { event.preventDefault(); saveRef.current(); }
        return;
      }
      /* 带 Alt / Ctrl 的组合留给浏览器和 React Flow，这里只接单键。 */
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (key === 'f') { event.preventDefault(); fitView({ duration: 300, padding: 0.2 }); }
      else if (key === 'l') { event.preventDefault(); autoLayout(); }
      /* 选中两个节点直接连线。和 F / L 一样用不带修饰键的单键：画布上没有别的含义，
         套 Ctrl 反而更容易和浏览器自己的快捷键撞上。 */
      else if (key === 'i') { event.preventDefault(); connectSelected(); }
      /* X 断开、I 连接 —— 一对相反的动作，一个键一个方向。
         Ctrl+X（剪切）在上面的组合键分支里已经 return 了，单键 X 撞不上。 */
      else if (key === 'x') { event.preventDefault(); disconnectSelection(); }
      /* B = 绕过 / 取消绕过（2026-09-29）。跟 I（连）/ X（断）一样用不带修饰键的单键。
         选了多个就一起切：**只要有一个还没绕过就全部绕过**，再按一次全部取消 ——
         混合状态下按「多数」决定会让同一个键在不同时候做不同的事。 */
      else if (key === 'b') { event.preventDefault(); toggleBypass(); }
      /*
       * Tab = 正常模式 / 无遮挡模式来回切（2026-10-02 徐先）。
       *
       * 为什么必须 `preventDefault()`：Tab 是浏览器的焦点导航键，不拦住的话按一下
       * 焦点会跳到顶栏那颗「保存」上（无遮挡模式下它还在 DOM 里、只是没显示），
       * 再按一下有效果的就是别的键了。
       * 上面那两道守卫（`overlay !== null` / `isEditingField()`）是**现成的**：
       * 在提示词框里按 Tab 仍然该是跳焦点，不该把整个界面收掉。
       * Shift+Tab（反向导航）不接 —— 那一路留给浏览器。
       */
      else if (key === 'tab' && !event.shiftKey) {
        event.preventDefault();
        setAppearanceOpen(false);
        setZen(value => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [autoLayout, connectSelected, cutNodes, disconnectSelection, duplicateNodes, fitView, overlay, toggleBypass]);

  const hydrated = useMemo(() => nodes.map(node => {
    const isGenerator = isGeneratorKind(node.data.kind);
    /** 文本节点与优化节点：这两个的值要沿链现算（2026-09-29）。 */
    const isTextValue = isTextValueKind(node.data.kind);
    /** 只有视频生成节点有接续 / latent / 时长这一套，图片生成节点没有。 */
    const isVideoGenerator = node.data.kind === 'video-generate';
    const isImageOutput = node.data.kind === 'image-out';
    /** 首尾帧节点也要看上游：它取帧的那段视频多半是**别人**产出的。 */
    const isFrameExtract = node.data.kind === 'frame-extract';
    const isOutput = isImageOutput || node.data.kind === 'video';
    const upstream = isGenerator || isImageOutput || isFrameExtract ? sources(node.id) : [];
    /** Nodes wired straight into this one, in edge order — these become the visible input slots. */
    const direct = isGenerator || isOutput
      ? edges
        .filter(edge => edge.target === node.id)
        .map(edge => nodes.find(item => item.id === edge.source))
        .filter(Boolean) as Node<NodeData>[]
      : [];
    const feeder = isOutput ? direct.find(item => isGeneratorKind(item.data.kind)) : undefined;
    const workflowNode = upstream.find(item => item.data.kind === 'workflow');
    const imageUpstream = upstream.find(item => item.data.kind === 'image' && (item.data.imageUrl || item.data.previewUrl));
    /** 生成节点上游那个首尾帧节点：卡片上要画出「这次拿哪两张去生成」（2026-09-21）。 */
    const frameFeed = isGenerator ? upstream.find(item => item.data.kind === 'frame-extract') : undefined;
    const frameFeedPick = String(frameFeed?.data.framePick || 'both');
    /** 中转节点自己没值时透传上游 latent，这里算出它这一轮真正会提交的值。 */
    const chain = isLatentKind(node.data.kind) ? latentChainOf(node.id) : null;
    /** 文本 / 优化节点这一刻要交给下游的那段文字（不写库）。 */
    const textChain = isTextValue ? textChainOf(node.id) : null;
    /* 只有优化节点挑「左边那份媒体」—— 别的节点收图有 `imageUrls` 那条路（按数量收，不按一张）。 */
    const mediaChain = node.data.kind === 'prompt-optimize' ? describeInputOf(node.id) : null;

    /** 参数块自己不存工作流：往下游找它喂到的那个生成节点，问后者选的是哪一份。 */
    const paramWorkflow = node.data.kind === 'params' ? paramWorkflowOf(node.id) : null;
    return {
      ...node,
      data: {
        ...node.data,
        workflows,
        inputs: isGenerator
          ? inputSlots(direct, latents, node.data.continuationEnabled === 'on', edges, latentChainOf)
          : undefined,
        passthroughImage: isImageOutput ? String(imageUpstream?.data.imageUrl || imageUpstream?.data.previewUrl || '') : undefined,
        upstreamStatus: feeder ? String(feeder.data.status || 'idle') : undefined,
        upstreamResult: feeder ? String(feeder.data.result || '') : undefined,
        upstreamLabel: feeder ? String(feeder.data.label || NODE_META[feeder.data.kind as NodeKind]?.label || '') : undefined,
        /* 参考图计数：上传图(remoteFile) 与 图片生成/image-out(resultUrl) 都算，取能拿到地址的那一份。
           上限跟配置页能绑的槽位数同源（MAX_REFERENCE_IMAGES）。 */
        referenceCount: isGenerator
          ? upstream
            .filter(item => isReferenceSource(item.data.kind))
            .flatMap(item => referenceUrlsOf(item.data))
            .filter((url, index, all) => all.indexOf(url) === index)
            .slice(0, MAX_REFERENCE_IMAGES).length
          : undefined,
        relayValue: chain?.value || undefined,
        /** 这一轮真正会交出去的那几份（含自动配对的结果）—— 面板的下拉和卡片都用它。 */
        relayValues: chain?.values?.length ? chain.values : undefined,
        relayFrom: chain?.from || undefined,
        /** 取不到值时把原因也带上：卡片和面板要能把「链断了」和「没上传」分开说。 */
        relayBroken: chain?.broken || undefined,
        /* 文本链解析出来的三样：值、来自哪个上游、链成环了没有。同样只在 hydrated 里。 */
        textValue: textChain?.value || undefined,
        textFrom: textChain?.from || undefined,
        textBroken: textChain?.broken || undefined,
        /**
         * 左边那份媒体（看图 / 看视频反推用）：地址 + 来自哪个上游 + 是图还是视频。
         * 卡片据此显示缩略图、把文案与「运行」按钮的措辞切成反推那一套。
         */
        mediaValue: mediaChain?.url || undefined,
        mediaFrom: mediaChain?.from || undefined,
        mediaKind: mediaChain?.kind || undefined,
        /** 只有中转节点有：上游视频节点产出过的 latent，供「取自哪次生成」下拉用。 */
        latentPickOptions: node.data.kind === 'latent-relay' ? latentPickOptionsOf(node.id) : undefined,
        latentCount: isVideoGenerator
          ? node.data.continuationEnabled !== 'on'
            ? 0
            : upstream.filter(item => isLatentKind(item.data.kind) && item.data.latentEnabled !== 'off'
              && isTerminalLatent(item.id, upstream, edges) && latentChainOf(item.id).value).slice(0, LATENT_SLOTS).length
          : undefined,
        workflowSource: isGenerator && workflowNode
          ? `老画布的工作流节点 · ${String(workflowNode.data.workflowId || '未选择')}`
          : undefined,
        paramCount: isGenerator
          ? [...collectParamRows(node.id), ...(node.data.kind === 'app-generate' ? ((node.data.appRows || []) as ParamRow[]) : [])]
            .filter(row => row.enabled && row.value.trim()).length
          : undefined,
        /** 参数块的「从工作流里挑」要用的两样：候选取自哪份工作流，以及那句说明。 */
        paramWorkflowId: paramWorkflow?.workflowId || undefined,
        paramWorkflowNote: paramWorkflow?.note,
        latents,
        /* 断线与写值在**同一次事件**里做完：分两次 setState 也行（React 会批处理），
           但绝不能等一帧 —— 中间那一帧会「上游已经没了、自己那份还没写上去」，
           卡片上会闪一下空白。 */
        onText: (value: string, options?: { detachUpstream?: boolean }) => {
          if (options?.detachUpstream) detachUpstreamOf(node.id);
          patch(node.id, { text: value });
        },
        /*
         * 卡片上那个「选文件」按钮按**节点类型**分流：
         *   - 首尾帧：存视频 → 立刻抽两帧；
         *   - latent / latent 中转：传远端（见 `uploadLatentFile`，latent 没有本地归档这一档）；
         *   - 图片 / 视频 / 音频输入：存成本站资产，提交时服务端读盘重传。
         */
        onFile: isFrameExtract
          ? (file: File) => void uploadFrameVideo(node.id, file)
          : isLatentKind(node.data.kind)
            ? (file: File) => void uploadLatentFile(node.id, file)
            : (file: File) => void archiveMedia(node.id, file),
        /*
         * 切引擎要走 `engineSwitchPatch`：本机 ComfyUI 那一档的默认比例是 16:9，
         * 而节点建出来时是 RunningHub 的 1:1 —— 不跟着换的话切完本地出图全是方的。
         */
        onField: (key: string, value: string) => patch(node.id, key === 'engine'
          ? engineSwitchPatch(node.data, value)
          : { [key]: value }),
        /* 「打开工作流配置」：交给画布开浮层，不跳页（见 `openWorkflowConfig`）。 */
        onOpenWorkflow: openWorkflowConfig,
        /* 「从工作流库选一份」：同样交给画布，选完直接写回本节点。 */
        onPickWorkflow: () => openWorkflowPicker(node.id),
        onParamRows: node.data.kind === 'params' ? (rows: ParamRow[]) => patch(node.id, { paramRows: rows }) : undefined,
        /* 应用节点上「就地改的应用参数」：只有它一种节点有这个面板（见 `GenerateDock` 的 appPanel）。 */
        onAppRows: node.data.kind === 'app-generate' ? (rows: ParamRow[]) => patch(node.id, { appRows: rows }) : undefined,
        onLatentIndexes: isLatentKind(node.data.kind)
          ? (indexes: number[]) => patch(node.id, { latentIndexes: indexes })
          : undefined,
        onLatentPicks: node.data.kind === 'latent-relay'
          ? (picks: string[]) => patch(node.id, { latentPicks: picks })
          : undefined,
        onMeasure: (size: string) => { if (node.data.imageSize !== size) patch(node.id, { imageSize: size }); },
        onPreview: setPreview,
        onPreviewClose: () => setPreview(null),
        /** 拖右下角改尺寸：实时写回 data，跟着画布一起保存。 */
        onResize: (width?: number, height?: number) => {
          // 不传尺寸 = 恢复默认：清掉自定义宽高，让卡片重新按内容自适应
          if (width === undefined || height === undefined) {
            if (node.data.width === undefined && node.data.height === undefined) return;
            patch(node.id, { width: undefined, height: undefined });
            return;
          }
          if (node.data.width === width && node.data.height === height) return;
          patch(node.id, { width, height });
        },
        /**
         * 正面就是一份媒体的节点改尺寸：**只写宽度**（2026-09-24）。
         *
         * 高度不写死 —— `.cv-node.sized-w` 下画框按内容长，图多高框就多高。
         * 顺手把历史存下来的 `height` 清掉：老画布上「拖成一个方框、竖图两侧留黑边」
         * 就是这么攒出来的。
         */
        onResizeWidth: (width: number) => {
          if (node.data.width === width && node.data.height === undefined) return;
          patch(node.id, { width, height: undefined });
        },
        /** 参数条要显示「这段帧是从哪段视频取的」：自己带的，还是上游哪个节点。 */
        frameSourceVideo: isFrameExtract ? frameSourceOf(node) || undefined : undefined,
        frameSourceFrom: isFrameExtract
          ? (String(node.data.videoUrl || node.data.videoRemoteUrl || '').trim()
            ? '本节点自带的视频'
            : (String(upstream.find(item => item.data.kind === 'video-input' || item.data.kind === 'video-generate')?.data.label || '')
              || (upstream.some(item => item.data.kind === 'video-input' || item.data.kind === 'video-generate') ? '上游视频' : ''))
            || undefined)
          : undefined,
        /*
         * 生成节点上要显示的「正在用的首帧 / 尾帧」（2026-09-21）。
         * 哪两张真的会送进生成，由上游那个首尾帧节点的「取用」开关决定 —— 这里照那个开关原样取，
         * 卡片上画出来的就是真的会用的那两张，不会出现「卡片上有尾帧、生成却没用上」。
         */
        frameInFirst: frameFeed && frameFeedPick !== 'last' ? String(frameFeed.data.firstFrameUrl || '') || undefined : undefined,
        frameInLast: frameFeed && frameFeedPick !== 'first' ? String(frameFeed.data.lastFrameUrl || '') || undefined : undefined,
        onFrameExtract: isFrameExtract ? () => void extractFrames(node.id) : undefined,
        onGenerate: isRunnableKind(node.data.kind) ? () => void runOne(node.id) : undefined,
        /** 优化节点：就地跑一次改写（参数条那个按钮与「启动」走的是同一条）。 */
        onOptimize: node.data.kind === 'prompt-optimize' ? () => void runPromptNode(node.id) : undefined,

        /** 超清：拿本节点已生成的结果再加工一道（按钮在卡片右上角，悬停才显形）。 */
        onUpscale: isGenerator ? () => void upscale(node.id) : undefined,
        onAbandon: isGenerator ? () => void abandonNode(node.id) : undefined,
        /**
         * 双击节点标题重命名：写回 data.label。
         * 空串清掉自定义名（label: undefined），标题回落显示原始类型名。
         */
        onRename: (name: string) => patch(node.id, { label: name.length > 0 ? name : undefined }),
        /** 导演台：打开那块舞台（按钮在卡片右上角，常驻）。 */
        onOpenDirector: node.data.kind === 'director' ? () => setDirectorFor(node.id) : undefined,
        onPasteImages: isGenerator || node.data.kind === 'image'
          ? (files: File[]) => addImages(files, { nodeId: node.id })
          : undefined,
        onNotice: setNotice,
      },
    };
  }), [collectParamRows, describeInputOf, edges, extractFrames, frameSourceOf, generate, latentChainOf,
    latentPickOptionsOf, openWorkflowConfig, openWorkflowPicker, runPromptNode, runOne, textChainOf,
    archiveMedia, latents, nodes, paramWorkflowOf, patch, sources, uploadFrameVideo, uploadLatentFile, workflows]);

  /*
   * 接上视频就自动提取一次。
   *
   * 不放自动的话，用户得先发现「参数条里还有个提取按钮」才会去点 —— 而大多数时候
   * 接上视频就是为了拿它的首尾帧，中间没有别的事要做。
   *
   * 两道闸防重复上传（每次提取要传两张图，重复跑很贵）：
   *   · `frameSource` 对得上、且手上已经有帧 → 这次不用提；
   *   · 本次会话已经为「这个节点 + 这段视频」试过一次 → 不再试，**失败也记账**，
   *     否则跨域那种注定失败的会一进画布就反复重试。
   */
  const autoFrames = useRef<Set<string>>(new Set());
  useEffect(() => {
    nodes.forEach(node => {
      if (node.data.kind !== 'frame-extract') return;
      if (node.data.status === 'running' || node.data.status === 'uploading') return;
      const src = frameSourceOf(node);
      if (!src) return;
      if (node.data.frameSource === src && (node.data.firstFrameFile || node.data.lastFrameFile)) return;
      const key = `${node.id}|${src}`;
      if (autoFrames.current.has(key)) return;
      autoFrames.current.add(key);
      void extractFrames(node.id);
    });
  }, [extractFrames, frameSourceOf, nodes]);

  /** Old edges were stored as smoothstep; render everything as bezier without rewriting persisted data. */
  const displayEdges = useMemo(() => edges.map(edge => ({ ...edge, type: 'star' })), [edges]);

  const add = useCallback((kind: NodeKind) => setNodes(ns => [...ns, {
    id: crypto.randomUUID(),
    type: 'frame',
    position: { x: 120 + ns.length * 30, y: 90 + ns.length * 24 },
    data: newNodeData(kind),
  }]), [setNodes]);

  /** The right-click menu drops the new node where the pointer was. When the menu was opened by
   *  dropping a wire on empty canvas, the new node is also wired to the node that started the drag. */
  const addAt = useCallback((kind: NodeKind, screen: { x: number; y: number }) => {
    const id = crypto.randomUUID();
    setNodes(ns => [...ns, {
      id,
      type: 'frame',
      position: screenToFlowPosition({ x: screen.x, y: screen.y }),
      data: newNodeData(kind),
    }]);
    const source = pendingLink;
    if (source) {
      const sourceKind = nodes.find(node => node.id === source)?.data.kind;
      if (canConnect(sourceKind, kind)) {
        setEdges(es => addEdge({ id: `${source}-${id}`, source, target: id, type: 'default', animated: true } as Edge, es));
      } else {
        setNotice(connectionHint(kind));
      }
    }
    setPendingLink(null);
    setMenu(null);
  }, [nodes, pendingLink, screenToFlowPosition, setEdges, setNodes]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(null); setPendingLink(null); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menu]);

  /**
   * 预览灯箱（打开原图 / 预览视频）也要能用 Esc 关。
   * 它盖住整个画布、又没有可见的关闭按钮，只能靠「点任意处」——
   * 键盘用户按 Esc 没反应时，会以为画布卡死了。
   */
  useEffect(() => {
    if (!preview) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [preview]);

  useEffect(() => {
    if (!notice) return;
    /** 清空走 setNoticeText：这只是「到点了」，不该再顶一次编号。 */
    const timer = setTimeout(() => setNoticeText(null), 2800);
    return () => clearTimeout(timer);
  }, [notice, noticeSeq]);

  const connect: OnConnect = useCallback((connection: Connection) => {
    const source = nodes.find(node => node.id === connection.source);
    const target = nodes.find(node => node.id === connection.target);
    if (!source || !target || !canConnect(source.data.kind, target.data.kind)) {
      setNotice(connectionHint(target?.data.kind));
      return;
    }
    setEdges(es => addEdge({ ...connection, type: 'default', animated: true } as Edge, es));
  }, [nodes, setEdges]);

  const connectStart = useCallback((event: MouseEvent | TouchEvent) => {
    dragStart.current = 'clientX' in event ? { x: event.clientX, y: event.clientY } : null;
  }, []);

  /**
   * Two outcomes of finishing a wire drag:
   * dropped on an incompatible node → say why; dropped on empty canvas → open the add-node menu
   * right there and wire whatever gets created to the node the drag started from.
   */
  const connectEnd = useCallback((event: MouseEvent | TouchEvent, state: { isValid?: boolean | null; toNode?: Node<NodeData> | null; fromNode?: Node<NodeData> | null }) => {
    if (state?.toNode) {
      if (!state.isValid) setNotice(connectionHint(state.toNode.data?.kind));
      return;
    }
    const from = state?.fromNode;
    const start = dragStart.current;
    dragStart.current = null;
    if (!from) return;
    const point = 'clientX' in event
      ? { x: event.clientX, y: event.clientY }
      : { x: event.changedTouches?.[0]?.clientX ?? 0, y: event.changedTouches?.[0]?.clientY ?? 0 };
    /** A plain click on a handle should not spawn the menu — require an actual drag. */
    if (!start || Math.hypot(point.x - start.x, point.y - start.y) < 40) return;
    setSelected(null);
    setPendingLink(from.id);
    setMenu({ kind: 'add-nodes', ...point });
  }, []);

  const save = useCallback(async (options?: { force?: boolean }) => {
    const force = options?.force ?? false;
    /** 上一个还在飞就记一笔，等它回来再发 —— 排到队尾用的必然是最新的 nodes/edges。 */
    if (saving.current) { queued.current = true; return; }
    saving.current = true;
    setSaveState('saving');
    try {
      /*
       * 连线只存 `id / source / target` 这三样。
       *
       * `selected` 是 React Flow 的界面状态（谁被点中了），跟着一起存进库的意思是
       * 「下次打开这张画布，那条线是选中的」—— 毫无意义，而且每次点一下线都会
       * 让画布脏一遍、触发一次自动保存。存库格式也和 MCP 那边读的
       * `{ id, source, target }` 对齐。
       */
      const body: Record<string, unknown> = {
        nodes,
        edges: edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target })),
        viewport: viewport.current,
      };
      /** force = 用户看过了冲突提示，明确要求「就按我这版覆盖」。 */
      if (!force && typeof versionRef.current === 'number') body.version = versionRef.current;
      const response = await fetch(`/api/projects/${projectId}/canvas`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 409) {
        conflicted.current = true;
        setSaveState('conflict');
        return;
      }
      if (!response.ok) throw new Error('save failed');
      const payload: { version?: number } = await response.json().catch(() => ({}));
      /**
       * 只有保存成功才认服务端的新版本号。
       * 409 的响应里也带着当前版本，但不能用它 —— 用了下一轮就会带着「别人那版」的号去写，
       * 等于把别处的改动静默盖掉，正是这套机制要拦的事。
       */
      if (typeof payload.version === 'number') versionRef.current = payload.version;
      conflicted.current = false;
      dirty.current = false;
      setSaveState('saved');
    } catch {
      setSaveState('failed');
    } finally {
      saving.current = false;
      const again = queued.current;
      queued.current = false;
      if (again && !conflicted.current) saveRef.current();
    }
  }, [edges, nodes, projectId]);

  useEffect(() => { saveRef.current = save; }, [save]);

  /*
   * 「让 Codex 操作画布」的最后一段路：它改完，这里要看得见。
   *
   * frame-mcp 那 14 个工具写的是**库**（PATCH /api/projects/{id}/canvas），前端不会自己知道。
   * 所以主进程在识别到 frame_* 的写工具调用完成时推一个 `canvas` 事件
   * （见 electron/main/codex-service.ts），这里收到就拉一次最新的画布。
   *
   * 两种处理，判据只有一个：**本地有没有没落库的改动**。
   *   没有 → 直接换掉（用户什么都没改，最新那版就是他要的）；
   *   有   → 不替他扔，置冲突，让顶上那条冲突条给「用我这版覆盖 / 重新加载」两条路。
   */
  const applyExternalCanvas = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/canvas`, { cache: 'no-store' });
      if (!response.ok) return;
      const payload: { nodes?: unknown; edges?: unknown; version?: number } = await response.json().catch(() => ({}));
      if (!Array.isArray(payload.nodes)) return;
      const nextVersion = typeof payload.version === 'number' ? payload.version : null;
      /*
        版本号没动 = 这次工具调用没真的改到画布（比如只是读了一次），
        别白刷一遍 —— 那会把选中态和视口抖一下。
      */
      if (nextVersion !== null && versionRef.current !== null && nextVersion === versionRef.current) return;
      if (dirty.current) {
        conflicted.current = true;
        setSaveState('conflict');
        return;
      }
      skipAutosave.current = true;
      if (nextVersion !== null) versionRef.current = nextVersion;
      setNodes(normalizeNodeLabels(payload.nodes as Node<NodeData>[]));
      setEdges(Array.isArray(payload.edges) ? payload.edges as Edge[] : []);
      setNotice('Codex 改了画布，已换成最新的一版。');
    } catch {
      /* 拉不到就当没发生：下一次工具调用还会再推一次，不值得在这里打扰用户。 */
    }
  }, [projectId, setEdges, setNodes, setNotice]);

  /*
   * 首页带过来的那份东西（那句话，以及 seed 变出来的整套节点与参考图）要**立刻落一次库**：
   * 上面那套初始节点只是客户端临时数据（服务端此刻还存着一张空画布），用户没碰画布就退出去的话，
   * 提示词和参考图会跟着 URL 一起消失。
   * 只在「新项目 + 确实带了东西过来」时触发一次 —— 老画布完全不受影响。
   */
  useEffect(() => {
    if (!seed && !seedPrompt) return;
    if (initial.nodes.length) return;
    saveRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    /** 刚从外面（Codex / 别的窗口）拉回来的那一次不要写回去，也**不算本地有改动** ——
        顺序反了的话，拉一次就把 dirty 置真，下一次外部改动会被误判成「两边都动过」而弹冲突条。 */
    if (skipAutosave.current) { skipAutosave.current = false; return; }
    dirty.current = true;
    /** 已经确认冲突就别再自动写：每一发都是覆盖别人，等用户在提示条上做选择。 */
    if (conflicted.current) return;
    const timer = setTimeout(save, 800);
    return () => clearTimeout(timer);
  }, [edges, nodes, save]);

  /** 选中节点的数据要用 React Flow 真正在渲染的那一份（hydrated），
   *  否则底部提示条拿到的 label / kind 会和画布上看到的不一致。 */
  const current = hydrated.find(node => node.id === selected) || null;
  /**
   * 生成节点（图片 / 视频）选中时，参数改在**挂在它下方那个对话框**里（`GenerateDock`），
   * 不再浮在卡片下方。判定与 `NodeCard` 收起浮条用的是同一个函数（nodeMeta 的
   * `usesGenerateDock`），两边不一致就会出现「浮条没了、对话框也没出来」。
   */
  const dockNode = current && usesGenerateDock(current.data.kind) ? current : null;
  /**
   * 盯住 dock 那个节点的 DOM 尺寸，量到就记进 `dockSize`（见它那段注释）。
   *
   * ⚠️ 依赖只写**节点的 id**，不写 `dockNode` 本身 —— 那个对象每帧都是新的，
   * 写进去等于每帧重建一个 ResizeObserver。
   * ⚠️ 用 `useEffect` 而不是 `useLayoutEffect`：项目里一处 `useLayoutEffect` 都没有，
   * 而且它会在服务端渲染时报警告、污染 `backend.stderr.log`。代价是面板出现的那一帧
   * 还按旧尺寸贴（16ms 后自己跳正），比现在「一直错」好得多。
   * ⚠️ `read` 里做了同值短路：ResizeObserver 回调里每帧 setState 会让画布白重渲染。
   */
  const dockId = dockNode?.id || '';
  useEffect(() => {
    if (!dockId) { setDockSize(null); return; }
    const el = document.querySelector(`.react-flow__node[data-id="${dockId}"]`);
    if (!el) { setDockSize(null); return; }
    const read = () => {
      /* offsetWidth/Height 是**布局**尺寸，不受画布 zoom 影响 —— 正是上面公式要的量。 */
      const w = (el as HTMLElement).offsetWidth;
      const h = (el as HTMLElement).offsetHeight;
      setDockSize(prev => (prev && prev.id === dockId && prev.w === w && prev.h === h ? prev : { id: dockId, w, h }));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [dockId]);
  /**
   * 对话框要**跟着节点走**，所以位置得在每次视口变化时重算。
   *
   * ⚠️ 这里三个原始值必须**分开订阅**：`useStore(s => s.transform)` 返回的是同一个
   * 数组引用，改了也不会触发重渲染；而 `s => ({ x, y })` 这类选择器每次给出新对象，
   * 会把 React 拖进无限重渲染。取下标拿原始值 + React Flow 自带的浅比较最稳。
   *
   * 拖节点不用管 —— 位置走 `nodes` state，本来就会重渲染。
   */
  const viewX = useStore(state => state.transform[0]);
  const viewY = useStore(state => state.transform[1]);
  const viewZoom = useStore(state => state.transform[2]);
  const paneW = useStore(state => state.width);
  /* ⚠️ 尺寸要**跟着节点走**：量到的是上一个节点的，就宁可退回 `measured`（那至少是它自己的），
     不然换节点那一帧面板会先跳到上一个节点的高度上去。 */
  const dockAnchor = dockNode
    ? dockAnchorFor(dockNode, { x: viewX, y: viewY, zoom: viewZoom, width: paneW },
      dockSize && dockSize.id === dockNode.id ? dockSize : null)
    : undefined;

  /**
   * 给选中的节点换卡片色（2026-10-01）。
   *
   * `null` = 恢复「跟随主题」：写 `undefined` 而不是空串 —— 空串会被存进库里，
   * 于是「没挑过」和「挑了一个空色」变成两种状态，而后者渲染出来什么都不是。
   * `undefined` 在序列化时整个键消失，读回来就是「没挑过」。
   *
   * 多选时一起改：挑色本来就是为了把一组节点并成一类，一个个改反而做不成这件事。
   */
  const paintNodes = useCallback((color: string | null) => {
    const ids = nodes.filter(node => node.selected).map(node => node.id);
    if (!ids.length) return;
    ids.forEach(id => patch(id, { color: color || undefined }));
    setNotice(color ? `已改 ${ids.length} 个节点的卡片色` : `${ids.length} 个节点恢复跟随主题`);
  }, [nodes, patch, setNotice]);

  const allRuns = useMemo(() => collectRuns(hydrated), [hydrated]);
  /**
   * 当前画布上还有哪些节点 —— 历史浮层要用它判断「这条记录的节点还在不在」。
   * 历史现在读的是库（见 `lib/runs.ts`），节点删了记录还在，所以不能再默认「点了就能跳过去」。
   */
  const nodeIds = useMemo(() => nodes.map(node => node.id), [nodes]);
  const saveText = saveState === 'saving' ? '保存中…' : saveState === 'failed' ? '保存失败' : saveState === 'conflict' ? '有冲突' : '已保存';

  /* 右键菜单的条目。三份内容互不重叠：
     add-nodes 选类型 · node-options 操作节点 · global 操作整块画布。
     全部现算而不是存在 state 里 —— 菜单一旦快照了打开那一刻的选中集合，
     「复制」「删除」就会作用在已经不对的那批节点上。 */
  const menuGroups = useMemo<MenuGroup[]>(() => {
    if (!menu) return [];
    const at = { x: menu.x, y: menu.y };
    const link = pendingLink ? nodes.find(node => node.id === pendingLink) : undefined;
    const picked = nodes.filter(node => node.selected).map(node => node.id);
    const count = picked.length;
    /* 菜单上那一项的**标签**要跟着当前状态走（「绕过」/「取消绕过」）：
       写着「绕过」点下去却是取消，是这种开关最容易犯的错。 */
    const allBypassed = count > 0 && nodes.filter(node => node.selected).every(node => node.data.bypassed);
    const target = menu.nodeId ? nodes.find(node => node.id === menu.nodeId) : undefined;
    /**
     * 选中这批节点当前挑的卡片色：**全同色才有值**。
     * 几个节点色不一样时一支都不打勾 —— 打在其中一支上等于说「它们是同一个色」，
     * 而用户看到的却是好几种。
     */
    const pickedNodes = nodes.filter(node => node.selected);
    const firstColor = String(pickedNodes[0]?.data.color || '');
    const colorNow = pickedNodes.length && pickedNodes.every(node => String(node.data.color || '') === firstColor)
      ? firstColor
      : '';

    /* ---------- 选类型 ---------- */
    if (menu.kind === 'add-nodes') {
      return [{
        title: link ? '接上新节点' : '添加节点',
        items: [
          {
            /*
             * 图片 / 视频 / 音频三个输入节点已经**不在这一栏**了（拖进来、粘进来、
             * 或者从这条上传进来自动建），所以这一条就是它们的入口：选文件，节点自己长出来。
             */
            id: 'upload', label: '上传文件', icon: <Upload size={14} strokeWidth={2} />,
            title: '选文件上传 · 按类型自动放对应的节点（文档会成为文本节点）',
            ariaLabel: '上传文件到画布', note: '文档 / 媒体',
            run: () => openUpload(at),
          },
          ...CREATE_KINDS.map<MenuItem>(kind => {
            /* 有上游、但这个类型接不上的：不是「不能用」，是接上去也不会参与生成。
               灰掉并把原因写在右边，总比让用户点了才发现没连上要好。 */
            const blocked = link ? !canConnect(link.data.kind, kind) : false;
            return {
              id: kind,
              /*
               * 2026-09-21：这一栏**写下节点名字**。上一轮改成只有图标之后，
               * 十个符号里没有一个是「一看就知道是什么节点」的 —— 名字回来，图标留着当速记。
               * `title` / `aria-label` / `data-kind` 三样照旧：悬停提示要说清接不接得上，
               * 屏幕阅读器要有名字，探针靠 `data-kind` 认节点而不是去数第几个图标。
               */
              label: NODE_META[kind].label,
              icon: <NodeGlyph kind={kind} size={14} />,
              title: blocked ? `${NODE_META[kind].label} · 不可接` : `${NODE_META[kind].label} · ${NODE_META[kind].tag}`,
              ariaLabel: `添加${NODE_META[kind].label}`,
              dataKind: kind,
              /* 「接不上」这件事仍然要看得见：那排灰掉的图标靠图标本身说明不了原因。 */
              note: blocked ? '不可接' : '',
              disabled: blocked,
              run: () => addAt(kind, at),
            };
        }),
        ],
      }];
    }

    /* ---------- 节点右键 ---------- */
    if (menu.kind === 'node-options') {
      const title = count > 1
        ? `${count} 个节点`
        : String(target?.data.label || '节点');
      return [
        {
          title,
          items: [
            {
              id: 'params', label: '查看参数', icon: <SlidersHorizontal size={14} strokeWidth={2} />,
              run: () => { if (target) setSelected(target.id); setMenu(null); },
            },
            {
              id: 'chain', label: '接上新节点', icon: <GitBranch size={14} strokeWidth={2} />, note: '自动连上它',
              disabled: !target, run: () => { if (!target) return; setPendingLink(target.id); setMenu({ ...at, kind: 'add-nodes' }); },
            },
          ],
        },
        {
          /*
           * 卡片颜色（2026-10-01）：**每个节点各挑一支**，跟设置里那支全局「卡片底色」
           * 是两件事 —— 那边改的是一整块画布，这里改的是手上这几个节点。
           * 第一块（斜杠）是退回：清掉这一支，节点重新跟着全局走。
           */
          title: count > 1 ? `卡片颜色 · ${count} 个` : '卡片颜色',
          items: [
            {
              /* 这一行只有色块，没有文字：组标题已经写了「卡片颜色」，
                 再在行首摆一个「卡片」是同一个词说两遍。 */
              id: 'node-color',
              label: '',
              ariaLabel: '卡片颜色',
              swatches: [
                { id: 'follow', value: null, label: '跟随主题', on: !colorNow, run: () => paintNodes(null) },
                ...NODE_CARD_COLORS.map(item => ({
                  id: item.value,
                  value: item.value,
                  label: item.label,
                  on: !!colorNow && colorNow === item.value,
                  run: () => paintNodes(item.value),
                })),
                /* 最后一块是取色器：九支不够挑时自己来。 */
                { id: 'pick', value: colorNow || '#14161a', label: '自己挑', pick: true, onPick: hex => paintNodes(hex) },
              ],
            },
          ],
        },
        {
          items: [
            {
              id: 'copy', label: '复制', icon: <Copy size={14} strokeWidth={2} />, shortcut: 'Ctrl+C', disabled: !count,
              run: () => { const moved = copyNodes(); setMenu(null); if (moved) setNotice(`已复制 ${moved} 个节点 · Ctrl+V 粘贴`); },
            },
            {
              id: 'duplicate', label: '原地复制', icon: <CopyPlus size={14} strokeWidth={2} />, shortcut: 'Ctrl+D', disabled: !count,
              run: () => { duplicateNodes(); setMenu(null); },
            },
            {
              id: 'cut', label: '剪切', icon: <Scissors size={14} strokeWidth={2} />, shortcut: 'Ctrl+X', disabled: !count,
              run: () => { cutNodes(); setMenu(null); },
            },
          ],
        },
        {
          items: [
            {
              id: 'link', label: '连接两个节点', icon: <Link2 size={14} strokeWidth={2} />, shortcut: 'I',
              /* 别的项目都是「有选中就能用」，只有这条要求**正好两个** ——
                 灰着的时候把原因写在右边，比让人点了才发现没反应强。 */
              disabled: count !== 2, note: count === 2 ? undefined : '需选中 2 个',
              run: () => { connectSelected(); setMenu(null); },
            },
            {
              id: 'disconnect', label: '断开全部连线', icon: <Unplug size={14} strokeWidth={2} />, disabled: !target,
              run: () => { if (target) disconnectNode(target.id); setMenu(null); },
            },
            {
              /* 绕过（2026-09-29）：选中几个就一起切，标签跟着**当前状态**变 ——
                 菜单上写着「绕过」点下去却取消了，是这种开关最容易犯的错。 */
              id: 'bypass', label: allBypassed ? '取消绕过' : '绕过', shortcut: 'B',
              icon: <Ban size={14} strokeWidth={2} />, disabled: !count,
              note: count > 1 ? `${count} 个` : undefined,
              run: () => { toggleBypass(picked); setMenu(null); },
            },
            {
              /*
               * 放弃这一轮（2026-09-29）：任务只有成功与失败，跑多久是上游的事，
               * 所以「不等了」只能由用户自己点 —— 这个入口就是那一声。
               */
              id: 'abandon', label: '放弃这一轮', icon: <Ban size={14} strokeWidth={2} />,
              disabled: !target || target.data.status !== 'running',
              note: target?.data.status === 'running' ? '不再等它，这次按失败处理' : '只在运行中可用',
              run: () => { if (target) void abandonNode(target.id); setMenu(null); },
            },
            {
              id: 'delete', label: '删除', icon: <Trash2 size={14} strokeWidth={2} />, shortcut: 'Del / ⌫', danger: true,
              disabled: !count, run: () => { deleteNodes(picked); setMenu(null); },
            },
          ],
        },
      ];
    }

    /* ---------- 画布空白处右键 ---------- */
    return [
      {
        items: [
          { id: 'add', label: '添加节点', icon: <Plus size={14} strokeWidth={2} />, run: () => setMenu({ ...at, kind: 'add-nodes' }) },
          {
            /* 一条比「先想清楚要哪种节点」更省事的路：挑文件，节点按类型自己长出来。 */
            id: 'upload', label: '上传文件', icon: <Upload size={14} strokeWidth={2} />, note: '按类型放节点',
            run: () => openUpload(at),
          },
          {
            id: 'paste', label: '粘贴', icon: <ClipboardPaste size={14} strokeWidth={2} />, shortcut: 'Ctrl+V',
            disabled: !clipboard.current?.nodes.length, run: () => { pasteNodes(); setMenu(null); },
          },
        ],
      },
      {
        items: [
          { id: 'layout', label: '自动排列', icon: <LayoutGrid size={14} strokeWidth={2} />, shortcut: 'L', run: () => { autoLayout(); setMenu(null); } },
          { id: 'fit', label: '适应画布', icon: <Maximize2 size={14} strokeWidth={2} />, shortcut: 'F', run: () => { fitView({ duration: 300, padding: 0.2 }); setMenu(null); } },
        ],
      },
      {
        items: [
          { id: 'save', label: '保存', icon: <Save size={14} strokeWidth={2} />, shortcut: 'Ctrl+S', run: () => { void save(); setMenu(null); } },
        ],
      },
    ];
  }, [abandonNode, addAt, autoLayout, clipboard, connectSelected, copyNodes, cutNodes, deleteNodes, disconnectNode, duplicateNodes, fitView, menu, nodes, openUpload, pasteNodes, pendingLink, save]);

  return <div className={`flow-shell${zen ? ' cv-zen' : ''}`}>
    <div className="cv-topbar">
      <a className="cv-brand" href="/">{projectName || '未命名项目'}</a>
      <div className="cv-spacer" />
      {/* 站点余额挂在这儿（全站只有一份 `SiteBalance`，它认 `[data-balance-slot]`）。
          位置选在「已保存」之前，**不是**最右 —— 最右紧挨着窗口的系统按钮，
          余额挤过去会钻到它们底下（标题栏是 `titleBarStyle:hidden`）。 */}
      <span className="cv-balance-slot" data-balance-slot />
      <span className={`cv-save ${saveState}`}><i />{saveText}</span>
      <button className="cv-btn primary sm" onClick={() => void save()}>保存</button>
      <div className="cv-divider" />
      {/* 回项目列表。用 `.secondary` 不用 `.ghost`：ghost 那道 7% 的描边在顶栏上几乎看不见，
          它会被读成一句飘着的文字（2026-10-02 徐先：「边界和颜色明显一些」）。 */}
      <Link className="cv-btn secondary sm" href="/">项目</Link>
      {/*
        一键运行（2026-09-27）。这一格原来是「工作流」链接 —— 那个入口在节点参数条
        （「打开工作流配置」）和左侧设置面板里都有，而这里是**手最常放的地方**，
        留给最高频的那个动作：把整条链跑一遍。
      */}
      <button className="cv-btn primary sm" type="button" data-cv-run-all
        title={runAllBusy
          ? '点一下停在这一步（已经提交出去的那一次不会被打断）'
          : '把画布上所有生成节点按依赖顺序跑一遍 —— 上游先跑，全部跑完才算一次'}
        onClick={() => {
          if (runAllBusy) { runAllStop.current = true; return; }
          void runAllNodes();
        }}>
        {runAllBusy && runProgress
          ? `停止 ${runProgress.round}/${runProgress.times} · ${Math.min(runProgress.done + 1, runProgress.total)}/${runProgress.total}`
          : runAllBusy ? '停止' : '启动'}
      </button>
      {/* 一键运行的次数：数字框 + 上调/下调（步长 1）。
          原来右边那格是一个「遍」字，徐先要的是能点的（2026-09-27）——
          手打数字在只想加一下的时候太别扭。
          用 `div` 不用 `label`：里面多了两颗按钮，`label` 的「点哪都聚焦输入框」在这里只会碍事。 */}
      <div className="cv-run-times" title="整条流程连着跑几遍（不是每个节点出几张，那个在各节点的「张数」里）">
        <input className="cv-input sm num" type="number" min={1} max={99} data-cv-run-times
          aria-label="运行次数"
          value={runTimes}
          disabled={runAllBusy}
          onChange={event => setRunTimes(Math.max(1, Math.min(99, Math.round(Number(event.target.value)) || 1)))} />
        <span className="cv-run-steps">
          <button className="cv-run-step" type="button" data-cv-run-up aria-label="运行次数加 1"
            title="加一次" disabled={runAllBusy}
            onClick={() => setRunTimes(value => Math.min(99, value + 1))}>
            <ChevronUp size={11} />
          </button>
          <button className="cv-run-step" type="button" data-cv-run-down aria-label="运行次数减 1"
            title="减一次" disabled={runAllBusy}
            onClick={() => setRunTimes(value => Math.max(1, value - 1))}>
            <ChevronDown size={11} />
          </button>
        </span>
      </div>
      {/*
        运行计时（2026-09-28）放在顶栏**最右**。这里不会钻到窗口那三个系统按钮底下 ——
        `.flow-shell .cv-topbar` 已经留了 `padding-right: calc(--window-controls-inset + 12px)`。
        没跑过任何一轮时它自己返回 null，不占位。
      */}
      <RunClock clock={runClock} />
    </div>

    {/* 一键运行大遍数二次确认（2026-09-27）：还没真正开跑，弹窗里取消就一个都不发。 */}
    {runTimesConfirm !== null && (
      <ConfirmDialog
        testId="run-times"
        title={`要连跑 ${runTimesConfirm} 遍？`}
        danger={false}
        confirmLabel="确定，开跑"
        onCancel={() => setRunTimesConfirm(null)}
        onConfirm={() => { setRunTimesConfirm(null); void runAllNodes(true); }}
        body={<p>整条流程会连着跑 {runTimesConfirm} 遍，按每个生成节点累计消耗积分。跑起来之后只能点「停止」中断，不能中途减遍数。确定要从头跑 {runTimesConfirm} 遍吗？</p>}
      />
    )}

    {/* 画布在别的窗口被改过：自动保存已经停下，这里给两条出路，不替用户选。 */}
    {saveState === 'conflict' && <div className="cv-conflict">
      <span className="cv-conflict-text">画布已在其他窗口被修改，这次的改动没有保存。</span>
      <button className="cv-btn ghost sm" onClick={() => void save({ force: true })}>用我这版覆盖</button>
      <button className="cv-btn ghost sm" onClick={() => window.location.reload()}>重新加载</button>
    </div>}

    <div className="cv-body">
      {/*
        左侧工具条改成了浮在画布上的胶囊（见 CanvasRail）：贴边的一整列会把画布挤窄一圈，
        而它真正占的只有几个按钮的位置，剩下的面积应该还给节点。
      */}
      <div
        className={`cv-stage ${dropping ? 'dropping' : ''}`}
        onMouseMove={event => { pointer.current = { x: event.clientX, y: event.clientY }; }}
        onDragEnter={event => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDropping(true);
        }}
        onDragOver={event => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={event => {
          if (!carriesFiles(event)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDropping(false);
        }}
        onDrop={event => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDropping(false);
          const client = { x: event.clientX, y: event.clientY };
          const dropped = Array.from(event.dataTransfer.files);
          const images = dropped.filter(file => file.type.startsWith('image/'));
          const videos = dropped.filter(file => file.type.startsWith('video/'));
          const audios = dropped.filter(file => file.type.startsWith('audio/'));
          if (images.length) addImages(images, { screen: client });
          if (videos.length) addVideos(videos, { screen: client });
          if (audios.length) addAudios(audios, { screen: client });
        }}
      >
        {/* 右键「上传文件」用的那个 input —— 藏起来，靠 `openUpload()` 触发。
            探针用 `DOM.setFileInputFiles` 直接喂它，不必过系统对话框。 */}
        <input
          ref={uploadInput}
          data-canvas-upload
          type="file"
          multiple
          hidden
          onChange={event => {
            const files = Array.from(event.target.files || []);
            /** 先取文件再清 value：清了之后 `files` 就空了。 */
            event.target.value = '';
            setMenu(null);
            if (files.length) addUploads(files, uploadAnchor.current ?? undefined);
          }}
        />

        {/* 背景图必须垫在 React Flow **底下**：它是墙纸，不是画布内容。
            真正的缘故见 CanvasWallpaper 里的注释：塞进 .react-flow 里会跟着画布一起缩放。 */}
        <CanvasWallpaper />
        <ReactFlow
          nodes={hydrated}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={connect}
          onConnectStart={connectStart}
          onConnectEnd={connectEnd}
          isValidConnection={connection => {
            const source = nodes.find(node => node.id === connection.source);
            const target = nodes.find(node => node.id === connection.target);
            if (!source || !target || source.id === target.id) return false;
            return canConnect(source.data.kind, target.data.kind);
          }}
          onNodeClick={(_, node) => setSelected(node.id)}
          onPaneClick={() => { setSelected(null); setMenu(null); setPendingLink(null); }}
          onPaneContextMenu={event => {
            event.preventDefault();
            setSelected(null);
            setPendingLink(null);
            setMenu({ kind: 'global', x: event.clientX, y: event.clientY });
          }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            setSelected(node.id);
            setPendingLink(null);
            /* 没被选中的话，把选区收敛成只有它一个 —— 菜单里的复制 / 删除
               要作用在用户以为的那批节点上。已经处在多选里时选区保持不动。 */
            if (!node.selected) setNodes(ns => ns.map(item => ({ ...item, selected: item.id === node.id })));
            setMenu({ kind: 'node-options', x: event.clientX, y: event.clientY, nodeId: node.id });
          }}
          onMove={(_, view) => { viewport.current = view; setZoom(view.zoom); }}
          defaultViewport={initial.viewport}
          fitView
          minZoom={0.2}
          maxZoom={2.5}
          connectionLineType={ConnectionLineType.Bezier}
          /*
           * 端口命中半径（默认 20，画布坐标）。
           *
           * 徐先 2026-09-24：连线的圆点压不中 —— 圆点视觉直径只有 10px（画布坐标），
           * 缩到 90% 时屏幕上量出 8.9px，往外扫 elementFromPoint，可点中半径只剩 4~5px，
           * 得拿鼠标尖去戳。React Flow 判定「松手落在哪个端口上」时用的是这个半径
           * （不是圆的像素包围盒），提到 44 之后画布坐标里有近 90px 的瞄准窗口，
           * 缩放到 20% 也还剩 17px 左右，随手一拖就能连上。
           * 提太大的代价是「同一侧有多个端口时容易挑错」，这里节点最多一个入口一个出口，不冲突。
           */
          connectionRadius={90}
          defaultEdgeOptions={{ type: 'star', animated: true }}
          edgeTypes={edgeTypes}
          /*
           * 框选「碰到就选中」（徐先 2026-09-26，对着 ComfyUI 的框选提的）。
           *
           * `selectionOnDrag` 早就开着（左键落在空白处拖＝拉框），但 `selectionMode` 一直
           * 吃 React Flow 的默认值 `SelectionMode.Full` —— **要把节点整个框进去**才选中，
           * 框擦到节点不算。节点一多就得拉一个比节点还大的框，手感跟 ComfyUI / LiteGraph 反着来。
           *
           * 换成 `Partial`（相交即选）之后，框碰到哪条边就选哪个。
           * 判定在 React Flow 内部：`getNodesInside(nodes, rect, transform, partially, true)`
           * （见 node_modules/@xyflow/react/dist/esm/index.js 的 Pane）。
           *
           * ⚠️ 框选写的是 React Flow 的 `node.selected`，与下面那个「当前聚焦哪一个节点」的
           * `selected` state 是两套：复制 / 删除 / I 键连接读的是前者，参数抽屉读的是后者。
           */
          selectionMode={SelectionMode.Partial}
          selectionOnDrag
          panOnDrag={[1]}
          panActivationKeyCode="Space"
          zoomOnScroll
          zoomOnDoubleClick={false}
          /*
           * 浮层开着时把这两个键摘掉：焦点落在浮层里某个**按钮**上时，React Flow 仍然认键
           * （它只挡输入框），于是「在设置里按一下 Backspace」会删掉画布上选中的节点 ——
           * 而浮层正挡着画布，删了什么根本看不见。
           */
          multiSelectionKeyCode={overlay === null ? 'Shift' : null}
          deleteKeyCode={overlay === null ? ['Backspace', 'Delete'] : null}
          proOptions={{ hideAttribution: true }}
        >
          {/* 点阵与缩略图的配色都写在 canvas.css 的 --xy-* 变量里。
              这里一旦传 color / bgColor 之类的 props，React Flow 会写进优先级更高的
              *-props 变量，主题与自定义底色就再也覆盖不动了。 */}
          {/* 点阵：间距 40、直径 2.4 —— 点更大、更疏（2026-09-21）。
              gap / size 都是画布坐标里的值，跟着缩放一起变。 */}
          <Background variant={BackgroundVariant.Dots} gap={40} size={2.4} />
          {miniMap && <MiniMap position="bottom-right" pannable zoomable />}
        </ReactFlow>
        {/* 左侧工具条、左下视口控制条、右下外观入口：三块都是浮层，
            放进 cv-stage 里当 React Flow 的兄弟节点，滚动与 transform 都影响不到它们。 */}
        <CanvasRail
          onAddMenu={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            setSelected(null);
            setPendingLink(null);
            setMenu({ kind: 'add-nodes', x: rect.right + 10, y: rect.top });
          }}
          /*
           * 左轨五项：点谁弹谁的居中大浮层（`CanvasOverlay`），再点一次同一项收起。
           * 不再是「只有资产能点、其余给一句还没做」—— 参考图那张卡片本来就是给
           * 「设置 / 工作流配置」这种一整页内容用的，五项共用一套形态才不会长出五种关法。
           */
          onOpen={key => {
            /* 左轨点开的「工作流」是**列表**那一屏、也不是替谁挑：上一次留下
               的「配这一份 / 替某节点挑一份」都要清掉，不然这次一点就落在别人身上。 */
            if (key === 'workflow') { setOverlayWorkflow(null); setOverlayPickNode(null); }
            setOverlay(value => (value === key ? null : (key as CanvasOverlayKey)));
          }}
          openKey={overlay}
          onFit={() => fitView({ duration: 300, padding: 0.2 })}
        />
        <CanvasViewportBar zoom={zoom} miniMap={miniMap} onToggleMiniMap={() => setMiniMap(value => !value)} />
        <div className="cv-ap-wrap">
          {appearanceOpen && <CanvasAppearancePanel open onClose={() => setAppearanceOpen(false)} />}
          <button
            className={`cv-ap-open${appearanceOpen ? ' on' : ''}`}
            type="button"
            data-ap-toggle=""
            aria-expanded={appearanceOpen}
            aria-label="画布外观"
            data-tip="画布外观"
            onClick={() => setAppearanceOpen(value => !value)}
          >
            <Palette size={16} strokeWidth={2} aria-hidden />
          </button>
        </div>
        {/*
          右上角那排图标：生成结果 + 内置浏览器 + Codex。
          它们唤起的都是**从右侧滑出来的侧边栏**，所以入口贴在右上角 —— 抽屉从右边出来，
          眼睛自然往那儿找。后两个只在桌面版出现（web 版没有主进程那一层）：
          宁可没有这个按钮，也不要一个点了没反应的按钮。
          「生成结果」哪一版都有：它读的是本机接口，不依赖主进程那一层。

          开一个就收另外两个：三个抽屉都占右边同一条边，叠着放谁也看不清。
          抽屉开着时整排图标往左挪一个抽屉的宽度（`right`），不然会被抽屉压在底下。

          「无遮挡模式」那颗放在这一排**最左**（2026-10-02 N+97）：它和右边那三颗不是一类
          （那三颗各开一格抽屉，它是切整屏的界面），排在最外一档不会看着像第四个抽屉入口；
          而且无遮挡之后这一排就是画面上仅剩的控件，位置必须和现在一模一样 ——
          钉在这排里最省，不必再算一次绝对坐标。
        */}
        <div className="cv-corner" style={{ right: 14 + (browserOpen ? browserDrawerSize : codexOpen ? (codexWidth ?? CODEX_DRAWER_WIDTH) : resultsOpen ? RESULTS_DRAWER_WIDTH : 0) }}>
          <button
            className={`cv-ap-open${zen ? ' on' : ''}`}
            type="button"
            data-zen-toggle=""
            aria-pressed={zen}
            aria-label={zen ? '退出无遮挡模式' : '无遮挡模式'}
            data-tip={zen ? '退出无遮挡模式 · Tab' : '无遮挡模式 · Tab'}
            onClick={() => { setAppearanceOpen(false); setZen(value => !value); }}
          >
            {/* 图标说的是**这一下会做什么**：能藏就画「闭眼」，已经是藏着的就画「睁眼」。 */}
            {zen ? <Eye size={16} strokeWidth={2} aria-hidden /> : <EyeOff size={16} strokeWidth={2} aria-hidden />}
          </button>
          <button
            className={`cv-ap-open${resultsOpen ? ' on' : ''}`}
            type="button"
            data-results-toggle=""
            aria-expanded={resultsOpen}
            aria-label="生成结果"
            data-tip="生成结果 · 所有画布"
            onClick={() => { const next = !resultsOpen; setResultsOpen(next); if (next) { setBrowserOpen(false); setCodexOpen(false); } }}
          >
            <History size={16} strokeWidth={2} aria-hidden />
          </button>
          {browserSupported() && (
            <button
              className={`cv-ap-open${browserOpen ? ' on' : ''}`}
              type="button"
              data-browser-toggle=""
              aria-expanded={browserOpen}
              aria-label="内置浏览器"
              data-tip="内置浏览器 · 找参考图"
              onClick={() => { const next = !browserOpen; setBrowserOpen(next); if (next) { setCodexOpen(false); setResultsOpen(false); } }}
            >
              <Globe size={16} strokeWidth={2} aria-hidden />
            </button>
          )}
          {codexSupported() && (
            <button
              className={`cv-ap-open${codexOpen ? ' on' : ''}`}
              type="button"
              data-codex-toggle=""
              aria-expanded={codexOpen}
              aria-label="Codex 对话"
              data-tip="Codex · 让它改这张画布"
              onClick={() => { const next = !codexOpen; setCodexOpen(next); if (next) { setBrowserOpen(false); setResultsOpen(false); } }}
            >
              <Sparkles size={16} strokeWidth={2} aria-hidden />
            </button>
          )}
        </div>
        {/*
          两个侧边栏。都**放在 .cv-stage 里面**（和左工具条、外观面板一样是浮层）：
          抽屉的定位基准必须是画布这块区域，而不是整个页面。
          关闭走「卸载」而不是隐藏 —— 浏览器那一块卸载时自己会调 `browser:close` 把网页视图收掉，
          那才是这份功能的正确性所在（视图是主进程的，面板藏起来视图还在）。
        */}
        <CanvasDrawer
          open={browserOpen}
          name="browser"
          title="内置浏览器"
          icon={<Globe size={13} strokeWidth={2} aria-hidden />}
          width={browserDrawerSize}
          resizable
          onResize={setBrowserWidth}
          onClose={() => setBrowserOpen(false)}
        >
          <CanvasBrowserPanel />
        </CanvasDrawer>
        <CanvasDrawer
          open={codexOpen}
          name="codex"
          title="Codex"
          icon={<Sparkles size={13} strokeWidth={2} aria-hidden />}
          width={codexWidth ?? CODEX_DRAWER_WIDTH}
          resizable
          onResize={setCodexWidth}
          onClose={() => setCodexOpen(false)}
        >
          <CanvasCodexPanel
            projectId={projectId}
            projectName={projectName || '未命名项目'}
            skill={codexSkill}
            onSkillChange={setCodexSkill}
            onCanvasChanged={applyExternalCanvas}
          />
        </CanvasDrawer>
        <CanvasDrawer
          open={resultsOpen}
          name="results"
          title="生成结果"
          icon={<History size={13} strokeWidth={2} aria-hidden />}
          width={RESULTS_DRAWER_WIDTH}
          onClose={() => setResultsOpen(false)}
        >
          <CanvasResultsPanel
            projectId={projectId}
            projectName={projectName || '未命名项目'}
            currentRuns={allRuns}
            latents={latents}
          />
        </CanvasDrawer>
        {/*
          生成节点的对话框。选中图片 / 视频生成节点就出现，取消选中就没了。
          它**钉在那个节点的正下方**（位置由 `dockAnchor` 算，见 `dockAnchorFor`），
          所以既不用占右轨那套 overlay 的位置，也不像原来那样横在界面底部
          —— 改参数时视线就在节点上，抬眼是画面、低头是参数。
        */}
        {/* key=节点id：换一颗节点就是一块新面板 —— 弹层 / 展开状态不跨节点残留。 */}
        {dockNode && <GenerateDock key={dockNode.id} data={dockNode.data} nodeId={dockNode.id} anchor={dockAnchor} />}
        {/* 对话框会盖住节点下方那一片，原来那条提示这时让位 —— 两层文字叠在一起谁也看不清。
            未选中时**整块不渲染**（2026-09-24 徐先：「这个提示可以删了」）——
            「右键空白处 / 左侧加号 / 圆点拖线」那三句是上手期的引导，用过一次就是噪音。
            选中时的说明**保留**：它讲的是"你现在选中的是什么、怎么往下接"，
            属于即时信息而不是说明书。 */}
        {!dockNode && !!selected && <div className="cv-hint">
          {`已选中「${String(displayLabelOf(current?.data || {}) || NODE_META[(current?.data.kind || 'text') as NodeKind].label)}」· ${connectionHint(current?.data.kind)}${current?.data.kind === 'text' ? (current?.data.textFrom ? ' · 这段来自上游，改一下就归它自己（会断开那条线）' : ' · 直接点文字框就能改') : ' · 参数在卡片下方'}`}
        </div>}
        {notice && <div className="cv-notice">{notice}</div>}
        {dropping && <div className="cv-drop-hint">松手即添加图片输入节点并自动连线</div>}
        {/* 画布本体就这一块，右边不再有固定宽度的属性栏 —— 节点自己的参数在选中时浮在卡片下方
            （文本节点则是直接在正面写），这里只留一个浮动小面板放「不跟着节点走」的 Latent 包与生成记录。 */}
      </div>

    </div>

    {/*
      左轨五项弹出的大浮层。放在 `.cv-stage` **外面**（与右键菜单、灯箱同级）：
      它们盖的是整块画布，不是画布里的某个位置 —— 塞进 cv-stage 里会撞上
      React Flow 那一层的 transform 与 overflow。
      关掉走「卸载」而不是隐藏：下一次打开要重新取一次（资产 / 工作流列表可能已经变了）。
    */}
    {overlay === 'assets' && (
      <CanvasAssetPanel onClose={() => setOverlay(null)} onPick={addAssetItem} />
    )}
    {overlay === 'workflow' && (
      <CanvasWorkflowPanel
        /* `key` 让「换一份直接开」真的重挂：`initialWorkflowId` 是初值，
           不换 key 的话浮层已经开着时再指过去，里面还是上一份。
           「给某个节点挑一份」也算一种入口，一并进 key。 */
        key={overlayWorkflow || overlayPickNode || 'library'}
        /* 从卡片 / 参数条进来时带着「配这一份」，左轨进来时是 null（开列表）。 */
        initialWorkflowId={overlayWorkflow || undefined}
        /* 有 pickNode = 这次是给那个节点挑一份：列表里出「用这一份」。 */
        pickKind={pickPurpose ?? undefined}
        pickSource={pickSource}
        onPickWorkflow={overlayPickNode
          ? (workflowId: string) => {
            patch(overlayPickNode, { workflowId });
            closeWorkflowOverlay();
          }
          : undefined}
        onClose={closeWorkflowOverlay}
        /* 库里那些「前往模型服务 / 设置 · 工作流配置」：不跳页，把设置那张浮层切到那一页（见 CanvasOverlay 的 onHref）。 */
        onGotoSetting={href => { setSettingsTab(href); setOverlay('settings'); }}
      />
    )}
    {overlay === 'settings' && (
      <CanvasSettingsPanel tab={settingsTab} onTab={setSettingsTab} onClose={() => setOverlay(null)} />
    )}
    {overlay === 'history' && (
      <CanvasHistoryPanel
        projectId={projectId}
        runs={allRuns}
        nodeIds={nodeIds}
        onClose={() => setOverlay(null)}
        /* 点一项 = 回到生成它的那个节点。节点已经删了就不跳 —— 记录还在，只是没地方可去。 */
        onPick={nodeId => {
          setOverlay(null);
          if (!nodeId) return;
          if (!nodes.some(node => node.id === nodeId)) {
            setNotice('生成它的那个节点已经删掉了 —— 这条记录留在历史里。');
            return;
          }
          setSelected(nodeId);
          focusNode(nodeId);
        }}
      />
    )}
    {overlay === 'skill' && (
      <CanvasSkillPanel
        onClose={() => setOverlay(null)}
        /* 选完直接把 Codex 侧栏打开并挂上 —— 不然用户还得自己再点一次入口。 */
        onUseInCodex={next => { setCodexSkill(next); setCodexOpen(true); }}
      />
    )}
    {directorFor && (() => {
      const node = nodes.find(item => item.id === directorFor);
      if (!node) return null;
      return (
        <DirectorPanel
          scene={readDirectorScene(node.data.directorScene)}
          onChange={next => patch(node.id, { directorScene: next })}
          onClose={() => setDirectorFor(null)}
          onSave={(dataUrl, next) => saveDirectorShot(node.id, dataUrl, next)}
        />
      );
    })()}

    {menu && menuGroups.length > 0 && (
      <CanvasContextMenu spec={menu} groups={menuGroups} onClose={() => { setMenu(null); setPendingLink(null); }} />
    )}

    {preview && (
      <div className="cv-lightbox" onClick={() => setPreview(null)}>
        {/*
         * 预览这一层现在要装三种东西（2026-10-02）。
         * 原来只有 `<img>`：**视频结果点「预览」本来就是一张打不开的坏图**（音频同理，
         * 这次一起修掉）。`onClick` 里 `stopPropagation` 是必须的 —— 不然在播放器上调
         * 进度条那一下会被当成「点遮罩关闭」，控件等于点不动。
         */}
        {isAudioUrl(preview)
          ? <div className="cv-lightbox-audio" onClick={event => event.stopPropagation()}>
            <audio src={preview} controls autoPlay />
          </div>
          : isVideoUrl(preview)
            ? <video src={preview} controls autoPlay onClick={event => event.stopPropagation()} />
            : <img src={preview} alt="参考图预览" />}
        <span>点击任意处或按 Esc 关闭</span>
      </div>
    )}
  </div>;
}

/**
 * 把本机 ComfyUI 的实时进度说成人看得懂的一句话。
 *
 * ComfyUI 在 WebSocket 上给的是三样零碎：`executing`（跑到哪个节点编号）、
 * `progress`（value / max 两个裸数字）、`status`（队列里还剩几个）。
 * 直接把它们拼给用户看等于什么都没说 —— 这里统一成「排队中 / 正在跑 KSampler #3 · 42%」。
 */
function describeLocalProgress(progress: {
  nodeId?: string; nodeType?: string; value?: number; max?: number; queueRemaining?: number;
}): string {
  const remaining = Number(progress?.queueRemaining);
  if (Number.isFinite(remaining) && remaining > 0) return `排队中 · 前面还有 ${remaining} 个`;
  const where = [String(progress?.nodeType || ''), progress?.nodeId ? `#${progress.nodeId}` : '']
    .filter(Boolean).join(' ');
  const value = Number(progress?.value);
  const max = Number(progress?.max);
  if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
    return `正在跑${where ? ` ${where}` : ''} · ${percent}%`;
  }
  return where ? `正在跑 ${where}` : '本机 ComfyUI 正在生成…';
}

export default function CanvasEditor(props: {
  projectId: string;
  projectName?: string;
  initial: CanvasPayload;
  /** 首页带过来的完整预设（含 `mode`）。没有它才回落到下面那条「只看一句话」的老路。 */
  seed?: CanvasSeed | null;
  seedPrompt?: string;
}) {
  return <ReactFlowProvider><Studio {...props} /></ReactFlowProvider>;
}
