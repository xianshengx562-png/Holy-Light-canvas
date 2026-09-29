/**
 * 出图参数的取值范围 —— **前后端共用的唯一定义**。
 *
 * 以前这些上下限只是写进 `<input min max>` 里：那种约束只管得住鼠标点箭头，
 * 手敲 `9999` 照样能提交，接口也照收。前端拦不住无所谓，服务端拦不住就麻烦了——
 * 参数一路送到 RunningHub，任务失败或者跑出一堆废图，积分照扣。
 * 所以上下限放在这里，UI 用它渲染 `min/max`，生成接口用它校验。
 *
 * 注意这套值**只对图片生成有意义**（视频那一路不会提交 steps / cfg / 采样器），
 * 但校验函数对缺失的键一律跳过，所以可以无脑对整个 `bindingValues` 调用。
 */

/**
 * 画面比例的档位 —— **工作流引擎那套**（首页输入框的比例下拉、画布参数条共用）。
 *
 * 值里带括号备注是历史包袱（RunningHub 的字段值就长这样），但 `deriveImageSize`
 * 的解析能容忍它，所以不动 —— 改了一堆老画布上存着的值会当场对不上。
 *
 * ⚠️ 另一套比例在 `image2Params.ts`（同步出图那一档，值是 `16:9` 这种短串）。
 * 两套互不相干：一个节点的**引擎**决定用哪套，界面上整块换装、绝不并排。
 * 从 `components/canvas/nodeMeta.ts` 搬过来 —— 首页要用它，而 lib 不该反向引 components。
 */
export const ASPECT_RATIOS = [
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
];

/** 工作流引擎的默认比例。图片那套的默认值在 `IMAGE_DEFAULTS.ratio`（方形），刻意不同。 */
export const DEFAULT_RATIO = '16:9 (Widescreen)';

export const IMAGE_DEFAULTS = {
  ratio: '1:1 (Square)',
  megapixels: '1',
  batchSize: '1',
  steps: '20',
  cfg: '7.5',
  seed: '-1',
  sampler: '',
} as const;

/**
 * 出图节点在**某一档引擎**下的默认比例（2026-09-24）。
 *
 * 为什么要按引擎分开给：本机 ComfyUI 那一档几乎全是横屏用途（漫剧 / 短剧 / 壁纸），
 * 默认给 16:9；1:1 是 RunningHub 那套工作流的历史默认（方形最省算力，也是云端示例图的形状），
 * 而老画布上没有 `engine` 字段的节点**必须继续按 1:1 跑** —— 所以默认值不统一改，
 * 只在「用户把引擎切到本机」这一刻才跟着换（见 `engineSwitchPatch`）。
 */
export function defaultImageRatioForEngine(engine: string | undefined | null): string {
  return String(engine ?? '').trim() === 'local' ? DEFAULT_RATIO : IMAGE_DEFAULTS.ratio;
}

/** 出图数量的上限：再多一次提交也没意义，而且很多工作流会在服务端排队很久。 */
export const MAX_BATCH = 8;
export const MAX_STEPS = 150;
export const MAX_CFG = 30;
export const MIN_MEGAPIXELS = 0.1;
export const MAX_MEGAPIXELS = 4;
/**
 * 种子的上限。Comfy 的种子理论上是 64 位无符号整数，但 JS 只能精确表示到
 * `Number.MAX_SAFE_INTEGER`，再往上使用两个不同的大数会被判成相等，所以就卡在这里。
 */
export const MAX_SEED = Number.MAX_SAFE_INTEGER;

/**
 * 采样器列表。值用 ComfyUI `KSampler` 的规范名——RunningHub 跑的就是 Comfy 工作流，
 * 直接传中文名对方认不出来；空值表示「由工作流自己决定」。
 */
