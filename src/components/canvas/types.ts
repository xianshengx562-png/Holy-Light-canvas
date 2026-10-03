/** 用途值域在 lib/workflows/purpose.ts（前后端共用一份），这里只做类型引入。 */
import type { GeneratorKind } from '@/lib/workflows/purpose';
import type { WorkflowCategory } from '@/lib/workflows/category';
import type { WorkflowOperation } from '@/lib/workflows/operation';
import type { DirectorScene } from '@/lib/director';
import type { RelayLatentItem } from '@/lib/asset-kinds';
import type { ResultKind } from '@/lib/result-kind';

export type LatentRecord = {
  id: string;
  sequence: string;
  kind: 'coarse' | 'fine';
  size: number;
  createdAt: string;
  sourceTaskId: string | null;
};

export type WorkflowOption = {
  workflowId: string;
  /**
   * 用户给这份配置起的名字，可以空（空 = 没起名字，界面回落显示 `workflowId`）。
   *
   * 下拉里认不出 19 位数字谁是谁，而「选错工作流」的后果是**静默**的（任务成功、
   * 产出另一种媒体），所以名字是防错的一部分，不是装饰。清洗 / 回落规则统一在
   * `lib/workflows/label.ts`，界面显示一律走 `workflowDisplayName`。
   */
  name: string;
  /**
   * 这份配置的用途：`'video' | 'image'`。
   *
   * 画布上给生成节点选工作流时**只列同用途的** —— 视频工作流里没有 KSampler 的
   * 步数 / CFG 字段，出图工作流里也没有接续 latent 的参数位，选错只会得到
   * 「任务成功但产出是另一种媒体」。服务端还会再校验一次，不只是下拉的事。
   */
  kind: GeneratorKind;
  /**
   * 分类：这份工作流要喂什么参考素材（无参考 / 单图 / 多图 / 视频 / 音频+多图）。
   *
   * **画布的下拉目前只按用途过滤，不按分类再过一道**，界面上也不显示它 —— 分类是设置页
   * 列表与配置页的维度（在那里它是筛选条件与一项标注）。这里跟着 `WorkflowSummary` 收下来，
   * 是为了接口出参与前端类型是同一个形状：真要在节点上标一句「多图参考」，改的只有渲染那一处。
   */
  category: WorkflowCategory;
  /**
   * 工序：这份工作流是「从无到有生成」还是「拿一份现成的媒体再加工」（超清）。
   *
   * **超清工作流不出现在生成下拉里**（不用说也能想到：拿它当生成工作流跑，任务会成功、
   * 产出一份全新素材，而不是被超清的那份），它由节点卡片右上角的「超清」按钮调用。
   * 生成下拉与超清按钮这两处的筛选都走 `nodeMeta.ts` 里那两个函数。
   */
  operation: WorkflowOperation;
  version: number;
  updatedAt: string;
  totalCount: number;
  enabledCount: number;
  isDefault: boolean;
  /**
   * 这份工作流的来源：`'runninghub'`（云端编号那份）还是 `'local'`
   * （本机 ComfyUI，ID 带 `local-` 前缀、自己带一张图）。
   *
   * 界面上要把两者分得开：**本地那份的字段是从它自己那张图扫出来的**，
   * 想改就回工作流库重新导一次图；云端那份的字段来自 RunningHub 拉回来的 API JSON。
   * 两条路上「为什么这个字段在列表里」的答案不一样，说明也得跟着变。
   */
  provider: 'local' | 'runninghub';
  /** 本地那份图的节点数（列表里显示「几个节点」）；云端那份图不在本机，恒 0。 */
  graphNodes: number;
};

/**
 * 一行自定义参数：直接指名工作流里的节点 id 与字段名，自己起个名字。
 *
 * 它是配置页那套字段的**叠加层** —— 配置页负责把常用参数接成画布输入，
 * 这些行负责补上配置里没有的节点，或者临时覆盖某一条。
 */
export type ParamRow = {
  id: string;
  /** 用户给这行起的名字，只在界面上显示，不发给 RunningHub。 */
  name: string;
  /** 工作流里的节点号，例如 `70`、`210`。不是画布节点的 id。 */
  nodeId: string;
  /** 节点上的字段名，例如 `value`、`image`、`seed`。 */
  fieldName: string;
  value: string;
  enabled: boolean;
  /**
   * 这一行的值按什么类型填 —— **只用于界面提示**（值那个输入框底下的小字），不参与提交。
   *
   * 从候选字段里挑出来的行才有（挑的时候已知类型）；手填的行本来就没有类型可言，
   * 所以是可空的。值域与 `WorkflowField['kind']` 一致。
   */
  kind?: 'text' | 'number' | 'boolean' | 'image' | 'video' | 'audio' | 'latent';
};

