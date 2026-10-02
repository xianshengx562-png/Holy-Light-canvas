import { z } from 'zod';

/**
 * 序列型绑定的槽位上限。
 *
 * 参考图给到 20：多角色 / 多机位的工作流真会一次吃七八张，写死 9 个不够用。
 * 视频 / 音频给到 10：一个工作流里 LoadVideo / LoadAudio 那类节点不会比这更多。
 */
export const MAX_REFERENCE_IMAGES = 20;
export const MAX_VIDEO_INPUTS = 10;
export const MAX_AUDIO_INPUTS = 10;

/** 槽位号（1 起）。用模板字面量类型生成「参考图 N」这一串名字，省掉手写二十遍。 */
type RefSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;
type MediaSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type ReferenceImageBinding = `reference_image_${RefSlot}`;
/**
 * 视频 / 音频的 **1 号不带编号后缀** —— 老配置里存的就是 `video_input` / `audio_input`。
 * 给它改名成 `video_input_1` 的代价是整份配置在 `configurationSchema.parse` 处直接失败
 * （「节点配置无效，请重新保存」），用户配好的所有绑定一夜之间全丢。
 */
export type VideoInputBinding = 'video_input' | `video_input_${Exclude<MediaSlot, 1>}`;
export type AudioInputBinding = 'audio_input' | `audio_input_${Exclude<MediaSlot, 1>}`;

export type CanvasBinding =
  | 'manual' | 'prompt' | 'duration' | 'aspect_ratio' | 'megapixels' | 'reference_count'
  | ReferenceImageBinding
  | 'latent_1' | 'latent_2' | 'continuation'
  | 'negative_prompt' | 'steps' | 'cfg' | 'seed' | 'batch_size' | 'sampler'
  | 'width' | 'height'
  | 'upscale_input'
  | VideoInputBinding | AudioInputBinding;

const PLAIN_BINDINGS = ['manual', 'prompt', 'duration', 'aspect_ratio', 'megapixels', 'reference_count',
  'latent_1', 'latent_2', 'continuation',
  'negative_prompt', 'steps', 'cfg', 'seed', 'batch_size', 'sampler',
  'width', 'height', 'upscale_input'] as const;

const REFERENCE_IMAGE_BINDINGS = Array.from({ length: MAX_REFERENCE_IMAGES }, (_, i) => `reference_image_${i + 1}`) as ReferenceImageBinding[];
const VIDEO_INPUT_BINDINGS = ['video_input', ...Array.from({ length: MAX_VIDEO_INPUTS - 1 }, (_, i) => `video_input_${i + 2}`)] as VideoInputBinding[];
const AUDIO_INPUT_BINDINGS = ['audio_input', ...Array.from({ length: MAX_AUDIO_INPUTS - 1 }, (_, i) => `audio_input_${i + 2}`)] as AudioInputBinding[];

export const ALL_CANVAS_BINDINGS: CanvasBinding[] = [...PLAIN_BINDINGS, ...REFERENCE_IMAGE_BINDINGS, ...VIDEO_INPUT_BINDINGS, ...AUDIO_INPUT_BINDINGS];

export const canvasBindingSchema = z.enum(ALL_CANVAS_BINDINGS);

/**
 * 序列型绑定：同一类输入可以挂**很多份**（参考图 1 / 2 / 3…，视频 1 / 2…）。
 *
 * `first` 是 1 号的值，`prefix` 是 2 号起的名字前缀 —— 两者分开是因为视频 / 音频的 1 号
 * 是历史值（不带编号），2 号起才带。改名会让老配置解析失败（见 `VideoInputBinding`）。
 */
type BindingSeries = {
  key: 'reference' | 'video' | 'audio';
  first: CanvasBinding;
  prefix: string;
  max: number;
  label: string;
  /**
   * 哪些用途下会出现。参考图三种用途都有；视频 / 音频输入是**喂一段素材进去**，
   * 出图工作流吃不消，音频工作流吃得下音频（改音色、续写这类），所以音频那两个都开。
   */
  contexts: ('image' | 'video' | 'audio')[];
};
const SERIES: BindingSeries[] = [
  { key: 'reference', first: 'reference_image_1', prefix: 'reference_image_', max: MAX_REFERENCE_IMAGES, label: '参考图', contexts: ['image', 'video', 'audio'] },
  { key: 'video', first: 'video_input', prefix: 'video_input_', max: MAX_VIDEO_INPUTS, label: '视频输入', contexts: ['video'] },
  { key: 'audio', first: 'audio_input', prefix: 'audio_input_', max: MAX_AUDIO_INPUTS, label: '音频输入', contexts: ['video', 'audio'] },
];

/**
 * 同一条序列里**下一个还没用到的槽位** —— 界面拿它提示「还能再加一份」
 * （不写这句，用户看着手里的「参考图 1」不会知道还能再接一张，等于把能力藏起来）。
 */
export function nextSeriesBinding(fields: { binding?: string }[], binding: CanvasBinding): CanvasBinding | null {
  const hit = seriesSlot(binding);
  if (!hit) return null;
  const next = hit.slot + 1;
  return next <= hit.series.max ? seriesBinding(hit.series, next) : null;
}

