/*
 * 媒体链解析（2026-10-03）—— 纯函数层。图片链那一版同日加，视频反推进来之后改的名。
 *
 * 与 `./textChain` 是同一个路子：把「左边那份媒体从哪儿来、此刻是哪一份」做成一层
 * 能单独编译跑断言的纯逻辑。它现在有三个用处，**三处必须用同一把尺子量**：
 *   1. 提交生成时收参考图（`nodeMeta.referenceUrlsOf` → 这里）；
 *   2. **看图反推提示词**（徐先：「左边的接口输入了图片，就自动反推」）；
 *   3. **看视频反推提示词**（同一天追加：「也支持视频，如果接入了视频，那进行视频反推」）。
 *
 * 各写一份的后果是「参数条写着 2 图，点反推却说没有图」，全程不报错。
 *
 * 🔴 所以这个文件**不 import 任何带 `@/` 别名、拖着整条工作流依赖链的模块**。
 */

/** 已落盘媒体的地址形状。三处判断（能不能取字节、能不能提交、要不要补上传）必须认同一个前缀。 */
export const LOCAL_ASSET_PREFIX = '/api/assets/';

/** 参与这条链的节点的最小形状（`Node<NodeData>` 天然满足）。 */
export type MediaChainNode = {
  id: string;
  data: {
    kind?: string;
    imageUrl?: string;
    previewUrl?: string;
    resultUrl?: string;
    remoteFile?: string;
    videoUrl?: string;
    videoRemoteUrl?: string;
    videoRemoteFile?: string;
    firstFrameUrl?: string;
    firstFrameFile?: string;
    lastFrameUrl?: string;
    lastFrameFile?: string;
    framePick?: string;
    label?: string;
    bypassed?: boolean;
    /**
     * 「指定节点上传」节点身上那份值：它是**上游透传下来的**，不是自己产的。
     * 与 `latent-relay` 的 `relayValue` 同一个名字、同一种来历（`hydrated` 现算，不写库）。
     */
    relayValue?: string;
    /** 透传下来的那份是图还是视频（同上，不写库）。决定它进参考图还是进视频输入那一支。 */
    mediaKind?: 'image' | 'video';
  };
};

/**
 * 「指定节点上传」节点的 kind（2026-10-05 徐先）。
 *
 * 🔴 字面量住在**这里**（纯函数层），由 `./nodeMeta` 转出给 UI —— 反过来说就是
 * `mediaChain` 不许 import `nodeMeta`。两处各写一遍的话，迟早出现
 * 「线拉得上、提交时却没把它算进参考图」这种不报错的错。
 */
export const PINNED_UPLOAD_KIND = 'pinned-upload';

export function isPinnedUploadKind(kind: unknown) {
  return kind === PINNED_UPLOAD_KIND;
}

/** 连线：`source` 在上游、`target` 在下游。 */
export type MediaChainEdge = { source: string; target: string };

/** 解析出来的那一份媒体。 */
export type MediaChain = {
  id: string;
  url: string;
  from: string;
  /** 🔴 图与视频是**两条反推路**：那边抽帧发多张，这边发一张。 */
  kind: 'image' | 'video';
};

/**
 * 这个节点能不能当**图片来源**。
 *
 * 提交时收参考图、参数条上数「几张图」、反推时挑「左边那张」，三处必须用同一个判断 ——
 * 各写一份的后果是参数条写着 2 图、实际只提交 1 张，而界面上一句话都没有。
 */
export function isImageSourceKind(kind: unknown) {
  /* 导演台存下来的构图参考图就是一张图，下游拿它当参考图用，与「图片输入」同一条路。 */
  return kind === 'image' || kind === 'image-generate' || kind === 'image-out'
    || kind === 'frame-extract' || kind === 'director'
    /* 应用节点跑出来的东西（图或片）同样能当下游的参考图 —— 具体是图还是片看地址后缀。 */
    || kind === 'app-generate'
    /*
     * 「指定节点上传」：它自己不产媒体，交出去的是**上游那份**（`relayValue`）。
     * 是图还是视频由 `mediaKind` 定，下面 `imageUrlsOf` / `videoUrlsOf` 各按自己的那一支判。
     */
    || isPinnedUploadKind(kind);
}