export const SAMPLERS: { value: string; label: string }[] = [
  { value: '', label: '由工作流决定' },
  { value: 'euler', label: 'Euler' },
  { value: 'euler_ancestral', label: 'Euler a' },
  { value: 'heun', label: 'Heun' },
  { value: 'dpm_2', label: 'DPM 2' },
  { value: 'dpm_2_ancestral', label: 'DPM 2 a' },
  { value: 'lms', label: 'LMS' },
  { value: 'dpmpp_2m', label: 'DPM++ 2M' },
  { value: 'dpmpp_2m_karras', label: 'DPM++ 2M Karras' },
  { value: 'dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { value: 'dpmpp_2m_sde_gpu', label: 'DPM++ 2M SDE GPU' },
  { value: 'dpmpp_2s_ancestral', label: 'DPM++ 2S a' },
  { value: 'dpmpp_sde', label: 'DPM++ SDE' },
  { value: 'dpmpp_sde_gpu', label: 'DPM++ SDE GPU' },
  { value: 'dpmpp_3m_sde', label: 'DPM++ 3M SDE' },
  { value: 'dpm_fast', label: 'DPM fast' },
  { value: 'dpm_adaptive', label: 'DPM adaptive' },
  { value: 'ddim', label: 'DDIM' },
  { value: 'lcm', label: 'LCM' },
  { value: 'uni_pc', label: 'UniPC' },
  { value: 'uni_pc_bh2', label: 'UniPC BH2' },
];

/** 采样器的显示名：认不出值时原样显示，免得下拉里出现空白。 */
export function samplerLabel(value: unknown) {
  const text = String(value ?? '').trim();
  return SAMPLERS.find(item => item.value === text)?.label || text;
}

type NumberSpec = {
  label: string;
  min: number;
  max: number;
  /** 必须是整数（步数、张数、种子）。 */
  integer?: boolean;
};

/**
 * 需要校验范围的数值字段。键名与 `bindingValues` 里的字段一致。
 *
 * 种子单独说明：最小值给 -1（「每次随机」的约定值），其余按 0 起算的整数走。
 */
export type ImageNumberField = 'batchSize' | 'steps' | 'cfg' | 'seed' | 'megapixels';

export const IMAGE_NUMBER_FIELDS: Record<ImageNumberField, NumberSpec> = {
  batchSize: { label: '出图张数', min: 1, max: MAX_BATCH, integer: true },
  steps: { label: '采样步数', min: 1, max: MAX_STEPS, integer: true },
  cfg: { label: '引导系数 (CFG)', min: 1, max: MAX_CFG },
  seed: { label: '随机种子', min: -1, max: MAX_SEED, integer: true },
  megapixels: { label: '百万像素 (MP)', min: MIN_MEGAPIXELS, max: MAX_MEGAPIXELS },
};

/** 生成接口收到的那部分画布值（都是字符串，可能缺）。 */
export type ImageParamValues = Partial<Record<ImageNumberField | 'sampler', string | undefined>>;

/**
 * 校验出图参数。返回错误文案，没问题返回 `null`。
 *
 * **空值不报错**——没填就是交给默认值，这是正常用法；只有填了而且填错才算错。
 * 这条很重要：`bindingValues` 里视频那一路根本不带 steps / cfg，如果空值也报错，
 * 视频生成会直接生成不了。
 */
export function validateImageParams(values: ImageParamValues | undefined | null): string | null {
  if (!values) return null;
  for (const key of Object.keys(IMAGE_NUMBER_FIELDS) as ImageNumberField[]) {
    const spec = IMAGE_NUMBER_FIELDS[key];
    const raw = String(values[key] ?? '').trim();
    if (!raw) continue;
    const num = Number(raw);
    if (!Number.isFinite(num)) return `${spec.label}得是数字，现在是「${raw}」。`;
    if (spec.integer && !Number.isInteger(num)) return `${spec.label}得是整数，现在是「${raw}」。`;
    if (num < spec.min || num > spec.max) {
      return `${spec.label}要在 ${spec.min} 到 ${spec.max} 之间，现在是「${raw}」。`;
    }
  }
  const sampler = String(values.sampler ?? '').trim();
  if (sampler && !SAMPLERS.some(item => item.value === sampler)) {
    return `采样器「${sampler}」不在可选列表里，请从下拉里重新选一个。`;
  }
  return null;
}

/**
 * 把「比例 + 分辨率(MP)」换算成像素宽高，供**空 Latent 节点**的 `width` / `height` 绑定使用。
 *
 * 空 Latent（ComfyUI `EmptyLatentImage`）的宽高就是像素数，没有「比例」这种抽象概念，
 * 但画布上图片生成节点只暴露「比例 + 分辨率」，所以这里把两者换算成具体像素：
 * - `megapixels` 是总面积（百万像素），面积 = MP × 1,000,000；
 * - 边长按 `width:height` 同比例缩放，使面积达标；
 * - 两个维度都取整到 **16 的倍数**（扩散模型下采样步长的硬约束，否则上游直接参数校验失败）。
 *
 * 比例字符串容忍 `16:9`、`16x9`、`16×9` 以及后面带括号备注（如 `16:9 (Widescreen)`）的写法；
 * 解析不出时回落 1:1。`megapixels` 解析不出或 ≤0 时回落 1 MP。
 * 返回 `null` 表示连兜底都算不出来（理论上不会，只为防止把 NaN 提交给工作流）。
 */
export function deriveImageSize(
  aspectRatio: string | undefined | null,
  megapixels: string | undefined | null,
): { width: number; height: number } | null {
  const ratioMatch = String(aspectRatio ?? '').trim().match(/(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)/i);
  let w = 1;
  let h = 1;
  if (ratioMatch) {
    w = Number(ratioMatch[1]);
    h = Number(ratioMatch[2]);
  }
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    w = 1;
    h = 1;
  }
  const mp = Number(String(megapixels ?? '').trim());
  const area = Number.isFinite(mp) && mp > 0 ? mp * 1_000_000 : 1_000_000;
  const scale = Math.sqrt(area / (w * h));
  const toEdge = (value: number) => {
    const snapped = Math.round(Math.max(16, value) / 16) * 16;
    return Math.min(8192, Math.max(16, snapped));
  };
  return { width: toEdge(w * scale), height: toEdge(h * scale) };
}

