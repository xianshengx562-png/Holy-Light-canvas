/**
 * 主页「图片生成」板块（`components/start/ImageStudio.tsx`）用到的纯数据与纯函数。
 *
 * 与 `compose.ts` 的分工：那边管「去画布」那一路（引擎、参数档位、seed 拼接），
 * 这边管「不出画布、原地出图」这一路。参数档位**不另写一份** —— 每个引擎的比例 / 分辨率
 * 直接复用 `compose.ts` 的 `ratioOptions` / `resolutionOptions` / `defaultParams`，
 * 因为发出去的接口（`/api/projects/<id>/generation`）校验的就是同一套值域，
 * 两份定义迟早漂出「下拉里选得到、接口说参数无效」。
 *
 * 不引 `server-only`、不碰库：`lib/studio.ts`（服务端）也读这里的固定项目名，
 * 回归脚本要能直接 `require` 它。
 */

import {
  readImageSizeMode, resolveImageSize, validateCustomSize, type ImageSizeMode,
} from '@/lib/workflows/imageParams';

/**
 * 主页出图挂靠的固定项目名。
 *
 * Task / Asset 都必须有 projectId（库结构决定的），而「不走画布」的出图也得有地方落 ——
 * 约定就落在这个同名项目下。改名 / 删了它都会在下一次出图时被重新建出来（find-or-create）。
 */
export const STUDIO_PROJECT_NAME = '图片生成';

/** 提示词上限。与出图接口的 z.string().max(40000) 同源 —— 界面先拦一道而已。 */
export const STUDIO_PROMPT_MAX = 40000;

/**
 * 每次出图用的节点号。生成接口要求一个 nodeId（Task 挂在节点名下），
 * 主页没有真的节点，就造一个一次性、可辨认的：排查任务记录时一眼看出「这是主页出的」。
 */
export function studioNodeId() {
  return `studio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 出图的**长宽**（2026-09-26，徐先：「分辨率只能选这几个参数，太单调，我要能手填」）。
 *
 * 两条来源，与画布出图节点那一份（`imageParams.ts` 的 `IMAGE_SIZE_MODES`）**同一套**：
 *   - `resolution` —— 由「比例 + 分辨率（MP）」换算；那几档只是常用值，MP 的真实值域是
 *     `MIN_MEGAPIXELS` ~ `MAX_MEGAPIXELS` 的**连续区间**（画布上一直能填，这里现在也能填）；
 *   - `custom` —— 直接填宽高像素。
 *
 * 🔴 **那一格显示的读数与提交给工作流的宽高必须来自同一个函数**。画布那条注释里的事在这里
 *    同样成立：两边各算一次就会出现「格子上写着 1024×1024、实际提交的是另一个数」，
 *    而这件事没有任何报错 —— 只能等用户看出图不对才发现。所以这里只做一件事：
 *    把五个输入解析成 `{ mode, width, height, error }`，界面拿它显示，提交也拿它填宽高。
 */
export type StudioSizeInput = {
  /** 「长宽」那一档：`'custom'` 或 `'resolution'`（认不出的值按 `resolution` 走）。 */
  sizeMode?: string | null;
  customWidth?: string | null;
  customHeight?: string | null;
  ratio?: string | null;
  megapixels?: string | null;
};

export type StudioImageSize = {
  mode: ImageSizeMode;
  /** 实际会提交的宽（像素）。`0` 表示这一档还没算出可用的数（手填那一档没填全 / 填错）。 */
  width: number;
  height: number;
  /** 空串表示可用；非空就是界面与提交**共用同一句**措辞（来自 `validateCustomSize`）。 */
  error: string;
};

export function studioImageSize(input: StudioSizeInput): StudioImageSize {
  const mode = readImageSizeMode(input.sizeMode);
  const resolved = resolveImageSize({
    sizeMode: mode,
    customWidth: input.customWidth,
    customHeight: input.customHeight,
    aspectRatio: input.ratio,
    megapixels: input.megapixels,
  });
  return {
    mode,
    width: resolved?.width ?? 0,
    height: resolved?.height ?? 0,
    error: mode === 'custom' ? validateCustomSize(input.customWidth, input.customHeight) : '',
  };
}

/**
 * 那一格上显示的字：算得出来就给读数；手填那一档还没填全时给「自定义长宽」而不是一串 0 ——
 * `0 × 0` 会被当成「真的要出一张 0 像素的图」，看着像坏了。
 */
export function studioSizeLabel(size: StudioImageSize): string {
  if (size.width > 0 && size.height > 0) return `${size.width} × ${size.height}`;
  return size.mode === 'custom' ? '自定义长宽' : '—';
}