/** 认出一个绑定属于哪条序列、是第几号；不是序列项就返回 null。 */
function seriesSlot(binding: string): { series: BindingSeries; slot: number } | null {
  for (const series of SERIES) {
    if (binding === series.first) return { series, slot: 1 };
    if (binding.startsWith(series.prefix)) {
      const slot = Number(binding.slice(series.prefix.length));
      if (Number.isInteger(slot) && slot >= 1 && slot <= series.max) return { series, slot };
    }
  }
  return null;
}

function seriesBinding(series: BindingSeries, slot: number): CanvasBinding {
  return (slot <= 1 ? series.first : `${series.prefix}${slot}`) as CanvasBinding;
}

const canvasBindingLabelsBase: Record<string, string> = {
  manual: '手动固定值', prompt: '画布 · 提示词', duration: '画布 · 视频时长',
  aspect_ratio: '画布 · 画面比例', megapixels: '画布 · 基础分辨率',
  reference_count: '画布 · 参考图数量',
  latent_1: '画布 · 接续 latent 1（粗采样）', latent_2: '画布 · 接续 latent 2（精采样）',
  continuation: '画布 · 开启接续（节点 196，反向：开=false）',
  negative_prompt: '画布 · 负向提示词', steps: '画布 · 采样步数', cfg: '画布 · 引导系数 (CFG)',
  seed: '画布 · 随机种子', batch_size: '画布 · 出图张数', sampler: '画布 · 采样器',
  width: '画布 · 宽度', height: '画布 · 高度',
  upscale_input: '超清',
};

/** 序列项的标签按编号生成 —— 手写 20 个「参考图 N」迟早会和枚举对不上。 */
function seriesLabels(values: CanvasBinding[], label: string): Record<string, string> {
  return Object.fromEntries(values.map((value, index) => [value, `画布 · ${label} ${index + 1}`]));
}

export const canvasBindingLabels: Record<CanvasBinding, string> = {
  ...canvasBindingLabelsBase,
  ...seriesLabels(REFERENCE_IMAGE_BINDINGS, '参考图'),
  ...seriesLabels(VIDEO_INPUT_BINDINGS, '视频输入'),
  ...seriesLabels(AUDIO_INPUT_BINDINGS, '音频输入'),
} as Record<CanvasBinding, string>;

/**
 * 配置页「画布参数绑定」下拉的可选项，**按工作流用途 / 工序过滤**，避免把不相关的绑定混进来：
 * - 图片生成：提示词、比例、分辨率、参考图，加上出图专属的步数 / CFG / 种子 / 负向提示词 / 采样器 / 张数。
 * - 视频生成：提示词、比例、分辨率、参考图，加上视频专属的时长 / 接续 latent / 开启接续。
 * - 音频生成：只留提示词与参考图数量（2026-10-02）。**刻意不列时长与比例** ——
 *   画布上音频那一档把「生成时长 / 比例 / 分辨率」整组收掉了，这里再给个「画布 · 视频时长」
 *   绑上去，提交时那个值是空的，症状又是「任务成功、参数被静默丢掉」。
 * - 超清：只有「参考图 1 / 视频输入 1」两个**通用输入槽**（待加工的那一份媒体落在其中一个），
 *   与生成配置彻底独立 —— 不要提示词、不要比例、不要 latent（理由见 `UPSCALE_BINDINGS`）。
 *
 * **不含序列项**（参考图 N / 视频 N / 音频 N）—— 那些由 `bindingsForFields` 按「已用到第几个」
 * 追加，全部铺开会让一个只用两张参考图的工作流面对 20 个选项。
 */
const IMAGE_GENERATION_BINDINGS: CanvasBinding[] = [
  'prompt', 'aspect_ratio', 'megapixels', 'reference_count',
  'negative_prompt', 'steps', 'cfg', 'seed', 'batch_size', 'sampler', 'width', 'height',
];
const VIDEO_GENERATION_BINDINGS: CanvasBinding[] = [
  'prompt', 'aspect_ratio', 'megapixels', 'reference_count',
  'duration', 'latent_1', 'latent_2', 'continuation',
];
/** 音频：只有提示词与参考图数量（理由见上面「按用途过滤」那条注释）。 */
const AUDIO_GENERATION_BINDINGS: CanvasBinding[] = ['prompt', 'reference_count'];
/**
 * 超清工序能绑的槽位：**通用输入槽，不再单造一个「超清」绑定**（2026-10-02 徐先）。
 *
 * 原来这里只有 `upscale_input` 一项，标签就叫「超清」。它是**为超清单造的一个概念** ——
 * 而超清工作流真正吃的那份媒体，在工作流里长什么样，跟普通「加载视频 / 加载图片」节点
 * 没有任何区别：都是「一个接收文件的字段」。专门为它造一个绑定，代价是
 * ①又多一个要记的名字；②超清工作流**只要还需要第二份输入就没处选**。
 *
 * 现在改成复用现成的两个槽位：
 * - `reference_image_1`（画布 · 参考图 1）—— 待加工的是一张图（图片超清）；
 * - `video_input`（画布 · 视频输入 1）—— 待加工的是一段视频（视频超清）。
 *
 * 两者都给而不是按用途只给一个：同一种媒体在不同工作流里落在不同类型的加载节点上，
 * 该绑哪个只有配这份工作流的人知道。没被绑的那一支不会进 `nodeInfoList`
 * （绑定的机制本来就是「没人接就跳过」），所以两个都给不会有副作用。
 *
 * ⚠️ `upscale_input` **没有删**：老配置里已经绑上它的字段要照旧能读、能跑
 * （读出来时 `selected.binding` 会把它带回下拉，可以改也可以留着）。
 * 只做「下拉里不再主动给新的」，不做迁移 —— 那是把一份能用的配置改成坏掉的配置。
 */