/**
 * 这个节点能不能当**视频来源**（2026-10-03：视频反推）。
 *
 * 🔴 `video-input` 在这里**也从图片那组挪过来了**：它身上是一段视频，
 * 连到优化节点上时该走「视频反推」（抽若干帧），而不是拿它的封面帧当一张图 ——
 * 只有一帧的话，镜头运动和画面变化全都丢了。
 * （它在提交生成时仍然是参考图来源，那是另一条路，不冲突。）
 */
export function isVideoSourceKind(kind: unknown) {
  return kind === 'video-input' || kind === 'video-generate' || kind === 'app-generate'
    /* 「指定节点上传」透传的是一段视频时走这一支（见 `isImageSourceKind` 那条注释）。 */
    || isPinnedUploadKind(kind);
}

/**
 * 这个值**服务端能取到字节**吗。
 *
 * 两种能：落盘资产（读盘）与 http(s) 链接（下载）。
 * 一种不能：`blob:` —— 它只活在渲染进程的内存里，提交给服务端必然 400。
 */
export function isResolvableUrl(value: unknown) {
  const text = String(value ?? '').trim();
  return text.startsWith(LOCAL_ASSET_PREFIX) || /^https?:\/\//i.test(text);
}

/** 地址后缀：视频。三处「这个结果该画成什么」的判定必须认同一份（见 `nodeMeta` 的注释）。 */
export function isVideoUrl(value: unknown) {
  return /\.(mp4|webm|mov)(\?|#|$)/i.test(String(value ?? ''));
}

/** 地址后缀：图片。 */
export function isImageUrl(value: unknown) {
  return /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(String(value ?? ''));
}

/**
 * 一个节点这次能给下游贡献**哪几张**图。
 *
 * 首尾帧节点特殊：它一个节点出两张（首帧 / 尾帧），给哪张由它自己的「取用」开关决定。
 * 其余节点一律一张（已上传的文件名优先，没有再退回结果地址）。
 *
 * `mode` 是给同步出图与**反推**那条路准备的：那边要的是**服务端能取到字节的地址**
 * （上传后的 http 地址或本站资产路径），而工作流那条路认的是 RunningHub 的文件名。
 */
export function imageUrlsOf(data: MediaChainNode['data'], mode: 'submit' | 'bytes' = 'submit'): string[] {
  const bytes = mode === 'bytes';
  /*
   * 「指定节点上传」：身上没有自己的媒体，交出去的是**上游透传下来的那份**。
   * 是图的时候才走这一支 —— 是视频的话它该进 `videoUrlsOf`，这里一件都不给，
   * 否则一段视频会被塞进「图」的槽里（静默的坏结果，跟 `ACCEPTS` 那条注释是同一件事）。
   */
  if (isPinnedUploadKind(data.kind)) {
    const relayed = String(data.relayValue || '').trim();
    if (!relayed || data.mediaKind === 'video') return [];
    return bytes && !isResolvableUrl(relayed) ? [] : [relayed];
  }
  if (data.kind === 'frame-extract') {
    const pick = data.framePick === 'first' || data.framePick === 'last' ? data.framePick : 'both';
    const first = String(bytes ? (data.firstFrameUrl || data.firstFrameFile) : (data.firstFrameFile || data.firstFrameUrl) || '').trim();
    const last = String(bytes ? (data.lastFrameUrl || data.lastFrameFile) : (data.lastFrameFile || data.lastFrameUrl) || '').trim();
    if (pick === 'first') return first ? [first] : [];
    if (pick === 'last') return last ? [last] : [];
    return [first, last].filter(Boolean);
  }
  if (bytes) {
    const preview = String(data.previewUrl || '').trim();
    if (preview) return [preview];
    /** 只有落盘的资产地址能读盘取字节；本地 blob 服务端取不到。 */
    const local = String(data.imageUrl || '').trim();
    if (local.startsWith(LOCAL_ASSET_PREFIX)) return [local];
    /*
     * 生成节点跑完之后身上**只有结果地址**（`resultUrl`），既没有 preview 也没有本地资产 ——
     * 漏掉它的症状正是这一层要防的那一种：卡片上看得到图，点反推却说「没有图」。
     * 只认**能取到字节**的那两种形态（http 链接 / 本站资产），其余（远端文件名）一律不算。
     */
    const result = String(data.resultUrl || '').trim();
    return isResolvableUrl(result) ? [result] : [];
  }
  const one = String(data.remoteFile || data.resultUrl || '').trim();
  if (one) return [one];
  /*
   * 从**资产库导入**的节点（以及首页带过来的预设）身上只有本站资产地址，没有远端文件名。
   * 这里必须把它算进来。漏掉它的症状是「卡片上看得到图、连好了线，点运行却说没有参考图」，
   * 而且用户没有任何办法修好它 —— 因为界面上根本没说缺的是什么。
   */
  const local = String(data.imageUrl || data.previewUrl || '').trim();
  return local.startsWith(LOCAL_ASSET_PREFIX) ? [local] : [];
}

/**
 * 一个节点这次能给下游贡献**哪一段视频**（2026-10-03：视频反推）。
 *
 * 取值顺序照 `CanvasEditor` 里收「画布 · 视频输入」那一条（同一个节点在两条路上
 * 交出去的值必须一致，否则「卡片上看着有视频，点反推却说没有」）：
 *   1. 生成节点刚跑完 → `resultUrl`；
 *   2. 视频输入节点 → 远端地址 → 本站资产地址（`videoRemoteFile` 是**对端平台的文件名**，
 *      服务端取不到字节，反推这条路不能认它）。
 */
export function videoUrlsOf(data: MediaChainNode['data'], mode: 'submit' | 'bytes' = 'submit'): string[] {
  /* 同上：「指定节点上传」只在它透传的那份**是视频**时才给，其余一律不给。 */
  if (isPinnedUploadKind(data.kind)) {
    const relayed = String(data.relayValue || '').trim();
    if (!relayed || data.mediaKind !== 'video') return [];
    return mode === 'bytes' && !isResolvableUrl(relayed) ? [] : [relayed];
  }
  const generated = String(data.resultUrl || '').trim();
  if (generated && isVideoUrl(generated)) return [generated];
  const remote = String(data.videoRemoteUrl || '').trim();
  if (remote && isResolvableUrl(remote)) return [remote];
  const local = String(data.videoUrl || '').trim();
  if (local.startsWith(LOCAL_ASSET_PREFIX)) return [local];
  if (mode === 'submit') {
    /* 提交那条路认对端平台的文件名（工作流里的 LoadVideo 吃的就是它）。 */
    const named = String(data.videoRemoteFile || data.remoteFile || '').trim();
    if (named) return [named];
    if (isResolvableUrl(local)) return [local];
  }
  return isResolvableUrl(local) ? [local] : [];
}

/**
 * 此刻**连在左边**的那一份媒体（给「看图 / 看视频反推提示词」用）。
 *
 * 取值规矩与文本链一致：
 *   1. 只看**直接上游**，按连线先后取第一个有地址的；
 *   2. 要的是**服务端取得到字节**的那个地址 —— 反推是服务端读盘 / 下载做的，
 *      拿着一个 RunningHub 文件名或者 `blob:` 过去必然失败，而那种失败只会说「取不到」。
 *   3. 🔴 **视频优先于图片**：同一个上游身上既有视频又有封面帧时（视频输入节点就是这样），
 *      走视频反推 —— 抽若干帧能看出镜头运动和画面变化，只发一帧等于把这段视频废掉。
 *
 * 返回 `null` = 左边没有可用的媒体（该走「改写」那条路）。
 */
export function pickMediaInput(
  nodes: MediaChainNode[],
  edges: MediaChainEdge[],
  id: string,
  /** 上游节点的显示名（卡片上那句「来自「X」」要用）。不传就退回 `label || kind`。 */
  labelOf?: (node: MediaChainNode) => string,
): MediaChain | null {
  const nameOf = labelOf || ((node: MediaChainNode) => String(node.data.label || node.data.kind || ''));
  for (const edge of edges) {
    if (edge.target !== id) continue;
    const from = nodes.find(item => item.id === edge.source);
    if (!from) continue;
    if (isVideoSourceKind(from.data.kind)) {
      const url = videoUrlsOf(from.data, 'bytes').find(isResolvableUrl);
      if (url) return { id: from.id, url: String(url).trim(), from: nameOf(from), kind: 'video' };
    }
    if (isImageSourceKind(from.data.kind)) {
      const url = imageUrlsOf(from.data, 'bytes').find(isResolvableUrl);
      if (url) return { id: from.id, url: String(url).trim(), from: nameOf(from), kind: 'image' };
    }
  }
  return null;
}