/**
 * 一次生成的一个输出（同一轮可能既出视频又出图）。
 *
 * 2026-10-02 起也可能是 `'audio'` —— 「视频/音频生成」节点挑了音频工作流就出这个。
 */
export type RunResult = { url: string; kind: ResultKind };

/**
 * 一次生成记录。挂在生成节点的 `runs` 上，随画布一起保存，
 * 所以刷新之后「每一次生成」都还在，右侧栏按它分开显示。
 */
export type GenerationRun = {
  id: string;
  /** 该节点上的第几次生成，从 1 开始。 */
  index: number;
  /** RunningHub 的任务号（提交后才有）。 */
  taskId?: string;
  /** 这次用的工作流编号。 */
  workflowId: string;
  /** 生成它的那个节点的名字，侧边栏汇总所有节点时才需要。 */
  nodeLabel?: string;
  /**
   * 生成它的那个节点的 id。**汇总时才补上**（`collectRuns`），存的时候不带 ——
   * 记录是挂在节点自己的 `runs` 上的，节点 id 会随复制 / 粘贴变，存一份迟早对不上。
   * 有它才能从「历史」浮层点一下回到那个节点。
   */
  nodeId?: string;
  /** 生成时间，展示用的字符串。 */
  at: string;
  /** 排序用的时间戳（毫秒）。没有就按 0 处理，排在最旧。 */
  ts?: number;
  status: 'success' | 'failed';
  error?: string;
  results: RunResult[];
};

/**
 * A directly connected upstream node, rendered as a slot inside the parameter node
 * (RunningHub shows whatever you wire in on the node itself).
 */
export type InputSlot = {
  id: string;
  kind: string;
  title: string;
  /** Image thumbnail url, latent sequence, workflow id or a prompt excerpt. */
  thumb?: string;
  /** True when the slot is an image whose thumbnail can be opened full size. */
  previewable?: boolean;
  note?: string;
  ready?: boolean;
  /**
   * True when the slot is wired up but deliberately not part of this run —
   * a latent whose continuation switch is off. Such a slot must not be drawn
   * as a pending/blocking input: nothing needs uploading for it.
   */
  skipped?: boolean;
};

/**
 * 首尾帧节点给下游的那几张图。
 *
 * 一个节点产出两张，「用哪张」必须由节点自己说清楚 —— 让下游去猜（比如一律取首帧）
 * 的后果是：想要尾帧续拍的人拿到首帧，任务照样成功、画面接不上，界面上一句话都没有。
 */
export type FramePick = 'first' | 'last' | 'both';

