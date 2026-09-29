/**
 * 视频生成节点的「引擎」—— 这段视频到底是**让一份工作流出**，还是**直连一个视频网关**出，
 * 还是**走用户自己添加的自定义接口**。
 *
 * 三者不是同一件事的实现细节，而是两套完全不同的东西：
 * - `runninghub` / `local`：参数是时长 / latent 续接 / 比例 / MP，值要绑到工作流节点字段上
 *   （`configuration.ts` 的绑定），支持 latent 续接；
 * - `videoapi`：参数是模型 / 时长 / 分辨率 / 比例，直接拼成 HTTP 请求体打网关（`videoApiParams.ts`），
 *   没有工作流、没有 latent、没有续接；
 * - `custom`（2026-09-21）：走用户在「设置 · 模型服务 · 自定义接口」里加的那条 OpenAI 兼容网关，
 *   异步提交 + 轮询（与 `videoapi` 同一套节奏），也没有工作流、没有 latent。
 *
 * 所以引擎不只是「换个接口」——它**换掉整条参数链路**。这就是为什么它必须是节点上一个显式字段、
 * 而不是靠「填了哪个参数就用哪套」去猜：猜错的症状和用途选错一样是静默的（任务成功、参数被忽略）。
 *
 * ## 为什么工作流要分成两档（2026-09-21）
 *
 * 原来只有一档 `workflow`，它底下混着云端的和本机的两份工作流。混着列是不行的：
 * 两者的**图在哪、跑在哪、出问题找谁**都不一样 ——
 * - `runninghub`：图在 RunningHub 那边，跑在它的算力上，提交走 `/api/projects/[id]/generation`
 *   带一个纯数字 ID；
 * - `local`：图在本机库里（导入时存下来的那张），跑在**用户自己的 ComfyUI** 上，不扣费、随时换图，
 *   提交同样走 `/api/projects/[id]/generation`，但服务端按 `provider` 分派到本地那条链路。
 *
 * 引擎这一档还决定了**下拉里列哪些工作流**：选了 `runninghub` 就只列云端的，选了 `local`
 * 就只列本机的。让它们混在一个下拉里，用户选中的那行到底会跑到哪儿，界面上一个字都不说 ——
 * 这类静默差异是这套 UI 反复踩的坑。
 *
 * ## 为什么 `custom` 要「没配就不显示」
 *
 * 与图片那条同一个理由（详见 `imageEngine.ts`）：它是唯一一个依赖「用户有没有加过接口」
 * 才存在的档位，一条出视频类型的自定义模型都没有时列出来只会让人选了之后撞墙。
 * 界面一律走 `videoEngineOptions(showCustom)`。
 *
 * ⚠️ 老值 `'workflow'` **必须继续认**：加这两档之前新建的视频节点存的就是它，
 * 老画布不会自己改。`readVideoEngine` 把它当成 `runninghub`（那时候只有云端这一种工作流）。
 *
 * ⚠️ 与图片那条链路的一个**关键差别**：图片侧的 `custom`（自定义接口出图）是**同步**的
 * （发完就出图），所以它可以完全绕开任务轮询；`videoapi` 与 `custom` 都是**异步**的
 * （提交拿外部任务号 → 轮询状态），因此必须让
 * `GET /api/tasks/[id]` 按 `task.provider` 分派到对应的 client —— 那层原本是写死 RunningHub 的。
 * 接新引擎时这一处**必须**跟着改，否则任务永远停在 running。
 *
 * 值域与兜底规则放在这里（不引 `server-only`、不碰数据库），因为 UI 渲染、提交前的自查、
 * 服务端校验都要同一份定义，回归脚本也要能直接加载它。
 */

export const VIDEO_ENGINES = ['runninghub', 'local', 'videoapi', 'custom'] as const;

export type VideoEngine = (typeof VIDEO_ENGINES)[number];

