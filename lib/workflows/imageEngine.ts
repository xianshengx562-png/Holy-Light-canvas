/**
 * 图片生成节点的「引擎」—— 这张图到底是**让一份工作流出**，还是**走用户自己添加的自定义接口**。
 *
 * 两者不是同一件事的实现细节，而是两套完全不同的东西：
 * - `runninghub` / `local`：参数是 steps / cfg / seed / 采样器 / 负向提示词，值要绑到工作流节点字段上
 *   （`imageParams.ts`）；
 * - `custom`（2026-09-21）：走用户在「设置 · 模型服务 · 自定义接口」里加的那条 OpenAI 兼容网关，
 *   参数是比例 / 分辨率 + **那家的模型名**（`image2Params.ts`），没有工作流、没有步数、没有负向提示词。
 *
 * ## 2026-09-23：Image 2.0（`image2`）整条删了
 *
 * 它是当年唯一的「直连出图网关」那一档（`IMAGE2_API_BASE_URL` / `IMAGE2_API_KEY` 那一套
 * 环境变量与 `/api/projects/<id>/image2`）。删掉之后出图只剩三档：两份工作流来源 + 自定义接口。
 * 那套**比例 / 分辨率的档位**（`image2Params.ts`）留着给自定义接口用 —— 它俩是同一条同步链路，
 * 所以节点上的 `image2Ratio` / `image2Resolution` 两个字段名也不动。
 * 老画布上可能还存着 `engine: 'image2'`，处理见下面 `RETIRED_IMAGE_ENGINES`。
 *
 * 所以引擎不只是「换个接口」——它**换掉整条参数链路**。这就是为什么它必须是节点上一个显式字段、
 * 而不是靠「填了哪个参数就用哪套」去猜：猜错的症状和用途选错一样是静默的（任务成功、参数被忽略）。
 *
 * ## 为什么工作流要分成两档（2026-09-21）
 *
 * 与视频那条完全同一个理由：原来那一档 `workflow` 底下混着云端的和本机的工作流，
 * 而它们的图在哪、跑在哪、出问题找谁都不一样。引擎这一档还决定**下拉里列哪些工作流**
 * （选了 `runninghub` 就只列云端的，选了 `local` 就只列本机的）。
 * 详见 `videoEngine.ts` 顶部那段说明，两份保持同一套道理。
 *
 * ## 为什么 `custom` 要「没配就不显示」
 *
 * 它是唯一一个**依赖用户有没有配过东西**才存在的档位：一条自定义接口都没加时把它列出来，
 * 用户选了只能拿到一句「还没配置」。所以 `IMAGE_ENGINE_OPTIONS` 里虽然有它，
 * 界面一律走 `imageEngineOptions(showCustom)` —— 由接口返回的「有没有出图类型的自定义模型」
 * 决定显不显示。
 *
 * ⚠️ 老值 `'workflow'` **必须继续认**：加这两档之前新建的图片节点存的就是它，
 *   下线的 `image2` 同理（见 `RETIRED_IMAGE_ENGINES`），
 * 老画布不会自己改。`readImageEngine` 把它当成 `runninghub`。
 *
 * 值域与兜底规则放在这里（不引 `server-only`、不碰数据库），因为 UI 渲染、提交前的自查、
 * 服务端校验都要同一份定义，回归脚本也要能直接加载它（见 scripts/test-image2-params.cjs）。
 */

export const IMAGE_ENGINES = ['runninghub', 'local', 'custom'] as const;

export type ImageEngine = (typeof IMAGE_ENGINES)[number];

/**
 * 缺省引擎。只能是 `runninghub`：加这两档之前所有图片生成节点都是走 RunningHub 工作流的，
 * 老画布上没有 `engine` 字段，它们必须继续按老路子跑。
 */
export const DEFAULT_IMAGE_ENGINE: ImageEngine = 'runninghub';

/**
 * 老值 → 新值。**只在读的时候用**，不要写回库：
 * 老画布上那一串 `'workflow'` 是历史数据，改了只是白写一次盘。
 */
const LEGACY_IMAGE_ENGINES: Record<string, ImageEngine> = { workflow: 'runninghub' };