export type NodeData = {
  label?: string;
  kind?: 'text' | 'image' | 'latent' | 'latent-relay' | 'workflow' | 'params'
    | 'video-generate' | 'image-generate' | 'video' | 'video-input' | 'audio-input' | 'image-out' | 'frame-extract'
    | 'director' | 'app-generate' | 'prompt-optimize';
  text?: string;
  /**
   * 优化提示词节点跑完之后产出的那段文本（2026-09-29）。
   *
   * 为什么不顺手改掉下游文本节点自己写的那份：断开连线之后，用户原来那句话还得在 ——
   * 优化结果属于**这一次运行**，手写的那份属于节点。
   */
  optimizedText?: string;
  /** 这个文本节点**此刻**要交给下游的那段文字（`hydrated` 现算，不写库）。 */
  textValue?: string;
  /** 上一段来自哪个上游节点（「优化提示词」这类），同样只在 `hydrated` 里有。 */
  textFrom?: string;
  /** 文本链连成环了（同上，不写库）。 */
  textBroken?: 'cycle' | null;
  /**
   * 优化节点**左边此刻连着的那份媒体**（2026-10-03，看图 / 看视频反推；`hydrated` 现算，不写库）。
   *
   * 🔴 与 `imageUrl` 是两回事：`imageUrl` 是**这个节点自己**身上那份（图片输入节点才有），
   * 这里是**上游**那份 —— 反推看的正是上游那份。
   */
  mediaValue?: string;
  /** 那份媒体来自哪个上游节点（同上，不写库）。 */
  mediaFrom?: string;
  /**
   * 那份是**图还是视频**（同上，不写库）。
   *
   * 两条反推路的差别不只是「抽不抽帧」：界面上「看图反推」与「看视频反推」是两个说法，
   * 卡片正面也不能拿一个视频地址去喂 `<img>`（2026-10-03 就出过这种坏图）。
   */
  mediaKind?: 'image' | 'video';
  imageUrl?: string;
  previewUrl?: string;
  imageSize?: string;
  remoteFile?: string;
  /** 视频输入节点：本地预览用的 blob 地址（上传中 / 上传后即时预览）；刷新后失效，持久的是 `videoRemoteUrl`。 */
  videoUrl?: string;
  /** 视频输入节点：上传到 RunningHub 后返回的服务器播放地址（持久，刷新后仍可播放）。 */
  videoRemoteUrl?: string;
  /** 视频输入节点：上传后 RunningHub 给的视频文件名（仅记录 / 展示用，生成时不直接食用）。 */
  videoRemoteFile?: string;
  /** 音频输入节点：本地预览用的 blob 地址；刷新后失效，持久的是 `audioRemoteUrl`。 */
  audioUrl?: string;
  /** 音频输入节点：上传后返回的服务器播放地址（持久，刷新后仍可播放）。 */
  audioRemoteUrl?: string;
  /** 音频输入节点：上传后 RunningHub 给的音频文件名 —— 绑到工作流 LoadAudio 类节点时用的就是这个。 */
  audioRemoteFile?: string;
  /*
   * 首尾帧节点（`kind: 'frame-extract'`）自己带的那段视频：不接上游、直接选一个本地文件时用。
   * 复用视频输入那两个字段（`videoUrl` 本地预览 / `videoRemoteUrl` 上传后的地址），
   * 不另起一套名字 —— 它们是同一个东西，只是落在另一种节点上。
   *
   * 提取出来的两张图存四个字段：
   *   · `firstFrameUrl` / `lastFrameUrl` —— 显示与下载用的 http 地址；
   *   · `firstFrameFile` / `lastFrameFile` —— 上传后 RunningHub 给的文件名，提交生成时用。
   * 两套都要留：参考图提交认文件名（服务端直接引用已上传的文件，最省事），
   * 而 Image 2.0 那类链路要的是**能取到字节的地址**，只有文件名它拿不到东西。
   */
  firstFrameUrl?: string;
  firstFrameFile?: string;
  lastFrameUrl?: string;
  lastFrameFile?: string;
  /** 生成节点上「正在用的首帧」：上游首尾帧节点交出来的那张，只用于卡片展示（2026-09-21）。 */
  frameInFirst?: string;
  /** 生成节点上「正在用的尾帧」。同上，跟着上游那个「取用」开关走。 */
  frameInLast?: string;
  /**
   * 这一轮提取用的那段视频是什么。
   *
   * 它是「要不要重提」的唯一判据：上游重新生成之后地址会变，这里对不上就说明
   * 手上的两张帧是**上一段视频**的 —— 那种情况下继续拿旧帧去续拍，
   * 症状是「画面接不上但一切看起来都正常」。
   */
  frameSource?: string;
  /** 下游生成取用哪几张（首帧 / 尾帧 / 两张）。没这个字段（老节点）按 'both' 处理。 */
  framePick?: FramePick;
  /**
   * 当前**能拿去提取**的那段视频地址，以及它是从哪来的（「本节点自带的视频」或上游节点名）。
   *
   * 只在 `hydrated` 里现算、不写库：它取决于此刻的连线，存下来就会和真实连线脱节。
   * 界面上要显示它，是因为「为什么这一提取不出来」最常见的答案就是
   * 「这一刻根本没有可用的视频」——不写出来，用户只能对着空卡片猜。
   */
  frameSourceVideo?: string;
  frameSourceFrom?: string;
  duration?: string;
  aspectRatio?: string;
  megapixels?: string;
  workflowId?: string;
  status?: string;
  result?: string;
  resultUrl?: string;
  referenceCount?: number;
  latentCount?: number;
  latentEnabled?: 'on' | 'off';
  continuationEnabled?: 'on' | 'off';
  /**
   * 这一节点出完结果之后，「超清」那一道怎么走（2026-10-02 徐先）。
   *
   * - `off`：完全不超清（卡片上连那颗按钮都不出现）；
   * - `manual`：出结果后卡片右上角出现「超清」，点了才跑（**没填过这个字段的老节点
   *   就是这个行为**，所以默认值必须是 `manual`，不能是 `off`）；
   * - `auto`：普通生成一成功就自动接上去跑，不用人点。
   */
  upscaleMode?: 'off' | 'manual' | 'auto';
  /**
   * 用哪一份超清工作流：`follow` 跟这个节点当前的引擎走，另两档**强制**来源。
   *
   * 强制的那两档在这一来源下找不到超清工作流时就是「没有」，**不回退到另一边** ——
   * 选了「本地 ComfyUI」却悄悄跑去云端跑一份，花的是用户自己账号里的钱。
   */
  upscaleSource?: 'follow' | 'runninghub' | 'local';
  /**
   * 点名用**哪一份**超清工作流（2026-10-02 徐先：「新加一条，选择超清工作流的一列，
   * 与选择工作流并列」）。留空 = 按来源自动挑最近改过的那份。
   *
   * 只在这一节点的用途 + 来源筛出来的那一批里挑；点名的那份后来不在了（删了 / 改了工序 /
   * 换了来源）就退回自动挑，界面上那一行会说出来。
   */
  upscaleWorkflowId?: string;
  /**
   * 这条 latent 要写进哪几个参数位（`latent_1` / `latent_2`，对应节点 210 / 278）。
   * 空数组或没填 = 按连上的顺序自动填空位，跟加这个字段之前的行为一致。
   */
  latentIndexes?: number[];
  /**
   * 粗采样 / 精采样在**工作流里**的节点号（默认 210 / 278）。
   *
   * 这两个号决定这条 latent 最终写进工作流的哪个节点：填了就覆盖配置页里
   * `latent_1` / `latent_2` 所绑字段的**节点号**（字段名不动），配置页没绑 latent 时
   * 则按这两个号补一条。换一份节点编号不一样的工作流时不必再进配置页重绑 ——
   * 编号不对是最难看出来的错：latent 传上去了、任务也成功，出来的片段和上一轮毫无关系。
   */
  latentCoarseNodeId?: string;
  latentFineNodeId?: string;
  /** 图片生成的参数（负向提示词 / 采样 / 出图张数）。视频生成节点不用这些。 */
  negativePrompt?: string;
  steps?: string;
  cfg?: string;
  seed?: string;
  batchSize?: string;
  sampler?: string;
  /**
   * 生成节点的引擎 —— 它决定**整条参数链路**用哪一套。
   *
   * 值域在 `lib/workflows/imageEngine.ts`（图片用）与 `lib/workflows/videoEngine.ts`（视频用），
   * 三档：`runninghub`（云端工作流）/ `local`（本机 ComfyUI 工作流）/ `custom`（自定义接口）。
   * 2026-09-21 加过第四档「直连网关」（图片 `image2`、视频 `videoapi`）；
   * 2026-09-23 图片那一侧的 `image2` 整条删了（视频网关还在），所以图片现在是三档。
   *
   * 引擎这一档不只决定参数，还决定**工作流下拉里列哪些** —— 选了 `local` 就只列本机那份。
   *
   * ⚠️ 老值 `'workflow'` 仍然认（加这两档之前存的），读的时候归一成 `'runninghub'`；
   * 所以这里必须把老值也写进联合类型，否则老画布反序列化出来对不上。
   * 没这个字段（更老的画布）一律按 `'runninghub'`，跟加引擎之前的行为一致。
   */
  engine?: 'runninghub' | 'local' | 'videoapi' | 'workflow' | 'custom';
  /**
   * RunningHub 的**运行规格** —— 这一发跑在多大的机器上（2026-09-30）。
   *
   * `default`（24G 显存）/ `plus`（48G）/ `ultra`（84G），值域与说明在
   * `lib/workflows/instanceType.ts`（官方定义见 RunningHub API 文档那份「发起 ComfyUI 任务-高级」）。
   *
   * 🔴 **不填就是 `default`**，而且不带这个字段时提交也照旧不带 `instanceType` ——
   * 老画布上所有节点都是这个状态，它们必须继续按 24G 跑。
   * 所以这个字段只在「用户真的在节点上改过」时才写进来，别在别处给它补默认值。
   *
   * 只对 RunningHub 云端有意义：本机 ComfyUI 用的是用户自己的显卡，
   * 网关那两档是别人家的机房，都没有「租哪种机器」这回事。
   */
  instanceType?: string;
  /**
   * 引擎 = `custom`（自定义接口）时选的是**哪条接口的哪个模型**，形如 `<providerId>::<modelId>`
   * （拆法见 `lib/providers/custom.ts` 的 `splitCustomModelValue`）。
   *
   * 为什么不复用 `videoApiModel` / `image2Ratio` 那几个字段：它们各自属于一条固定的链路，
   * 而自定义接口是**用户后加的、随时可能删掉**的一条 —— 值里必须自带「属于哪条接口」，
   * 否则删掉那条接口之后，节点上会留下一个指向不存在接口的裸模型名，
   * 提交时只能报一句「找不到」，用户根本不知道该去哪儿改。
   */
  customModel?: string;
  /**
   * 「优化提示词」用哪家文本模型（2026-09-22）。
   *
   * 三种写法：
   * - **不填 / 空串** = 跟着用户走（设置 · 模型服务里指定的那家；没指定就自动挑）。默认值。
   * - `'glm'` / `'deepseek'` … = 官方六家里的某一家；
   * - `'custom:<providerId>:<modelId>'` = 某条自定义接口上的某个文本模型。
   *
   * ⚠️ 这是**节点级覆盖**，不是全局设置：同一个项目里不同节点可以用不同模型优化
   * （比如图片节点用便宜的那家批量跑，重点镜头的节点用好的那家）。
   * 全局那份仍在 `User.promptProvider`，两者不会互相写对方。
   *
   * ⚠️ 值指向的东西可能被删掉（自定义接口、甚至某个厂商），所以读的时候要能
   * **认得出「这一项已经不在选项里了」并在界面上说出来** —— 静默退回自动等于
   * 用户以为自己指定过、实际走的是别家，而这一步没有任何界面会告诉他。
   */
  promptModel?: string;
  /**
   * 这一节点照**哪个技能**的写法来改写提示词（技能 slug，SKILL 社区里标了「用于提示词优化」的那些）。
   * 空 = 不指定，按通用写法。字段早就有了、只是没在 `NodeData` 上声明 —— 补上。
   */
  promptSkill?: string;
  /**
   * 改写幅度（2026-09-29）：`light` 轻度润色 / `standard` 标准补全 / `heavy` 重度扩写。
   *
   * 🔴 字段**不存在**与「等于 standard」是两回事：不存在 = 用户一次都没选过，
   * 那种情况下不能往 system 里塞任何东西（老画布的优化结果必须不变）。
   * 值域与取值规矩在 `lib/optimizeOptions.ts`。
   */
  promptStrength?: string;
  /**
   * 用户自己填的一句附加要求（2026-09-29），如「保持中文」「不要写镜头语言」。
   * 🔴 **不限字数**（2026-09-29 徐先：「补充要求不限字数」）—— 原来切到 500 字，
   * 现在原样带出去，界面上也是能换行的多行框。
   */
  promptNote?: string;
  /**
   * 左边那份媒体**反推过没有**（2026-10-03）。
   *
   * 存的是**那一轮反推用的地址**，不是布尔值：
   * 「反推过了」与「反推的是这一份」是两件事 —— 上游重新生成一次之后地址就变了，
   * 那种情况必须**再反推一遍**，而不是拿上一份的描述去喂下游。
   * 于是判据就是「现在这份的地址 ≠ 这个值」（图与视频都适用，所以不用再存 kind）。
   *
   * 🔴 只在**自动**反推那条路上写（点按钮手动反推不写）——
   * 「自动」要防的是无限重跑，手动那一次是用户自己要的，不该被这个字段挡住。
   */
  describedFrom?: string;
  /** 反推 / 改写这一轮用的是**哪一个上游**的显示名（界面上「来自「X」」要用）。 */
  describedLabel?: string;
  /**
   * 这个节点被**绕过**了（2026-09-29，徐先要的 Bypass）。
   *
   * 绕过的节点**不做自己那份活**，只当一根管子把上游的值交下去：
   * 优化节点不改写、文本节点不用自己写的那句、生成节点不跑（不烧额度）。
   *
   * 🔴 与「删掉节点」的差别：绕过**可逆**、连线都还在，一眼看得出链本来长什么样 ——
   * 所以它是**存库**的，重新打开画布还在。
   * 🔴 生成节点被绕过时下游拿不到它的产出（它是 latent 的生产者），这一点要在界面上
   * 说清，不能让它静默地变成「什么都没发生」。
   */
  bypassed?: boolean;
  /**
   * 这一个节点自己的卡片色（2026-10-01，徐先："同时也可以改变画布选项卡的颜色"）。
   *
   * 与设置里那支「卡片底色」的关系：**没有这一支时跟随全局**（设置里改了它跟着变），
   * 挑过之后就以它为准 —— 两档并存，别互相覆盖。存库跟着节点走，刷新还在。
   *
   * 值一律是 `#rrggbb`；空 / 非法值 = 没挑过（走全局）。派生色（文字、描边、次级面板）
   * 不落在这里，由 `lib/appearance.ts` 的 `nodeTintVars()` 现算 —— 存一份原始色就够，
   * 存派生色等于把同一件事在两个地方各记一遍，改一处必然漏另一处。
   */
  color?: string;
  /**
   * 这一节点用**本地模型**优化提示词时，装进去之后卸不卸（2026-09-26）。
   *
   * `'keep'` = 一直装载、手动卸载（连着改几次提示词最划算，装载大模型实测几十秒）；
   * `'auto'` = 优化完立刻卸载（默认值，字段不存在时就是它 —— 保持老画布的行为不变）。
   *
   * ⚠️ 只对 `promptModel === 'local'` 的那一个节点有意义：选了云端那几家的节点
   * 没有「装载」这回事，界面上也不会把这一行画出来。
   */
  promptLocalLoad?: string;
  /**
   * 同步出图（现在是**自定义接口**那一档；当年的 Image 2.0 也是这套）的三个参数。
   * 值域在 `lib/workflows/image2Params.ts` —— 界面显示的是中文标签，
   * 存的是 `value`（比例 `'16:9'` / 分辨率 `'2k'` / 背景 `'transparent'`），
   * 真正发给上游的像素尺寸由 `image2Size()` 现算，不落进画布。
   *
   * 字段名不动：老画布上存的就是 `image2Ratio`，改一次名等于让所有老节点集体失忆。
   */
  image2Ratio?: string;
  image2Resolution?: string;
  image2Background?: string;
  /**
   * 视频网关（videoapi 引擎）的四个参数。值域在 `lib/workflows/videoApiParams.ts`。
   *
   * 与上面那三个是**两套互不相干的参数**：一个节点要么是图片要么是视频，
   * 所以共用 `engine` 这个字段不会打架，但参数字段必须分开存 ——
   * 否则切一次引擎就会把另一套的值带过去，而那套值在另一个引擎里根本没有意义。
   *
   * `videoApiModel` 留空 = 用 `.env` 里配的那个（那个也留空就连字段都不发给网关）。
   */
  videoApiModel?: string;
  videoApiDuration?: string;
  videoApiResolution?: string;
  videoApiRatio?: string;
  /**
   * 中转节点解析出来的实际值：自己选了归档或上传了文件就用自己的，否则透传上游那个 latent。
   * 只在 `hydrated` 里算，不写库。
   */
  relayValue?: string;
  /** 值是从哪个节点透传过来的，显示在卡片上，同样不写库。 */
  relayFrom?: string;
  /**
   * 中转节点从**上游视频节点**取 latent 时，指定要哪一份（`asset:<id>`）。
   *
   * 为什么要单独一个字段、不复用 `remoteFile`：后者是「本节点自己的文件 / 覆盖值」，
   * 选了它就不是透传了。而这里选的仍然是上游那份 —— 上游重新生成之后，
   * 这份还在不在、要不要改选，界面得能分得清。
   *
   * 视频节点一次生成会归档两份（粗 / 精），跑多轮就有多组，
   * **必须由用户指定**，不自动猜：猜错的症状是接续悄悄喂了错的 latent，
   * 任务照样成功、产出和上一段毫无关系。
   */
  latentPick?: string;
  /** 下拉里能选的那些（只列上游视频节点自己的归档）。只在 `hydrated` 里算，不写库。 */
  latentPickOptions?: LatentPickOption[];
  /**
   * 透传不出值时的原因（成环 / 中转没接上游 / 上游视频节点还没产出 / 还没选哪一份）。
   * 卡片、参数条、属性面板都靠它把「链断了」和「还没上传」分开说。
   * 同样只在 `hydrated` 里算，不写库。
   */
  relayBroken?: LatentChain['broken'];
  /**
   * **从资产库放进来的**视频：它是哪一次生成的。
   *
   * 有了这个，画布上接一个「Latent 中转」就能拿那次归档的 latent 续接下一段 ——
   * 不用回原来的画布去找那个（可能已经删掉的）视频生成节点。
   */
  sourceTaskId?: string;
  /**
   * 那一次生成归档下来的 latent（粗 / 精），**放进画布的那一刻**记下来。
   *
   * 🔴 必须当场记：画布上的 `latents` 列表只有**当前项目**那一份，
   *    而从资产库点进来的视频可能属于别的项目 —— 那时候再按项目去查，
   *    结果就是「明明有 latent，中转节点下拉里却什么都没有」。
   */
  relayLatents?: RelayLatentItem[];
  latents?: LatentRecord[];
  workflows?: WorkflowOption[];
  /** 自定义参数块（`kind: 'params'`）里的行。 */
  paramRows?: ParamRow[];
  /**
   * **应用节点上就地改过的参数**（2026-09-26）。
   *
   * RunningHub 应用自己就把参数填好了（模式 / 时长 / 总像素 / 强度…），节点上要能改 ——
   * 但改的是**这一个节点**，不该写回应用那份全局配置。所以单独存一列：
   *   - 只装「用户真改过的」那些（改回默认值就把这一行去掉）→ 应用默认值以后变了，节点跟着变；
   *   - 提交时并进 `paramRows` 一起走 `mergeParamRows`（同 `nodeId + fieldName` 覆盖），
   *     所以服务端一行都不用改。
   */
  appRows?: ParamRow[];
  /**
   * 参数块自己**不存工作流编号** —— 它写的是「将被提交的那份工作流」里的节点字段，
   * 而那份工作流是它下游那个生成节点选的。所以这个字段由 `CanvasEditor` 沿连线往
   * **下游**找一圈算出来（`hydrated` 里现算，不写库），换一条链路它自然跟着变。
   *
   * 空串 = 没接到任何一个选好了工作流的生成节点，此时「添加参数」回落成手填。
   */
  paramWorkflowId?: string;
  /** 这份工作流是从哪个节点身上取来的（「跟随「视频生成」」），或者「N 份不一致」这类说明。 */
  paramWorkflowNote?: string;
  /** 这个生成节点每一次生成的记录，最新的在最后。 */
  runs?: GenerationRun[];
  /** 上游自定义参数块里会参与本次生成的行数，只用于显示。 */
  paramCount?: number;
  /** Directly connected upstream nodes, shown inside a parameter node. */
  inputs?: InputSlot[];
  /** Label of the upstream workflow node that supplies the workflow id, when one is connected. */
  workflowSource?: string;
  /** Upstream image shown on an image output node before any generated result arrives. */
  passthroughImage?: string;
  /**
   * 3D 导演台（`kind: 'director'`）的场景：灰模的站位与机位。
   *
   * 存在这里而不是「只在打开面板时算一份」，是因为**改完要能再改**：
   * 关掉面板再打开，站位还得是上次摆的那个。读的时候一律过 `readDirectorScene()`，
   * 免得手改过的（或旧版本存下来的）画布喂进来一个 `distance: 0` 让视口算出 NaN。
   */
  directorScene?: DirectorScene;
  /**
   * 存参考图时一并写下的构图提示词。它跟着**那次存下来的图**走 ——
   * 图和这段话描述的是同一个机位，分开存就会变成「图换了、词还是旧的」。
   */
  directorPrompt?: string;
  /**
   * 用户拖右下角改过的节点尺寸（像素）。不写这两项时节点按 CSS 的默认大小走。
   * 尺寸存在 data 上而不是 React Flow 的 node.width/height 上：后者会被画布接口的
   * schema 剥掉，而 data 是自由字段，跟着画布一起存。
   */
  width?: number;
  height?: number;
  /**
   * 图片生成节点「长宽」这一档的来源（2026-09-21）。
   *
   * `resolution`（默认）—— 长宽由「比例 + 分辨率（MP）」换算，界面上是只读读数；
   * `custom` —— 用户直接填宽高像素，提交时用他填的那个数。
   *
   * ⚠️ 别拿 `width` / `height` 存这两个数 —— 那两项是**节点卡片自己**的尺寸
   * （右下角拖出来的），复用会让「拖大节点」变成「改出图分辨率」。
   */
  sizeMode?: 'resolution' | 'custom';
  /** `sizeMode: 'custom'` 时手填的宽（像素）。 */
  customWidth?: string;
  /** `sizeMode: 'custom'` 时手填的高（像素）。 */
  customHeight?: string;
  /** Status and message of the generator node feeding this output node. */
  upstreamStatus?: string;
  upstreamResult?: string;
  upstreamLabel?: string;
  /**
   * 文本节点上改字。
   *
   * 🔴 `detachUpstream`（2026-09-29）：这一个字是打在**上游给的那句**上的，
   * 而「接了上游 → 上游说了算」那条规矩还在 —— 不把那条连线断开，改完看到的
   * 那句仍然是从上游算出来的，改了等于没改。那一类失败**不报错、界面也不跳**，
   * 是最难查的一种。所以这一下由**卡片**告诉画布「这句要固化下来」，
   * 画布负责断线 + 说一句，卡片自己不碰 `edges` —— 它手上没有那张图。
   *
   * 只有**第一次**会带上它：那一次之后上游已经没了，`linkedText` 变假，
   * 后续每个字走的都是普通那条路（断线的副作用不会一遍遍触发）。
   */
  onText?: (value: string, options?: { detachUpstream?: boolean }) => void;
  onFile?: (file: File) => void;
  onField?: (key: string, value: string) => void;
  /**
   * 打开「工作流配置」——**在画布里**（2026-10-01 徐先）。
   *
   * 带 id = 直接进那一份的配置屏；不带 = 开列表。
   * 以前这些入口写的是 `#/settings/providers/workflows?id=…`，桌面版单窗口 hash 路由下
   * 点一下就是**离开画布**：用户只是想改一份工作流的字段绑定，回来还得自己找路。
   * 现在统一由画布开 `CanvasWorkflowPanel`，关掉即回画布。
   */
  onOpenWorkflow?: (workflowId?: string) => void;
  /**
   * 「从工作流库选一份」（2026-10-01 徐先：「这里的工作流选择可以下拉，也可以从工作流库中选择」）。
   *
   * 下面那个下拉只列**同用途、同来源**的已保存配置，刚导入的 / 档位不一样的在里面看不见；
   * 这条是第二条路：把整张库打开，选完直接写回本节点的 `workflowId`。
   */
  onPickWorkflow?: () => void;
  /**
   * 优化提示词节点：就地跑一次改写（2026-09-29）。
   *
   * 与 `onGenerate` 的分工：那个是「提交一次生成」，这个是「只改写字」——
   * 参数条上那个「改写提示词」按钮用它，「启动」走的是 `onGenerate`（已在 `CanvasEditor`
   * 里接到同一个 `runOne`）。
   */
  onOptimize?: () => void;
  /** 整体替换自定义参数块里的行（增删改都走这一条）。 */
  onParamRows?: (rows: ParamRow[]) => void;
  /** 整体替换**应用节点上改过的应用参数**（与 `onParamRows` 同形，只是存的是另一列）。 */
  onAppRows?: (rows: ParamRow[]) => void;
  /** 改 latent 的参数位编号（1 / 2，可多选：一条 latent 同时写进多个槽）。 */
  onLatentIndexes?: (indexes: number[]) => void;
  onPreview?: (url: string) => void;
  /** 关掉预览灯箱。Esc 要能用 —— 关不掉的全屏浮层等于把画布锁住。 */
  onPreviewClose?: () => void;
  onMeasure?: (size: string) => void;
  onGenerate?: () => void;
  /**
   * 超清：把本节点已生成的结果交给一份「超清」工序的工作流再加工一道。
   * 只有生成节点有（超清的输入就是「这个节点自己生成出来的东西」），
   * 没有配超清工作流时按不显示按钮处理 —— 由卡片自己判断。
   */
  onUpscale?: () => void;
  /** 放弃这一轮（2026-09-29）：只在运行中可点，点了就按失败处理（不再等上游）。 */
  onAbandon?: () => void;
  /**
   * 双击节点标题重命名：写回 `data.label`。
   * 空串 = 清掉自定义名，标题回落显示原始类型名（`NODE_META[kind].label`）。
   */
  onRename?: (name: string) => void;
  /** 首尾帧：从上游（或本节点自带的）视频里重新取一次首帧与尾帧。 */
  onFrameExtract?: () => void;
  /** 打开 3D 导演台。只有导演台节点带这一条（卡片右上角那个常驻按钮用它）。 */
  onOpenDirector?: () => void;
  /** Image files pasted from the clipboard while this node is selected. */
  onPasteImages?: (files: File[]) => void;
  /**
   * 拖右下角改尺寸时实时回调（像素，已取整）。
   * 两个参数都不传 = 「恢复默认尺寸」，把自定义宽高清掉。
   */
  onResize?: (width?: number, height?: number) => void;
  /**
   * 正面就是一份媒体的卡片专用：改尺寸**只给宽度**（2026-09-24）。
   * 高度永远交给这张图自己的宽高比 —— 要的是「边框适应图片」，不是把图塞进框里。
   */
  onResizeWidth?: (width: number) => void;
  onNotice?: (message: string) => void;
  [key: string]: unknown;
};