const UPSCALE_BINDINGS: CanvasBinding[] = ['reference_image_1', 'video_input'];

/**
 * 这个绑定能不能承接**待超清的那份媒体**。
 *
 * 三类落点（理由见 `UPSCALE_BINDINGS` 那条注释）：
 * `upscale_input`（老绑定，老配置里还绑着它，不能因为加了新槽位就把它们判成没接上）、
 * `reference_image_*`（图超清）、`video_input*`（视频超清）。
 *
 * 🔴 配置页那句「还没有字段承接待加工的媒体」与服务端那条
 * 「有值却没接进工作流就报错」的检查**必须走同一个判定** ——
 * 两边各写一份的话，迟早出现「界面说绑好了、提交时却说没接上」。
 */
export function isUpscaleInputBinding(binding: unknown): boolean {
  const value = String(binding ?? '');
  return value === 'upscale_input' || value.startsWith('reference_image_') || value.startsWith('video_input');
}

export function bindingsForContext(
  kind: 'image' | 'video' | 'audio',
  operation: 'generate' | 'upscale',
): CanvasBinding[] {
  if (operation === 'upscale') return UPSCALE_BINDINGS;
  if (kind === 'image') return IMAGE_GENERATION_BINDINGS;
  return kind === 'audio' ? AUDIO_GENERATION_BINDINGS : VIDEO_GENERATION_BINDINGS;
}

/**
 * 下拉里**真正能选**的那些绑定 = 非序列项 + 各序列「已用到第 N 个就露出前 N+1 个」。
 *
 * 为什么要渐进：一上来把 20 个「参考图 5 / 参考图 6…」全铺开，绝大多数工作流只用前两个，
 * 用户得翻完一屏才知道自己要的是哪一个 —— 而「还能再加一张」这件事反而看不出来。
 * 反过来，**少了这一条就等于把能力藏起来**：原来那一版只有 9 个写死的参考图位，
 * 想要第 10 张的人根本没处选。
 */
export function bindingsForFields(
  fields: { binding?: string }[],
  kind: 'image' | 'video' | 'audio',
  operation: 'generate' | 'upscale',
): CanvasBinding[] {
  const base = bindingsForContext(kind, operation);
  if (operation === 'upscale') return base;
  const out = [...base];
  for (const series of SERIES) {
    if (!series.contexts.includes(kind)) continue;
    const used = fields.reduce((max, field) => {
      const hit = seriesSlot(String(field.binding || ''));
      return hit && hit.series === series ? Math.max(max, hit.slot) : max;
    }, 0);
    /** 用到第 N 个就给到 N+1：刚选完「参考图 2」，下一个「参考图 3」已经在下拉里等着。 */
    const shown = Math.min(used + 1, series.max);
    for (let slot = 1; slot <= shown; slot += 1) out.push(seriesBinding(series, slot));
  }
  return out;
}

/**
 * 字段名里的**隐形字符**。从 ComfyUI 导出的图里真的会遇到：
 *
 * - 零宽空格（U+200B）/ 零宽不连字 / 零宽连字 / BOM —— 在编辑器里看不见，
 *   但两个「同名」字段其实是两个不同的字符串；
 * - 尾巴上的空格。
 *
 * `AnimaMultiLoraLoader` 这类第三方插件的 LoRA 控制项就是重灾区：同一节点里
 * `"   Strength"` 和 `"   Strength\u200b"` 会同时出现，两者在界面上渲染出来一模一样。
 */
const INVISIBLE = /[\u200b\u200c\u200d\u2060\ufeff]/g;

/**
 * 把一个字段名收拾成**能显示、能比较**的样子：去掉隐形字符、首尾空白折成一个。
 *
 * 只动「显示与比对」这一层，**不动提交给 ComfyUI 的 `fieldName`** —— 那是插件认的键，
 * 改一个字符它就找不到 LoRA 了。两者分开由 `graphToFields` 维护。
 */
export function normalizeFieldLabel(fieldName: string): string {
  const cleaned = fieldName.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  /* 全是隐形字符 / 空白的名字保底给一个占位，避免 label 为空触发 schema 的 min(1)。 */
  return cleaned || '(未命名字段)';
}

/**
 * 节点字段的稳定标识：`nodeId + '.' + fieldName`。
 *
 * 图里扫出来的字段、手填的字段、界面改过 ID / 字段名之后的字段 —— 全都走这一个函数，
 * 保证「同一行」在任何时候算出来的 key 都一样。发现不一致时**先看这个函数有没有被绕过**：
 * 只要有一处自己拼字符串，那一处的行就会在改完名字之后跟丢选中项。
 */
export function fieldKey(nodeId: string, fieldName: string): string {
  return `${nodeId}.${fieldName}`;
}

export const defaultBindingsByKey: Record<string, CanvasBinding> = {
  '70.value': 'prompt', '48.value': 'duration', '66.aspect_ratio': 'aspect_ratio',
  '66.megapixels': 'megapixels', '273.length': 'reference_count',
  '265.image': 'reference_image_1', '266.image': 'reference_image_2',
  '255.image': 'reference_image_3', '256.image': 'reference_image_4',
  '268.image': 'reference_image_5', '312.image': 'reference_image_6',
  '313.image': 'reference_image_7', '314.image': 'reference_image_8',
  '315.image': 'reference_image_9',
  '210.手动上传': 'latent_1', '278.手动上传': 'latent_2',
  '196.value': 'continuation',
};

