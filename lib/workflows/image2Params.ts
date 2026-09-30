/**
 * 同步出图那一档的出图参数 —— **前后端共用的唯一定义**。
 *
 * 2026-09-23：这一套当初是为 **Image 2.0** 引擎写的（独立平台 · OpenAI 兼容）。
 * 那条链路整条删掉之后，它**没有跟着删** —— 因为「自定义接口出图」走的是同一条同步形状
 * （一次请求拿回图，参数是比例 / 分辨率），用的也是这一份值域和校验。
 * 文件名与 `IMAGE2_*` 这些常量名**保留原样**：节点数据里的字段名是 `image2Ratio` /
 * `image2Resolution`，改一次名等于让所有老节点集体失忆，收益却是零。
 *
 * 与 `imageParams.ts`（工作流引擎那套 steps / cfg / seed / 采样器）是**两套互不相干的参数**：
 * 那边是把值绑到 RunningHub 工作流的节点字段上，这边是自己拼请求体直接打网关。
 * 所以两者不共用默认值、不共用校验函数，只共用一条规矩 ——「可选值与上下限必须前后端同源」：
 * 值域写在这里，UI 用它渲染下拉，生成接口用它校验（`<option>` 只挡得住鼠标，挡不住手改请求）。
 *
 * 三个参数最终都要**变形成网关认得的形状**再发出去，映射只有一处（`readImage2Params`）：
 * - 比例 + 分辨率 → `size: '2048x1152'`（自适应 → `'auto'`）
 * - 输出背景模式 → `background: 'auto' | 'transparent' | 'opaque'`
 * 界面上显示中文，发出去的必须是枚举值 —— 中文只存在于 `label`，永远不进请求体。
 *
 * ⚠️ 待与真实文档核对（徐先补上 key/url 之后要过的几件事，改的时候只动本文件）：
 *   1. `size` 到底收 `WxH` 还是收档位代号（如 `1K`）——现在是按 `WxH` 算的；
 *   2. 边长是否必须 16 的倍数、以及 4K 是不是允许的最大档；
 *   3. 背景模式的三个枚举值是不是就叫 auto / transparent / opaque；
 *   4. 参考图那三档上限（上面 `IMAGE2_MAX_REFERENCE_*`）：网关自己的限制是多少，
 *      以及图生图到底走哪个端点（现在按 OpenAI 的 `/v1/images/edits` 写 —— 当年读这项配置
 *      的 `lib/providers/image2/config.ts` 已于 2026-09-23 连同引擎一起删了）。
 */

/** 「自适应」的内部值。界面显示「自适应」，发给上游是 `size: 'auto'`。 */
export const IMAGE2_RATIO_AUTO = 'auto';

/**
 * 「点一下就把尺寸定下来」时先用的那一档画幅（2026-09-30）。
 *
 * 比例是自适应时尺寸归上游，分辨率那一档**本来就不生效**，所以界面上摆的是
 * 一个只读读数（不是下拉）。可只有它一个读数，用户会得出「选不了 1K/2K/4K」——
 * 2026-09-30 徐先就是这么问的（他那个节点的比例还是默认的自适应，而唯一的提示
 * 藏在 hover 的 `title` 里，不悬上去看不见）。
 *
 * 于是那一行改成**可以点**：点一下先把比例从自适应换成一档具体画幅，
 * 分辨率下拉就出来了。这里定的就是「先换成哪一档」——
 * 选 1:1 是因为它最中性（方图），改起来也最容易认。
 *
 * 放在这里而不是组件里：它必须是 `IMAGE2_RATIOS` 里真有一档的值，
 * 写两处迟早对不上（这正是本文件开头那条「可选值必须前后端同源」的规矩）。
 */
export const IMAGE2_FIXED_RATIO = '1:1';

/**
 * 「尺寸交给上游」时 `image2Size()` 的返回值（2026-09-29）。
 *
 * 这是**我们自己**的记号，不是上游认得的枚举 —— OpenAI 那一套 `size` 只收
 * `1024x1024` / `4096x2304` 这种像素串，把 `'auto'` 发过去，认得的按「没指定」处理、
 * 不认得的直接 400。所以 `generateCustomImage` 见到它必须**整个字段不发**。
 *
 * 以前是直接发出去的 —— 那就是「我明明选了 4K、出来的却是 1K」的源头：
 * 上游拿不到合法尺寸，按自己的默认（1024）出图，界面上却还写着 4K。
 */
