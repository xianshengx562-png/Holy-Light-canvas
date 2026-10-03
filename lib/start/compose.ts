/**
 * 首页那个大输入框的**两个去向**，以及「去画布」时随行的那几个参数。
 *
 * 与 `quick.ts` 的分工：那边管**那句话本身**（长度上限、项目名、示例胶囊），
 * 这边管**这句话要去哪儿、带什么参数**。两个文件都不引 `server-only`、不碰库 ——
 * 接口、组件、回归脚本读的必须是同一份定义。
 *
 * 「生成分类」那个下拉选的是**引擎**（`ComposeEngine`），它决定整条参数链路用哪一套值域：
 *   - 视频 + `videoapi` → `videoApiParams.ts`（比例 7 档 / 分辨率 480p-720p-1080p / 时长）
 *   - 两者 + 工作流来源 → `imageParams.ts` 那套（比例 8 档 / 百万像素 / 时长）
 *
 * 2026-09-23：出图那一档的「直连 Image 2.0」删了（连同它的 `.env` 配置与 `/image2` 接口），
 * 所以图片的工作流来源剩两个：RunningHub 工作流 / 本机 ComfyUI 工作流 —— 与画布上
 * 「去掉 Image 2.0 之后还剩三档（两份工作流 + 自定义接口）」是同一件事的两个界面。
 * 2026-09-25（徐先）：**「/image 图片生成工作台」也列「自定义接口」了** —— 参数链路与画布
 * 节点完全同一套（image2Params 的比例 / 分辨率 + 模型），同步出图；ENGINES_FOR.image 不动，
 * 所以首页那个大输入框（ComposeBar）仍然不列：它只负责把话带进画布，模型进画布再挑。
 *
 * 三套是**整块换装、绝不并排**的：串着用会让节点拿到另一个引擎根本不认识的值，
 * 而那种错的症状正是这套 UI 一直在防的 —— 任务照样成功，参数被静默丢掉。
 */

import { PROMPT_MAX } from './quick';
import { ASPECT_RATIOS, DEFAULT_RATIO } from '@/lib/workflows/imageParams';
import { IMAGE2_RATIOS, IMAGE2_RATIO_AUTO, IMAGE2_RESOLUTIONS } from '@/lib/workflows/image2Params';
import {
  IMAGE2_MAX_REFERENCES,
} from '@/lib/workflows/image2Params';
import {
  VIDEO_API_DEFAULTS, VIDEO_API_DURATION_MAX, VIDEO_API_DURATION_MIN,
  VIDEO_API_RATIOS, VIDEO_API_RESOLUTIONS,
} from '@/lib/workflows/videoApiParams';

/**
 * 两个去向：出图 / 出视频。两个都去画布，差别只在建哪一种生成节点。
 *
 * 2026-09-21 之前这里是三个（还有 `chat` 去对话页），对话整块移除后就剩这两个。
 * `CanvasMode` 这个名字留着：凡是「要带参数去画布」的签名都用它，
 * 换成 `ComposeMode` 只是把同一个类型换个名字，反而让调用方全跟着动一遍。
 */
export type ComposeMode = 'image' | 'video';

/** 会跳画布的那两个 —— 现在等于 `ComposeMode`，见上面那段说明。 */
export type CanvasMode = ComposeMode;

export const COMPOSE_MODES: readonly ComposeMode[] = ['image', 'video'];

/**
 * 生成引擎 —— 对话框里「生成分类」那个下拉选的就是它。
 *
 * 2026-09-21 起「工作流」那一档拆成了两个**来源**：`runninghub`（云端）与 `local`（本机 ComfyUI）。
 * 原来只有一个 `workflow`，两种来源混在同一个词底下，而它们的图在哪、跑在哪、要不要扣费
 * 完全不一样 —— 首页这个下拉是用户第一次决定「这次谁出片」的地方，那时就得说清。
 *
 * 老值 `'workflow'` 仍然认（老链接、老书签），读的时候归一成 `runninghub`。
 */
export type ComposeEngine = 'videoapi' | 'runninghub' | 'local' | 'custom';

/** 每个模式能选的引擎。**互不串门**：图片里不出现视频网关，视频里不出现图片那一套。 */
export const ENGINES_FOR: Record<CanvasMode, readonly ComposeEngine[]> = {
  image: ['runninghub', 'local'],
  video: ['videoapi', 'runninghub', 'local'],
};