export const fieldSchema = z.object({
  /*
   * `key` 是界面用来选中 / 定位一行的句柄，服务端不拿它认字段 ——
   * 真正提交给 ComfyUI 的只有 `nodeId` + `fieldName`。
   *
   * 它是 `fieldKey(nodeId, fieldName)` 现算出来的，改 `nodeId` / `fieldName` 时由界面同步改掉
   * （见 `WorkflowConfigurator.patch`）。用它做选中/定位，比拿 `nodeId + fieldName` 现拼稳 ——
   * 后者一旦被 schema 改形就对不上了。
   */
  key: z.string().min(1).max(120),
  nodeId: z.string().regex(/^[\w:-]+$/).max(100),
  /*
   * ⚠️ **不要 trim**。这里是发给 ComfyUI 的参数键，必须和插件认的那串字符**逐字相同**。
   *
   * 第三方插件的键名经常带空格 / 隐形字符：`AnimaMultiLoraLoader` 里就同时有
   * `"   Strength"`（三个前导空格）和 `"   Strength\u200b"`（再加个零宽空格）——
   * 它们是**两个不同 LoRA 的强度**。早先这里写了 `.trim()`：
   *   1. 提交时 `"   Strength"` 被削成 `"Strength"`，插件根本找不到这个键 → 参数被丢掉；
   *   2. 两个键双双削成 `"Strength"`，撞成一个，用户勾了两个只生效一个（或报「只能启用一次」）；
   *   3. `key`（未被 trim）与 `nodeId + '.' + fieldName`（已 trim）从此对不上，改一次存一次就散。
   * 显示用 `label`（见 `normalizeFieldLabel`），提交用 `fieldName`（原样），两者职责分开。
   */
  fieldName: z.string().min(1).max(100),
  label: z.string().trim().min(1).max(160),
  kind: z.enum(['text', 'number', 'boolean', 'image', 'video', 'audio', 'latent']),
  value: z.string().max(40000),
  enabled: z.boolean(),
  binding: canvasBindingSchema.default('manual'),
  recommended: z.boolean().default(false),
  /**
   * 这一条**能填哪些值**（应用字段自己公开的选项）。
   *
   * 只有 RunningHub **应用**用得上：它的元信息在一个叫 `fieldData` 的 JSON 串里 ——
   * `["LIST", { options: [...] }]`，或者 SWITCH 那种 `[{ description: '文戏', index: 0 }, ...]`。
   * 带出来之后，画布上的输入框才能换成下拉；不带的话用户只看得见一个光秃秃的「模式选择」，
   * `0` 和 `1` 谁是文戏谁是武戏全凭猜。
   *
   * 只用于界面：`toNodeInfoList` 不看它，提交的仍然只有 `value`。
   */
  options: z.array(z.string().max(80)).max(60).optional(),
  classType: z.string().max(160).default('Custom'),
  uploadedAt: z.string().datetime().optional(),
  /*
   * 下面三个是**画布输入节点**写在自己身上的展示信息（见 `CANVAS_META_FIELDS`）。
   *
   * 全部 `.optional()`：绝大多数字段（K 采样器的 seed、CLIP 的 text…）根本没有这些，
   * 而且已经存进库里的旧配置也没有 —— 加必填会让它们一夜之间全部校验失败。
   *
   * 只用于界面排序 / 分组 / 折叠：`toNodeInfoList` 不看它们，提交的仍然只有 `value`。
   */
  /** 节点上「画布分组」那一行。没有就是 undefined（不分组）。 */
  canvasGroup: z.string().trim().max(60).optional(),
  /** 节点上「画布顺序」那一行。**有它的字段排在最前面并按它升序**。 */
  canvasOrder: z.number().int().min(0).max(999).optional(),
  /** 节点上「折进高级」勾了没有。勾了就不出现在「常用字段」筛选里。 */
  canvasAdvanced: z.boolean().optional(),
});
export const configurationSchema = z.object({
  fields: z.array(fieldSchema).max(400),
}).superRefine(({ fields }, ctx) => {
  const targets = new Set<string>();
  const keys = new Set<string>();
  fields.forEach((field, index) => {
    if (keys.has(field.key)) ctx.addIssue({ code: 'custom', path: ['fields', index], message: '配置项重复。' });
    keys.add(field.key);
    /*
     * 「同一个节点字段」按 `nodeId + fieldName` 认 —— 这是提交时真正用的身份，逐字比较。
     *   `"   Strength"` 与 `"   Strength\u200b"` 在这里是**两个**目标（它们本来就是两个 LoRA），
     *   两个都能勾；而 `"   Strength"` 与 `"Strength"` 也是两个（插件认的就是两串不同的键），
     *   同样都能勾 —— 界面靠 `label` 上的 `(2)` 后缀让人分得清。
     */
    const target = `${field.nodeId}\0${field.fieldName}`;
    if (targets.has(target)) ctx.addIssue({ code: 'custom', path: ['fields', index], message: '同一节点字段只能启用一次。' });
    targets.add(target);
    if (!field.enabled) return;
    if (field.binding !== 'manual') return;
    if (field.kind === 'number' && (!field.value.trim() || !Number.isFinite(Number(field.value))))
      ctx.addIssue({ code: 'custom', path: ['fields', index], message: `${field.label}需要有效数字。` });
    if (field.kind === 'boolean' && !['true', 'false'].includes(field.value))
      ctx.addIssue({ code: 'custom', path: ['fields', index], message: '开关值无效。' });
    if (['image', 'video', 'audio', 'latent'].includes(field.kind) && !field.value.trim())
      ctx.addIssue({ code: 'custom', path: ['fields', index], message: `${field.label}尚未配置文件路径。` });
  });
});
export type WorkflowField = z.infer<typeof fieldSchema>;
export type Configuration = z.infer<typeof configurationSchema>;