export const IMAGE2_SIZE_AUTO = 'auto';

export type Image2Ratio = {
  /** 内部键，同时是下拉的 value。**不发给上游**（上游收的是算出来的像素尺寸）。 */
  value: string;
  label: string;
  /** 宽高比（整数）；自适应是 0 / 0，表示「不指定尺寸」。 */
  w: number;
  h: number;
};

/**
 * 比例档位。`auto` 排在最前 —— 它是默认值，也是「拿不准选什么」时的正确答案。
 *
 * 这里是个**纯内部值域**，好处是猜错代价小：多一档少一档只影响能选到哪种画幅，
 * 不会像工作流那样「选了但参数被静默丢掉」——每一档都会真实算成一串像素尺寸发出去。
 */
export const IMAGE2_RATIOS: Image2Ratio[] = [
  { value: IMAGE2_RATIO_AUTO, label: '自适应', w: 0, h: 0 },
  { value: '1:1', label: '1:1', w: 1, h: 1 },
  { value: '3:4', label: '3:4', w: 3, h: 4 },
  { value: '4:3', label: '4:3', w: 4, h: 3 },
  { value: '9:16', label: '9:16', w: 9, h: 16 },
  { value: '16:9', label: '16:9', w: 16, h: 9 },
  { value: '2:3', label: '2:3', w: 2, h: 3 },
  { value: '3:2', label: '3:2', w: 3, h: 2 },
  { value: '21:9', label: '21:9', w: 21, h: 9 },
  { value: '4:5', label: '4:5', w: 4, h: 5 },
  { value: '1:2', label: '1:2', w: 1, h: 2 },
  { value: '2:1', label: '2:1', w: 2, h: 1 },
  { value: '5:4', label: '5:4', w: 5, h: 4 },
  { value: '5:3', label: '5:3', w: 5, h: 3 },
  { value: '3:5', label: '3:5', w: 3, h: 5 },
  { value: '4:7', label: '4:7', w: 4, h: 7 },
];

export type Image2Resolution = { value: string; label: string; /** 长边的像素数。 */ longEdge: number };

/** 分辨率档位：`longEdge` 是**长边**的像素数，短边按比例算出来（见 `image2Size`）。 */
export const IMAGE2_RESOLUTIONS: Image2Resolution[] = [
  { value: '1k', label: '1K', longEdge: 1024 },
  { value: '2k', label: '2K', longEdge: 2048 },
  { value: '4k', label: '4K', longEdge: 4096 },
];

export type Image2Background = { value: string; label: string; hint: string };

/** 输出背景模式。`value` 就是发给上游的 `background` 枚举值。 */
export const IMAGE2_BACKGROUNDS: Image2Background[] = [
  { value: 'auto', label: '自动', hint: '由模型决定' },
  { value: 'transparent', label: '透明', hint: '透明底（PNG）' },
  { value: 'opaque', label: '不透明', hint: '实色背景' },
];

export const IMAGE2_DEFAULTS = {
  ratio: IMAGE2_RATIO_AUTO,
  resolution: '1k',
  background: 'auto',
} as const;

/**
 * 参考图（图生图）的上限。与画布一致最多 9 张 —— 多接的会被丢掉，
 * 所以这个数字**必须**和 UI 上「N/9 图」那行提示对得上。
 */
export const IMAGE2_MAX_REFERENCES = 9;

/**
 * 单张 / 全部参考图的字节上限。
 *
 * 参考图要在服务端先取回字节再转发给网关，这里卡的是「我们愿意转发多少」：
 * 一张几十 MB 的原图既拖慢请求，也大概率被网关以「文件过大」拒掉，
 * 与其让上游回一句看不懂的错，不如在这里用中文说清楚是哪一张超了。
 */
export const IMAGE2_MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
export const IMAGE2_MAX_REFERENCE_TOTAL = 32 * 1024 * 1024;

/** 边长上限 / 下限。上限压着 4K 档，下限防止极端比例算出个几十像素的图。 */
export const IMAGE2_MAX_EDGE = 4096;
export const IMAGE2_MIN_EDGE = 256;
/**
 * 边长必须是 16 的倍数 —— 扩散模型的下采样步长决定的。
 * 宁愿短边差几像素，也不要给上游一个它不认的尺寸（那种错只会回一个参数校验失败）。
 */