/**
 * 缺省引擎。只能是 `runninghub`：加这两档之前所有视频生成节点都是走 RunningHub 工作流的，
 * 老画布上没有 `engine` 字段，它们必须继续按老路子跑。
 */
export const DEFAULT_VIDEO_ENGINE: VideoEngine = 'runninghub';

/**
 * 老值 → 新值。**只在读的时候用**，不要往库里写回去：
 * 老画布上那一串 `'workflow'` 是历史数据，改了反而制造一次没必要的写盘。
 */
const LEGACY_VIDEO_ENGINES: Record<string, VideoEngine> = { workflow: 'runninghub' };

/** 走工作流的那两档。与非工作流那两档的区别见文件头。 */
const WORKFLOW_VIDEO_ENGINES: readonly string[] = ['runninghub', 'local'];

/** 严格校验，给接口入参用 —— 送来不认识的引擎要**报错**，不能悄悄改成默认值。 */
export function isVideoEngine(value: unknown): value is VideoEngine {
  return typeof value === 'string'
    && ((VIDEO_ENGINES as readonly string[]).includes(value) || value in LEGACY_VIDEO_ENGINES);
}

/** 读取兜底，给「展示一个从库里读出来的值」用。与 `isVideoEngine` 的区别是它不报错。 */
export function readVideoEngine(value: unknown): VideoEngine {
  if (typeof value === 'string' && (VIDEO_ENGINES as readonly string[]).includes(value)) return value as VideoEngine;
  if (typeof value === 'string' && value in LEGACY_VIDEO_ENGINES) return LEGACY_VIDEO_ENGINES[value];
  return DEFAULT_VIDEO_ENGINE;
}

/** 这一档走不走工作流（也就是要不要选一份工作流、支不支持 latent 续接）。 */
export function usesWorkflowEngine(value: unknown) {
  return WORKFLOW_VIDEO_ENGINES.includes(readVideoEngine(value));
}

/** 这一档要的工作流来源。`videoapi` / `custom` 不经过工作流，返回 null。 */
export function videoEngineProvider(value: unknown): 'local' | 'runninghub' | null {
  const engine = readVideoEngine(value);
  if (!WORKFLOW_VIDEO_ENGINES.includes(engine)) return null;
  return engine === 'local' ? 'local' : 'runninghub';
}

/**
 * 给下拉/分段控件用。放在这里是为了「有哪些引擎」只有一处定义。
 *
 * ⚠️ 这里**没有**老值 `'workflow'` 那一行 —— 它只在 `LEGACY_VIDEO_ENGINES` 里出现，
 * 职责是「读老数据时认它」，不是「让人再选它一次」。用户要选的是**来源**，
 * 而来源就是下面这三档里的前两档。
 */
export const VIDEO_ENGINE_OPTIONS: { value: VideoEngine; label: string; hint: string }[] = [
  { value: 'runninghub', label: 'RunningHub', hint: '用 RunningHub 上保存的工作流出片，支持 latent 续接；算力在云端，按点扣费' },
  { value: 'local', label: '本地 ComfyUI', hint: '用本机 ComfyUI 的工作流出片，支持 latent 续接；图与算力都在自己这边，不扣费' },
  { value: 'videoapi', label: '视频网关', hint: '直连一个通用视频生成 API，参数是模型 / 时长 / 分辨率 / 比例；不经过工作流、没有续接' },
  { value: 'custom', label: '自定义接口', hint: '走你在「设置 · 模型服务」里添加的自定义接口，提交后轮询拿结果；模型与计费都由那家决定' },
];

/** 下拉里**实际**要显示的几项。`showCustom` 由「有没有出视频类型的自定义模型」决定。 */
export function videoEngineOptions(showCustom: boolean) {
  return VIDEO_ENGINE_OPTIONS.filter(option => option.value !== 'custom' || showCustom);
}

export function videoEngineLabel(value: unknown) {
  return VIDEO_ENGINE_OPTIONS.find(item => item.value === readVideoEngine(value))?.label || 'RunningHub';
}