/**
 * 画布上「自定义参数块」里的一行：直接指名工作流里的节点 id 与字段名，自己起个名字。
 *
 * 它和配置页的字段是**叠加**关系，不是二选一 —— 配置页负责把常用参数接成画布输入，
 * 这些行负责补上配置里没有的节点、或者临时覆盖某一条。所以叫「堆积木」。
 */
export const paramRowSchema = z.object({
  id: z.string().min(1).max(80),
  /** 用户给这一行起的名字，只在界面上显示，不发给 RunningHub。 */
  name: z.string().trim().max(120).default(''),
  nodeId: z.string().regex(/^[\w:-]+$/).max(100),
  /* 同 `fieldSchema.fieldName`：这是写进图里 `inputs` 的键，**不能 trim**。 */
  fieldName: z.string().min(1).max(100),
  value: z.string().max(40000),
  enabled: z.boolean().default(true),
  /**
   * 这一行的值按什么类型填 —— **只用于界面提示**（输入框底下的那行小字），不参与提交：
   * `mergeParamRows` 不看它。可空，因为手填出来的行本来就没有类型可言。
   */
  kind: z.enum(['text', 'number', 'boolean', 'image', 'video', 'audio', 'latent']).optional(),
});
export type ParamRow = z.infer<typeof paramRowSchema>;

/**
 * 把自定义参数行并进已经算好的 nodeInfoList。
 *
 * 同一 `nodeId + fieldName` 命中已有条目时**用自定义值替换**，命中不到就追加 ——
 * 这样同一块参数连到生成节点上就是「覆盖已有参数、补上没有的参数」。
 * 空值的行直接跳过：和 `toNodeInfoList` 一样，空值不带进去，避免把配置里的值顶成空串。
 */
export function mergeParamRows(
  list: { nodeId: string; fieldName: string; fieldValue: string }[],
  rows: ParamRow[],
) {
  if (!rows?.length) return list;
  const merged = list.slice();
  for (const row of rows) {
    if (!row.enabled) continue;
    const value = String(row.value ?? '');
    if (!value) continue;
    const entry = { nodeId: row.nodeId, fieldName: row.fieldName, fieldValue: value };
    const index = merged.findIndex(item => item.nodeId === row.nodeId && item.fieldName === row.fieldName);
    if (index >= 0) merged[index] = entry;
    else merged.push(entry);
  }
  return merged;
}

export type CanvasBindingValues = {
  prompt?: string;
  duration?: string;
  aspectRatio?: string;
  megapixels?: string;
  referenceImages?: string[];
  /**
   * 视频 / 音频**可以有多份**：画布上连了几个输入节点就有几份，按槽位对位
   * （`video_input_2` 取第 2 份）。
   */
  videoInputs?: string[];
  audioInputs?: string[];
  latents?: string[];
  /** Node 196 is inverted: false means "use context", i.e. continuation is on. */
  continuation?: string;
  /** 图片生成专用：视频工作流不会给这些值，留空即可。 */
  negativePrompt?: string;
  steps?: string;
  cfg?: string;
  /** -1（或空）表示随机种子。 */
  seed?: string;
  batchSize?: string;
  sampler?: string;
  /** 图片生成专用：空 Latent 节点的宽 / 高（像素），由画布「比例 + 分辨率(MP)」自动换算、取整到 16 的倍数。 */
  width?: string;
  height?: string;
  /**
   * 超清工作流唯一的输入：待加工的那份媒体（`/api/assets/<id>/media.mp4` 一类的落盘地址）。
   * 服务端会把它取成字节重新上传，换成 RunningHub 认得的文件名。
   */
  upscaleInput?: string;
  /**
   * **只交一份**时的老字段（MCP / 手打接口还在用），服务端把它当成 1 号槽位
   * —— 那是「一个工作流只能吃一份视频」时期的唯一形态。新代码用上面的数组。
   *
   * 只有工作流里真有 LoadVideo / LoadAudio 那类节点、并在配置页把字段绑到「画布 · 视频 / 音频输入」时才用得上。
   * 没绑就不会进 nodeInfoList —— 视频输入节点另有「首帧当参考图」那条主路，所以这两项**不参与**
   * 「有值却没接进工作流就报错」那条检查（见 generation 路由的 assertInputsAreWired）。
   */
  videoInput?: string;
  audioInput?: string;
};

export function applyDefaultBindings(config: unknown) {
  if (!config || typeof config !== 'object' || !Array.isArray((config as { fields?: unknown }).fields)) return config;
  return { ...(config as object), fields: (config as { fields: Array<Record<string, unknown>> }).fields.map(field => {
    const binding = defaultBindingsByKey[String(field.key)] || 'manual';
    const isLegacy = field.binding === undefined;
    return { ...field, binding: field.binding || binding, enabled: isLegacy && binding !== 'manual' ? true : field.enabled };
  }) };
}