export const IMAGE2_EDGE_STEP = 16;

function clampEdge(value: number) {
  const snapped = Math.round(value / IMAGE2_EDGE_STEP) * IMAGE2_EDGE_STEP;
  return Math.min(IMAGE2_MAX_EDGE, Math.max(IMAGE2_MIN_EDGE, snapped));
}

/**
 * 比例 + 分辨率 → 上游要的 `size` 字符串。
 *
 * 规则：**分辨率说的是长边**，短边按比例换算后取整到 16 的倍数。
 * 这样 `16:9 + 2K` 得到 `2048x1152`，`9:16 + 2K` 得到 `1152x2048` —— 换比例不用换档位。
 * 比例选了「自适应」就返回 `'auto'`，把尺寸交给上游决定（此时分辨率不生效，界面上会说明）。
 */
export function image2Size(ratio: unknown, resolution: unknown): string {
  const item = IMAGE2_RATIOS.find(entry => entry.value === String(ratio ?? '').trim());
  if (!item || item.value === IMAGE2_RATIO_AUTO) return IMAGE2_SIZE_AUTO;
  const edge = IMAGE2_RESOLUTIONS.find(entry => entry.value === String(resolution ?? '').trim())?.longEdge
    ?? IMAGE2_RESOLUTIONS[0].longEdge;
  const long = Math.max(item.w, item.h);
  const short = Math.min(item.w, item.h);
  /** 长边直接就是档位本身（1024 / 2048 / 4096 都是 16 的倍数，不用再取整）。 */
  const longPx = clampEdge(edge);
  const shortPx = clampEdge((edge * short) / long);
  return item.w >= item.h ? `${longPx}x${shortPx}` : `${shortPx}x${longPx}`;
}

/** 生成接口收到的那三个值（都是字符串，可能缺）。 */
export type Image2ParamValues = {
  ratio?: string;
  resolution?: string;
  background?: string;
};

/** 落定之后的实际提交值。`size` 是算好的像素串（或 `'auto'`）。 */
export type Image2Request = {
  ratio: string;
  resolution: string;
  background: string;
  size: string;
};

function pickValue(list: { value: string }[], raw: unknown, fallback: string) {
  return list.find(item => item.value === String(raw ?? '').trim())?.value ?? fallback;
}

/**
 * 把画布上那三个值（可能缺、可能被手改成脏值）落成**实际会提交**的一组值。
 *
 * 和 `validateImage2Params` 的分工：那个负责在参数不对时**报错**，这个负责在参数没填时给默认值。
 * 两个都要有 —— 只做校验的话「没填」会一路空着发出去；只做兜底的话手改的脏值会被静默改成默认值，
 * 用户看到的效果就成了「我明明选了 4K，出来的却是 1K」。
 */
export function readImage2Params(values: Image2ParamValues | undefined | null): Image2Request {
  const ratio = pickValue(IMAGE2_RATIOS, values?.ratio, IMAGE2_DEFAULTS.ratio);
  const resolution = pickValue(IMAGE2_RESOLUTIONS, values?.resolution, IMAGE2_DEFAULTS.resolution);
  const background = pickValue(IMAGE2_BACKGROUNDS, values?.background, IMAGE2_DEFAULTS.background);
  return { ratio, resolution, background, size: image2Size(ratio, resolution) };
}

/**
 * 校验同步出图这三个参数（比例 / 分辨率 / 输出背景）。返回错误文案，没问题返回 `null`。
 *
 * **空值不报错** —— 那和 `imageParams.ts` 保持一致的语义：没填就是交给默认值。
 * 只有「填了、而且填的东西不在可选列表里」才算错。
 */
export function validateImage2Params(values: Image2ParamValues | undefined | null): string | null {
  if (!values) return null;
  const checks: [string, unknown, { value: string }[]][] = [
    ['比例', values.ratio, IMAGE2_RATIOS],
    ['分辨率', values.resolution, IMAGE2_RESOLUTIONS],
    ['输出背景模式', values.background, IMAGE2_BACKGROUNDS],
  ];
  for (const [label, raw, list] of checks) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    if (!list.some(item => item.value === text)) {
      return `${label}「${text}」不在可选列表里，请从下拉里重新选一个。`;
    }
  }
  return null;
}