/**
 * 每个引擎两套名字，**按语境挑**：
 *   - `label` —— 完整名字，把「这是个什么来源」说全。首页那个选择框用它
 *     （那里就一颗下拉，旁边没有别的字能替它把话说完）。
 *   - `short` —— 短名字，**只在图片生成页底部那一排**用（2026-10-03，N-99）。
 *     那里的语境是 `RunningHub ⌄ | 选工作流… ⌄ | 16:9 横屏 ⌄ | 1328 × 752 ⌄`：
 *     右边那颗已经写着「工作流」了，左边再写一遍，整排就要 904px ——
 *     而生成条只有 860px，多出来的 44px 正好把发送钮挤到第二行。
 *
 * ⚠️ 短名字**只改显示**：`engine` 的值、参数链路、提交给工作流的字段一个都不动。
 * ⚠️ 短名字是**必填**（不是 `short?`）：这样以后加一个引擎，tsc 会逼着你想一次
 *    「它在那一排里显示成什么」，而不是默默退回到长名字、把那排重新撑破。
 */
export const ENGINE_META: Record<ComposeEngine, { label: string; short: string; hint: string }> = {
  videoapi: { label: '视频网关', short: '视频网关', hint: '直连视频网关，选比例 / 分辨率 / 时长' },
  runninghub: { label: 'RunningHub 工作流', short: 'RunningHub', hint: '用云端保存的工作流，算力在 RunningHub 上，按点扣费；进画布后选具体哪一份' },
  local: { label: '本地 ComfyUI 工作流', short: '本地 ComfyUI', hint: '用本机 ComfyUI 的工作流，图与算力都在自己这边，不扣费；进画布后选具体哪一份' },
  custom: { label: '自定义接口', short: '自定义接口', hint: '走你在「设置 · 模型服务」里添加的自定义接口，挑一个模型直接出图；参数是比例 / 分辨率，计费由那家决定' },
};

/** 每个模式的默认引擎：出图走 RunningHub 工作流，出视频走网关。 */
export function defaultEngine(mode: CanvasMode): ComposeEngine {
  return mode === 'image' ? 'runninghub' : 'videoapi';
}

export function isCanvasMode(value: unknown): value is CanvasMode {
  return value === 'image' || value === 'video';
}

/** 老值 → 新值。跟 `lib/workflows/*Engine.ts` 里那两份同一套规矩。 */
const LEGACY_ENGINES: Record<string, ComposeEngine> = { workflow: 'runninghub' };

/** 认不出的引擎（手改 URL、老链接）退回该模式的默认值，而不是照单全收。 */
export function readEngine(mode: CanvasMode, value: unknown): ComposeEngine {
  const raw = String(value ?? '').trim();
  const normalized = LEGACY_ENGINES[raw] || raw;
  return (ENGINES_FOR[mode] as readonly string[]).includes(normalized) ? normalized as ComposeEngine : defaultEngine(mode);
}

/** 下拉的一行。 */
export type ComposeOption = { value: string; label: string };

/**
 * 「百万像素」在对话框里的常用档位。
 *
 * ⚠️ 这**不是值域** —— 真实值域是 `MIN_MEGAPIXELS` ~ `MAX_MEGAPIXELS` 的连续区间，
 * 工作流引擎的参数条上是个数字输入框。这里只把常用的几档列成下拉，方便在首页一次选完；
 * 进画布之后照样能填区间内的任意值。
 */
const MEGAPIXEL_STEPS = ['0.5', '1', '2', '3', '4'];

/** 时长档位，同上：真实值域是 1~30 的整数，这里只列常用档且两端都夹在合法区间内。 */
const DURATION_STEPS = ['3', '5', '6', '8', '10', '15'];

/**
 * 「16:9 (Widescreen)」→「16:9 横屏」。
 *
 * 括号里的英文备注是 RunningHub 字段值的历史包袱，直接摆进下拉对中文用户毫无信息量，
 * 所以只在这里做**显示层**的翻译 —— 存进节点、发出去的始终是原值。
 * 认不出的备注原样返回，免得下拉里出现空白。
 */
function ratioLabel(value: string) {
  const match = /^(\d+:\d+)\s*\((.+)\)$/.exec(value);
  if (!match) return value;
  const noun: Record<string, string> = {
    Square: '方形',
    'Portrait Photo': '竖版照片',
    Photo: '照片',
    'Portrait Standard': '竖版',
    Standard: '标准',
    'Portrait Widescreen': '竖屏',
    Widescreen: '横屏',
    Ultrawide: '宽幅',
  };
  return `${match[1]} ${noun[match[2]] || match[2]}`;
}