function bindingValue(binding: CanvasBinding, values: CanvasBindingValues) {
  if (binding === 'prompt') return values.prompt;
  if (binding === 'duration') return values.duration;
  if (binding === 'aspect_ratio') return values.aspectRatio;
  if (binding === 'megapixels') return values.megapixels;
  /*
   * 参考图数量是个**派生值**：它不是用户填的数，而是画布这次实际接进来几张参考图。
   * 所以绑定了它就不用再填 —— 上传 / 连线变化会自己跟着变（0 张就写 0）。
   */
  if (binding === 'reference_count') return String(values.referenceImages?.length ?? 0);
  const slot = seriesSlot(binding);
  if (slot) {
    if (slot.series.key === 'reference') return values.referenceImages?.[slot.slot - 1];
    if (slot.series.key === 'video') return videoInputsOf(values)?.[slot.slot - 1];
    return audioInputsOf(values)?.[slot.slot - 1];
  }
  if (binding.startsWith('latent_')) {
    const index = Number(binding.slice('latent_'.length)) - 1;
    return values.latents?.[index];
  }
  if (binding === 'continuation') return values.continuation;
  if (binding === 'negative_prompt') return values.negativePrompt;
  if (binding === 'steps') return values.steps;
  if (binding === 'cfg') return values.cfg;
  if (binding === 'seed') return values.seed;
  if (binding === 'batch_size') return values.batchSize;
  if (binding === 'sampler') return values.sampler;
  if (binding === 'width') return values.width;
  if (binding === 'height') return values.height;
  if (binding === 'upscale_input') return values.upscaleInput;
  return undefined;
}

/**
 * 视频 / 音频既能是数组（画布上连了几个输入节点就有几个），也可能是老客户端交上来的单值。
 * 单值当 1 号槽位 —— 那是「一个工作流只能吃一份视频」时期的唯一形态。
 */
function videoInputsOf(values: CanvasBindingValues) {
  return values.videoInputs?.length ? values.videoInputs : (values.videoInput ? [values.videoInput] : undefined);
}
function audioInputsOf(values: CanvasBindingValues) {
  return values.audioInputs?.length ? values.audioInputs : (values.audioInput ? [values.audioInput] : undefined);
}

export function toNodeInfoList(config: Configuration, values: CanvasBindingValues = {}) {
  return configurationSchema.parse(config).fields.flatMap(field => {
    if (!field.enabled) return [];
    const value = field.binding === 'manual' ? field.value : bindingValue(field.binding, values);
    if (value === undefined || value === '') return [];
    return [{ nodeId: field.nodeId, fieldName: field.fieldName, fieldValue: value }];
  });
}

/**
 * Which canvas inputs the enabled config actually consumes.
 *
 * Used to refuse a run whose inputs would be thrown away: the whole binding mechanism is
 * silent by design (a binding with no value is simply skipped), so a config that never got
 * its `binding` written — or where the user switched a field off — will happily generate a
 * video with no prompt and look like a success. Callers compare this against the values the
 * canvas is about to send and fail loudly instead.
 */
export function consumedCanvasBindings(config: Configuration) {
  const set = new Set<CanvasBinding>();
  for (const field of configurationSchema.parse(config).fields) {
    if (field.enabled && field.binding !== 'manual') set.add(field.binding);
  }
  return set;
}

/**
 * 画布「接续上一段 / Latent 中转」节点上填的粗 / 精采样**工作流节点号**。
 *
 * 留空 = 沿用配置页里 `latent_1` / `latent_2` 所绑字段的节点号
 * （不是「用 210 / 278」—— 那份默认工作流的编号对别的工作流不成立）。
 */
export type LatentNodeIds = { coarse?: string; fine?: string };

/**
 * 补写 latent 时用的字段名：RunningHub 那份默认工作流里就是 `210.手动上传` / `278.手动上传`。
 *
 * 只有在配置页**一个 latent 字段都没启用**时才会用到 —— 那种情况下我们无从知道对方
 * 图里的字段名，只能沿用这套默认工作流里的那个。
 */
export const LATENT_FIELD_NAME = '手动上传';

/**
 * 按画布上填的节点号改写 latent 的落点。
 *
 * 只改 `nodeId`、**不动字段名**：「哪个字段接收 latent」是配置页配好的（可能叫 `latent`、
 * 也可能叫别的），画布这一层只管「写到哪个节点上」。
 *
 * 没填号的一律不改写：沿用配置页的绑定，跟加这个功能之前的行为一致 ——
 * 回落成 210 / 278 会把那些已经绑到别的节点号的工作流悄悄改掉落点。
 */
export function applyLatentNodeIds(config: Configuration, nodeIds?: LatentNodeIds): Configuration {
  const coarse = String(nodeIds?.coarse || '').trim();
  const fine = String(nodeIds?.fine || '').trim();
  if (!coarse && !fine) return config;
  return {
    ...config,
    fields: config.fields.map(field => {
      if (coarse && field.binding === 'latent_1') return { ...field, nodeId: coarse };
      if (fine && field.binding === 'latent_2') return { ...field, nodeId: fine };
      return field;
    }),
  };
}

