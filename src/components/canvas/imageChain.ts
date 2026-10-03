/*
 * 图片链解析（2026-10-03）—— 纯函数层。
 *
 * 与 `./textChain` 是同一个路子：把「左边那张图从哪儿来、此刻是哪一张」做成一层
 * 能单独编译跑断言的纯逻辑。它现在有两个用处，两处必须用同一把尺子量：
 *   1. 提交生成时收参考图（`nodeMeta.referenceUrlsOf` → 这里）；
 *   2. **看图反推提示词**（徐先：「左边的接口输入了图片，就自动反推」）——
 *      反推要的就是「此刻连在左边的是哪一张」，
 *      而两处各写一份的后果是「卡片上看得到图，点反推却说没有图」，全程不报错。
 *
 * 🔴 所以这个文件**不 import 任何带 `@/` 别名、拖着整条工作流依赖链的模块**。
 */

/** 已落盘媒体的地址形状。三处判断（能不能取字节、能不能提交、要不要补上传）必须认同一个前缀。 */
export const LOCAL_ASSET_PREFIX = '/api/assets/';

/** 参与这条链的节点的最小形状（`Node<NodeData>` 天然满足）。 */
export type ImageChainNode = {
  id: string;
  data: {
    kind?: string;
    imageUrl?: string;
    previewUrl?: string;
    resultUrl?: string;
    remoteFile?: string;
    firstFrameUrl?: string;
    firstFrameFile?: string;
    lastFrameUrl?: string;
    lastFrameFile?: string;
    framePick?: string;
    label?: string;
    bypassed?: boolean;
  };
};

/** 连线：`source` 在上游、`target` 在下游。 */
export type ImageChainEdge = { source: string; target: string };

/** 解析出来的那一张图。 */
export type ImageChain = { id: string; url: string; from: string };

/**
 * 这个节点能不能当**图片来源**。
 *
 * 提交时收参考图、参数条上数「几张图」、反推时挑「左边那张」，三处必须用同一个判断 ——
 * 各写一份的后果是参数条写着 2 图、实际只提交 1 张，而界面上一句话都没有。
 */
export function isImageSourceKind(kind: unknown) {
  /* 导演台存下来的构图参考图就是一张图，下游拿它当参考图用，与「图片输入」同一条路。 */
  return kind === 'image' || kind === 'image-generate' || kind === 'image-out'
    || kind === 'video-input' || kind === 'frame-extract' || kind === 'director'
    /* 应用节点跑出来的东西（图或片）同样能当下游的参考图。 */
    || kind === 'app-generate';
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

/**
 * 一个节点这次能给下游贡献**哪几张**图。
 *
 * 首尾帧节点特殊：它一个节点出两张（首帧 / 尾帧），给哪张由它自己的「取用」开关决定。
 * 其余节点一律一张（已上传的文件名优先，没有再退回结果地址）。
 *
 * `mode` 是给同步出图与**反推**那条路准备的：那边要的是**服务端能取到字节的地址**
 * （上传后的 http 地址或本站资产路径），而工作流那条路认的是 RunningHub 的文件名。
 */
export function imageUrlsOf(data: ImageChainNode['data'], mode: 'submit' | 'bytes' = 'submit'): string[] {
  const bytes = mode === 'bytes';
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
 * 此刻**连在左边**的那一张图（给「看图反推提示词」用）。
 *
 * 取值规矩与文本链一致：
 *   1. 只看**直接上游**里能给图的节点（`isImageSourceKind`），按连线先后取第一个有地址的；
 *   2. 要的是**服务端取得到字节**的那个地址（`bytes` 模式）—— 反推是服务端读盘做的，
 *      拿着一个 RunningHub 文件名或者 `blob:` 过去必然失败，而那种失败只会说「取不到图」。
 *
 * 返回 `null` = 左边没有可用的图（该走「改写」那条路）。
 */
export function pickImageInput(
  nodes: ImageChainNode[],
  edges: ImageChainEdge[],
  id: string,
  /** 上游节点的显示名（卡片上那句「来自「X」」要用）。不传就退回 `label || kind`。 */
  labelOf?: (node: ImageChainNode) => string,
): ImageChain | null {
  const nameOf = labelOf || ((node: ImageChainNode) => String(node.data.label || node.data.kind || ''));
  for (const edge of edges) {
    if (edge.target !== id) continue;
    const from = nodes.find(item => item.id === edge.source);
    if (!from || !isImageSourceKind(from.data.kind)) continue;
    const url = imageUrlsOf(from.data, 'bytes').find(isResolvableUrl);
    if (!url) continue;
    return { id: from.id, url: String(url).trim(), from: nameOf(from) };
  }
  return null;
}
