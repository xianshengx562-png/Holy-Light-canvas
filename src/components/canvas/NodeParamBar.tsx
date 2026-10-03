'use client';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Download, ImagePlus } from 'lucide-react';
import type { LatentPickOption, NodeData, ParamRow } from './types';
import {
  LATENT_ACCEPT, LATENT_SLOTS, NODE_META,
  groupWorkflowsByProvider, isAudioUrl, isLatentKind, isVideoUrl, latentAssetPrefix,
  latentBrokenHint, latentLabel, latentSlotHint, workflowLabel, displayLabelOf,
} from './nodeMeta';
import type { NodeKind } from './nodeMeta';
import { NodeGlyph } from './nodeIcons';
import ParamRowEditor from './ParamRowEditor';
import OptimizeOptions from './OptimizeOptions';
import LatentSlotPicker from './LatentSlotPicker';
import Link from 'next/link';

/** Slot display order inside the parameter bar: prompt first, then reference images, then the rest. */
const SLOT_ORDER: Record<string, number> = { text: 0, 'prompt-optimize': 0, image: 1, 'video-input': 1, 'frame-extract': 1, 'audio-input': 5, latent: 2, 'latent-relay': 2, workflow: 3, params: 4 };

/*
 * 参数区是一层**浮在卡片下方的浮层**（选中节点时出现），和改动之前一致。
 * 2026-09-20 中途试过「选中即替换节点正面」，用户否掉了：他要的只是文本节点
 * 点两下就能写字（那是 `.cv-node-textbox` 的活），其余节点不该跟着变。
 *
 * 两个仍然要注意的点：
 *
 * 1. `nodrag` / `nowheel` 要加在**具体控件**上，别加在整块外壳上。
 *    外壳加了 `nodrag`，里面所有东西（包括滚动区）都会失去默认手势。
 * 2. 内容会超过面板高度，所以中间那段包在 `.cv-param-body` 里，由它滚动。
 *
 * The bar carries `nodrag` on its controls so interacting with them never drags the node.
 */
/** 工作流下拉里那条「去库里挑」的哨兵值 —— 与 `GenerateDock` 同一个约定（不会撞真实 workflowId）。 */
const LIBRARY_OPTION = '__library__';