/**
 * 配置页一个 latent 字段都没启用时，按画布填的节点号**补一条**。
 *
 * 不补的话这条 latent 会被 `toNodeInfoList` 静默丢掉：任务照常跑成功，
 * 出来的片段和上一轮毫无关系 —— 而填了节点号恰恰说明用户知道该往哪儿写。
 * 已经由 `applyLatentNodeIds` 改写过的槽位不重复补。
 */
export function appendLatentEntries(
  list: { nodeId: string; fieldName: string; fieldValue: string }[],
  config: Configuration,
  values: CanvasBindingValues | undefined,
  nodeIds?: LatentNodeIds,
) {
  const wired = (binding: string) => config.fields.some(field => field.enabled && field.binding === binding);
  const pairs: { nodeId?: string; binding: string; value: string }[] = [
    { nodeId: nodeIds?.coarse, binding: 'latent_1', value: String(values?.latents?.[0] || '') },
    { nodeId: nodeIds?.fine, binding: 'latent_2', value: String(values?.latents?.[1] || '') },
  ];
  const extra: { nodeId: string; fieldName: string; fieldValue: string }[] = [];
  for (const pair of pairs) {
    const id = String(pair.nodeId || '').trim();
    if (!id || !pair.value || wired(pair.binding)) continue;
    /** 同节点同字段已经有条目时不追加第二条：两份值喂给同一个字段，只会互相打架。 */
    if (list.some(item => item.nodeId === id && item.fieldName === LATENT_FIELD_NAME)) continue;
    extra.push({ nodeId: id, fieldName: LATENT_FIELD_NAME, fieldValue: pair.value });
  }
  return extra.length ? [...list, ...extra] : list;
}

/**
 * 把 RunningHub `getJsonApiFormat` 返回的 ComfyUI 节点图（`prompt` JSON 字符串）摊平成
 * 配置页用的「节点字段」列表。
 *
 * - 跳过连线（`inputs` 里是数组 `["7",0]`）和复杂结构（对象）：它们是节点间 wiring，不是可填参数。
 * - 标量按类型推断 kind：boolean → 开关，number → 数字，string → 文本（带媒体加载器 class_type 的
 *   按节点类型猜 image/video/latent，用户也能在编辑器里改）。
 * - `recommended` 默认 true：配置页左侧默认筛「常用字段」，不标推荐就又是一片空白（正是这个 bug 的来源）。
 * - `enabled` 默认 false：拉下来只是「可见」，要生效得用户自己勾。
 */
export function workflowJsonToFields(promptJson: string): WorkflowField[] {
  let graph: unknown;
  try {
    graph = JSON.parse(promptJson);
  } catch {
    return [];
  }
  return graphToFields(graph);
}

/**
 * 和 `workflowJsonToFields` 做同一件事，只是入口换成一个**已经解析好的图对象**。
 *
 * 拆出来是为了本地工作流：那份 ComfyUI API JSON 就存在 `WorkflowDraft.graph`（已经是对象），
 * 没必要先 `JSON.stringify` 一轮再让这边 `JSON.parse` 回来 —— 而且绕这一趟，
 * 数值会被 JavaScript 的数字精度整过一遍（种子的大整数可能被写成科学计数法）。
 *
 * 两条写得一模一样的扫描规则迟早会不一样，所以只有这一份。
 */
/**
 * 画布输入节点的类名前缀。**Holy Light画布和 AIFisher 两套都认**。
 *
 * 两个软件共用同一个 ComfyUI（扩展目录就是同一份），工作流会互相导来导去 ——
 * 只认自己那套的话，从 AIFISHER 导进来的工作流里所有画布参数都会退回「自己勾选 + 自己命名」，
 * 而那正是这个节点存在的意义。两个前缀除了品牌没有任何区别，字段一模一样。
 */
const CANVAS_INPUT_PREFIXES: readonly string[] = ['FrameCanvas', 'AIFisherCanvas'];

/**
 * 画布输入节点上写给**画布**看的说明字段，不是要用户填的参数。
 *
 * 五个：文本/数值/整数/种子/开关四个共用的，加图片节点独有的「允多项」。
 * 它们会被提交给 ComfyUI（节点确实有这些输入），但**不该出现在参数表里** ——
 * 否则用户会看到「画布名称」「画布顺序」两行输入框，改了也不知道改的是什么。
 */
const CANVAS_META_FIELDS: ReadonlySet<string> = new Set(['画布名称', '画布分组', '画布顺序', '折进高级', '允许多张']);

function isCanvasInputClass(classType: string): boolean {
  return CANVAS_INPUT_PREFIXES.some(prefix => classType.startsWith(prefix));
}

/**
 * 从一个画布输入节点上读那四个说明字段。**读不出来就按没有处理**（节点里确实可能没写）。
 *
 * 这些值本来是给用户看的，所以宽容：`画布顺序` 写成了 `"3"` 这种字符串也认，
 * 认不出来才回落 0 —— 严一点的话用户少填一个字符就整份参数排序全乱。
 */
function readCanvasMeta(inputs: Record<string, unknown>): { name: string; group: string; order: number | null; advanced: boolean } {
  const rawName = inputs['画布名称'];
  const rawGroup = inputs['画布分组'];
  const rawOrder = inputs['画布顺序'];
  const rawAdvanced = inputs['折进高级'];
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const group = typeof rawGroup === 'string' ? rawGroup.trim() : '';
  const order = typeof rawOrder === 'number' && Number.isFinite(rawOrder)
    ? rawOrder
    : typeof rawOrder === 'string' && rawOrder.trim() !== '' && Number.isFinite(Number(rawOrder))
      ? Number(rawOrder)
      : null;
  return { name, group, order, advanced: rawAdvanced === true };
}

