'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Handle, NodeResizeControl, Position, useNodeId, useStore } from '@xyflow/react';
import { Move3d, Play, Sparkles, TriangleAlert } from 'lucide-react';
import type { NodeData, ParamRow } from './types';
import { nodeTintVars } from '@/lib/appearance';
/* 创作预设（2026-10-06）：卡片上那几颗「已选」角标。 */
import { CREATIVE_KIND_LABEL, creativePicksFrom, picksOf } from './creativePresets';
import {
  LATENT_SLOTS, NODE_META, NODE_SIZE,
  isAudioUrl, isGeneratorKind, isLatentKind, isPinnedUploadKind, isVideoUrl, latentAssetPrefix, latentBrokenHint, latentLabel,
  paramRowLabel, uploadFieldOf, uploadNodeIdOf,
  usesGenerateDock, workflowDisplayName, workflowIdNote, displayLabelOf,
  readUpscaleMode, readUpscaleSource,
  upscalePurposeOfNode, upscaleSourceOfNode,
  upscaleFollowsConnection, upscaleFollowedLabel, upscaleFollowedSide, upscaleTargetOfNode,
} from './nodeMeta';
import { readLastUpscaleWorkflow } from '@/lib/upscaleMemory';
import type { NodeKind } from './nodeMeta';
import { NodeGlyph } from './nodeIcons';
import NodeParamBar from './NodeParamBar';
import StarFlow from '@/components/ui/StarFlow';

/**
 * RunningHub-style node card: a title bar plus a frame that previews content.
 *
 * ⚠️ 2026-09-20：**只有「文本」这一种节点**（2026-09-29 之前叫「文本提示词」）把正面做成了「点两下就写」的文本框，
 * 其余节点一律保持原样（正面 = 预览，参数仍然由选中时浮在卡片下方的参数条提供）。
 *
 * 中途试过「选中就把整个正面换成参数区」，被用户否掉了 —— 那版连文本框的外观
 * 一起换掉了，而他要的只是「外观不变、点第二下能打字」。别再把那套加回来。
 *
 * 文本框的三条规矩写在 `.cv-node-textbox` 那段 CSS 里（为什么不能自己实现双击、
 * 为什么外观必须恒定），动它之前先看那段。
 *
 * 没有文字时**不留占位提示**：空框自己就说明了「这里可以打字」。
 * 同一条规矩推广到**所有空画框**（2026-09-20）：不写字、不画虚线，只留一个撑住高度的空框。
 * 只有「正在上传 / 正在生成 / 失败」这类**状态**还留在框里 —— 那不是提示，去掉就看不到发生了什么。
 *
 * 拖动节点**不算点击**：React Flow 在 drag-start 就把节点选上了，而拖完那一下 click
 * 会被 d3-drag 抑制掉。所以「点两下才写字」的第一下只认**一次真的 click**（`armed`），
 * 拖完仍然停在「还差第一下」。详见组件里那段。
 */
/** 指针走过这么多像素就算「在挪节点」，不算点击。留一点余量，手抖不算。 */
const DRAG_SLOP_PX = 5;

/** 文本框里拖选文字、参数浮层里拖滑块 —— 那都不是「移动节点」，不参与点击记账。 */
const isInnerGesture = (target: EventTarget | null) =>
  !!target && !!(target as HTMLElement).closest?.('.cv-node-textbox, .cv-param-bar');

