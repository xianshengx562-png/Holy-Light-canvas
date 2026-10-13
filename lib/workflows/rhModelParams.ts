/**
 * RunningHub **标准模型 API**（模型直调）的出片参数 —— 前后端共用的唯一定义。
 *
 * 与 `videoApiParams.ts`（视频网关）是**两套并列的适配层**，别互相借用值域：
 * 那一份是「换个网关改 .env」的**通用**假设（480p/720p/1080p、16:9 起手），
 * 这一份是**照着 RunningHub 家实测出来的**规格 —— 分辨率只有 2K / 768P，
 * 时长是 5~15 的整数秒，比例带一个 `adaptive`（让模型自己定）。
 * 拿那一份的档位去校验这一份的参数，会在「明明能跑的组合」上报警。
 *
 * ## 为什么值域要写死在这里（而不是让上游报错）
 *
 * 上游**确实会**报错（`1007 field 'duration' value 999 is not in the allowed options,
 * allowed values: 5, 6, … 15`），但那是在**请求已经发出去之后**。
 * 这一层的作用是让「选错档位」这件事在**点生成之前**就被看见 ——
 * 下拉只挡得住鼠标，挡不住手改画布与老数据，所以服务端也要校验（同一个函数）。
 *
 * ## 这些数是**实测**来的，不是抄文档的（2026-10-11）
 *
 * 方法是给一个必然非法的 `duration: 999`，读 `1007` 回话里的 `allowed values`；
 * 再逐个喂 `'ZZZ'` 看哪个字段名被真正校验（认不出的字段名会被**静默忽略**）。
 * 全程 `taskId` 为空，一次都没真跑、没花积分。
 *
 * ⚠️ **「字段名被静默忽略」是这一层最要命的坑**：
 *   给 `text-to-video` 传 `imageUrls` 不会报错，它只是**当没看见** ——
 *   于是用户连了参考图、界面显示「已带 3 张图」，上游拿到的却是一次纯文生视频。
 *   任务照样成功、画面跟他给的图毫无关系，界面上一个字都不说。
 *   所以 `RH_MODELS` 里每一档都**显式写清楚它收哪几路素材**，
 *   提交时按这份表裁掉它不认的那几路（并在界面上说明「这一档不带参考图」）。
 *
 * 界面上显示中文、存的是 `value`、发出去的必须是枚举值 —— 中文只存在于 `label`，永远不进请求体。
 */