/**
 * 按「画布顺序」排：有顺序的排前面并按它升序，没有的保持原相对次序在后。
 *
 * **一个画布输入节点都没有时原样返回** —— 那种图（绝大多数）不该因为这个功能
 * 而变换任何一行次序，它本来就是按节点 id 排的、用户已经看习惯了。
 */
export function sortCanvasFields(fields: WorkflowField[]): WorkflowField[] {
  const ordered = fields.filter(field => typeof field.canvasOrder === 'number');
  if (!ordered.length) return fields;
  const sorted = ordered.slice().sort((a, b) => (a.canvasOrder as number) - (b.canvasOrder as number));
  return [...sorted, ...fields.filter(field => typeof field.canvasOrder !== 'number')];
}

export function graphToFields(input: unknown): WorkflowField[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const graph = input as Record<string, { class_type?: string; inputs?: Record<string, unknown> } | null | undefined>;
  const fields: WorkflowField[] = [];
  /*
   * 同一个「清洗后的显示名」出现两次时，给第二份起个可区分的名字。
   *
   * 这不是假想：`AnimaMultiLoraLoader` 里 `"   Strength"` 和 `"   Strength\u200b"`
   * 会同时出现，清洗完都是 `Strength` —— 列表里两行一模一样，但它们是两个不同 LoRA 的强度，
   * 勾错一个就改错了 LoRA。编号后缀让人至少能分辨「这是第几个」。
   */
  const labelSeen = new Map<string, number>();
  for (const [nodeId, node] of Object.entries(graph)) {
    if (!node || typeof node !== 'object' || !node.inputs || typeof node.inputs !== 'object') continue;
    const classType = typeof node.class_type === 'string' ? node.class_type : 'Custom';
    /* 画布输入节点：先把节点上那几行说明读出来，它决定下面这个字段怎么展示。 */
    const canvas = isCanvasInputClass(classType) ? readCanvasMeta(node.inputs) : null;
    for (const [fieldName, raw] of Object.entries(node.inputs)) {
      if (raw === null || Array.isArray(raw) || typeof raw === 'object') continue;
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') continue;
      if (canvas && CANVAS_META_FIELDS.has(fieldName)) continue;
      const kind = inferFieldKind(classType, fieldName, raw);
      const value = typeof raw === 'boolean' || typeof raw === 'number' ? String(raw) : String(raw);
      /*
       * 名字优先用节点上写的「画布名称」：那本来就是用户在 ComfyUI 里特意给它起的，
       * 比 `文本` / `数值` 这种字段名有意义得多。空着才回落到字段名 ——
       * `label` 在 schema 里是 min(1)，空名字会让整份配置校验失败。
       */
      const base = normalizeFieldLabel(canvas?.name ? canvas.name : fieldName) || normalizeFieldLabel(fieldName);
      const seen = (labelSeen.get(`${nodeId}\0${base}`) ?? 0) + 1;
      labelSeen.set(`${nodeId}\0${base}`, seen);
      fields.push({
        key: fieldKey(nodeId, fieldName),
        nodeId,
        fieldName,
        /* 显示名洗净：隐形字符去掉、空白折成一个，否则界面上是一坨看不出意义的前导空格。 */
        label: seen === 1 ? base : `${base} (${seen})`,
        kind,
        value: value.slice(0, 40000),
        /*
         * 画布输入节点**默认启用**：用户跑到 ComfyUI 里专门放一个节点、还给它起了名字，
         * 意思就是「这个要露到画布上」。再让他回来勾一次等于白做。
         * 别的字段维持默认关闭 —— 一张图几十上百个字段，全勾上没法看。
         */
        enabled: canvas !== null,
        binding: 'manual',
        /* 「折进高级」= 不进「常用字段」那一档筛选，要看就去「全部字段」。 */
        recommended: canvas ? !canvas.advanced : true,
        classType,
        canvasGroup: canvas?.group || undefined,
        canvasOrder: canvas?.order ?? undefined,
        canvasAdvanced: canvas?.advanced || undefined,
      });
    }
  }
  return sortCanvasFields(fields);
}

function inferFieldKind(classType: string, fieldName: string, value: string | number | boolean): WorkflowField['kind'] {
  const ct = classType.toLowerCase();
  const fn = fieldName.toLowerCase();
  /*
   * 媒体加载器节点只用**具体的加载器 class_type**判断，不用泛化的 "image"/"video"/"latent" 子串 ——
   * 否则 `EmptyLatentImage`、`*Latent*` 这类「产出/消费 latent 但输入是数字」的节点会被误判成
   * latent，数字字段变成上传控件，明显不对。`width`/`height` 因此正确回落到 number。
   */
  if (ct.includes('loadimage') || ct.includes('loadimg')) return 'image';
  if (ct.includes('loadaudio')) return 'audio';
  if (ct.includes('vhs') || ct.includes('loadvideo')) return 'video';
  if (fn.includes('latent')) return 'latent';
  if (fn.includes('audio')) return 'audio';
  if (fn.includes('video')) return 'video';
  if (fn.includes('image') || fn.includes('img')) return 'image';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return 'text';
}
