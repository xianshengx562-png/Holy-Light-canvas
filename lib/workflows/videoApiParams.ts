/**
 * 视频网关（videoapi 引擎）的出图参数 —— **前后端共用的唯一定义**。
 *
 * 与工作流引擎那套（时长绑到工作流节点、latent 接续）是**两套互不相干的参数**：
 * 那边是把值绑到 RunningHub 工作流的节点字段上，这边是自己拼请求体直接打网关。
 * 两者不共用默认值、不共用校验函数，只共用一条规矩 ——「可选值与上下限必须前后端同源」：
 * 值域写在这里，UI 用它渲染下拉，生成接口用它校验（`<option>` 只挡得住鼠标，挡不住手改请求）。
 *
 * 界面上显示中文、存的是 `value`、发出去的必须是枚举值 —— 中文只存在于 `label`，永远不进请求体。
 *
 * ⚠️ 这是**通用适配层**，目标是「换个网关改 `.env` 就能跑」，所以它刻意只做**最保守的假设**：
 *   1. 请求体字段用最常见的那套名字（`prompt` / `duration` / `aspect_ratio` / `resolution` / `image_url`），
 *      对不上就在 `.env` 里换端点路径，或者改 `lib/providers/videoapi/client.ts` 里那一处拼装；
 *   2. **各网关支持的时长档位差得很大**（有的只收 5 / 10，有的 4~15 任意整数），所以这里只卡
 *      一个宽泛的区间（`VIDEO_API_DURATION_MIN` ~ `MAX`），精确档位交给网关自己校验；
 *   3. **图生视频时比例由输入图决定** —— 这是几家网关的共同行为（`ratio` 会被忽略），
 *      所以有首帧图时不该再让人纠结比例，界面上要说明「有首帧图时比例由图片决定」。
 */

/** 比例档位。`value` 就是发给上游的 `aspect_ratio`。 */
export const VIDEO_API_RATIOS: { value: string; label: string }[] = [
  { value: '16:9', label: '16:9 横屏' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '1:1', label: '1:1 方形' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '21:9', label: '21:9 宽幅' },
];

/** 分辨率档位。`value` 就是发给上游的 `resolution`。 */
export const VIDEO_API_RESOLUTIONS: { value: string; label: string }[] = [
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
];

/**
 * 时长（秒）的允许区间。
 *
 * 刻意宽泛：各网关能收的档位不一样（有的固定 5/10，有的 4~15 任意整数，有的能到 30），
 * 卡死成一份枚举反而会挡住本来能跑的组合。这里只拦「明显是乱填的」（0 秒、负数、几百秒），
 * 真正的档位由网关在收到请求时自己判 —— 那时的报错会带上它自己的可选值，比我们猜的准。
 */
export const VIDEO_API_DURATION_MIN = 1;
export const VIDEO_API_DURATION_MAX = 30;

export const VIDEO_API_DEFAULTS = {
  ratio: '16:9',
  resolution: '720p',
  duration: 5,
} as const;

/** 生成接口收到的那几个值（都是字符串 / 数字，可能缺）。 */
export type VideoApiParamValues = {
  /** 模型名。留空表示「用 `.env` 里配的那个」。 */
  model?: string;
  duration?: string | number;
  resolution?: string;
  aspectRatio?: string;
};

/** 落定之后的实际提交值。 */
export type VideoApiRequest = {
  model: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
};

function pickValue(list: { value: string }[], raw: unknown, fallback: string) {
  return list.find(item => item.value === String(raw ?? '').trim())?.value ?? fallback;
}

/**
 * 把时长落成数字。填了但解析不出来（`'abc'`、空串）就回默认值 ——
 * 校验函数会在「填了脏值」时报错，这里只管「没填」这一类。
 */
function readDuration(raw: unknown): number {
  const text = String(raw ?? '').trim();
  if (!text) return VIDEO_API_DEFAULTS.duration;
  const value = Number(text);
  return Number.isFinite(value) ? Math.round(value) : VIDEO_API_DEFAULTS.duration;
}

/**
 * 把画布上那几个值（可能缺、可能被手改成脏值）落成**实际会提交**的一组值。
 *
 * 和 `validateVideoApiParams` 的分工：那个负责在参数不对时**报错**，这个负责在参数没填时给默认值。
 * 两个都要有 —— 只做校验的话「没填」会一路空着发出去；只做兜底的话手改的脏值会被静默改成默认值，
 * 用户看到的效果就成了「我明明选了 1080p，出来的却是 720p」。
 */
export function readVideoApiParams(values: VideoApiParamValues | undefined | null): VideoApiRequest {
  return {
    model: String(values?.model ?? '').trim(),
    duration: readDuration(values?.duration),
    resolution: pickValue(VIDEO_API_RESOLUTIONS, values?.resolution, VIDEO_API_DEFAULTS.resolution),
    aspectRatio: pickValue(VIDEO_API_RATIOS, values?.aspectRatio, VIDEO_API_DEFAULTS.ratio),
  };
}

/**
 * 校验视频网关的参数。返回错误文案，没问题返回 `null`。
 *
 * **空值不报错** —— 与 `image2Params.ts` 保持一致的语义：没填就是交给默认值。
 * 只有「填了、而且填的东西不对」才算错。
 */
export function validateVideoApiParams(values: VideoApiParamValues | undefined | null): string | null {
  if (!values) return null;

  const resolution = String(values.resolution ?? '').trim();
  if (resolution && !VIDEO_API_RESOLUTIONS.some(item => item.value === resolution)) {
    return `分辨率「${resolution}」不在可选列表里，请从下拉里重新选一个。`;
  }

  const aspectRatio = String(values.aspectRatio ?? '').trim();
  if (aspectRatio && !VIDEO_API_RATIOS.some(item => item.value === aspectRatio)) {
    return `比例「${aspectRatio}」不在可选列表里，请从下拉里重新选一个。`;
  }

  const rawDuration = String(values.duration ?? '').trim();
  if (rawDuration) {
    const duration = Number(rawDuration);
    if (!Number.isFinite(duration) || !Number.isInteger(duration)) {
      return `时长「${rawDuration}」不是整数秒，请填 ${VIDEO_API_DURATION_MIN}~${VIDEO_API_DURATION_MAX} 之间的整数。`;
    }
    if (duration < VIDEO_API_DURATION_MIN || duration > VIDEO_API_DURATION_MAX) {
      return `时长「${duration}」秒超出范围，请填 ${VIDEO_API_DURATION_MIN}~${VIDEO_API_DURATION_MAX} 之间的整数。`;
    }
  }

  return null;
}