export default function NodeCard({ data, selected }: { data: NodeData; selected?: boolean }) {
  const kind = (data.kind || 'text') as NodeKind;
  /** 自己的 id —— 「跟随连出去的那个节点」要从这里出发顺着线找（`useNodeId` 是 React Flow 给的）。 */
  const nodeId = useNodeId() || '';
  const meta = NODE_META[kind];
  const running = data.status === 'running';
  const imageSource = data.imageUrl || data.previewUrl;
  const videoSource = String(data.videoUrl || data.videoRemoteUrl || '');
  const audioSource = String(data.audioUrl || data.audioRemoteUrl || '');
  /** 首尾帧节点那两张图。空 = 还没提取（或这一轮没提取出来）。 */
  const firstFrame = String(data.firstFrameUrl || '');
  const lastFrame = String(data.lastFrameUrl || '');
  /**
   * 取用开关：这两张里哪几张会喂给下游生成。
   *
   * 没取用的那张**照旧显示**（提取出来就是为了看），但要画成不参与的样子 ——
   * 否则「卡片上明明有尾帧，生成却没用它」又是一个说不清的坑。
   */
  const framePick = String(data.framePick || 'both') as 'first' | 'last' | 'both';
  const frameUsed = (which: 'first' | 'last') => framePick === 'both' || framePick === which;
  /** 生成节点上「正在用的首帧 / 尾帧」：由上游首尾帧节点的「取用」开关决定（2026-09-21）。 */
  const frameInFirst = String(data.frameInFirst || '');
  const frameInLast = String(data.frameInLast || '');
  const archived = data.latents || [];
  const latentValue = String(data.remoteFile || '');
  const selectedLatent = archived.find(item => `${latentAssetPrefix}${item.id}` === latentValue);
  const latentOn = data.latentEnabled !== 'off';
  /** latent 链断了要把原因写在卡片上 —— 这是状态，不是提示。 */
  const latentBroken = latentBrokenHint(data.relayBroken);
  /** 中转节点自己没选值时透传上游 latent，卡片上要说明这值是「借来的」。 */
  const relayValue = String(data.relayValue || '');
  const relayFrom = String(data.relayFrom || '');
  /** 这一轮真正会交出去的**份数**（含自动配对）—— 只写「透传」的话一份两份看不出来。 */
  const relayCount = (data.relayValues || []).filter(Boolean).length || (relayValue ? 1 : 0);
  /* 「指定节点上传」的三样：落点节点号、字段名、以及这份媒体是图还是视频。 */
  const pinnedNodeId = isPinnedUploadKind(kind) ? uploadNodeIdOf(data) : '';
  const pinnedFieldName = isPinnedUploadKind(kind) ? uploadFieldOf(data.mediaKind, data.uploadFieldName) : '';
  const pinnedMediaLabel = data.mediaKind === 'video' ? '透传视频' : '透传图片';
  const pinnedBroken = String(data.relayBroken || '') as 'cycle' | 'upstream' | '';
  const latentIndexes = (data.latentIndexes || []).filter(index => index >= 1 && index <= LATENT_SLOTS);
  /*
   * 已选的创作预设（2026-10-06）—— 卡片底部那几颗小角标，形如「风格 · 暖阳赛璐璐CG」。
   * 只显示**选了的那几档**（没选的不占位置）。
   */
  const creativeTags = picksOf(creativePicksFrom(data))
    .map(item => `${CREATIVE_KIND_LABEL[item.kind]} · ${item.name}`);
  const chosenWorkflow = (data.workflows || []).find(item => item.workflowId === String(data.workflowId || ''));
  /** Generated video urls must not be rendered as an image. */
  const resultValue = String(data.resultUrl || '');
  const resultIsVideo = !!resultValue && isVideoUrl(resultValue);
  /** 音频同样不能当图片画 —— 见 `nodeMeta.ts` 里 `isAudioUrl` 那条注释。 */
  const resultIsAudio = !!resultValue && isAudioUrl(resultValue);
  const resultImage = resultValue && !resultIsVideo && !resultIsAudio ? resultValue : '';
  /**
   * 音频结果的正面：一条播放器，不是 `<img>`、也不是 16:9 的黑框。
   * ⚠️ 下面那两个 `kind === '…-generate'` 分支原来是「不是视频就当图片」写的，
   * 漏了音频那一支的话，出音频之后卡片正面是一张**打不开的坏图**（零报错）。
   */
  const audioFace = <div className="cv-audio nodrag"><audio src={resultValue} controls preload="metadata" /></div>;
  /**
   * 文字结果的正面（2026-10-04）。
   *
   * 出文本的应用 / 节点根本没有文件可以画，正面留个空框等于「跑完了但什么都没发生」。
   * 用 `<pre>`（换行、空格原样保留）而**不是** `<textarea>`：这一份只给人看和选，
   * `<textarea>` 会让人以为能在这里改，改完却不会进结果。
   * `nodrag` 不能省 —— 不然一选中文字就把节点拖走了。
   */
  const textResult = String(data.textResult || '').trim();
  const textFace = textResult
    ? <div className="cv-text-result nodrag" title="本次结果是一段文字（资产库里另存了一份 .txt）"><pre>{textResult}</pre></div>
    : null;
  const outputImage = resultImage || String(data.passthroughImage || '');
  const text = String(data.text || '').trim();
  const paramRows = (data.paramRows || []) as ParamRow[];
  const paramOn = paramRows.filter(row => row.enabled && row.value);
  const upstreamStatus = String(data.upstreamStatus || 'idle');
  const upstreamResult = String(data.upstreamResult || '');
  /** Short status strip under the frame — errors and upload results must be visible on the node itself. */
  const statusValue = String(data.status || '');
  const statusText = String(data.result || '').trim();
  const statusKind = statusValue === 'failed' ? 'bad' : statusValue === 'running' || statusValue === 'uploading' ? 'busy' : 'ok';
  /** 用户拖过的尺寸；没拖过时交给 CSS 的默认宽高，DOM 上不写死。 */
  const sizedWidth = Number(data.width) > 0 ? Math.round(Number(data.width)) : undefined;
  const sizedHeight = Number(data.height) > 0 ? Math.round(Number(data.height)) : undefined;
  /**
   * 导入素材那一档的「跟随」跟的是**连出去的那个节点**的引擎（徐先 2026-10-04）：
   * 「超清工作流引擎跟随连接的节点；如果没有，默认使用上一次超清的工作流」。
   * 顺线找在 `upscaleFollowedSide` / `upscaleFollowedLabel` 里（纯函数，在 lib）。
   *
   * ⚠️ 两个选择器**必须只返回字符串**（那边和节点名字）：返回对象的话每次 store 变化
   * 都是新引用，拖一下节点就整屏重渲染。不是导入素材的节点直接短路，连 store 都不读。
   */
  const followsConnection = upscaleFollowsConnection(kind);
  const followedSide = useStore(state => (followsConnection ? upscaleFollowedSide(nodeId, state.nodes, state.edges) : ''));
  const followedFrom = useStore(state => (followsConnection ? upscaleFollowedLabel(nodeId, state.nodes, state.edges) : ''));
  /**
   * 右上角「超清」按钮用不用得上。四个条件缺一不可：
   * 这个节点身上有一份能加工的媒体（生成节点是它自己的结果，**图片输入 / 视频输入节点是
   * 它自己那份图 / 视频** —— 2026-10-03 起导入的素材也能超清）、它确实有那份媒体、
   * 这一节点没把超清关掉（参数条上那个胶囊能选「关闭 / 手动 / 自动」，2026-10-02）、
   * 以及**这一趟真能挑出一份**工作流（挑法统一在 `upscaleTargetOfNode`）。
   */
  const upscalePurpose = upscalePurposeOfNode(kind);
  const upscaleSource = upscaleSourceOfNode(data);
  const upscaleMode = readUpscaleMode(data.upscaleMode);
  const upscaleTarget = upscalePurpose && upscaleSource && upscaleMode !== 'off'
    ? upscaleTargetOfNode(data, data.workflows || [], followedSide, readLastUpscaleWorkflow(upscalePurpose))
    : undefined;

  /**
   * 「点两下才写字」的**第一下**，必须是一次真的 click，不能是「拖完节点」顺带来的选中。
   *
   * React Flow 在 drag-start 就把节点选上了（`selectNodesOnDrag` 默认开），而拖完那一下
   * click 会被 d3-drag 抑制掉（`nodeClickDistance` 默认 0 —— 指针动过就不算 click）。
   * 于是「拖动」天然产生不了 click：这里只要**只在 click 里记账**，拖完就仍然停在
   * 「还差第一下」，用户得再点一次才进编辑。
   *
   * `onPointerUp` 那一步是兜底：正在编辑时又拖了一把节点（挪开看后面的东西），
   * 同样不该把「已经点过第一下」这个状态带过去。
   */
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * 「点一下展开节点信息，再点一下才预览」（2026-09-25，徐先）：
   * 图片生成好之后点节点，第一下必须只是「选中 + 展开信息面板」，不能直接跳图片预览；
   * 节点已经选中的那次按压，点正面图片才开灯箱。
   *
   * ⚠️ 不能在 click 里直接读 `selected` 判断「是不是第二下」：React Flow 在 mousedown
   * 就选中节点，React 往往在 click 派发前就重渲染完了 —— 第一下的 click 里
   * `selected` 已经是 true，挡不住。pointerdown 早于 RF 的 mousedown，所以在
   * onPointerDown 里记一份「按下那一刻选中了没有」，click 只认这份快照。
   */
  const pressSelectedRef = useRef(false);
  /** 改尺寸这一拖中间到底有没有真的调过 `onResize`（撤销栈的「这一下算不算一步」就看它）。 */
  const resizing = useRef(false);
  /** 正面图片的点击门卫：第一击永远留给「选中 + 展开信息」，已选中的按压才开预览。 */
  const previewIfSelected = (url: string) => () => {
    if (!pressSelectedRef.current) return;
    data.onPreview?.(url);
  };
  const [armed, setArmed] = useState(false);
  /** 取消选中就把第一下的记账清掉，下次选中重新从第一下开始。 */
  useEffect(() => { if (!selected) setArmed(false); }, [selected]);
  /** 文本框真的可以写：选中 **且** 这个选中不是拖动换来的。 */
  const writable = !!selected && armed;
  /**
   * 这一颗被上游（文本 / 优化节点）接管了（2026-09-29）：
   * 正面展示的是上游那段文字，自己的那份此刻不生效 —— 所以改成只读，
   * 免得出现「明明改了字、生成出去的还是上游那句」。
   */
  const linkedText = kind === 'text' && !!String(data.textFrom || '').trim();
  /** 被绕过（2026-09-29）：只当管子，不做自己那份活。灰化 + 角标都靠它。 */
  const bypassed = !!data.bypassed;

  /**
   * 优化提示词节点卡片上那颗「运行」按钮能不能按（2026-09-29 徐先：「添加运行按钮」）。
   *
   * 没有可改写的输入（上游那句和自己改写过的那份都没有）时
   *   **必须禁用并说清原因** —— 给一个点了只会报错的按钮，等于在骗用户。
   * 被绕过了也一样：那一轮根本不跑它。
   */
  const optimizeInput = String(data.textValue || data.optimizedText || '').trim();
  /*
   * 左边接了**图**就走「看图反推」（2026-10-03）—— 那种情况下它不需要一句待改写的文本，
   * 所以「有图」也算「有得跑」；少这一档的话，接了图片的优化节点上那颗按钮是灰的，
   * 而用户看着卡片上明明有张图。
   */
  const hasMediaInput = !!String(data.mediaValue || '').trim();
  /* 视频走的是「抽若干帧再看」那条路：界面上要说清，不然他不知道为什么这次会慢一点。 */
  const isVideoInput = data.mediaKind === 'video';
  const canOptimize = kind === 'prompt-optimize' && (hasMediaInput || !!optimizeInput) && !bypassed;
  const optimizeHint = bypassed
    ? '这个节点被绕过了 —— 按 B 取消绕过才跑得起来'
    : isVideoInput
      ? '运行：看着左边这段视频抽出来的几帧，写出一段能直接喂给生成模型的提示词'
      : hasMediaInput
        ? '运行：看着左边这张图，写出一段能直接喂给生成模型的提示词'
        : optimizeInput
          ? '运行：把上游这句改写成能直接喂给生成模型的提示词'
          : '先接一个文本节点（改写）或图片 / 视频节点（反推）到它左边';

  /**
   * 节点标题重命名（2026-09-27，徐先）：双击标题进入编辑态，写回 `data.label`。
   * 与文本节点的 `armed/writable` 相互独立 —— 标题编辑不依赖「选中 + 点两下」，
   * 双击随时可进；编辑中给输入框加 `nodrag`、在它自己的指针事件上 stopPropagation，
   * 既不抢节点的拖动、也不被拖动记账干扰。
   */
  const [editingTitle, setEditingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  /** 进入编辑态：聚焦并把原有名字全选，方便直接改或覆盖。 */
  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      const el = titleInputRef.current;
      el.focus();
      el.select();
    }
  }, [editingTitle]);

  /**
   * 空画框：不写字、不画虚线（2026-09-20）。空框本身就说明「这里还没内容」，
   * 再补一句「选中节点后配置并生成」只是在占地方；虚线框是给提示配套的，一起去掉了。
   * `min-height` 必须留着 —— 它是未选中时节点高度的来源，去掉节点会塌成一条。
   */
  /*
   * 空画框里画出这个节点类型的大图标（2026-09-21）。
   * 「空框不写字」那条规矩照旧 —— 图标说的不是「这里该干什么」，而是「这是个什么节点」，
   * 而这件事在卡片正面本来就该看得见（此前只有标题行上那个 13px 的小图标）。
   * 文本节点例外：它的正面是能直接打字的框，压一个图标只会挡视线。
   */
  /*
   * 光点汇聚那一层（只在等待时出现）。
   *
   * 点本身、那张固定种子表、怎么动，全在 `components/ui/StarFlow.tsx` + `star-flow.css` ——
   * 2026-10-03 徐先「这里的生成界面也改为小圆点的汇集」之后，图片生成页也用同一层，
   * 就从这儿抽出去了，**别在本地再写一份种子表**（写回来就是两份，改一边忘一边）。
   * 这个文件里只负责**套一个宿主框**：`.cv-node-empty.stars` 给定位、裁剪和点色。
   */
  const starFrame = (
    <div className="cv-node-empty stars" aria-hidden>
      <StarFlow />
    </div>
  );

  /** 等待中 = 生成 / 上传。完事（或失败）之后这一层自动消失，回落到静态图标。 */
  const awaiting = statusValue === 'running' || statusValue === 'uploading';

  const emptyFrame = kind === 'text'
    ? <div className="cv-node-empty" aria-hidden />
    : awaiting
      ? starFrame
      /*
       * 空态那个图标原来 44px，徐先说「小一点」（2026-10-03，N-113）——
       * 44 在 128px 高的空框里几乎顶满，看着像个大按钮而不是「这里以后会有东西」。
       * 32 留出呼吸，和卡片标题栏那颗 13px 的层级关系也更正常。
       */
      : <div className="cv-node-empty glyph" aria-hidden><NodeGlyph kind={kind} size={32} /></div>;

  /**
   * 画框里只放**状态**：「正在上传 / 等待上游 / 失败」这类真的说明正在发生什么的话。
   * 没状态就回落到空框。
   */
  const placeholder = (hint?: string) => (hint
    ? <div className="cv-node-placeholder">
      <span>{hint}</span>
    </div>
    : emptyFrame);

  /** 生成节点接了输入但还没结果：以前这里写「已连接 N 个输入 / N 图」，现在同样是空框。 */
  const slotGrid = () => emptyFrame;

  /**
   * 生成节点上那排「正在用的首帧 / 尾帧」（2026-09-21）。
   *
   * 没有结果时画在正面：空框只能说明「还没生成」，说明不了「这次到底拿哪两张去生成」——
   * 续拍接错一张是不报错的，画出来才能在上游就看出来。有了结果就让位给结果。
   */
  const frameStrip = () => {
    const cells = [['首帧', frameInFirst], ['尾帧', frameInLast]] as const;
    const shown = cells.filter(([, url]) => url);
    if (!shown.length) return null;
    return (
      <div className="cv-frames in">
        {shown.map(([tag, url]) => (
          <div key={tag} className="cv-frame-cell">
            <img src={url} alt={tag} onClick={previewIfSelected(url)} />
            <span className="cv-frame-tag">{tag}</span>
          </div>
        ))}
      </div>
    );
  };

  const preview = kind === 'text'
    ? null
    : kind === 'image'
      ? (imageSource
        ? <div className="cv-thumb plain media">
          <img
            src={imageSource}
            alt="参考图"
            onClick={previewIfSelected(String(imageSource))}
            onLoad={event => data.onMeasure?.(`${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`)}
          />
        </div>
        : (data.status === 'uploading' ? placeholder('正在上传…') : emptyFrame))
      : isLatentKind(kind)
        ? (selectedLatent
          ? <div className="cv-node-info">
            <b>{selectedLatent.sequence}</b>
            <span>{selectedLatent.kind === 'fine' ? '精采样' : '粗采样'}</span>
            {latentIndexes.length ? <em>#{latentIndexes.join(' / #')}</em> : <em>{latentOn ? '已启用接续' : '已停用'}</em>}
          </div>
          : relayValue
            ? <div className="cv-node-info">
              {/* 🔴 份数要写在卡片上（2026-10-03）：一个中转节点能供两份，只写「透传」的话
                  供一份和供两份长得一模一样，他会以为「才穿了一个到下游」。 */}
              <b>{relayCount > 1 ? `透传 ${relayCount} 份` : '透传'}</b>
              {/* 卡片上只放得下两行（CSS 里封的），完整名字走 `title` —— 那是个没有空格的长文件名，截断了没法自己拼回来。 */}
              <span title={relayFrom || undefined}>{relayFrom || '上游 latent'}</span>
              {latentIndexes.length ? <em>#{latentIndexes.join(' / #')}</em> : <em>{latentOn ? '已启用接续' : '已停用'}</em>}
            </div>
            : latentOn
              /**
               * 链断了的时候要把原因写在卡片上：这种情况下用户多半正在反复上传文件，
               * 而问题根本不在文件上。`relayBroken` 只在解析不出值时才带得上来。
               * 没断就不写字 —— 空框自会说明「这里还没接上」。
               */
              ? (latentBroken ? placeholder(latentBroken) : emptyFrame)
              : placeholder('该 latent 节点已停用'))
        /*
         * 「指定节点上传」（2026-10-05 徐先）：与 latent 中转同形 —— 自己不产媒体，
         * 交下去的是上游那份；不同的是它还能**额外**指定「写进工作流的哪个节点」。
         *
         * 🔴 卡片上必须能一眼看出**落点填没填**：没填就是一根管子（跟没加这个节点一样），
         * 填了才真的往工作流里多写一条。这两档在别的界面上长得完全一样，
         * 分不清就会出现「以为指定了、其实什么都没写」的静默失败。
         */
        : isPinnedUploadKind(kind)
          ? (relayValue
            ? <div className="cv-node-info">
              <b>{pinnedMediaLabel}{pinnedNodeId ? ` → 节点 ${pinnedNodeId}` : ' · 纯透传'}</b>
              {/* 完整名字走 `title`：那是个没有空格的长名，截断了没法自己拼回来。 */}
              <span title={relayFrom || undefined}>{relayFrom || '上游'}</span>
              {/* 没填号时这句话是唯一能说明「它现在只是一根管子」的地方。 */}
              <em>{pinnedNodeId ? `.${pinnedFieldName}` : '未指定节点'}</em>
            </div>
            : placeholder(pinnedBroken === 'cycle' ? '连线成环' : pinnedBroken === 'upstream' ? '左边还没接媒体' : '上游还没有媒体'))
        : kind === 'workflow'
          ? (chosenWorkflow
            ? <div className="cv-node-info">
              {/* 卡片上显示**名字**（没起名字回落编号）：老画布上这个节点唯一的作用就是说明用的是哪份工作流。 */}
              <b>{workflowDisplayName(chosenWorkflow)}</b>
              <span>{chosenWorkflow.isDefault ? '默认工作流' : '自定义工作流'}{workflowIdNote(chosenWorkflow)}</span>
              <em>{chosenWorkflow.enabledCount} / {chosenWorkflow.totalCount} 项启用</em>
            </div>
            : emptyFrame)
          : kind === 'params'
            ? (paramRows.length
              ? <div className="cv-node-params">
                <b>{paramOn.length} / {paramRows.length} 行生效</b>
                {paramRows.slice(0, 4).map(row => (
                  <span key={row.id} className={`cv-chip ${row.enabled && row.value ? '' : 'off'}`} title={`${row.nodeId}.${row.fieldName} = ${row.value}`}>
                    {paramRowLabel(row)}
                    <em>{row.nodeId}.{row.fieldName}</em>
                  </span>
                ))}
                {paramRows.length > 4 && <span className="cv-note">还有 {paramRows.length - 4} 行</span>}
              </div>
              : emptyFrame)
            : kind === 'video-generate'
            ? (resultValue
              ? (resultIsVideo
                ? <video className="cv-video nodrag" src={resultValue} controls preload="metadata" />
                : resultIsAudio
                  ? audioFace
                  : <div className="cv-thumb media">
                    <img src={resultValue} alt="生成结果" onClick={previewIfSelected(resultValue)} />
                    <span className="cv-badge">生成结果</span>
                  </div>)
              : (textFace || frameStrip() || slotGrid()))
            : kind === 'image-generate' || kind === 'app-generate'
              ? (resultValue
                ? (resultIsVideo
                  ? <video className="cv-video nodrag" src={resultValue} controls preload="metadata" />
                  : resultIsAudio
                    ? audioFace
                    : <div className="cv-thumb media">
                      <img src={resultValue} alt="生成结果" onClick={previewIfSelected(resultValue)} />
                      <span className="cv-badge">生成结果</span>
                    </div>)
                : (textFace || frameStrip() || slotGrid()))
            : kind === 'video-input'
              ? (videoSource
                ? <video className="cv-video nodrag" src={videoSource} controls preload="metadata" />
                : (data.status === 'uploading' ? placeholder('正在上传…') : emptyFrame))
            : kind === 'frame-extract'
              ? (firstFrame || lastFrame
                ? <div className="cv-frames">
                  {([['首帧', firstFrame], ['尾帧', lastFrame]] as const)
                    .filter(([, url]) => url)
                    .map(([tag, url], index) => (
                      <div key={tag} className={`cv-frame-cell${frameUsed(index === 0 ? 'first' : 'last') ? '' : ' off'}`}>
                        <img src={url} alt={tag} onClick={previewIfSelected(url)} />
                        <span className="cv-frame-tag">{tag}</span>
                      </div>
                    ))}
                </div>
                /* 没提取出来就是空框：那句「接一段视频」是提示，不是状态，按规矩不写（见文件头）。 */
                : (data.status === 'running' ? placeholder('正在提取首尾帧…') : emptyFrame))
            : kind === 'audio-input'
              ? (audioSource
                ? <div className="cv-audio nodrag"><audio src={audioSource} controls preload="metadata" /></div>
                : (data.status === 'uploading' ? placeholder('正在上传…') : emptyFrame))
            : kind === 'video'
              ? (resultValue
                ? <video className="cv-video nodrag" src={resultValue} controls preload="metadata" />
                : upstreamStatus === 'running'
                  ? <div className="cv-node-placeholder waiting">
                    <span className="cv-node-placeholder-icon"><Play size={22} strokeWidth={1.5} aria-hidden /></span>
                    <span>{`${data.upstreamLabel || '上游生成'} 正在生成…`}</span>
                  </div>
                  : upstreamStatus === 'failed'
                    ? <div className="cv-node-placeholder warn">
                      <span className="cv-node-placeholder-icon"><TriangleAlert size={22} strokeWidth={1.5} aria-hidden /></span>
                      <span>{upstreamResult || '上游生成失败'}</span>
                    </div>
                  : emptyFrame)
              : kind === 'image-out'
                ? (outputImage
                  ? <div className="cv-thumb media">
                    <img src={outputImage} alt="图片输出" onClick={previewIfSelected(String(outputImage))} />
                    <span className="cv-badge">{resultImage ? '生成结果' : '上游图片'}</span>
                  </div>
                  : upstreamStatus === 'running'
                    ? <div className="cv-node-placeholder waiting">
                      <span className="cv-node-placeholder-icon"><Play size={22} strokeWidth={1.5} aria-hidden /></span>
                      <span>{`${data.upstreamLabel || '上游生成'} 正在生成…`}</span>
                    </div>
                    : emptyFrame)
            : kind === 'director'
              ? (imageSource
                ? <div className="cv-thumb plain media">
                  <img
                    src={imageSource}
                    alt="构图参考图"
                    onClick={previewIfSelected(String(imageSource))}
                  />
                </div>
                : emptyFrame)
            : kind === 'prompt-optimize'
              /* 没跑过时 `textValue` 是上游原句：卡片上照实显示「这一刻会交出去的那句」，不是空白。 */
              ? (String(data.optimizedText || data.textValue || '').trim()
                ? <div className="cv-node-textbox">
                  <textarea
                    className="cv-node-textarea nodrag nowheel"
                    value={String(data.optimizedText || data.textValue || '')}
                    readOnly
                    spellCheck={false}
                    aria-label={data.optimizedText ? '优化后的提示词' : '上游原文（还没改写）'}
                  />
                </div>
                : data.status === 'running'
                  ? placeholder(isVideoInput ? '正在看视频反推…' : hasMediaInput ? '正在看图反推…' : '正在改写提示词…')
                  /* 左边接了图、还没反推过：画框里就放**那张图** —— 空框说明不了「这次看的是哪一张」。 */
                  : hasMediaInput && !isVideoInput
                    ? <div className="cv-thumb plain media">
                      <img
                        src={String(data.mediaValue)}
                        alt="待反推的图"
                        onClick={previewIfSelected(String(data.mediaValue))}
                      />
                    </div>
                    /*
                     * 🔴 视频**不能**拿地址去喂 `<img>` —— 那会得到一张打不开的坏图。
                     * 这里给一句「按这段视频反推」：空框说明不了这次要看的是什么，
                     * 而 `<video>` 塞进来只会是个黑框（还没有能播的封面）。
                     */
                    : hasMediaInput
                      ? placeholder('按这段视频反推提示词')
                      : emptyFrame)
                : null;

  /**
   * 正面是不是「就是一份媒体」：结果图 / 结果视频 / 输入图 / 输入视频（2026-09-23）。
   *
   * 是的话画框不留内边距、媒体也不套第二层描边 —— 图直接铺到卡片边上，**卡片多高由这张图
   * 自己的宽高比定**（横图矮、竖图高）。以前固定 `max-height:200 + contain`，竖图两侧各留
   * 一条黑边，再叠上画框那圈 10px 留白，就成了「没铺满 + 边框很宽」。
   *
   * 样式那半边写在 canvas.css 的 `.cv-node-frame.media` 那段，这里只负责说清「是哪种正面」；
   * 别把这套加到文本 / 参数 / latent 节点上 —— 它们的留白是内容需要的。
   *
   * ⚠️ 2026-09-24：**媒体正面不吃用户拖出来的高度**。徐先的原话是「不是图片适应边框，
   * 是边框适应图片」——画框高一点，图就该跟着长一点，而不是缩进去两侧留黑边。
   * 所以下面 `sizedHeight` 对媒体正面一律作废（连 `sized-h` 类都不加），
   * 而且右下角那颗把手改成 `resizeDirection="horizontal"`：只让改宽度。
   */
  const mediaFace = kind === 'image' || kind === 'director'
    ? !!imageSource
    : kind === 'video-input'
      ? !!videoSource
      : kind === 'image-out'
        ? !!outputImage
        : kind === 'image-generate' || kind === 'video-generate' || kind === 'video'
          || kind === 'app-generate'
          ? !!resultValue
          : false;

  /*
   * 端口（连线圆点）的垂直中点要跟**画框**走，不跟「标题条 + 画框」的整体走。
   *
   * 徐先 2026-09-25：「连接口位于中间位置，现在明显偏上」。量的结果：端口原来挂在
   * 卡片根上，top:50% 是「标题条(26px) + 下边距(6px) + 画框」整体的中心 ——
   * 比画框自己的中心固定高出门框那一半（16px），画框越高偏得越碍眼。
   *
   * 修法：非媒体节点把 Handle 渲染进 .cv-node-frame（它有 position:relative、
   * 没有 overflow:hidden，绝对定位的把手不受网格布局影响），top:50% 就是画框正中。
   * 媒体画框有 overflow:hidden，塞进去外环会被裁掉 —— 而媒体画框上下对称内收、
   * 节点中心本来就是画框中心，保持挂在卡片根上即可。
   */
  const inputHandle = meta.input ? <Handle type="target" position={Position.Left} /> : null;
  const outputHandle = meta.output ? <Handle type="source" position={Position.Right} /> : null;

  /**
   * 这一个节点自己挑的卡片色（2026-10-01）。
   *
   * 没挑过（`data.color` 为空）= **一个变量都不往 DOM 上写** —— 卡片照旧吃设置里
   * 那支全局「卡片底色」。写上去反而是错的：那会把「跟随全局」变成「钉死在现在的全局值上」，
   * 用户回头改设置，这个节点不跟着变。
   */
  const nodeTint = data.color ? nodeTintVars(data.color) : undefined;

  return (
    <div
      /* 类型色（2026-10-07 方向 D，DESIGN.md §3.3）：只给 CSS 认，用来画卡片顶上那条
         2px 的类型条和标题里的图标色 —— 一眼分清这条链上都是什么节点。
         ⚠️ 它是**内容层**的色，不参与界面 chrome：面板 / 顶栏 / 按钮仍全是中性灰。 */
      data-kind={kind}
      className={`cv-node ${selected ? 'selected' : ''} ${running ? 'running' : ''} ${sizedWidth ? 'sized-w' : ''} ${!mediaFace && sizedHeight ? 'sized-h' : ''} ${writable && kind === 'text' ? 'editing' : ''} ${bypassed ? 'bypassed' : ''}`}
      /* 正面是媒体：高度不写死 —— 交给图自己的宽高比，画框永远贴着图（2026-09-24）。 */
      style={{ width: sizedWidth, height: mediaFace ? undefined : sizedHeight, ...nodeTint } as CSSProperties}
      onPointerDown={event => {
        pressSelectedRef.current = !!selected;
        pressRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={event => {
        const start = pressRef.current;
        pressRef.current = null;
        if (!start || isInnerGesture(event.target)) return;
        const moved = Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y);
        // 走这么远就是在挪节点，不是点击 —— 把「已经点过第一下」的记账收回来。
        if (moved > DRAG_SLOP_PX) setArmed(false);
      }}
      onClick={event => {
        if (isInnerGesture(event.target)) return;
        setArmed(true);
      }}
    >
      {/* 右下角的拖拽把手：只在悬停或选中时显形，平时不打扰。 */}
      {data.onResize && (
        <NodeResizeControl
          position="bottom-right"
          className="cv-resize"
          minWidth={NODE_SIZE.minWidth}
          minHeight={NODE_SIZE.minHeight}
          maxWidth={NODE_SIZE.maxWidth}
          maxHeight={NODE_SIZE.maxHeight}
          /*
           * 正面就是一份媒体时**只让改宽度**：高度不归用户定，由这张图的宽高比定。
           * 这样「边框适应图片」永远成立 —— 拖成什么样、画布缩放到多少，都在图上等比例长。
           */
          resizeDirection={mediaFace ? 'horizontal' : undefined}
          /*
           * 改尺寸是**连续**手势：开始留一份快照，松手才决定记不记这一步。
           * `resizing` 记的是「这一拖中间到底有没有真的调过 `onResize`」——
           * 点一下把手就松开的话一次都不会调，那就不该算一步。
           */
          onResizeStart={() => { resizing.current = false; data.onResizeBegin?.(); }}
          onResize={(_event, size) => {
            resizing.current = true;
            if (mediaFace && data.onResizeWidth) { data.onResizeWidth(Math.round(size.width)); return; }
            data.onResize?.(Math.round(size.width), Math.round(size.height));
          }}
          onResizeEnd={() => data.onResizeFinish?.(resizing.current)}
        >
          <span className="cv-resize-grip" aria-hidden />
        </NodeResizeControl>
      )}

      {/* 媒体画框裁内容，把手留在卡片根上（那边的画框本来就居中） */}
      {mediaFace && inputHandle}

      <div className="cv-node-head">
        <span className="cv-node-glyph"><NodeGlyph kind={kind} /></span>
        {editingTitle ? (
          <input
            ref={titleInputRef}
            className="cv-node-title-input nodrag"
            value={String(data.label || '')}
            placeholder={meta.label}
            spellCheck={false}
            aria-label="节点名称"
            onChange={event => data.onRename?.(event.target.value)}
            onBlur={() => setEditingTitle(false)}
            onPointerDown={event => event.stopPropagation()}
            onDoubleClick={event => event.stopPropagation()}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault();
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <span
            className="cv-node-title"
            title="双击重命名"
            onDoubleClick={event => {
              event.stopPropagation();
              setEditingTitle(true);
            }}
          >
            {displayLabelOf(data) || meta.label}
          </span>
        )}
        {running && <span className="cv-node-pulse" title="生成中" />}
        {/*
          「超清」按钮：把这份结果再加工一道。
          **平时不显形**（悬停或选中才出来）——生成节点上已经挤了标题、状态、参数条，
          再摆一个常驻按钮，用户扫一眼根本分不清哪个是干什么的。
          条件是「有结果 + 配了同用途的超清工作流 + 这一节点没把超清关掉」，缺哪个都不显示：
          显示一个点了只报错的按钮，等于在骗用户。
          自动那一档（参数条胶囊里选的）**也画这颗按钮** —— 自动跑的那一道失败了，
          用户总得有个地方再点一次，而不是只能重跑整段生成。
        */}
        {upscaleTarget && (
          <button
            type="button"
            className="cv-node-upscale nodrag"
            title={`用「${workflowDisplayName(upscaleTarget)}」把这份${upscalePurpose === 'video' ? '视频' : '图'}再加工一道（超清）`}
            aria-label="超清"
            disabled={running || !data.onUpscale}
            onClick={event => { event.stopPropagation(); data.onUpscale?.(); }}
          >
            <Sparkles size={13} strokeWidth={2} aria-hidden />
            <span>超清</span>
          </button>
        )}
        {/*
          导演台那个「打开舞台」的按钮**常驻**，不像「超清」那样只在悬停时显形：
          这个节点存在的唯一理由就是打开那块舞台，藏起来等于把节点变空。
        */}
        {kind === 'director' && (
          <button
            type="button"
            className="cv-node-director nodrag"
            title="打开 3D 导演台，摆站位和机位"
            aria-label="打开 3D 导演台"
            data-director-open=""
            onClick={event => { event.stopPropagation(); data.onOpenDirector?.(); }}
          >
            <Move3d size={13} strokeWidth={2} aria-hidden />
            <span>导演台</span>
          </button>
        )}
        {/*
          优化提示词节点的「运行」按钮（2026-09-29）。
          🔴 **常驻**，不像「超清」那样悬停才显形：这个节点存在的唯一理由就是跑一次改写，
             藏起来等于把节点变空（改之前得先选中它、再在参数条里找那个按钮）。
             参数条里那个「改写提示词」留着：调参数时顺手就在旁边，不用来回找。
        */}
        {kind === 'prompt-optimize' && (
          <button
            type="button"
            className="cv-node-run nodrag"
            title={optimizeHint}
            aria-label="运行"
            data-node-run=""
            disabled={running || !canOptimize || !data.onOptimize}
            onClick={event => { event.stopPropagation(); data.onOptimize?.(); }}
          >
            <Play size={12} strokeWidth={2.4} aria-hidden />
            <span>{running ? '改写中' : '运行'}</span>
          </button>
        )}
        {/* 类型标签在界面上不显示，只作为机器可读的节点类型标记保留 */}
        <span className="cv-node-kind" data-kind={kind}>{meta.tag}</span>
        {/*
          绕过角标（2026-09-29）。
          🔴 **必须画在节点上**（不能只靠灰化）：灰化也会被「未选中」「跑完了」这些状态糊弄过去，
          而「这个节点不干活」是一件必须一眼看得见的事 —— 不然用户看着一条完整的链，
          不理解为什么结果跟自己想的不一样。
        */}
        {bypassed && <span className="cv-node-bypass" data-node-bypass="" title="这个节点被绕过了：它不做自己那份活，上游的值直接传下去（按 B 取消）">绕过</span>}
      </div>

      {/*
       * 正面。**只有文本节点**在这里放一个常驻的 `<textarea>`：
       *   · 未选中（或刚拖完）= `readOnly` + 容器 `pointer-events: none`，外观与可编辑时完全一致；
       *   · 选中**且**这一下不是拖动换来的（`writable`）= 同一个控件恢复可交互，点进去就能打字。
       * 这是**同一个 textarea**，不是两个状态换着渲染 —— 换子树会丢光标位置，
       * 而且皮肤会跳一下，「点一下就写」的感觉就没了。
       *
       * 其余节点保持原样：正面就是预览（`preview`）。
       */}
      <div className={`cv-node-frame${mediaFace ? ' media' : ''}`}>
        {/* 非媒体节点：把手进画框 —— top:50% 就是画框正中（见上面 inputHandle 前的注释）。
            放在内容后面，事件优先落在把手上，画框里的东西不会被这层透明热区挡住点击。 */}
        {!mediaFace && inputHandle}
        {kind === 'text' ? (
          <div className={`cv-node-textbox${writable ? ' live' : ''}`}>
            <textarea
              className="cv-node-textarea nodrag nowheel"
              value={linkedText ? String(data.textValue || '') : String(data.text || '')}
              /* 🔴 只由「点两下进可写」决定，不再因为接了上游就锁死 ——
                 锁死的表现是「点进去光标不动」，用户只会以为框坏了。 */
              readOnly={!writable}
              spellCheck={false}
              aria-label="提示词"
              /*
               * 2026-09-29 起**接了上游也能改**：打下第一个字 = 把上游那条连线断开、
               * 那句从此归它自己（为什么必须断线，见 `types.ts` 里 `onText` 那条注释）。
               * 而**文本节点是不出参数条的**（下面 `kind !== 'text'` 那一句），
               * 所以「改了会发生什么」只能靠这一句 tooltip 说 —— 不然用户不知道线会断。
               */
              /* 接了多个上游时 `textFrom` 是「A、B」：这句话必须**同时**说清三件事
                 —— 来源是谁、按什么顺序拼的、中间隔了一行。少说一件，用户看着一段
                 拼好的字就只能猜（2026-09-29）。 */
              title={linkedText ? `这段来自上游「${String(data.textFrom || '')}」—— 按连线先后拼起来、中间空一行；打下第一个字就会断开上游连线，这句从此归它自己` : undefined}
              onChange={event => data.onText?.(event.target.value, { detachUpstream: linkedText })}
            />
          </div>
        ) : preview}
        {!mediaFace && outputHandle}
      </div>

      {statusText && <div className={`cv-node-status ${statusKind}`}>{statusText}</div>}
      {/*
        绕过角标只说「它不干活」，而**生成节点**被绕过还有一层后果：
        它是 latent / 结果图的生产者，绕过之后下游拿不到这一份产出 ——
        不写这句的话，用户看着一条完整的链，只看到「什么都没发生」。
        （这类静默失败是本工程最难查的一类：不报错、界面也不跳。）
      */}
      {bypassed && isGeneratorKind(kind) && (
        <div className="cv-node-status warn" data-node-bypass-note="">
          已绕过 —— 这一轮不跑它，下游拿不到它的产出
        </div>
      )}
      {/*
        已选创作预设（2026-10-06）—— 挂在卡片上而不是只在对话框里。
        对话框只在选中这个节点时出现，而「我这条链上到底挂了哪几档预设」是**扫一眼画布**
        就该看出来的事：换一条预设会明显改画面，看不到挂了什么就只能凭记忆。
        按钮那排已经说了「风格 · 暖阳赛璐璐CG」，这一行只为**没选中时**也看得到。
      */}
      {creativeTags.length > 0 && (
        <div className="cv-node-status preset" data-node-presets="">
          {creativeTags.map(item => <em key={item}>{item}</em>)}
        </div>
      )}

      {/*
       * 参数面板：选中节点时浮在卡片**下方**，和这次改动之前一样。
       *
       * ⚠️ 坐标是相对 `.cv-node`（它有 `position: relative`）算的，所以必须挂在这里，
       * 不能塞进 `.cv-node-frame`（那样 `top: calc(100% + 10px)` 会从画框底边起算，
       * 每次量出来的位置都会差一截）。
       *
       * ⚠️ **文本节点不给浮层**。它的正面已经是一个能直接写的文本框，
       * 浮层里那个提示词输入框就是同一个值的第二个入口 —— 多此一举，还会盖住下面一排节点。
       * 参数条上其余的说明（「这段文本会作为下游生成节点的提示词」）也已经在正面表达过了。
       */}
      {/*
        生成节点不给浮层了（2026-09-21）：它们的参数改在画布底部那个对话框里。
        判断走 nodeMeta 的 `usesGenerateDock` —— 与 CanvasEditor 抬出对话框用的是同一个判定，
        不然会出现「浮条收了、对话框也没出来」，这个节点就一个参数都改不了了。
      */}
      {selected && kind !== 'text' && !usesGenerateDock(kind)
        && <NodeParamBar data={data} followedSide={followedSide} followedFrom={followedFrom} />}

      {mediaFace && outputHandle}
    </div>
  );
}