/** 比例档位。`value` 就是发给上游的 `ratio`。`adaptive` = 由模型自己定。 */
export const RH_MODEL_RATIOS: { value: string; label: string }[] = [
  { value: 'adaptive', label: '自适应（模型定）' },
  { value: '21:9', label: '21:9 宽幅' },
  { value: '16:9', label: '16:9 横屏' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1 方形' },
  { value: '3:4', label: '3:4' },
  { value: '9:16', label: '9:16 竖屏' },
];

/** 分辨率档位。`value` 就是发给上游的 `resolution`。**只有两档**，没有 720p / 1080p。 */
export const RH_MODEL_RESOLUTIONS: { value: string; label: string }[] = [
  { value: '2K', label: '2K' },
  { value: '768P', label: '768P' },
];

/**
 * RH Enhanced 那两档的分辨率档位（2026-10-12 实测）。
 *
 * 🔴 **跟上面那份不是同一组值，也不能互相校验**：那两档是 2K / 768P，
 * 这一组是 480p / 768p / 1080p。拿一份的清单去校验另一份的参数，
 * 会在「明明能跑的组合」上报警（1080p 会被判成非法），
 * 反过来又会放过一个真非法的 `2K`。这正是这个项目最爱复发的「两把尺子」。
 */
export const RH_ENHANCED_RESOLUTIONS: { value: string; label: string }[] = [
  { value: '480p', label: '480p' },
  { value: '768p', label: '768p' },
  { value: '1080p', label: '1080p' },
];

/**
 * RH Enhanced 那两档的比例档位（2026-10-12 实测）。
 *
 * 🔴 两个差别：字段名是 **`aspectRatio`**（不是 `ratio`），
 * 而且**没有 `adaptive`** —— 上游的枚举里就没这一项，传了会被拒。
 */
export const RH_ENHANCED_RATIOS: { value: string; label: string }[] = [
  { value: '1:1', label: '1:1 方形' },
  { value: '2:3', label: '2:3' },
  { value: '3:2', label: '3:2' },
  { value: '3:4', label: '3:4' },
  { value: '4:3', label: '4:3' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '16:9', label: '16:9 横屏' },
  { value: '21:9', label: '21:9 宽幅' },
];

/**
 * 某一路参考素材在这一档模型上的落点。
 *
 * `field` 是发给上游的字段名，**四档模型并不统一**：
 *   - 图生视频那一档是**单值** `firstFrameUrl`；
 *   - 多模态那两档是**数组** `imageUrls` / `videoUrls` / `audioUrls`。
 * `null` = 这一档**根本不收**这类素材（传了也会被静默忽略，见文件头）。
 */
export type RhMediaSlot = { field: string; max: number; array: boolean } | null;

/**
 * 首尾帧那一对字段（RH Enhanced 的 `i2va` 专用）。
 *
 * 与 `image`（参考图列表）是**两回事，不能合并**：
 * 首帧 / 尾帧在输出里**各占一个真实的帧位置**（第 0 帧与最后一帧），
 * 而参考图只是「照着这个人的样子来」，不进画面。所以这里给的是两个**各自的**字段名，
 * 不是「最多两张图」。
 */
export type RhFrameSlot = { first: string; last: string } | null;

export type RhModelSpec = {
  /** 发给上游的路径片段，拼在 `/openapi/v2/` 后面。 */
  value: string;
  label: string;
  hint: string;
  image: RhMediaSlot;
  video: RhMediaSlot;
  audio: RhMediaSlot;
  /** 首帧 / 尾帧。与 `image` 互斥：`i2va` 用这两个，普通 H3 用 `imageUrls`。 */
  frames: RhFrameSlot;
  durationMin: number;
  durationMax: number;
  /**
   * 发比例用的字段名 —— **两档模型不一样**（2026-10-12 实测）：
   * 普通 H3 是 `ratio`，RH Enhanced 那两档是 `aspectRatio`。
   * 写死一个，另一档就会**静默忽略**这个字段（上游不报错，只是当没看见）。
   */
  ratioField: 'ratio' | 'aspectRatio';
  /** 这一档自己的分辨率档位。⚠️ 两档模型的值域不同，见 `RH_ENHANCED_RESOLUTIONS`。 */
  resolutions: { value: string; label: string }[];
  /** 这一档自己的比例档位。 */
  ratios: { value: string; label: string }[];
  /**
   * 收不收 `aigc_watermark`。RH Enhanced 那两档**不认**这个字段（探过，被静默忽略），
   * 所以界面上根本不该把「水印」那一格摆出来 —— 摆了等于给一个不会生效的开关。
   */
  watermark: boolean;
};

/**
 * 能直调的四档 H3 模型（2026-10-11 实测）。
 *
 * 🔴 顺序 = 界面下拉里从上到下的顺序。第一档是**能力最全**的那个
 * （不传素材时它就是文生视频，传了就是参考生视频），所以把它排在最前当默认值 ——
 * 选它永远不会「因为没带素材而跑不了」。
 */
export const RH_MODELS: readonly RhModelSpec[] = [
  {
    value: 'minimax/hailuo-h3/multimodal-to-video',
    label: 'H3 多模态参考生视频',
    hint: '文本 + 参考图（≤9）+ 参考视频（≤3）+ 参考音频（≤3）组合驱动；不传素材就是文生视频',
    image: { field: 'imageUrls', max: 9, array: true },
    video: { field: 'videoUrls', max: 3, array: true },
    audio: { field: 'audioUrls', max: 3, array: true },
    frames: null,
    durationMin: 5,
    durationMax: 15,
    ratioField: 'ratio',
    resolutions: RH_MODEL_RESOLUTIONS,
    ratios: RH_MODEL_RATIOS,
    watermark: true,
  },
  /*
   * ---- RH Enhanced 两档（2026-10-12 徐先要的「RH Enhance」）----
   *
   * 🔴 路径前缀是 **`rhart-video/`**，不是 `minimax/` —— 2026-10-11 我按 `minimax/`
   *    猜了 19 个候选全 `1001`，于是误判「这个模型没有 API」。真名里那个 `rhart`
   *    靠猜是猜不到的，是从官方文档页（`runninghub-api-doc-cn/api-52087743x`）抄来的。
   *
   * 这两档是**音视频一体**（路径末尾那个 A 就是 audio），规格跟上面那四档
   * **没有一项是共用的**：分辨率 480p/768p/1080p、比例字段叫 `aspectRatio`、
   * 没有 `adaptive`、不认 `aigc_watermark`。所以每一项都得写在自己这一档上。
   */
  {
    value: 'rhart-video/minimax-h3-rh-enhanced/t2va',
    label: 'H3 RH 增强 · 文生视频（带音频）',
    hint: 'RH 增强版文生视频，画面与音频一起出；**不收任何参考素材**，连了也不会生效',
    image: null,
    video: null,
    audio: null,
    frames: null,
    durationMin: 1,
    durationMax: 15,
    ratioField: 'aspectRatio',
    resolutions: RH_ENHANCED_RESOLUTIONS,
    ratios: RH_ENHANCED_RATIOS,
    watermark: false,
  },
  {
    value: 'rhart-video/minimax-h3-rh-enhanced/i2va',
    label: 'H3 RH 增强 · 图生 / 首尾帧（带音频）',
    hint: '给首帧图（可再给尾帧）让它照着演；连两张图 = 第一张当首帧、第二张当尾帧',
    image: null,
    video: null,
    audio: null,
    frames: { first: 'firstFrameUrl', last: 'lastFrameUrl' },
    durationMin: 1,
    durationMax: 15,
    ratioField: 'aspectRatio',
    resolutions: RH_ENHANCED_RESOLUTIONS,
    ratios: RH_ENHANCED_RATIOS,
    watermark: false,
  },
  {
    value: 'minimax/hailuo-h3/image-to-video',
    label: 'H3 图生视频',
    hint: '给一张首帧图 + 提示词；**只认一张**，多连的图会被丢掉',
    image: { field: 'firstFrameUrl', max: 1, array: false },
    video: null,
    audio: null,
    frames: null,
    durationMin: 5,
    durationMax: 15,
    ratioField: 'ratio',
    resolutions: RH_MODEL_RESOLUTIONS,
    ratios: RH_MODEL_RATIOS,
    watermark: true,
  },
  {
    value: 'minimax/hailuo-h3/text-to-video',
    label: 'H3 文生视频',
    hint: '只吃提示词；**连上来的参考图 / 视频 / 音频一律不带**（上游会当没看见）',
    image: null,
    video: null,
    audio: null,
    frames: null,
    durationMin: 5,
    durationMax: 15,
    ratioField: 'ratio',
    resolutions: RH_MODEL_RESOLUTIONS,
    ratios: RH_MODEL_RATIOS,
    watermark: true,
  },
  {
    value: 'minimax/hailuo-h3/context-ir-multimodal',
    label: 'H3 多模态增强提示词',
    hint: '多模态上下文理解，适合「照着这批素材来一段」；时长 4~15 秒',
    image: { field: 'imageUrls', max: 9, array: true },
    video: { field: 'videoUrls', max: 3, array: true },
    audio: { field: 'audioUrls', max: 3, array: true },
    frames: null,
    durationMin: 4,
    durationMax: 15,
    ratioField: 'ratio',
    resolutions: RH_MODEL_RESOLUTIONS,
    ratios: RH_MODEL_RATIOS,
    watermark: true,
  },
];

export type RhModelId = string;

/** 默认模型 = 清单里第一档（能力最全，不带素材也能跑）。 */
export const DEFAULT_RH_MODEL = RH_MODELS[0].value;

export const RH_MODEL_DEFAULTS = {
  model: DEFAULT_RH_MODEL,
  ratio: 'adaptive',
  resolution: '2K',
  duration: 5,
} as const;

/** 生成接口收到的那几个值（都是字符串 / 数字，可能缺）。 */
export type RhModelParamValues = {
  model?: string;
  duration?: string | number;
  resolution?: string;
  aspectRatio?: string;
};

/** 落定之后的实际提交值。 */
export type RhModelRequest = {
  model: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
};

/**
 * 按 id 取这一档的规格。认不出来返回 `null` —— **不回落默认值**：
 *
 * 模型 id 是「这一次要交给谁」的唯一依据，回落成第一档等于
 * 「你选了图生视频，我给你跑了多模态」，产出和预期不符而全程不报错。
 * 调用方拿到 null 应当直接拦下这次提交。
 */
export function rhModelSpecOf(id: unknown): RhModelSpec | null {
  const text = String(id ?? '').trim();
  if (!text) return null;
  return RH_MODELS.find(item => item.value === text) || null;
}

/** 这一档收不收某一路素材。给界面「该不该显示这一行」用。 */
export function rhModelTakesMedia(id: unknown, kind: 'image' | 'video' | 'audio'): RhMediaSlot {
  const spec = rhModelSpecOf(id);
  if (!spec) return null;
  return spec[kind];
}

/** 这一档用不用首尾帧（`i2va` 那两档）。给界面「该不该显示这一行」用。 */
export function rhModelFrames(id: unknown): RhFrameSlot {
  const spec = rhModelSpecOf(id);
  return spec ? spec.frames : null;
}

function pickValue(list: { value: string }[], raw: unknown, fallback: string) {
  return list.find(item => item.value === String(raw ?? '').trim())?.value ?? fallback;
}

function readDuration(raw: unknown, spec: RhModelSpec | null): number {
  const text = String(raw ?? '').trim();
  const fallback = spec
    ? Math.min(spec.durationMax, Math.max(spec.durationMin, RH_MODEL_DEFAULTS.duration))
    : RH_MODEL_DEFAULTS.duration;
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  return Math.round(value);
}

/**
 * 把画布上那几个值（可能缺、可能被手改成脏值）落成**实际会提交**的一组值。
 *
 * 与 `validateRhModelParams` 的分工同 `videoApiParams.ts`：那个负责报错，这个负责补默认值，
 * 两个都要有 —— 缺一个就会出现「没填的字段空着发出去」或「手改的脏值被静默改掉」。
 */
export function readRhModelParams(values: RhModelParamValues | undefined | null): RhModelRequest {
  const raw = String(values?.model ?? '').trim();
  const spec = rhModelSpecOf(raw);
  /*
   * 🔴 分辨率 / 比例的值域**按这一档自己的清单走**，不是拿一份全局清单。
   * RH Enhanced 那两档是 480p/768p/1080p + 无 adaptive，其余是 2K/768P + 有 adaptive；
   * 用错一份就会把「能跑的」判成非法、把「非法的」放过去。
   * 模型没填 / 认不出时退回默认档的清单，保证这组值永远有一份明确的出处。
   */
  /** `RH_MODELS[0]` 就是默认档（`DEFAULT_RH_MODEL` 取自它），不可能是空。 */
  const active = spec || RH_MODELS[0];
  return {
    /**
     * 「没填」和「填了但认不出」是两回事，必须分开处理：
     *   - 没填 → 给清单第一档（能力最全、不带素材也能跑），这样「新建节点直接跑」不会撞墙；
     *   - 填了但认不出 → **原样带出去**，交给 `validateRhModelParams` 报「不在可选列表里」，
     *     **绝不悄悄回落成另一档** —— 那等于把活交给另一个模型而全程不报错。
     */
    model: raw ? (spec ? spec.value : raw) : DEFAULT_RH_MODEL,
    duration: readDuration(values?.duration, active),
    resolution: pickValue(active.resolutions, values?.resolution, active.resolutions[0].value),
    aspectRatio: pickValue(active.ratios, values?.aspectRatio, active.ratios[0].value),
  };
}

/**
 * 校验模型直调的参数。返回错误文案，没问题返回 `null`。
 *
 * **空值不报错**（与其余两套参数同一条语义）：没填就是交给默认值。
 * 只有「填了、而且填的东西不对」才算错。
 *
 * 例外是 **model**：空串要报错 —— 那是「还没选模型」，跟「没填时长」不是一回事，
 * 而提交时必须有一个具体路径，凭空猜一个等于把活交给另一档模型。
 */
export function validateRhModelParams(values: RhModelParamValues | undefined | null): string | null {
  if (!values) return null;

  const model = String(values.model ?? '').trim();
  if (!model) return '还没选模型 —— 在「模型」那个下拉里挑一档。';
  const spec = rhModelSpecOf(model);
  if (!spec) return `模型「${model}」不在可选列表里，请从下拉里重新选一个。`;

  const resolution = String(values.resolution ?? '').trim();
  if (resolution && !spec.resolutions.some(item => item.value === resolution)) {
    return `分辨率「${resolution}」这一档不收（${spec.resolutions.map(item => item.value).join(' / ')}），请从下拉里重新选一个。`;
  }

  const aspectRatio = String(values.aspectRatio ?? '').trim();
  if (aspectRatio && !spec.ratios.some(item => item.value === aspectRatio)) {
    return `比例「${aspectRatio}」这一档不收（${spec.ratios.map(item => item.value).join(' / ')}），请从下拉里重新选一个。`;
  }

  const rawDuration = String(values.duration ?? '').trim();
  if (rawDuration) {
    const duration = Number(rawDuration);
    if (!Number.isFinite(duration) || !Number.isInteger(duration)) {
      return `时长「${rawDuration}」不是整数秒，请填 ${spec.durationMin}~${spec.durationMax} 之间的整数。`;
    }
    if (duration < spec.durationMin || duration > spec.durationMax) {
      return `时长「${duration}」秒超出范围：这一档模型只收 ${spec.durationMin}~${spec.durationMax} 秒。`;
    }
  }

  return null;
}