export type ResultItem = { url: string; label: string; at: string; kind?: 'video' | 'image' };

/**
 * 沿链解析出一个 latent 节点最终要提交的值（中转节点透传上游那个）。
 *
 * `broken` 说明「解析不出值」的原因，存在的意义是把几种完全不同的情况分开：
 * - `cycle` —— 链上有环，补多少文件都取不到值；
 * - `upstream` —— 中转节点压根没接上 latent 来源；
 * - `empty` —— 上游是视频节点，但它一次都还没生成出 latent（先去跑一次生成）；
 * - `unpicked` —— 上游视频节点产出过多份（粗 / 精、或多轮），还没指定要哪一份。
 *
 * 这几种都不能报「尚未上传完成」：那会把用户推去重复上传一个本来就没问题的文件，
 * 而且怎么传都不会好。`empty` 和 `unpicked` 尤其不能合并 —— 前者要人去生成，
 * 后者要人点一下下拉，指错了方向就是白等。
 */
export type LatentChain = {
  value: string;
  from: string;
  broken: 'cycle' | 'upstream' | 'empty' | 'unpicked' | null;
};

/*
 * `TextChain` 由 `./textChain` 拥有（那条链的取值规则是一层纯函数，要单独跑单测），
 * 这里原样转出 —— 已经在从 `./types` 引它的地方不用改。
 */
export type { TextChain } from './textChain';

/**
 * 中转节点「取自上游哪一份 latent」下拉里的一行。
 *
 * 只列**上游视频节点自己**归档的那些（粗 / 精、多轮各次都在），不掺别人的 ——
 * 连线的意义就在于把范围收窄到「这一段生成产出的东西」。
 */
export type LatentPickOption = {
  /** 形如 `asset:<id>`，与「已归档的 latent」下拉同一个值形态。 */
  value: string;
  /** 已带上游节点名的显示文案，界面不该再拼一遍。 */
  label: string;
};

export type CanvasPayload = {
  nodes: { id: string; type?: string; position: { x: number; y: number }; data: NodeData }[];
  edges: { id: string; source: string; target: string }[];
  viewport: { x: number; y: number; zoom: number };
  /**
   * 服务端当前的画布版本号。保存时原样带回去，服务端拿它判断这份画布
   * 有没有被别的窗口改过（对不上就 409，不落库）。缺省就不做检查。
   */
  version?: number;
};