/*
 * 图片节点「长宽」的两种来源（2026-09-21）。
 *
 * - `resolution` —— 长宽由「比例 + 分辨率（MP）」换算出来，界面上是**只读读数**；
 * - `custom` —— 用户在面板里直接填宽高像素。
 *
 * 为什么做成节点上的一档，而不是「跟着这份工作流实际绑了什么推」：
 * 后者要先读一次工作流配置，而那个接口在**没有草稿的云端自定义工作流**上会去
 * RunningHub 拉一遍图 —— 几秒、还可能失败。选中一个节点就发这种请求不划算，
 * 而且失败时界面还得决定「猜哪个」。用户自己选一档：当场切换、不联网、行为可预期。
 */
export const IMAGE_SIZE_MODES = [
  { value: 'resolution', label: '按分辨率' },
  { value: 'custom', label: '自定义长宽' },
] as const;

export type ImageSizeMode = (typeof IMAGE_SIZE_MODES)[number]['value'];

/** 手填长宽的上下限。上限与 `deriveImageSize` 的钳制对齐；下限 64 是为了让「手滑填了 6」
 *  这种值当场被拒，而不是送进工作流之后才炸 —— 那时的报错在服务端，看不出是填数填错了。 */
export const MIN_CUSTOM_SIDE = 64;
export const MAX_CUSTOM_SIDE = 8192;

export function readImageSizeMode(value: string | undefined | null): ImageSizeMode {
  return value === 'custom' ? 'custom' : 'resolution';
}

/**
 * 实际提交的宽高是否站得住 —— 服务端在扣分**之前**也要过这一条。
 *
 * 界面上那两个输入框的 `min` / `max` 只挡得住鼠标点箭头，手敲一个 99999
 * 照样能提交；而换算那一档算出来的数也该有个上限兜底。
 * 下限取 16（与 `deriveImageSize` 的钳制一致：小于它下游的下采样步长就对不上了）。
 */
export function validateOutputSize(
  width: string | undefined | null,
  height: string | undefined | null,
): string {
  const rawW = String(width ?? '').trim();
  const rawH = String(height ?? '').trim();
  if (!rawW || !rawH) return '';   /* 没给长宽 = 这一档不参与，不拦 */
  const w = Number(rawW);
  const h = Number(rawH);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return '长宽要填数字。';
  if (w < 16 || h < 16) return '长宽不能小于 16 像素。';
  if (w > MAX_CUSTOM_SIDE || h > MAX_CUSTOM_SIDE) return `长宽不能大于 ${MAX_CUSTOM_SIDE} 像素。`;
  return '';
}

/**
 * 这个节点本轮实际提交的宽高像素。
 *
 * 界面显示与提交**必须走同一个函数**。两边各算一次的话，只要有一边忘了看 `sizeMode`，
 * 就会出现「面板上写着 1024×1024，实际提交的是按 MP 算出来的另一个数」——
 * 这种错没有任何报错，只能等用户看出图不对才发现。
 */
export function resolveImageSize(input: {
  sizeMode?: string | null;
  customWidth?: string | null;
  customHeight?: string | null;
  aspectRatio?: string | null;
  megapixels?: string | null;
}): { width: number; height: number } | null {
  if (readImageSizeMode(input.sizeMode) === 'custom') {
    if (validateCustomSize(input.customWidth, input.customHeight)) return null;
    const w = Math.round(Number(String(input.customWidth ?? '').trim()));
    const h = Math.round(Number(String(input.customHeight ?? '').trim()));
    /* 同样对齐到 16 的倍数：手填一个 1000 会让下游的下采样步长对不上。 */
    const snap = (value: number) => Math.round(value / 16) * 16;
    return { width: snap(w), height: snap(h) };
  }
  return deriveImageSize(input.aspectRatio, input.megapixels);
}

/**
 * 手填那一档填得对不对；返回空串表示可用。
 * 界面与服务端共用同一句措辞 —— 否则会出现「界面说上限 8192、服务端说 4096」这种对不上的情况。
 */
export function validateCustomSize(
  width: string | undefined | null,
  height: string | undefined | null,
): string {
  const raw = String(width ?? '').trim();
  const rawH = String(height ?? '').trim();
  if (!raw || !rawH) return '自定义长宽要两个都填。';
  const w = Number(raw);
  const h = Number(rawH);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return '长宽要填数字。';
  if (w < MIN_CUSTOM_SIDE || h < MIN_CUSTOM_SIDE) return `长宽不能小于 ${MIN_CUSTOM_SIDE} 像素。`;
  if (w > MAX_CUSTOM_SIDE || h > MAX_CUSTOM_SIDE) return `长宽不能大于 ${MAX_CUSTOM_SIDE} 像素。`;
  return '';
}