/** 比例档位 —— 由「模式 + 引擎」共同决定用哪一套。 */
export function ratioOptions(mode: CanvasMode, engine: ComposeEngine): ComposeOption[] {
  if (mode === 'video' && engine === 'videoapi') {
    return VIDEO_API_RATIOS.map(item => ({ value: item.value, label: item.label }));
  }
  /** 自定义接口那档的参数链路是 image2Params 的（画布节点同款值域，自适应排最前）。 */
  if (mode === 'image' && engine === 'custom') {
    return IMAGE2_RATIOS.map(item => ({ value: item.value, label: item.label }));
  }
  return ASPECT_RATIOS.map(value => ({ value, label: ratioLabel(value) }));
}

/** 分辨率档位，同上。工作流那套给的是「百万像素」，所以带上 MP 字样。 */
export function resolutionOptions(mode: CanvasMode, engine: ComposeEngine): ComposeOption[] {
  if (mode === 'video' && engine === 'videoapi') {
    return VIDEO_API_RESOLUTIONS.map(item => ({ value: item.value, label: item.label }));
  }
  if (mode === 'image' && engine === 'custom') {
    return IMAGE2_RESOLUTIONS.map(item => ({ value: item.value, label: item.label }));
  }
  return MEGAPIXEL_STEPS.map(value => ({ value, label: `${value} MP` }));
}

/** 时长档位。只有视频需要它；出图返回空数组 = 界面上不出这一格。 */
export function durationOptions(mode: CanvasMode): ComposeOption[] {
  if (mode !== 'video') return [];
  return DURATION_STEPS
    .map(Number)
    .filter(seconds => seconds >= VIDEO_API_DURATION_MIN && seconds <= VIDEO_API_DURATION_MAX)
    .map(seconds => ({ value: String(seconds), label: `${seconds} 秒` }));
}

/** 对话框里当前选着的那几个参数。 */
export type ComposeParams = { ratio: string; resolution: string; duration: string };

/**
 * 那一行「生成偏好」胶囊上显示的**当前状态摘要**（例：`自适应 · 1K` / `16:9 横屏 · 720p · 5 秒`）。
 *
 * 参数默认是收起的，所以这颗胶囊上的字就是用户**唯一**能一眼看到的东西：
 * 只写「生成偏好」的话，选完就再也想不起来自己选的是什么了。
 * 标签一律从上面那几组档位里取（`label` 是显示层的翻译），**不要在这里另写一份名字** ——
 * 那样档位改名之后胶囊上会留下一个世界上不存在的值。
 */
export function paramSummary(mode: CanvasMode, engine: ComposeEngine, params: ComposeParams): string {
  const labelOf = (list: ComposeOption[], value: string) =>
    list.find(item => item.value === value)?.label || value;
  const parts = [
    labelOf(ratioOptions(mode, engine), params.ratio),
    labelOf(resolutionOptions(mode, engine), params.resolution),
  ];
  if (mode === 'video' && params.duration) parts.push(`${params.duration} 秒`);
  return parts.join(' · ');
}

/**
 * 某个「模式 + 引擎」下的默认参数。
 *
 * **切换引擎时必须用它整组重置**：两套值域里的值互不通用（`16:9` 与
 * `16:9 (Widescreen)`、`2k` 与 `2`），留着上一套的值会让下拉匹配不到任何选项 ——
 * 而 `<select>` 匹配不到时的行为是**静默跳到第一项**，用户看到的是「我选的明明没变」。
 */
export function defaultParams(mode: CanvasMode, engine: ComposeEngine): ComposeParams {
  if (mode === 'video' && engine === 'videoapi') {
    return {
      ratio: VIDEO_API_DEFAULTS.ratio,
      resolution: VIDEO_API_DEFAULTS.resolution,
      duration: String(VIDEO_API_DEFAULTS.duration),
    };
  }
  /** 自定义接口：image2Params 那套值域（自适应 + 1K），与画布节点同款默认。 */
  if (mode === 'image' && engine === 'custom') {
    return { ratio: IMAGE2_RATIO_AUTO, resolution: '1k', duration: String(VIDEO_API_DEFAULTS.duration) };
  }
  return { ratio: DEFAULT_RATIO, resolution: '1', duration: String(VIDEO_API_DEFAULTS.duration) };
}

/**
 * 把一组（来自 URL、可能被手改过的）参数落定成该引擎认识的值。
 *
 * 认不出的**一律退回默认**，而不是像生成接口那样报错 —— 这是「打开画布」这一步，
 * 因为一个参数不对就打不开画布，代价比默默用默认值大得多。
 */