/**
 * 已经下线的引擎（2026-09-23：Image 2.0）。
 *
 * ⚠️ **不许**把它们塞进 `LEGACY_IMAGE_ENGINES` 映射成别的一档：那等于界面显示 RunningHub、
 * 而库里存的还是 `image2` —— 正是这个文件一直在防的「说一套、走另一套」。
 * 正确做法是**原样读回**，让界面按已有的「存着的值不在选项里」那条路子
 * （`GenerateDock` 里那颗 `.cv-dock-eng.stale`）显示成「… · 当前用不了」，由用户自己改。
 */
const RETIRED_IMAGE_ENGINES: Record<string, string> = { image2: 'Image 2.0（已下线）' };

/** 走工作流的那两档。单独拎出来是因为「要不要工作流」和「是不是直连」不是同一个判断。 */
const WORKFLOW_IMAGE_ENGINES: readonly string[] = ['runninghub', 'local'];

/** 严格校验，给接口入参用 —— 送来不认识的引擎要**报错**，不能悄悄改成默认值。 */
export function isImageEngine(value: unknown): value is ImageEngine {
  return typeof value === 'string'
    && ((IMAGE_ENGINES as readonly string[]).includes(value) || value in LEGACY_IMAGE_ENGINES);
}

/** 读取兜底，给「展示一个从库里读出来的值」用。与 `isImageEngine` 的区别是它不报错。 */
export function readImageEngine(value: unknown): ImageEngine {
  if (typeof value === 'string' && (IMAGE_ENGINES as readonly string[]).includes(value)) return value as ImageEngine;
  if (typeof value === 'string' && value in LEGACY_IMAGE_ENGINES) return LEGACY_IMAGE_ENGINES[value];
  /** 下线那一档**原样**返回（上面那段说了为什么不能映射）。 */
  if (typeof value === 'string' && value in RETIRED_IMAGE_ENGINES) return value as ImageEngine;
  return DEFAULT_IMAGE_ENGINE;
}

/** 这一档走不走工作流（也就是要不要选一份工作流、有没有步数 / CFG / 负向提示词）。 */
export function usesWorkflowEngine(value: unknown) {
  return WORKFLOW_IMAGE_ENGINES.includes(readImageEngine(value));
}

/** 这一档要的工作流来源。`image2` / `custom` 不经过工作流，返回 null。 */
export function imageEngineProvider(value: unknown): 'local' | 'runninghub' | null {
  const engine = readImageEngine(value);
  if (!WORKFLOW_IMAGE_ENGINES.includes(engine)) return null;
  return engine === 'local' ? 'local' : 'runninghub';
}

/**
 * 给下拉/分段控件用。放在这里是为了「有哪些引擎」只有一处定义。
 *
 * ⚠️ 同样**没有**老值 `'workflow'` 那一行：它只在 `LEGACY_IMAGE_ENGINES` 里，
 * 职责是读老数据，不是让人再选一次。用户要选的是来源。
 *
 * ⚠️ 用它的地方一律走 `imageEngineOptions(showCustom)` —— `custom` 那一项只在
 * 用户真的加了出图类型的自定义接口时才该出现（理由见文件头）。
 */
export const IMAGE_ENGINE_OPTIONS: { value: ImageEngine; label: string; hint: string }[] = [
  { value: 'runninghub', label: 'RunningHub', hint: '用 RunningHub 上保存的工作流出图，参数是步数 / CFG / 种子 / 采样器；算力在云端，按点扣费' },
  { value: 'local', label: '本地 ComfyUI', hint: '用本机 ComfyUI 的工作流出图，参数是步数 / CFG / 种子 / 采样器；图与算力都在自己这边，不扣费' },
  { value: 'custom', label: '自定义接口', hint: '走你在「设置 · 模型服务」里添加的自定义接口，模型与计费都由那家决定' },
];

/** 下拉里**实际**要显示的几项。`showCustom` 由「有没有出图类型的自定义模型」决定。 */
export function imageEngineOptions(showCustom: boolean) {
  return IMAGE_ENGINE_OPTIONS.filter(option => option.value !== 'custom' || showCustom);
}

export function imageEngineLabel(value: unknown) {
  const engine = readImageEngine(value);
  /** 下线那一档没有选项行，名字只在 `RETIRED_IMAGE_ENGINES` 里。 */
  if (typeof value === 'string' && value in RETIRED_IMAGE_ENGINES) return RETIRED_IMAGE_ENGINES[value];
  return IMAGE_ENGINE_OPTIONS.find(item => item.value === engine)?.label || 'RunningHub';
}