export default function NodeParamBar({ data }: { data: NodeData }) {
  const kind = (data.kind || 'text') as NodeKind;
  const meta = NODE_META[kind];
  const archived = data.latents || [];
  const workflows = data.workflows || [];
  const latentValue = String(data.remoteFile || '');
  const selectedLatent = archived.find(item => `${latentAssetPrefix}${item.id}` === latentValue);
  const imageSource = data.imageUrl || data.previewUrl;
  const resultImage = data.resultUrl && !isVideoUrl(data.resultUrl) && !isAudioUrl(data.resultUrl) ? String(data.resultUrl) : '';
  const outputImage = resultImage || String(data.passthroughImage || '');
  const latentOn = data.latentEnabled !== 'off';
  const running = data.status === 'running';
  const chosenWorkflow = workflows.find(item => item.workflowId === String(data.workflowId || ''));
  /**
   * The bar is wider than most cards, so a node near the right edge would push it off screen.
   * Decide the side from the **node** rect and the bar width only — never from the bar's own
   * position, otherwise the two states flip back and forth and React bails out with an
   * infinite-update error.
   */
  const barRef = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);
  useLayoutEffect(() => {
    const el = barRef.current;
    const node = el?.parentElement;
    if (!el || !node) return;
    const barWidth = el.getBoundingClientRect().width;
    if (!barWidth) return;
    const nodeRect = node.getBoundingClientRect();
    /** Measure against the canvas area, not the window: the inspector panel also eats width. */
    const stage = el.closest('.react-flow')?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth };
    const fitsRight = nodeRect.left - 18 + barWidth <= stage.right - 12;
    const fitsLeft = nodeRect.right + 18 - barWidth >= stage.left + 12;
    const next = !fitsRight && fitsLeft;
    if (next !== flip) setFlip(next);
  });

  const promptBox = (
    <textarea
      className="cv-param-input"
      value={data.text || ''}
      placeholder="描述你想要生成的内容"
      onChange={event => data.onText?.(event.target.value)}
    />
  );

  const shell = (top: ReactNode, tools?: ReactNode, above?: ReactNode, after?: ReactNode) => (
    <div className={`cv-param-bar nodrag ${flip ? 'flip' : ''}`} data-kind={kind} data-face="params" ref={barRef}>
      {/*
       * ⚠️ `nodrag` / `nowheel` 只加在**具体控件**上，不能加在标题行，更不能加在整块外壳上：
       * 参数区现在长在节点内部（`.cv-param-face`），是节点唯一可抓的地方。
       * 整块都 `nodrag` 的话标题栏的抓取区会被一起冻住 —— 表现成「这个节点拖不动了」。
       */}
      <div className="cv-param-title">
        <span className="cv-node-glyph"><NodeGlyph kind={kind} size={13} /></span>
        <span>{displayLabelOf(data) || meta.label}</span>
        <em>{meta.tag}</em>
      </div>
      {above}
      <div className="cv-param-body">
        <div className="cv-param-top nodrag nowheel">{top}</div>
        {tools && <div className="cv-param-tools nodrag nowheel">{tools}</div>}
      </div>
      {after}
    </div>
  );

  /** Connected upstream nodes, RunningHub style: the wired-in image shows up in the parameter bar.
   *  Text inputs stay on top, then images, then latent and workflow. */
  /** 参考图可以直接从槽位行末尾的「+」加进来，和截图里的虚线添加框一致 */
  /** Clipboard paste is the fastest path from screenshot to reference image. */
  const pasteFromClipboard = async () => {
    try {
      if (!navigator.clipboard?.read) throw new Error('unsupported');
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(kind => kind.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        data.onPasteImages?.([new File([blob], 'pasted.png', { type })]);
        return;
      }
      data.onNotice?.('剪贴板里没有图片');
    } catch {
      data.onNotice?.('直接按 Ctrl+V / ⌘V 粘贴图片即可');
    }
  };

  /** The workflow picker lives here now — the standalone workflow node is legacy-only. */
  const workflowTools = (
    /*
     * 带 `workflowId`：节点上已经选定了某一份就直开那一份（改的正是它）；
     * 没选：开工作流浮层的**列表**那一屏（列表里就有「新建一份」）。
     *
     * ⚠️ 这一格换过三次写法，现在是第三种：
     *
     * 1. 最早 `<a target="_blank">`：桌面版是单窗口 hash 路由，新窗口拿到的是
     *    `app://app/settings/...`（没有 `#/`），只能回兜底 index.html —— 一个全白窗口。
     * 2. 改成 `<Link>`：它是受路由状态驱动的，而它挂在**节点正面**上 —— 点一下触发导航、
     *    节点重渲染，回来时选中的已经不是刚才那个节点，下拉直接被收起。
     * 3. 于是换成 `<a href="#/settings/providers/workflows...">`：不碰 React 路由了，
     *    但**单窗口 hash 路由下这一下仍然是「画布没了」**（2026-10-01 徐先报的）。
     *
     * 现在不再自己导航：喊一声 `onOpenWorkflow`，由画布开工作流浮层（`CanvasWorkflowPanel`），
     * 关掉即回画布 —— 用户要的是「在这里配完接着干」，不是「去看另一个页面」。
     */
    <button
      className="cv-btn sm ghost"
      type="button"
      data-param-wfcfg=""
      onClick={() => data.onOpenWorkflow?.(data.workflowId ? String(data.workflowId) : undefined)}
    >
      打开工作流配置
    </button>
  );

  const upstream = String(data.upstreamStatus || 'idle');
  const upstreamLine = (
    <div className="cv-param-desc">
      <span className="cv-param-hint">{upstream === 'running'
        ? `${data.upstreamLabel || '上游生成'} 正在生成…`
        : upstream === 'failed'
          ? `上游失败：${String(data.upstreamResult || '未知原因')}`
          : upstream === 'success'
            ? `${data.upstreamLabel || '上游生成'} 已完成`
            : '等待上游生成结果'}</span>
    </div>
  );

  if (kind === 'text') {
    /** 接了上游时正面那句话是**上游给的**，这里得说清「改自己没用」。 */
    const linked = String(data.textFrom || '').trim();
    return shell(promptBox, <span className="cv-param-hint">{linked
      ? `这段来自「${linked}」—— 改一下就归它自己（会断开那条连线）`
      : '这段文本会作为下游生成节点的提示词'}</span>);
  }

  /*
   * 优化提示词（2026-09-29）。
   *
   * 它不出媒体，但**怎么改写**这事用户要能说了算：用哪家文本模型、照哪个技能的写法、
   * 改写多深、还有什么附加要求 —— 四项都摆在参数条上（`OptimizeOptions`）。
   *
   * 🔴 2026-09-29 之前这里只有一个「改写」按钮，模型那一项故意不摆下拉
   * （注释当时写的是「这一块存在的意义是一键改写，不是调参」）。徐先要的就是调参，
   * 所以那条判断作废 —— 但**默认值仍然是「不动」**：四项都留空 = 和以前一模一样。
   */
  if (kind === 'prompt-optimize') {
    const linked = String(data.textFrom || '').trim();
    const out = String(data.optimizedText || '').trim();
    const incoming = String(data.textValue || '').trim();
    /*
     * 左边接了**媒体**（图或视频）= 走「反推」那条路（2026-10-03）：缩略图、文案、按钮名
     * 三处都要跟着换。只换按钮不换文案的话，用户点完看到「已改写」会以为这句是
     * 从自己那句话改出来的 —— 而它其实是看着图 / 视频写的。
     */
    const media = String(data.mediaValue || '').trim();
    const mediaFrom = String(data.mediaFrom || '').trim();
    const isVideo = data.mediaKind === 'video';
    /** 「看图」还是「看视频」—— 这两句话的差别必须看得见，不然他不知道这次到底在看什么。 */
    const what = isVideo ? '这段视频' : '这张图';
    return shell(
      <div className="cv-param-desc">
        <OptimizeOptions data={data} />
        {/* 视频不摆缩略图：拿一个 .mp4 地址去喂 `<img>` 得到的是一张打不开的坏图。 */}
        {media && !isVideo && <div className="cv-param-thumb static">
          <img src={media} alt="待反推的图" />
        </div>}
        <span className="cv-param-hint">{running
          ? (isVideo ? '正在看视频反推…' : media ? '正在看图反推…' : '正在改写提示词…')
          : out
            ? (media ? `已反推 —— 下游拿到的是按${what}写的那句` : '已改写 —— 下游拿到的是改写后这句')
            : media
              ? `接上${isVideo ? '视频' : '图片'}后会自动反推一次`
              : incoming
                ? '还没改写 —— 现在交出去的还是上游原句'
                : '还没接上游文本节点或图片 / 视频节点'}</span>
        {mediaFrom && <span className="cv-param-hint">{`${isVideo ? '视频' : '图片'}来自「${mediaFrom}」`}</span>}
        {linked && <span className="cv-param-hint">{`输入来自「${linked}」`}</span>}
      </div>,
      <>
        <button className="cv-btn sm" type="button" disabled={running} onClick={() => data.onOptimize?.()}>
          {out ? (media ? '重新反推' : '再改写一次') : (media ? '反推提示词' : '改写提示词')}
        </button>
      </>,
    );
  }

  if (kind === 'image') {
    return shell(
      <>
        <label className="cv-param-thumb">
          {imageSource
            ? <img src={imageSource} alt="参考图" />
            : <span className="cv-param-plus">＋</span>}
          <input
            type="file"
            accept="image/*"
            onChange={event => { const file = event.target.files?.[0]; if (file) data.onFile?.(file); event.target.value = ''; }}
          />
        </label>
        <div className="cv-param-desc">
          <span className="cv-param-hint">{data.status === 'uploading'
            ? '正在上传…'
            : imageSource
              ? (data.remoteFile ? '已就绪' : '待重新上传')
              : '点击左侧方框上传，或选中本节点后 Ctrl+V 粘贴'}</span>
        </div>
      </>,
      <>
        <label className="cv-btn sm">
          {imageSource ? '更换' : '上传'}
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={event => { const file = event.target.files?.[0]; if (file) data.onFile?.(file); event.target.value = ''; }}
          />
        </label>
        {imageSource && <button className="cv-btn sm ghost" type="button" onClick={() => data.onPreview?.(String(imageSource))}>查看原图</button>}
        {!imageSource && <button className="cv-btn sm ghost" type="button" onClick={pasteFromClipboard}>粘贴图片</button>}
      </>,
    );
  }

  if (kind === 'video-input') {
    const videoSrc = String(data.videoUrl || data.videoRemoteUrl || '');
    return shell(
      <>
        <label className="cv-param-thumb">
          {videoSrc
            ? <video className="cv-video" src={videoSrc} controls preload="metadata" />
            : <span className="cv-param-plus">＋</span>}
          <input
            type="file"
            accept="video/*"
            onChange={event => { const file = event.target.files?.[0]; if (file) data.onFile?.(file); event.target.value = ''; }}
          />
        </label>
        <div className="cv-param-desc">
          <span className="cv-param-hint">{data.status === 'uploading'
            ? '正在上传…'
            : videoSrc
              ? (data.remoteFile ? '首帧已就绪 · 可连到生成节点当首帧 / 参考图' : '视频已上传 · 正在取首帧')
              : '点击方框上传视频，或把视频文件拖到画布上'}</span>
        </div>
      </>,
      <>
        <label className="cv-btn sm">
          {videoSrc ? '更换' : '上传'}
          <input
            type="file"
            accept="video/*"
            style={{ display: 'none' }}
            onChange={event => { const file = event.target.files?.[0]; if (file) data.onFile?.(file); event.target.value = ''; }}
          />
        </label>
        {videoSrc && <button className="cv-btn sm ghost" type="button" onClick={() => data.onPreview?.(videoSrc)}>预览</button>}
      </>,
    );
  }

  if (kind === 'frame-extract') {
    const frames: { tag: string; url: string }[] = [
      { tag: '首帧', url: String(data.firstFrameUrl || '') },
      { tag: '尾帧', url: String(data.lastFrameUrl || '') },
    ];
    const picked = String(data.framePick || 'both');
    const got = frames.filter(item => item.url).length;
    const source = String(data.frameSourceVideo || '');
    const from = String(data.frameSourceFrom || '');
    return shell(
      <>
        {/*
          「取用」放在最上面：它是这个节点**唯一**影响下游的设置，
          塞到下面去的话，用户会默认「两张都传」——而续拍时给错那张是不报错的。
        */}
        <div className="cv-field">
          <span>取用</span>
          <select className="cv-select" value={picked} onChange={event => data.onField?.('framePick', event.target.value)}>
            <option value="both">两张都给下游</option>
            <option value="first">只给首帧</option>
            <option value="last">只给尾帧</option>
          </select>
        </div>
        <div className="cv-param-desc">
          <span className="cv-param-hint">{picked === 'both'
            ? '下游生成会收到两张参考图（首帧 + 尾帧）'
            : picked === 'first'
              ? '下游只会收到首帧 —— 尾帧仍然留在卡片上，能看、能下载'
              : '下游只会收到尾帧 —— 续拍要让下一段接上这一段时，通常要的就是这张'}</span>
        </div>
        {source
          ? <video className="cv-video nodrag" src={source} controls preload="metadata" />
          : (
            <label className="cv-param-thumb">
              <span className="cv-param-plus">＋</span>
              <input
                type="file"
                accept="video/*"
                onChange={event => { const file = event.target.files?.[0]; if (file) data.onFile?.(file); event.target.value = ''; }}
              />
            </label>
          )}
        <div className="cv-param-desc">
          <span className="cv-param-hint">{data.status === 'running'
            ? '正在提取首尾帧…'
            : data.status === 'uploading'
              ? '正在上传视频…'
              : got
                ? `已提取 ${got} 张${from ? ` · 来自${from}` : ''}`
                : source
                  ? '还没提取 —— 点下面「提取首尾帧」'
                  : '接一段视频（视频输入 / 视频生成），或在下面选一个本地视频'}</span>
        </div>
      </>,
      <>
        <label className="cv-btn sm">
          选择视频
          <input
            type="file"
            accept="video/*"
            style={{ display: 'none' }}
            onChange={event => { const file = event.target.files?.[0]; if (file) data.onFile?.(file); event.target.value = ''; }}
          />
        </label>
        <button
          className="cv-btn sm"
          type="button"
          disabled={!source || data.status === 'running'}
          onClick={data.onFrameExtract}
        >
          {data.status === 'running' ? '提取中…' : got ? '重新提取' : '提取首尾帧'}
        </button>
        {frames.filter(item => item.url).map(item => (
          <span key={item.tag} className="cv-param-inline">
            <button className="cv-btn sm ghost" type="button" onClick={() => data.onPreview?.(item.url)}>看{item.tag}</button>
          </span>
        ))}
      </>,
    );
  }

  if (kind === 'audio-input') {
    const audioSrc = String(data.audioUrl || data.audioRemoteUrl || '');
    return shell(
      <>
        {audioSrc && <div className="cv-param-audio"><audio src={audioSrc} controls preload="metadata" /></div>}
        <div className="cv-param-desc">
          <span className="cv-param-hint">{data.status === 'uploading'
            ? '正在上传…'
            : audioSrc
              ? (data.audioRemoteFile ? '音频已就绪 · 可在工作流里把加载音频的字段绑到「画布 · 音频输入」' : '待重新上传')
              : '点击「上传」选择音频，或把音频文件直接拖到画布上'}</span>
        </div>
      </>,
      <>
        <label className="cv-btn sm">
          {audioSrc ? '更换' : '上传'}
          <input
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            onChange={event => { const file = event.target.files?.[0]; if (file) data.onFile?.(file); event.target.value = ''; }}
          />
        </label>
      </>,
    );
  }

  if (isLatentKind(kind)) {
    const relay = kind === 'latent-relay';
    const fromLabel = String(data.relayFrom || '');
    /** 上游视频节点产出过的 latent；为空说明没接视频节点（那就还是老样子）。 */
    const picks = (data.latentPickOptions || []) as LatentPickOption[];
    /** 选过的值可能已经不在列表里（上游重新生成、连线改了）—— 这种要显式说出来，不能让 select 静默跳第一项。 */
    const pickedValid = picks.some(option => option.value === String(data.latentPick || ''));
    /** 节点上填的粗 / 精采样节点号。留空 = 沿用配置页里绑的那个字段的节点号。 */
    const coarseNodeId = String(data.latentCoarseNodeId || '');
    const fineNodeId = String(data.latentFineNodeId || '');
    return shell(
      <div className="cv-param-desc">
        <label className="cv-switch">
          <input type="checkbox" checked={latentOn} onChange={event => data.onField?.('latentEnabled', event.target.checked ? 'on' : 'off')} />
          <span>{latentOn ? '启用接续' : '已停用 · 不参与生成'}</span>
        </label>
        <LatentSlotPicker
          indexes={(data.latentIndexes || []).filter(index => index >= 1 && index <= LATENT_SLOTS)}
          onChange={indexes => data.onLatentIndexes?.(indexes)}
          disabled={!latentOn}
          nodeIds={{ coarse: coarseNodeId, fine: fineNodeId }}
        />
        {/*
          粗 / 精采样写进工作流的哪个节点。默认 210 / 278 是 RunningHub 那份默认工作流的编号，
          换一份工作流就得改 —— 编号不对的症状最难看出来：latent 传上去了、任务也成功，
          出来的片段和上一轮毫无关系。
        */}
        {/* 粗 / 精并排一行（2026-10-01 徐先）：这两格**永远成对出现**、宽度也只要一个编号，
            各占一行只会把面板拉长。用现成的 `.cv-row2`（本身就是「一行两格」）。 */}
        <div className="cv-row2">
          <div className="cv-field">
            <span>粗采节点 id</span>
            <input
              className="cv-input sm"
              value={coarseNodeId}
              placeholder="210"
              disabled={!latentOn}
              onChange={event => data.onField?.('latentCoarseNodeId', event.target.value)}
            />
          </div>
          <div className="cv-field">
            <span>精采节点 id</span>
            <input
              className="cv-input sm"
              value={fineNodeId}
              placeholder="278"
              disabled={!latentOn}
              onChange={event => data.onField?.('latentFineNodeId', event.target.value)}
            />
          </div>
        </div>
        <div className="cv-field">
          <span>{relay ? '覆盖值（可留空）' : '已归档的 latent'}</span>
          <select
            className="cv-select"
            disabled={!latentOn}
            value={selectedLatent ? latentValue : ''}
            onChange={event => data.onField?.('remoteFile', event.target.value)}
          >
            <option value="">{relay ? '— 透传上游 latent —' : '— 手动上传新文件 —'}</option>
            {archived.map(item => <option key={item.id} value={`${latentAssetPrefix}${item.id}`}>{latentLabel(item)}</option>)}
          </select>
        </div>
        {/*
          上游接着视频节点时，透传的不是「某个文件」而是「那一次生成产出的 latent」——
          一次生成会归档两份（粗 / 精），跑多轮又有好几组，必须让人指定是哪一份。
          选项只列上游视频节点自己的产出，项目里别的 latent 不掺进来。
        */}
        {relay && picks.length > 0 && (
          <div className="cv-field">
            <span>取自哪次生成</span>
            <select
              className="cv-select"
              disabled={!latentOn}
              value={pickedValid ? String(data.latentPick || '') : ''}
              onChange={event => data.onField?.('latentPick', event.target.value)}
            >
              <option value="">— 选择一份 latent —</option>
              {picks.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
        )}
      </div>,
      <>
        <label className={`cv-btn sm ${latentOn ? '' : 'off'}`} style={{ opacity: latentOn ? 1 : 0.45 }}>
          上传 latent
          <input
            type="file"
            accept={LATENT_ACCEPT}
            disabled={!latentOn}
            style={{ display: 'none' }}
            onChange={event => { const file = event.target.files?.[0]; if (file) data.onFile?.(file); event.target.value = ''; }}
          />
        </label>
        <span className="cv-param-hint">
          槽位 {latentSlotHint(1, coarseNodeId)} / {latentSlotHint(2, fineNodeId)} · {' '}
          {/*
            参数条这里空间够，直接写长解释：链断了的时候用户正在找「该传哪个文件」，
            必须当场告诉他问题不在文件上。
          */}
          {latentValue ? '用本节点自己的文件'
            : relay
              ? (fromLabel ? `透传「${fromLabel}」` : latentBrokenHint(data.relayBroken) || '未接上游 · 透传为空')
              : '未选择归档'}
        </span>
      </>,
    );
  }

  if (kind === 'workflow') {
    return shell(
      <div className="cv-param-desc">
        <div className="cv-field">
          <span>已保存的工作流</span>
          <select className="cv-select" value={String(data.workflowId || '')} onChange={event => {
            /*
             * 「从工作流库中选择…」是个动作，不是一份工作流（2026-10-01 徐先）。
             * 绝不能让它落到 `onField`：把 `__library__` 当 workflowId 存进去，
             * 节点就指向一份不存在的配置，而界面上看不出哪里错（下拉空白，提交时才报）。
             */
            const next = event.target.value;
            if (next === LIBRARY_OPTION) { data.onPickWorkflow?.(); return; }
            data.onField?.('workflowId', next);
          }}>
            <option value={LIBRARY_OPTION}>＋ 从工作流库中选择…</option>
            <option value="">— 选择工作流 —</option>
            {/*
              老节点没有用途、也没有引擎（它是遗留节点），所以**两份都列**；
              每行带上用途标签，混着列时不标就分不清哪条能用在哪个生成节点上。
              这里同样按来源分组：这个下拉里云端与本机的混在一起，不分就说不出这行会跑在谁那儿。
            */}
            {groupWorkflowsByProvider(workflows).map(group => (
              <optgroup key={group.provider} label={`${group.label} · ${group.items.length}`}>
                {group.items.map(item => <option key={item.workflowId} value={item.workflowId}>{workflowLabel(item, true)}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <span className="cv-param-hint">{chosenWorkflow
          ? `${chosenWorkflow.isDefault ? '默认工作流' : '自定义工作流'} · ${chosenWorkflow.enabledCount} / ${chosenWorkflow.totalCount} 项启用`
          : '还没有可用的工作流配置，先到设置页保存一份'}</span>
        <span className="cv-param-hint">工作流配置已并入视频生成节点，这个节点只为老画布保留；连到生成节点后生成时仍优先用它</span>
      </div>,
      <>
        {workflowTools}
        <span className="cv-param-hint">新画布直接在生成节点的参数条里选工作流</span>
      </>,
    );
  }

  if (kind === 'params') {
    const rows = (data.paramRows || []) as ParamRow[];
    return shell(
      <ParamRowEditor
        rows={rows}
        onChange={next => data.onParamRows?.(next)}
        workflowId={data.paramWorkflowId}
        workflowNote={data.paramWorkflowNote}
        onNotice={data.onNotice}
      />,
      <>
        <span className="cv-param-hint">{rows.filter(row => row.enabled && row.value).length} / {rows.length} 行会提交</span>
        <span className="cv-param-hint">参数块可以串着接，越靠近生成节点的优先级越高</span>
      </>,
    );
  }

  /*
   * 3D 导演台。这个节点的「参数」就是一段构图提示词加一张参考图。
   *
   * 提示词**做成可改的**（不改也行）：模型对「俯拍」「远景」这类词的反应差异很大，
   * 让用户顺手把措辞调成自己惯用的说法，比逼他每次回去重摆一遍机位划算得多。
   * 改文字**不用重存图** —— 提交生成时这两件事各走各的（图当参考图、文字进提示词）。
   */
  if (kind === 'director') {
    const shot = String(data.imageUrl || '');
    return shell(
      <>
        <textarea
          className="cv-param-input"
          aria-label="构图提示词"
          value={String(data.directorPrompt || '')}
          placeholder="存为参考图之后，随图一起提交的构图描述会出现在这里"
          onChange={event => data.onField?.('directorPrompt', event.target.value)}
        />
        <span className="cv-param-hint">{shot
          ? '这段描述会和参考图一起交给下游生成节点；图不对就回导演台重存一次'
          : '还没存过参考图 —— 打开导演台摆好站位和机位，点「存为参考图」'}</span>
      </>,
      <>
        <button className="cv-btn sm" type="button" onClick={() => data.onOpenDirector?.()}>打开导演台</button>
        {shot && <button className="cv-btn sm ghost" type="button" onClick={() => data.onPreview?.(shot)}>预览参考图</button>}
      </>,
    );
  }

  if (kind === 'video') {
    return shell(
      <>
        {upstreamLine}
        {data.resultUrl && <div className="cv-param-desc"><span className="cv-param-hint">视频已就绪（链接 24 小时后失效）</span></div>}
        <span className="cv-param-hint">视频输出已并入视频生成节点，这个节点只为老画布保留</span>
      </>,
      <>
        {data.resultUrl && <button className="cv-btn sm ghost" type="button" onClick={() => data.onPreview?.(String(data.resultUrl))}>预览</button>}
        {archived.slice(0, 2).map(item => (
          <Link key={item.id} className="cv-btn sm ghost" href={`/api/assets/${item.id}/download`}>
            <Download size={13} strokeWidth={1.8} aria-hidden /> {item.sequence}
          </Link>
        ))}
      </>,
    );
  }

  if (kind === 'image-out') {
    return shell(
      <>
        <label className="cv-param-thumb static">
          {outputImage ? <img src={outputImage} alt="图片输出" /> : <span className="cv-param-plus"><ImagePlus size={18} strokeWidth={1.6} aria-hidden /></span>}
        </label>
        <div className="cv-param-desc">
          <span className="cv-param-hint">{outputImage
            ? (resultImage ? '来自生成结果' : '来自上游图片节点')
            : '等待上游图片或生成结果'}</span>
          <span className="cv-param-hint">结果链接 24 小时后失效</span>
        </div>
        {!outputImage && upstreamLine}
      </>,
      <>
        {outputImage && <button className="cv-btn sm" type="button" onClick={() => data.onPreview?.(String(outputImage))}>查看原图</button>}
      </>,
    );
  }

  return null;
}