export function readParams(
  mode: CanvasMode,
  engine: ComposeEngine,
  raw: { ratio?: unknown; resolution?: unknown; duration?: unknown },
): ComposeParams {
  const fallback = defaultParams(mode, engine);
  const pick = (list: ComposeOption[], value: unknown, def: string) => {
    const text = String(Array.isArray(value) ? value[0] : value ?? '').trim();
    return list.some(item => item.value === text) ? text : def;
  };
  const params: ComposeParams = {
    ratio: pick(ratioOptions(mode, engine), raw.ratio, fallback.ratio),
    resolution: pick(resolutionOptions(mode, engine), raw.resolution, fallback.resolution),
    duration: fallback.duration,
  };
  if (mode === 'video') {
    const seconds = Number(String(Array.isArray(raw.duration) ? raw.duration[0] : raw.duration ?? '').trim());
    if (Number.isInteger(seconds) && seconds >= VIDEO_API_DURATION_MIN && seconds <= VIDEO_API_DURATION_MAX) {
      params.duration = String(seconds);
    }
  }
  return params;
}

/**
 * 参考图张数上限（画布上「最多九张」也是它）。
 *
 * 名字还叫 `IMAGE2_*` 是因为这套档位当初就是为那条同步出图链路定的，
 * 现在自定义接口出图用的还是同一套（见 `lib/workflows/image2Params.ts` 文件头）。
 */
export const MAX_REFS = IMAGE2_MAX_REFERENCES;

/**
 * 参考图地址只认**本站资产**（`/api/assets/<id>/media.<ext>`）。
 *
 * 这是**安全边界**，不只是洁癖：这些地址会被服务端真的拿去取字节（`lib/providers/referenceBytes.ts`
 * 读盘或下载），照单全收 URL 里的任意地址，等于给了任何一条链接
 * 「让服务器去访问攻击者指定地址」的能力。所以非本站资产一律丢掉。
 */
export function isAssetUrl(value: unknown) {
  return typeof value === 'string' && /^\/api\/assets\/[A-Za-z0-9-]+\/media\.[A-Za-z0-9]+$/.test(value);
}

export function readRefs(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(isAssetUrl)
    .slice(0, MAX_REFS);
}

/** 从首页带进画布的那一份「预设」。 */
export type CanvasSeed = {
  prompt: string;
  mode: CanvasMode;
  engine: ComposeEngine;
  ratio: string;
  resolution: string;
  duration: string;
  /** 参考图地址，按传入顺序连到生成节点上。 */
  refs: string[];
};

export const SEED_QUERY = {
  mode: 'mode',
  engine: 'engine',
  ratio: 'ratio',
  resolution: 'resolution',
  duration: 'duration',
  refs: 'refs',
  prompt: 'prompt',
} as const;

/** 拼出跳画布的地址。参数名只有这一处定义 —— 读的那头（`readCanvasSeed`）也是。 */
export function canvasHref(projectId: string, seed: CanvasSeed) {
  const query = new URLSearchParams();
  query.set(SEED_QUERY.mode, seed.mode);
  query.set(SEED_QUERY.engine, seed.engine);
  query.set(SEED_QUERY.ratio, seed.ratio);
  query.set(SEED_QUERY.resolution, seed.resolution);
  if (seed.duration) query.set(SEED_QUERY.duration, seed.duration);
  if (seed.refs.length) query.set(SEED_QUERY.refs, seed.refs.join(','));
  /* 那句话放最后：它最长，出问题时更容易从地址截断处一眼看出来。 */
  if (seed.prompt) query.set(SEED_QUERY.prompt, seed.prompt);
  return `/projects/${projectId}?${query.toString()}`;
}

/** searchParams 里同一个键可能来两次（`?mode=a&mode=b`），一律只认第一个。 */
function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 从画布页的 searchParams 里读出那一份预设。
 *
 * **没有 `mode` 就返回 `null`** —— 这是兼容老链接的关键：首页以前只带 `?prompt=`，
 * 那种情况下画布必须完全保持原样（建它自己那套默认节点），不能被这里悄悄改掉。
 */
export function readCanvasSeed(search: Record<string, string | string[] | undefined>): CanvasSeed | null {
  const mode = firstValue(search[SEED_QUERY.mode]);
  if (!isCanvasMode(mode)) return null;
  const engine = readEngine(mode, firstValue(search[SEED_QUERY.engine]));
  const params = readParams(mode, engine, {
    ratio: firstValue(search[SEED_QUERY.ratio]),
    resolution: firstValue(search[SEED_QUERY.resolution]),
    duration: firstValue(search[SEED_QUERY.duration]),
  });
  const rawPrompt = firstValue(search[SEED_QUERY.prompt]);
  return {
    prompt: typeof rawPrompt === 'string' ? rawPrompt.slice(0, PROMPT_MAX).trim() : '',
    mode,
    engine,
    ...params,
    refs: readRefs(search[SEED_QUERY.refs]),
  };
}
