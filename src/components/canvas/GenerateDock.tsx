'use client';
/*
 * 生成节点的**底部对话框**（2026-09-21 二改：参考即梦式布局复刻）。
 *
 * 结构从上到下：
 *   参考图槽位 → 提示词（无框，直接写在面板上）→ 操作排。
 * 操作排只留四样：引擎 chip、**参数摘要 chip**（点开分组弹层）、
 * 「自定义参数」图标、发送圆钮。
 *
 * 比例 / 分辨率 / 长宽（图片）/ 时长（视频）不再平铺在操作排 ——
 * 它们收进摘要点开的**分组弹层**（`[data-dock-pop]`，绝对定位、从操作排上沿
 * 往上浮，可以高出面板本体，参考的就是第二张截图那种窄卡片）。
 * 要改进阶参数（步数、CFG、种子、负向提示词、工作流…）仍走「自定义参数」
 * 在滚动区里往下展开，**不弹第二层窗、不换位置**。
 *
 * ⚠️ 四条规矩，改这块时别破：
 *
 * 1. **所有参数仍然在同一个节点上**。这里不是另一份参数，只是同一批参数的另一种摆法：
 *    每一项都还是走 `data.onField?.('字段名', v)`。出现「面板上写了但生成没用上」
 *    = 有控件忘了接 `onField`，这是最容易犯的错。
 * 2. **长宽那一档两态互斥**：`sizeMode` 是 `resolution` 时长宽是**只读读数**（由比例+MP 换算），
 *    是 `custom` 时才变成两个输入框。显示用哪个数、提交用哪个数，都由
 *    `resolveImageSize()` 一个函数决定 —— 界面和提交各算一遍迟早对不上。
 * 3. `nodrag` / `nowheel` 只加在**具体控件**上。整块加会让这一片失去默认手势
 *    （滚轮在这里要能滚动画布）。
 * 4. **弹层是绝对定位**（不占布局、不被面板的滚动裁剪），所以它**不能**成为
 *    「面板里有没有这个控件」的判断依据 —— 判断控件存在与否照常用 DOM 查询，
 *    但「可不可点」要看它当前是不是开着的。
 */
import { useRef, useState, type ReactNode } from 'react';
import { apiPost } from '@/lib/client';
import { useApi } from '@/lib/client';
import { customEngineVisible } from '@/lib/providers/custom-visible';
import { ArrowUp, ChevronDown, Download, Loader, Plus, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { NodeData } from './types';
import {
  ASPECT_RATIOS, DEFAULT_RATIO, IMAGE2_FIXED_RATIO, IMAGE2_RATIOS, IMAGE2_RESOLUTIONS, IMAGE2_SIZE_AUTO,
  IMAGE_DEFAULTS, IMAGE_SIZE_MODES, INSTANCE_TYPE_OPTIONS, MAX_BATCH, MAX_CFG, MAX_CUSTOM_SIDE,
  MAX_MEGAPIXELS, MAX_STEPS, MIN_CUSTOM_SIDE, MIN_MEGAPIXELS, SAMPLERS, VIDEO_API_RATIOS,
  VIDEO_API_RESOLUTIONS, deriveImageSize, generatorKindLabel, imageEngineOptions, instanceTypeHint, videoEngineOptions,
  groupWorkflowsByProvider, imageEngineLabel, imageEngineProvider, isAudioUrl, isVideoUrl, readImage2Params,
  readImageEngine, readImageSizeMode, readInstanceType, readVideoApiParams, readVideoEngine, resolveImageSize,
  validateCustomSize, videoEngineLabel,
  videoEngineProvider, workflowDisplayName, workflowLabel, workflowMismatchHint, upscaleWorkflowsFor,
  workflowsForApp, workflowsForGeneration, workflowsForProvider, purposeForNode, purposeOfNode, purposesOfNode,
  nodeEngineProvider, readUpscaleMode, readUpscaleSource, upscaleWorkflowFor,
  UPSCALE_MODE_LABELS, UPSCALE_MODES, UPSCALE_SOURCE_LABELS, UPSCALE_SOURCES,
} from './nodeMeta';
import type { UpscaleMode, UpscaleSource } from './nodeMeta';
/* 老画布上可能在生成节点上选着一份 RunningHub 应用 —— 那一行要说得出它是什么（2026-10-04）。 */
import { isRunningHubAppWorkflowId } from '@/lib/workflows/runninghubApp';
import type { ParamRow } from '@/lib/workflows/configuration';
import DockCombo from './DockCombo';

/** 有这一块的三种节点：图片生成 / 视频生成 / RunningHub 应用。 */
export type DockKind = 'image-generate' | 'video-generate' | 'app-generate';

/**
 * 对话框钉在哪儿（**画布坐标系**，不是屏幕坐标）。
 *
 * 由 `CanvasEditor` 拿着节点的 flow 坐标 × 当前视口变换算好传进来 ——
 * 这里刻意**不自己算**：视口变换、画布尺寸、节点实测高度都只有那边拿得到，
 * 组件里再算一遍就是第二份真相。
 *
 * ⚠️ **只有 `top`，没有 `bottom` 这一支了**（2026-10-02）：以前「下方放不下就翻到节点上方」
 * 那一支是靠 `bottom` 定位的，徐先看过之后要求「节点移到下面时参数框不用移到上方」，
 * 于是那条分支整个删掉（见 `CanvasEditor` 的 `dockAnchorFor`）。
 */
export type DockAnchor = {
  left: number;
  width: number;
  top: number;
  maxHeight: number;
};

/** 槽位在行里的排序：提示词在最前，然后是图，最后是 latent / 工作流 / 参数块。 */
const SLOT_ORDER: Record<string, number> = {
  text: 0, 'prompt-optimize': 0, image: 1, 'video-input': 1, 'frame-extract': 1,
  latent: 2, 'latent-relay': 2, workflow: 3, params: 4, 'audio-input': 5,
};

/** 比例可视化格子要的一个统一形状（三种链路的档位列表长得都不一样）。 */
type RatioOpt = { value: string; label: string; w: number; h: number };

/** 比例小方框：长边固定 24、短边按比例算，非自适应档都能画出来。 */
function ratioBoxSize(opt: RatioOpt) {
  if (!opt.w || !opt.h) return { bw: 24, bh: 14 };
  return opt.w >= opt.h
    ? { bw: 24, bh: Math.max(5, Math.round((24 * opt.h) / opt.w)) }
    : { bh: 15, bw: Math.max(5, Math.round((15 * opt.w) / opt.h)) };
}

/** /api/skills 里只用到这三个字段 —— 别把整个 SkillItem 搬进 dock。 */
type SkillOption = { id: string; title: string; optimize: boolean };

/**
 * 应用字段在界面这一侧只用到这几列 —— 也就是 `GET /api/workflows/<id>/config` 回的 `config.fields`。
 *
 * `options` 是应用自己公开的选项（`文戏=0` 这种）：有它就能把输入框换成下拉，
 * 界面和配置页读的是同一份配置，不存在「这里改了那边不知道」。
 */
type AppField = {
  key: string;
  nodeId: string;
  fieldName: string;
  label: string;
  kind: string;
  value: string;
  enabled: boolean;
  binding: string;
  options?: string[];
};

/*
 * 「从工作流库中选择…」**不再需要一个哨兵值**了（2026-10-02）。
 *
 * 以前它是一个 `<option value="__library__">`：受控下拉的 value 来自 `data.workflowId`，
 * 所以选中它必须**特殊处理** —— 一旦手滑把 `__library__` 落到 `onField`，节点就指向一份
 * 不存在的工作流，而界面上完全看不出错了（下拉空白、提交时才报「配置不存在」）。
 * `DockCombo` 里它是列表最上面一颗**独立的按钮行**（`action`），压根不进候选，
 * 这个问题从结构上就不存在了。`NodeParamBar` 那份仍然用哨兵值（它还是原生下拉）。
 */

export default function GenerateDock({ data, nodeId, anchor }: {
  data: NodeData;
  /** 挂在哪个节点上 —— 只给探针 / 排查看，业务逻辑一概不用它。 */
  nodeId?: string;
  anchor?: DockAnchor;
}) {
  const kind = (data.kind || 'image-generate') as DockKind;
  const isApp = kind === 'app-generate';
  const isImage = kind === 'image-generate';
  const [more, setMore] = useState(false);
  const [pop, setPop] = useState(false);
  /** 「超清」那一颗胶囊自己的弹层（不与参数摘要共用一个开关：两个都开着会互相盖住）。 */
  const [upPop, setUpPop] = useState(false);
  const running = data.status === 'running';

  /*
   * 自定义接口清单（2026-09-21）。
   *
   * 引擎里那一项「自定义接口」**只在真有对应用途的模型时才出现** ——
   * 一条都没加就把它列出来，用户选了只能拿到一句「还没配置」。
   * 所以这里问一次「有哪些能出图 / 出片的自定义模型」，再拿它过滤引擎选项。
   */
  const custom = useApi<{
    models: { image: { value: string; label: string }[]; video: { value: string; label: string }[] };
  }>('/api/providers/custom');
  const customModels = (isImage ? custom.data?.models.image : custom.data?.models.video) || [];
  /*
   * 这一档**显不显示**：只有「清单成功问到了、而且确实一个都没有」才隐藏（2026-09-29）。
   *
   * 反过来（没问到 / 问失败就隐藏）会把一个**正在用**的档位悄悄藏起来：节点上存着的
   * `engine: 'custom'` 会被显示成「自定义接口 · 当前用不了」，而它其实好端端的 ——
   * 用户看到的就是「自定义接口有时候会消失」。规矩详见 `lib/providers/custom-visible.ts`。
   */
  const showCustomEngine = customEngineVisible({ loaded: Boolean(custom.data), count: customModels.length });

  /*
   * 「优化提示词」用哪家文本模型的可选项（2026-09-22）。
   *
   * 留             空 = 跟着用户在设置里指定的那家走；这里让用户在**这个节点上**单独指定，
   * 因为同一个项目里不同节点的诉求不一样（批量跑的节点用便宜的，重点镜头用好的）。
   * `configured:false` 的那些也照常列出来 —— 下拉里看不见，用户只会以为这家没接进来，
   * 而不是「我还没填 Key」；点下去服务端会说清楚是哪一家没配。
   */
  const textModels = useApi<{
    items: { value: string; label: string; configured: boolean }[];
    resolvedLabel: string | null;
    resolvedProvider: string | null;
  }>('/api/prompt/models');
  const promptModelItems = textModels.data?.items || [];
  const promptModelValue = String(data.promptModel || '');
  /*
   * 优化提示词时照哪个技能写（2026-09-25，SKILL 社区）。
   * 选项只收 `optimize` 打开过的那些 —— 全列出来的话这个下拉会有十几项，
   * 而其中大部分跟「写提示词」没关系（比如只规划资产的那几个）。
   */
  const skillList = useApi<{ skills: SkillOption[] }>('/api/skills');
  const optimizeSkills = (skillList.data?.skills ?? []).filter(item => item.optimize);
  const promptSkillValue = String(data.promptSkill || '');
  const resolvedLabel = String(textModels.data?.resolvedLabel || '').trim();
  /*
   * 存着的那个值已经不在选项里了（那条自定义接口被删了、或者这台机器上配的那家没了）。
   *
   * ⚠️ **不许**在这里偷偷退回「自动」：那等于告诉用户「你指定过了」，然后悄悄走别家 ——
   * 而优化结果的差异没有任何界面会提示。正确的做法是把它显示成一个带说明的可选项，
   * 让用户自己决定改不改。
   */
  const missingPromptModel = promptModelValue
    && !promptModelItems.some(item => item.value === promptModelValue)
    ? promptModelValue
    : '';

  /* ---------------- 本地模型：装载 / 卸载（2026-09-26，徐先要的两档） ---------------- */
  /*
   * 这一节点优化提示词**是不是真的会用到本地模型**。
   *
   * 两种情况下是：① 下拉里明明白白选了「本地」；② 留空（跟随设置）而设置里
   * 指定的那家正好就是本地。判据用 `resolvedProvider`（厂商 id）而不是 label ——
   * label 是给人看的文案，拿它做判断等于把逻辑押在文案上。
   */
  const resolvedProvider = String(textModels.data?.resolvedProvider || '').trim();
  const localEffective = promptModelValue === 'local' || (!promptModelValue && resolvedProvider === 'local');
  /**
   * `keep` = 装载后一直装载、手动卸载；`auto` = 优化完自动卸载。
   * 默认 `auto`：老画布上没这个字段，默认值必须等于「以前的行为」，否则用户
   * 一升级就会发现显存被莫名占着，而界面上没有任何一处告诉他是谁占的。
   */
  const localLoadMode = String(data.promptLocalLoad || '').trim() === 'keep' ? 'keep' : 'auto';
  /*
   * 本地引擎现在装没装。**只在这一节点用得到本地、且自定义参数区展开时才问** ——
   * 每个节点都挂着 dock，无条件地问等于每次开画布都多打一堆请求。
   */
  const llmStatus = useApi<{ running: boolean; state: string; modelPath: string; message: string }>(
    more && localEffective ? '/api/local-llm/status' : null,
  );
  const llmRunning = Boolean(llmStatus.data?.running);
  const llmModelName = String(llmStatus.data?.modelPath || '')
    .split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') || '';
  const [localBusy, setLocalBusy] = useState(false);

  /** 手动装载 / 卸载：装的是「设置 · 模型服务 · 本地模型」里选的那一份。 */
  async function toggleLocalModel() {
    setLocalBusy(true);
    try {
      if (llmRunning) {
        await apiPost('/api/local-llm/stop', {});
        data.onNotice?.('已卸载本地模型，显存还回去了。');
      } else {
        /*
         * ⚠️ 空对象**不能省**：`/api/local-llm/start` 走 `jsonBody()`，
         * 它第一条就是「请求不能为空」（400），不传 body 的 fetch 没有 request.body。
         * 症状是按钮点了没反应，只有一句 notice 一闪而过。
         */
        await apiPost('/api/local-llm/start', {});
        data.onNotice?.('本地模型已装载 — 现在是「一直装载」，不用了记得点「卸载」。');
      }
    } catch (error) {
      data.onNotice?.(error instanceof Error ? error.message : '本地模型装载 / 卸载失败。');
    } finally {
      setLocalBusy(false);
      llmStatus.reload();
    }
  }

  /* ---------------- 引擎 / 工作流（两套节点共用这部分推导） ---------------- */
  /*
   * 应用节点出图还是出片，由**选中的那份应用**决定（导入时定的用途）——不能按节点类型写死，
   * 写死的话一个出片的应用会按「图片」去筛下拉、也会按 image 提交给服务端。
   */
  const workflowOptions = data.workflows || [];
  const chosenWorkflow = workflowOptions.find(item => item.workflowId === String(data.workflowId || ''));
  /**
   * 这个节点上选的是 **RunningHub 应用**，而它自己不是应用节点（2026-10-04）。
   *
   * 工作流下拉现在一律不列应用（`workflowsOnly`），所以这一种只可能来自老画布。
   * 遇上了必须**说出它是什么**：这行原来会显示成「RunningHub（云端） · N 项启用」——
   * 把一份应用说成云端工作流，正是他一直在防的那种「界面说的和实际不是一回事」。
   * 生成**照跑不误**（他库里这两份应用的绑定是全的，参数真的送得进去），
   * 所以这里只提示、不拦 —— 拦了等于把一张本来能跑的画布弄坏。
   */
  const appOnGenerateNode = !isApp && !!chosenWorkflow && isRunningHubAppWorkflowId(chosenWorkflow.workflowId);
  /*
   * 2026-10-02：视频 / 音频生成节点出什么，**跟着选中的那份工作流走**（应用节点那支同一套路）。
   * 写死成 'video' 的话，挑了音频工作流之后用途还报「视频」：提交会带上时长 / 比例 /
   * latent 这些音频工作流根本没有的参数，界面上还会弹「这份工作流不是视频用的」——
   * 而它明明是下拉里列出来让人选的。
   */
  const purpose: 'image' | 'video' | 'audio' = isApp
    ? (chosenWorkflow?.kind === 'video' ? 'video' : 'image')
    : (purposeForNode(data.kind, workflowOptions, data.workflowId) ?? (isImage ? 'image' : 'video'));
  /*
   * 音频那一档：**画面那几组参数全都不成立**（2026-10-02）。
   * 比例、分辨率（MP）、时长说的都是画面，latent 接续更是只属于视频（音频工作流没有 latent 位）。
   * 摆着它们的后果和「应用节点上摆比例 / 时长」一模一样 —— 改了看着生效，
   * 提交时这几个字段根本进不去 `nodeInfoList`。所以整组不渲染，不是置灰。
   */
  const audioOnly = purpose === 'audio';
  const isImageParams = isImage || (isApp && purpose === 'image');
  const engine = isImageParams ? readImageEngine(data.engine) : readVideoEngine(data.engine);
  const engineOptions = isImage ? imageEngineOptions(showCustomEngine) : videoEngineOptions(showCustomEngine);
  const engineHint = engineOptions.find(item => item.value === engine)?.hint || '';
  /**
   * 不经过任何工作流的两档：视频网关、以及**图片那一侧的自定义接口**（同步出图，
   * 参数是比例 / 分辨率，没有步数 / CFG / 负向提示词）。
   *
   * 2026-09-23：原来这里是 `image2 || videoapi`（Image 2.0 与视频网关）。Image 2.0 删掉之后，
   * 图片这一侧唯一「不经过工作流」的就是自定义接口 —— 它和当年的 Image 2.0 是同一条同步形状，
   * 用的也是同一套 `image2Ratio` / `image2Resolution` 字段。
   */
  const isGateway = engine === 'videoapi' || engine === 'custom';
  /** 接续上一段（视频节点专用；图片节点不吃 latent，网关那两档也没有）。 */
  const continuationOn = data.continuationEnabled === 'on';

  /*
   * 应用节点固定走云端（应用只存在于 RunningHub 上），所以来源这一层对它就是个常量；
   * 而它要列的是**应用**，不是工作流 —— 少了这一支，下拉里会是空的，
   * 用户只能得出「导入了应用却选不到」的结论。
   */
  const engineProvider = isApp ? 'runninghub' : (isImageParams ? imageEngineProvider(data.engine) : videoEngineProvider(data.engine));
  const workflows = workflowOptions;
  const listedBase = isApp
    ? workflowsForApp(workflowOptions)
    : workflowsForGeneration(workflows, purposesOfNode(data.kind));
  const listedWorkflows = workflowsForProvider(listedBase, engineProvider);
  const listedGroups = groupWorkflowsByProvider(listedWorkflows);
  /**
   * 「同类但**来源对不上**」的那几份。
   *
   * 候选为空有两种，界面上长得一模一样，但要用户做的事完全不同：
   * ① 一份都没存过 → 去设置页存一份；
   * ② 存过，只是都属于**另一个来源档**（引擎选了 RunningHub，手上那两份却是本机 ComfyUI 的）
   *    → 把「引擎」切过去就选得到。
   * 不分开说，用户只会得出「我明明有工作流，它却说一份都没有」。
   */
  const otherSourceCount = listedBase
    .filter(item => !listedWorkflows.some(mine => mine.workflowId === item.workflowId)).length;
  /**
   * 「同类但**是应用**」的那几份（2026-10-04）。
   *
   * 应用已经从生成下拉里挑出去了（`workflowsOnly`），于是「一份工作流都没有」这条提示
   * 会变成一句假话 —— 他手上明明导了两份应用。所以空候选那一串里要专门有一支：
   * **不是没有，是它们属于另一个节点**（「RunningHub 应用」），并说出去哪儿用。
   */
  const appPurposeCount = isApp
    ? 0
    : workflowsForApp(workflows).filter(item => purposesOfNode(data.kind).includes(item.kind)).length;

  /*
   * 「超清」这一道（2026-10-02 徐先）：触发方式（关闭 / 手动 / 自动）+ 用哪一份（来源）。
   *
   * 应用节点不参与 —— 它没有「引擎」那一档，`upscale()` 也只认两种生成节点，
   * 给它画一颗胶囊等于给一个点了必然报错的开关。
   */
  const upscalePurpose = purposeOfNode(kind);
  const upscaleMode = readUpscaleMode(data.upscaleMode);
  const upscaleSource = readUpscaleSource(data.upscaleSource);
  const upscaleProvider = nodeEngineProvider(kind, data.engine);
  /*
   * 「超清工作流」那一行的候选：用途 + 工序 + 来源都对得上的那批。
   * 与下面挑「这次用哪一份」**同一个筛法**（`upscaleWorkflowsFor`），所以下拉里列出来的
   * 一定就是能被选中的那一批 —— 两处各写一份的话，会出现「列表里有、选了他又说没有」。
   */
  const upscaleOptions = upscalePurpose
    ? upscaleWorkflowsFor(workflowOptions, upscalePurpose, upscaleSource, upscaleProvider)
    : [];
  /** 点名的哪一份；空 = 自动。 */
  const upscaleChosen = String(data.upscaleWorkflowId || '').trim();
  /** 点名的那份已经不在这批候选里了（删了 / 改了工序 / 来源对不上）。 */
  const upscaleChoiceStale = !!upscaleChosen && !upscaleOptions.some(item => String(item.workflowId) === upscaleChosen);
  const upscaleTarget = upscalePurpose
    ? upscaleWorkflowFor(workflowOptions, upscalePurpose, upscaleSource, upscaleProvider, upscaleChosen)
    : undefined;
  /*
   * 「工作流」和「超清工作流」两个下拉**并排**（2026-10-02 徐先：「工作流和超清工作流两个并排」）。
   *
   * 它俩本来各占一整行（`.cv-dock-field.wide` 是 `flex: 1 1 100%`），两份工作流一上一下叠着，
   * 会被读成两段无关的设置 —— 可它们说的是同一个节点上的两份工作流（这份跑生成、那份跑超清）。
   *
   * ⚠️ 只有**两个都在**的时候才各占一半：缺一个（网关那两档没有「工作流」、
   * 应用节点没有「超清工作流」）时剩下的那个仍然占满整行，不然会凭空空出半行。
   */
  const pairWorkflows = !isGateway && !!upscalePurpose && !isApp;
  /*
   * 两个可输入搜索框的候选（`DockCombo`）。形状只有两个字段：
   * `value` 是工作流编号、`label` 是整行文案（**名字 + 编号 + 多少项启用**，由
   * `workflowLabel()` 拼）。匹配就在这条 label 上做 —— 它同时含着名字和编号，
   * 所以无论用户记的是「我起的那个名字」还是「那串数字」都能搜到（口径与设置页一致）。
   */
  const wfItems = listedWorkflows.map(item => ({ value: String(item.workflowId), label: workflowLabel(item) }));
  const wfGroups = listedGroups.map(group => ({
    key: group.provider,
    label: `${group.label} · ${group.items.length}`,
    items: group.items.map(item => ({ value: String(item.workflowId), label: workflowLabel(item) })),
  }));
  const upItems = upscaleOptions.map(item => ({ value: String(item.workflowId), label: workflowLabel(item) }));

  const slots = [...(data.inputs || [])].sort((a, b) => (SLOT_ORDER[a.kind] ?? 9) - (SLOT_ORDER[b.kind] ?? 9));
  const resultUrl = String(data.resultUrl || '');
  const resultImage = resultUrl && !isVideoUrl(resultUrl) && !isAudioUrl(resultUrl) ? resultUrl : '';

  /* ---------------- 图片：尺寸那一档 ---------------- */
  const image2 = readImage2Params({
    ratio: data.image2Ratio, resolution: data.image2Resolution, background: data.image2Background,
  });
  const sizeMode = readImageSizeMode(data.sizeMode);
  /**
   * 界面上写的宽高**必须**是提交时会用的那个 —— 所以这里直接问 `resolveImageSize`，
   * 不自己按 sizeMode 再算一遍（见文件头第 2 条）。
   */
  const resolved = isImage ? resolveImageSize(data) : null;
  /** 按分辨率时给一句「实际多少」；自定义时给一句「填的数不对在哪」。 */
  const sizeIssue = isImage && sizeMode === 'custom'
    ? validateCustomSize(data.customWidth, data.customHeight)
    : '';

  /* ---------------- 视频网关的即时读数（摘要 / 弹层共用一次推导） ---------------- */
  const videoApi = engine === 'videoapi'
    ? readVideoApiParams({
      model: data.videoApiModel, duration: data.videoApiDuration,
      resolution: data.videoApiResolution, aspectRatio: data.videoApiRatio,
    })
    : null;

  const pasteFromClipboard = async () => {
    try {
      if (!navigator.clipboard?.read) throw new Error('unsupported');
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(entry => entry.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        data.onPasteImages?.([new File([blob], 'pasted.png', { type })]);
        return;
      }
      data.onNotice?.('剪贴板里没有图片');
    } catch {
      data.onNotice?.('直接按 Ctrl+V / ⌘V 粘贴图片即可');
    }
  };

  /* ---------------- 操作排：引擎 chip ---------------- */
  /*
   * 节点上存着的引擎，现在**不在可选项里**了。
   *
   * 典型的来路：选了「自定义接口」，后来把那条接口删了（或者它的模型用途被改成了不匹配的），
   * 于是 `imageEngineOptions` 里不再有 `custom`。
   *
   * ⚠️ 这时候**不能让它显示成别的东西**：`<select value="custom">` 在没有匹配项时，
   * 浏览器会拿第一项（RunningHub）当脸面显示，可 `data.engine` 还是 `'custom'` ——
   * 界面说 RunningHub、提交走自定义接口，而且这一档还得被删掉一次。
   * 所以把存着的值补成一个带说明的选项，让下拉说的是实话。
   */
  const engineStale = engine && !engineOptions.some(item => item.value === engine);
  const engineSelect = (
    <select
      className={`cv-select sm cv-dock-eng${engineStale ? ' stale' : ''}`}
      data-dock-engine=""
      data-dock-engine-stale={engineStale ? '' : undefined}
      aria-label="引擎"
      title={engineHint
        ? `${engineHint}${isGateway ? ' · 这一档直接提交给网关，不经过工作流' : ''}`
        : '选哪条链路跑这一发'}
      value={engine}
      onChange={event => data.onField?.('engine', event.target.value)}
    >
      {engineStale && (
        <option value={engine}>
          {`${isImage ? imageEngineLabel(engine) : videoEngineLabel(engine)} · 当前用不了`}
        </option>
      )}
      {engineOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
  );

  /*
   * RunningHub 的**运行规格**（2026-09-30，徐先要的）。
   *
   * 在这之前界面上一个字都没有：提交时永远不带 `instanceType`，官方就按 24G 派机器 ——
   * 吃显存的工作流在 24G 上跑不动时，报出来的是上游的显存不足，
   * 而用户在自己这一侧找不到任何能调的东西。
   *
   * ⚠️ 只在这一节点**真的走 RunningHub** 时才画出来：本机 ComfyUI 用的是用户自己的显卡，
   *    网关那两档（videoapi / custom）是别人家的机房 —— 都没有「租哪种机器」这回事。
   *    应用节点恒为云端（`engineProvider` 对它直接返回 runninghub），所以它也照常显示。
   * ⚠️ 默认那一档也照常列着，**不做**「只在非默认时才显示」那套：
   *    一个忽隐忽现的下拉，用户只会以为这功能时好时坏。
   */
  const instanceType = readInstanceType(data.instanceType);
  const instanceSelect = engineProvider === 'runninghub' ? (
    <select
      className={`cv-select sm cv-dock-eng cv-dock-instance${instanceType === 'default' ? '' : ' on'}`}
      data-dock-instance=""
      aria-label="运行规格"
      title={`跑在多大的机器上 —— ${instanceTypeHint(instanceType)}（只对 RunningHub 云端有效）`}
      value={instanceType}
      onChange={event => data.onField?.('instanceType', event.target.value)}
    >
      {INSTANCE_TYPE_OPTIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
  ) : null;

  /*
   * 选了「自定义接口」才出现的模型下拉。
   *
   * 值形如 `<providerId>::<modelId>`：**值里自带它属于哪条接口**，
   * 所以那条接口被删掉之后这里能明确报「这条接口已经不存在」，
   * 而不是留下一个谁也不认识的裸模型名。
   */
  const customModelValue = String(data.customModel || '');
  /** 选过、但现在已经不在清单里（那条接口被删了 / 那个模型被移除了）。 */
  const customModelStale = customModelValue && !customModels.some(item => item.value === customModelValue)
    ? customModelValue
    : '';
  const customModelSelect = engine === 'custom' ? (
    <select
      className="cv-select sm cv-dock-custom-model"
      data-dock-custom-model=""
      aria-label="自定义接口的模型"
      title="用这条接口上的哪个模型出"
      value={customModelValue}
      onChange={event => data.onField?.('customModel', event.target.value)}
    >
      <option value="">选一个模型</option>
      {customModelStale ? <option value={customModelStale}>{`${customModelStale} · 这一项已经不存在了`}</option> : null}
      {customModels.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
  ) : null;

  /*
   * 「优化提示词」：把一句话扩成一段能直接喂给生成模型的中文提示词。
   *
   * ⚠️ 它调的是**文本模型**（设置 · 模型服务 · 官方大语言模型那一栏），不生成任何媒体。
   * 一家文本模型都没配时，服务端会回一句指到那一页的话 —— 这里原样转给用户，
   * 别含糊成「优化失败」，否则用户会以为是这句话有问题。
   */
  const [optimizing, setOptimizing] = useState(false);
  async function optimizePrompt() {
    const raw = String(data.text || '').trim();
    if (!raw) { data.onNotice?.('先写一句话再优化。'); return; }
    setOptimizing(true);
    try {
      const result = await apiPost<{ optimizedPrompt: string }>('/api/prompt/optimize', {
        prompt: raw,
        /*
         * 节点上单独指定过就带上它；留空是整个 feature 的默认值（服务端读 `User.promptProvider`）。
         * ⚠️ 别把空串发出去再让服务端判断：那会把「节点没指定」和「用了自动」混成一个值，
         * 将来要区分「跟随设置变化」与「钉死在这一家」时就退不回来了。
         */
        ...(promptModelValue ? { provider: promptModelValue } : {}),
        /* 选了技能就带上：优化出来的提示词得是**那个技能**要的格式，不然选它干嘛。 */
        ...(promptSkillValue ? { skillId: promptSkillValue } : {}),
        /*
         * 走本地时这两档决定跑完卸不卸：`-1` = 一直装载（手动卸载），`0` = 写完立刻卸。
         * 云端那几家没有「装载」这回事，所以只在本地生效时才发 —— 发个 `keepAlive`
         * 给云端请求只会让后端多校验一次字段。
         */
        ...(localEffective ? { keepAlive: localLoadMode === 'keep' ? -1 : 0 } : {}),
      });
      data.onText?.(result.optimizedPrompt);
      data.onNotice?.(promptSkillValue ? '已按所选技能的写法改写提示词' : '已用文本模型改写提示词');
    } catch (error) {
      data.onNotice?.(error instanceof Error ? error.message : '提示词优化失败。');
    } finally {
      setOptimizing(false);
      /*
       * 优化这条路**也会把本地模型装起来**（尤其「一直装载」那一档，跑完还不卸）。
       * 不刷新状态行的话，界面上写着「未装载」而显存已经占着 —— 这一块存在的意义
       * 就是让人看得见装载状态，所以这里必须刷新。
       */
      if (localEffective) llmStatus.reload();
    }
  }

  /* ---------------- 弹层：比例（可视化格子） ---------------- */
  const ratioOptions: RatioOpt[] = isImage && engine === 'custom'
    ? IMAGE2_RATIOS.map(item => ({ value: item.value, label: item.label, w: item.w, h: item.h }))
    : engine === 'videoapi'
      ? VIDEO_API_RATIOS.map(item => {
        const [w, h] = item.value.split(':').map(Number);
        return { value: item.value, label: item.value, w: w || 1, h: h || 1 };
      })
      : ASPECT_RATIOS.map(item => {
        const m = item.match(/^(\d+):(\d+)/);
        return { value: item, label: item.split(' ')[0], w: m ? Number(m[1]) : 1, h: m ? Number(m[2]) : 1 };
      });
  const currentRatio = isImage && engine === 'custom'
    ? image2.ratio
    : engine === 'videoapi'
      ? String(videoApi?.aspectRatio || '')
      : String(data.aspectRatio || (isImage ? IMAGE_DEFAULTS.ratio : DEFAULT_RATIO));
  const setRatio = (value: string) => data.onField?.(
    isImage && engine === 'custom' ? 'image2Ratio' : engine === 'videoapi' ? 'videoApiRatio' : 'aspectRatio',
    value,
  );

  /**
   * 「点一下就把尺寸定下来」——分辨率那一栏里那个只读读数上的一下（2026-09-30）。
   *
   * 起因：徐先问「这里怎么选择不了 1k，2k，4k 的了」。查下来不是坏了 ——
   * 比例还是默认的**自适应**，而自适应时尺寸归上游，分辨率本来就不生效，
   * 所以那一栏摆的是读数不是下拉。可唯一的提示藏在 hover 的 `title` 里，
   * 不把鼠标悬上去根本看不见，人的结论自然就是「选不了」。
   *
   * 于是读数变成可点的动作：点它 = 「我要自己定尺寸」→
   * 先把比例从自适应换成 `IMAGE2_FIXED_RATIO`（1:1，最中性的一档），
   * 下拉当场就出来。同时把**比例那一栏**滚进视野并闪一下 ——
   * 用户下一步八成就是想换个画幅（1:1 只是先替他指一个），
   * 得让他一眼看到「画幅在这儿改」，而不是以为被锁死成方图了。
   */
  const ratioGroupRef = useRef<HTMLDivElement | null>(null);
  const [ratioFlash, setRatioFlash] = useState(false);
  const pickFixedRatio = () => {
    data.onField?.('image2Ratio', IMAGE2_FIXED_RATIO);
    setRatioFlash(true);
    window.setTimeout(() => setRatioFlash(false), 900);
    ratioGroupRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };

  const ratioGroup = (
    <div
      className={`cv-dock-group${ratioFlash ? ' cv-dock-flash' : ''}`}
      ref={ratioGroupRef}
      data-dock-ratio-group=""
    >
      <span className="cv-dock-grouplabel">比例</span>
      <div className="cv-dock-ratios" data-dock-ratio="" role="radiogroup" aria-label="画面比例">
        {ratioOptions.map(opt => {
          const on = opt.value === currentRatio;
          const box = ratioBoxSize(opt);
          return (
            <button
              key={opt.value}
              type="button"
              className={`cv-dock-ratio${on ? ' on' : ''}`}
              data-dock-ratio-opt={opt.value}
              aria-pressed={on}
              title={opt.label}
              onClick={() => setRatio(opt.value)}
            >
              <i style={{ width: box.bw, height: box.bh }} aria-hidden />
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  /* ---------------- 弹层：分辨率 ---------------- */
  /**
   * 分辨率那一档：
   * - 图片 + 自定义接口 → 1k / 2k 这些档位（与当年的 Image 2.0 同一套）；
   * - 图片 + 工作流 → MP（百万像素），它决定换算出来的实际宽高；
   * - 视频 + 网关 → 分辨率档位；视频 + 工作流 → MP。
   */
  const resolutionGroup = (
    <div className="cv-dock-group">
      <span className="cv-dock-grouplabel">分辨率</span>
      <div className="cv-dock-groupbody">
        {isImage && engine === 'custom' ? (
          image2.size === IMAGE2_SIZE_AUTO
            /*
             * 比例是「自适应」时**不摆那个下拉**（2026-09-29）。
             *
             * 摆着它也照样显示 4K，可这一次发出去的是「尺寸由接口决定」——
             * 用户看着自己选的 4K、拿到一张 1K 的图，整条事情就是这么来的。
             * 换成一行读数比一个点了没用的下拉诚实。
             *
             * ⚠️ 但**只给读数是不够的**（2026-09-30 徐先：「这里怎么选择不了 1k，2k，4k 的了」）：
             * 那句「想固定尺寸就在上面选一个比例」原来只在 hover 的 `title` 里，
             * 不悬上去看不见，人只会得出「选不了」。所以读数现在**可以点**
             * （见 `pickFixedRatio` 上的注释）：点一下就把比例定成一档具体画幅，
             * 下拉当场出来。`data-dock-resolution-auto` 这个钩子留着别删 ——
             * 旧探针靠它认这一态。
             */
            ? <button
              type="button"
              className="cv-dock-readout cv-dock-readout-action"
              data-dock-resolution-auto=""
              data-dock-resolution-fix=""
              title={`尺寸由接口自己决定（点一下：先把比例设为 ${IMAGE2_FIXED_RATIO}，就能选 1K / 2K / 4K 了）`}
              onClick={pickFixedRatio}
            >
              <span>{`跟随上游（${String(image2.resolution).toUpperCase()} 不生效）`}</span>
              <em>点这里固定尺寸</em>
            </button>
            : <select
              className="cv-select sm"
              data-dock-resolution=""
              aria-label="分辨率"
              title="长边对应的像素数，短边按比例算"
              value={image2.resolution}
              onChange={event => data.onField?.('image2Resolution', event.target.value)}
            >
              {IMAGE2_RESOLUTIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
        ) : engine === 'videoapi' ? (
          <select
            className="cv-select sm"
            data-dock-resolution=""
            aria-label="分辨率"
            value={String(videoApi?.resolution || '')}
            onChange={event => data.onField?.('videoApiResolution', event.target.value)}
          >
            {VIDEO_API_RESOLUTIONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        ) : (
          <label className="cv-dock-field">
            <input
              className="cv-input sm"
              data-dock-mp=""
              type="number"
              min={MIN_MEGAPIXELS}
              max={MAX_MEGAPIXELS}
              step="0.1"
              aria-label="分辨率（百万像素）"
              title="出图的总像素量（MP），和实际宽高一起决定最终尺寸"
              value={data.megapixels || (isImage ? IMAGE_DEFAULTS.megapixels : '0.2')}
              onChange={event => data.onField?.('megapixels', event.target.value)}
            />
            <span>MP</span>
          </label>
        )}
      </div>
    </div>
  );

  /**
   * 长宽：图片节点独有。
   *
   * `resolution` → 只读读数 + 一句「怎么算的」；
   * `custom` → 两个输入框，填错了当场说在哪（不让用户去猜为什么提交失败）。
   */
  const sizeGroup = !isImage ? null : (
    <div
      className="cv-dock-group"
      data-dock-size=""
      data-size-mode={sizeMode}
      title={sizeMode === 'custom'
        ? `手填的宽高会直接交给工作流（${MIN_CUSTOM_SIDE}–${MAX_CUSTOM_SIDE}，自动对齐到 16 的倍数）`
        : '长宽由「比例 + 分辨率」算出来，改比例或分辨率就跟着变'}
    >
      <span className="cv-dock-grouplabel">长宽</span>
      <div className="cv-dock-groupbody">
        <div className="cv-dock-sizemode" data-dock-sizemode-row="">
          {IMAGE_SIZE_MODES.map(item => (
            <button
              key={item.value}
              className={`cv-dock-chip${sizeMode === item.value ? ' on' : ''}`}
              type="button"
              data-dock-sizemode={item.value}
              aria-pressed={sizeMode === item.value}
              onClick={() => data.onField?.('sizeMode', item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {sizeMode === 'custom' ? (
          <div className="cv-dock-size-inputs">
            <input
              className="cv-input sm num"
              data-dock-w=""
              type="number"
              min={MIN_CUSTOM_SIDE}
              max={MAX_CUSTOM_SIDE}
              step="16"
              aria-label="宽（像素）"
              placeholder="宽"
              value={String(data.customWidth || '')}
              onChange={event => data.onField?.('customWidth', event.target.value)}
            />
            <span aria-hidden>×</span>
            <input
              className="cv-input sm num"
              data-dock-h=""
              type="number"
              min={MIN_CUSTOM_SIDE}
              max={MAX_CUSTOM_SIDE}
              step="16"
              aria-label="高（像素）"
              placeholder="高"
              value={String(data.customHeight || '')}
              onChange={event => data.onField?.('customHeight', event.target.value)}
            />
          </div>
        ) : (
          <b className="cv-dock-size-read" data-dock-size-read="">
            {resolved ? `${resolved.width} × ${resolved.height}` : '—'}
          </b>
        )}
      </div>
    </div>
  );

  /* ---------------- 弹层：生成时长（视频独有，滑杆 + 数字） ---------------- */
  const durationValue = engine === 'videoapi'
    ? String(videoApi?.duration ?? '5')
    : String(data.duration || '6');
  const setDuration = (value: string) => data.onField?.(
    engine === 'videoapi' ? 'videoApiDuration' : 'duration',
    value,
  );
  const durationGroup = !isImage && !audioOnly ? (
    <div className="cv-dock-group" data-dock-duration="">
      <span className="cv-dock-grouplabel">生成时长</span>
      <div className="cv-dock-duration">
        <input
          className="cv-dock-range nodrag"
          data-dock-duration-range=""
          type="range"
          min="1"
          max="30"
          step="1"
          aria-label="时长（滑杆）"
          value={durationValue}
          onChange={event => setDuration(event.target.value)}
        />
        <input
          className="cv-input sm num"
          type="number"
          min="1"
          max="30"
          aria-label="时长"
          value={durationValue}
          onChange={event => setDuration(event.target.value)}
        />
        <span className="cv-dock-grouphint">秒</span>
      </div>
    </div>
  ) : null;

  /* ---------------- 应用参数（RunningHub 应用自己的那一套） ---------------- */
  /*
   * 应用**不是**一份 ComfyUI 图，它自己早就把参数填好了（模式 / 时长 / 总像素 / 强度…）。
   * 所以节点上该显示的是它公开的那些字段，而不是画布那套比例 / 分辨率 / 时长 ——
   * 用户的原话是「应用已经把参数填好了，节点中只有映射这些参数就行了，然后选择修改」。
   *
   * 分两拨渲染，因为它们**来源不同**：
   *   - 能改的（`binding: 'manual'` 且不是媒体）→ 就地一个控件，改了就存一份**本节点的覆盖**；
   *   - 跟画布走的（提示词、参考图 N）→ 只报一句「跟画布提示词 / 参考图 N 张」。
   *     它们本来就该由画布给，这里再放一个输入框等于两份真相。
   */
  const appConfig = useApi<{ config: { fields: AppField[] } }>(
    isApp && data.workflowId ? `/api/workflows/${encodeURIComponent(String(data.workflowId))}/config` : null,
  );
  const appFields = (appConfig.data?.config?.fields || []).filter(field => field.enabled);
  const appEditable = appFields.filter(field => field.binding === 'manual'
    && !['image', 'video', 'audio', 'latent'].includes(field.kind));
  const appRows = (data.appRows || []) as ParamRow[];
  const appRowOf = (field: AppField) => appRows.find(
    item => item.nodeId === field.nodeId && item.fieldName === field.fieldName,
  );
  /** 显示值 = 本节点改过的值，没改过就用应用自己填的那个。 */
  const appValueOf = (field: AppField) => {
    const row = appRowOf(field);
    return row ? String(row.value ?? '') : field.value;
  };
  /**
   * 改一项应用参数。
   *
   * 值**回到配置里的默认值**（或清空）就把这一行删掉 —— `appRows` 只装「真改过的」，
   * 这样应用那份配置以后改了默认值，这个节点会跟着变，而不是被一份旧快照钉死。
   */
  const setAppValue = (field: AppField, value: string) => {
    const rest = appRows.filter(item => !(item.nodeId === field.nodeId && item.fieldName === field.fieldName));
    const next = value === field.value || !value.trim() ? rest : [...rest, {
      id: `${field.nodeId}.${field.fieldName}`.slice(0, 80),
      name: field.label.slice(0, 120),
      nodeId: field.nodeId,
      fieldName: field.fieldName,
      value,
      enabled: true,
    }];
    data.onAppRows?.(next);
  };
  /**
   * 选项的两种写法：SWITCH 那种是 `文戏=0`（`=` 前是给人看的、后是要填的值），
   * COMBO 那种（`1:1 (Square)`）整串就是值。取第一个 `=` 切开 —— 应用的比例 / 模型名里
   * 不带 `=`，`name=value` 的写法是我们自己拼的，不冲突。
   */
  const optionValue = (option: string) => {
    const at = option.indexOf('=');
    return at > 0 && at < option.length - 1 ? option.slice(at + 1) : option;
  };
  /**
   * 面板上的字段名。
   *
   * 配置页那边的 label 里**带着选项清单**（`aspect_ratio（可选：1:1 (Square) / …）`）——
   * 那一页只有一个纯文本输入框，不写出来用户就得去应用页面抄。但画布这里本来就是**下拉**，
   * 选项已经在眼前了，再来一段一样的内容只会把名字挤没（实测名字被截到只剩「aspect_ratio（可选：」）。
   *
   * ⚠️ 尾巴要一直削到**行尾**，不能要求它收在 `）` 上：选项多的字段（比例有 8 档）
   * label 早就被 `slice(0, 160)` 截断了，根本不带右括号 —— 只匹配完整的「（可选：…）」
   * 会在这种字段上原地不动（2026-09-26 实测就是这个名字最长的那一个漏了）。
   */
  const appFieldName = (field: AppField) => (field.options?.length
    ? field.label.replace(/（可选：[\s\S]*$/, '').trim()
    : field.label);
  /** 跟画布走的那几项：提示词 / 参考图。合成一句话报出来，不逐条占一行。 */
  const appCanvasCount = appFields.filter(field => /^reference_image_\d+$/.test(field.binding)).length;
  const appCanvasNote = [
    appFields.some(field => field.binding === 'prompt') ? '提示词' : '',
    appCanvasCount ? `参考图 ${appCanvasCount} 张` : '',
  ].filter(Boolean).join(' · ');
  const appPanel = (
    <div className="cv-dock-appparams" data-dock-appparams="">
      <div className="cv-dock-row">
        <span className="cv-dock-grouplabel">应用参数</span>
        <span className="cv-dock-hint">{appConfig.loading
          ? '正在读这个应用的参数…'
          : appFields.length
            ? '值来自应用自己 —— 在这里改只影响这一个节点'
            : '这个应用没有公开可调用的参数'}</span>
      </div>
      {appEditable.map(field => {
        const value = appValueOf(field);
        const changed = Boolean(appRowOf(field));
        /* 「已改」必须看得见：改过之后它和配置里那个值就不一样了，而界面上没有任何别的线索。 */
        const name = `${appFieldName(field)}${changed ? ' · 已改' : ''}`;
        return (
          <div className="cv-dock-appfield" key={field.key} data-dock-appfield={field.key}>
            <span className="cv-dock-applabel" title={`${field.nodeId}.${field.fieldName}`}>{name}</span>
            {field.options?.length ? (
              <select
                className="cv-select sm"
                data-dock-appselect=""
                aria-label={field.label}
                value={value}
                onChange={event => setAppValue(field, event.target.value)}
              >
                {/* 存着的值不在选项里（应用改过选项？）也要看得见，否则下拉会显示成第一项。 */}
                {field.options.every(option => optionValue(option) !== value) && (
                  <option value={value}>{value || '（空）'}</option>
                )}
                {field.options.map(option => (
                  <option key={option} value={optionValue(option)}>{option}</option>
                ))}
              </select>
            ) : (
              <input
                className="cv-input sm"
                data-dock-appinput=""
                aria-label={field.label}
                value={value}
                onChange={event => setAppValue(field, event.target.value)}
              />
            )}
          </div>
        );
      })}
      {appCanvasNote && <span className="cv-dock-hint" data-dock-appcanvas="">另外跟画布走：{appCanvasNote}</span>}
      {data.workflowId && (
        <div className="cv-dock-row">
          {/* 同「打开工作流配置」：开画布上的浮层，不跳设置页（2026-10-01）。 */}
          <button
            className="cv-btn sm ghost"
            type="button"
            data-dock-appcfg=""
            onClick={() => data.onOpenWorkflow?.(String(data.workflowId))}
          >
            打开应用配置
          </button>
        </div>
      )}
    </div>
  );

  /* ---------------- 摘要 chip 上的那串字 ---------------- */
  /*
   * 应用节点：摘要说的是**应用自己的参数**，不是画布的比例 / 时长。
   * 那两个数对应用没有任何意义 —— 应用的参数是它自己公开的那些字段，画布只给它提示词与参考图。
   * 以前这里照搬「6秒 · 16:9」，看到的就是「节点参数跟着工作流走」（2026-09-26 徐先的反馈），
   * 而提交时那两个数根本没进 `nodeInfoList`。
   */
  const summaryText = (
    /* 用数组包一层：下面统一 `.filter(Boolean).join(' · ')`，直接给字符串会被 TS 判成联合类型。 */
    isApp
      ? [appConfig.loading ? '读取应用参数…' : `${appEditable.length} 项应用参数`]
      : isImage
      ? engine === 'custom'
        ? [
          image2.ratio === 'auto' ? '自适应' : image2.ratio,
          image2.size === 'auto' ? '' : String(image2.resolution).toUpperCase(),
        ]
        : [
          String(data.aspectRatio || IMAGE_DEFAULTS.ratio).split(' ')[0],
          sizeMode === 'custom'
            ? (data.customWidth && data.customHeight ? `${data.customWidth}×${data.customHeight}` : '自定义长宽')
            : (resolved ? `${resolved.width}×${resolved.height}` : `${data.megapixels || IMAGE_DEFAULTS.megapixels}MP`),
        ]
      : engine === 'videoapi'
        ? [videoApi?.resolution, `${videoApi?.duration}秒`, videoApi?.aspectRatio]
        : audioOnly
          /* 音频没有画面可言：报「6 秒 · 16:9」等于在预告两个它根本不会带的参数。 */
          ? [generatorKindLabel('audio')]
          : [`${durationValue}秒`, String(data.aspectRatio || DEFAULT_RATIO).split(' ')[0]]
  ).filter(Boolean).join(' · ');

  /* ---------------- 自定义参数（展开区） ---------------- */
  const moreBox = !more ? null : (
    <div className="cv-dock-more" data-dock-more-panel="">
      {/*
        优化提示词用哪家文本模型 —— **节点级覆盖**全局设置。
        放在自定义参数的第一行：它跟「怎么生成」无关，跟「谁能动提示词」有关，
        搁在最上面是为了让用户一眼知道这一格是给别人（模型）看的，不是给生图参数看的。
      */}
      <div className="cv-dock-row">
        <label className="cv-dock-field wide">
          <span>优化提示词用</span>
          <select
            className="cv-select"
            data-dock-prompt-model=""
            aria-label="优化提示词用哪个文本模型"
            title="点底栏那颗星标按钮时，调哪个文本模型来改写这句话"
            value={promptModelValue}
            onChange={event => data.onField?.('promptModel', event.target.value)}
          >
            <option value="">{`自动（跟随设置 · ${resolvedLabel || '还没配置任何文本模型'}）`}</option>
            {missingPromptModel ? (
              <option value={promptModelValue}>{`${promptModelValue} · 这一项已经不存在了`}</option>
            ) : null}
            {promptModelItems.map(item => (
              <option key={item.value} value={item.value}>
                {item.configured ? item.label : `${item.label} · 未配置`}
              </option>
            ))}
          </select>
        </label>
        {missingPromptModel || promptModelValue ? (
          <span className="cv-dock-hint">{missingPromptModel
            ? '这个值指向的文本模型已经不在选项里了，会直接报错 —— 回到「自动」或换一个即可'
            : '只影响这一个节点'}</span>
        ) : null}
      </div>
      {/*
        本地模型装卸方式（2026-09-26，徐先要的两档）。

        **只在这一节点真的会用本地模型时才画出来**：选的是云端那几家的话，
        「装载 / 卸载」根本不存在，摆在这儿只会让人以为云端也要先装一遍。

        两档互斥、手感跟旁边的 chip 一致（选中态也是 `.cv-dock-chip.on`）。
      */}
      {localEffective ? (
        <>
          <div className="cv-dock-row" data-dock-local-mode-row="">
            <div className="cv-dock-field wide">
              <span>本地模型</span>
              <div className="cv-dock-local-modes" role="radiogroup" aria-label="本地模型装卸方式">
                <button
                  type="button"
                  className={`cv-dock-chip${localLoadMode === 'keep' ? ' on' : ''}`}
                  data-dock-local-mode="keep"
                  aria-pressed={localLoadMode === 'keep'}
                  title="第一次优化时装进显存，之后一直留着，直到你手动卸载"
                  onClick={() => data.onField?.('promptLocalLoad', 'keep')}
                >一直装载（手动卸载）</button>
                <button
                  type="button"
                  className={`cv-dock-chip${localLoadMode === 'auto' ? ' on' : ''}`}
                  data-dock-local-mode="auto"
                  aria-pressed={localLoadMode === 'auto'}
                  title="每次优化时装进来，写完立刻卸载"
                  onClick={() => data.onField?.('promptLocalLoad', 'auto')}
                >优化后自动装卸</button>
              </div>
            </div>
            <span className="cv-dock-hint" data-dock-local-mode-hint="">{localLoadMode === 'keep'
              ? '装一次就一直留着：后面再点星标是秒开，同一个节点连着改几次最划算。不用了点下面「卸载」把显存还回去（关掉应用也会自动放掉）'
              : '每次点星标时装进来、写完立刻卸载，显存一次都不多占；代价是每次都要等装载，大模型第一次可能要几十秒'}</span>
          </div>
          {/*
            手动装载 / 卸载那一排**只给「一直装载」这一档**。
            选了自动装卸还给一颗「装载」是矛盾的：装完第一次优化就给你卸了。
          */}
          {localLoadMode === 'keep' ? (
            <div className="cv-dock-row" data-dock-local-load-row="">
              <span className="cv-dock-local-state" data-dock-local-state={llmRunning ? 'on' : 'off'}>
                {llmStatus.loading
                  ? '本地模型状态读取中…'
                  : llmRunning
                    ? `已装载${llmModelName ? ` · ${llmModelName}` : ''}`
                    : '未装载'}
              </span>
              <button
                type="button"
                className="cv-btn sm"
                data-dock-local-toggle=""
                disabled={localBusy}
                title={llmRunning
                  ? '立刻卸载本地模型，把显存还回去'
                  : '按「设置 · 模型服务 · 本地模型」里选的模型和运行时装载'}
                onClick={toggleLocalModel}
              >{localBusy ? (llmRunning ? '卸载中…' : '装载中…') : llmRunning ? '卸载' : '装载'}</button>
              <span className="cv-dock-hint">
                装的是设置里选的那份（换模型去设置页）；关掉 Holy Light画布会自动放掉，下次打开要重新装载
              </span>
            </div>
          ) : null}
        </>
      ) : null}
      {/*
        优化提示词照哪个技能写。
        一个都没标过就整行不渲染 —— 一个只有「不指定」的下拉只会让人以为这功能坏了。
      */}
      {optimizeSkills.length ? (
        <div className="cv-dock-row">
          <label className="cv-dock-field wide">
            <span>优化时照</span>
            <select
              className="cv-select"
              data-dock-prompt-skill=""
              aria-label="优化提示词时遵循哪个技能"
              title="点底栏那颗星标按钮时，按这个技能的写法来改写这句话"
              value={promptSkillValue}
              onChange={event => data.onField?.('promptSkill', event.target.value)}
            >
              <option value="">不指定（只按通用写法扩写）</option>
              {optimizeSkills.map(item => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {/*
        工作流选择：只在「还要走工作流」的那一档出现。网关那两档不经过工作流，
        把下拉留着会指向一个它根本不读的值（用户会以为自己换了工作流）。

        「超清工作流」在 2026-10-02 先是单开了一行（徐先：「新加一条，选择超清工作流的一列，
        与选择工作流并列」），同一天又一句「工作流和超清工作流两个并排」把「并列」落成了
        字面意思：**两个下拉各占一半、同处一行**。理由跟当初一样 —— 它俩说的是同一个节点上的
        两份工作流（这份跑生成、那份跑超清），一上一下叠着会被读成两段无关的设置。

        ⚠️ 三条顺序上的约束，动这一块之前先看一眼：
          - 两个 `<label>` 必须**挨在一起**排在最前 —— `.cv-dock-row` 是 `flex-wrap`，
            先排的先把第一行占满，两个 `.half` 正好一行；
          - 说明文字（`.cv-dock-hint`）与「打开工作流配置」排在两个下拉**之后**，
            它们自然折到第二行，跟改版前一模一样；
          - 「接续」带 `margin-left: auto`（靠右站），所以它必须是**最后一个** ——
            排在它后面的东西会被一起推到右边去。
        ⚠️ `.half` 只在两个都在时加（见 `pairWorkflows`）。
      */}
      {(!isGateway || (upscalePurpose && !isApp)) && (
        <div className="cv-dock-row">
          {!isGateway && (
            <label className={`cv-dock-field ${pairWorkflows ? 'half' : 'wide'}`}>
              <span>{isApp ? '应用' : '工作流'}</span>
              <DockCombo
                hook="workflow"
                ariaLabel="工作流"
                value={String(data.workflowId || '')}
                items={wfItems}
                groups={wfGroups}
                missingLabel={appOnGenerateNode
                  ? `${String(data.workflowId)} · RunningHub 应用（不在「工作流」列表里）`
                  : (!chosenWorkflow && data.workflowId ? `${String(data.workflowId)} · 未保存配置` : null)}
                placeholder="— 输入名字或编号，自动找工作流 —"
                action={{ label: '＋ 从工作流库中选择…', onPick: () => data.onPickWorkflow?.() }}
                emptyHint={`没有名字或编号里含这段字的${generatorKindLabel(purpose)}工作流 —— 换个短一点的关键词，或点上面那颗「从工作流库中选择…」`}
                onChange={next => data.onField?.('workflowId', next)}
              />
            </label>
          )}

          {upscalePurpose && !isApp && (
            <label className={`cv-dock-field ${pairWorkflows ? 'half' : 'wide'}`}>
              <span>超清工作流</span>
              <DockCombo
                hook="upscale-workflow"
                ariaLabel="超清工作流"
                value={upscaleChosen}
                items={upItems}
                missingLabel={upscaleChoiceStale ? `${upscaleChosen} · 这份不在候选里` : null}
                placeholder="自动（最近改过的那份）"
                emptyHint={`没有名字或编号里含这段字的${generatorKindLabel(upscalePurpose)}超清工作流`}
                onChange={next => data.onField?.('upscaleWorkflowId', next)}
              />
            </label>
          )}

          {!isGateway && (
            <>
              <span className="cv-dock-hint">{isApp
                ? (chosenWorkflow
                  ? `RunningHub 应用 · ${chosenWorkflow.enabledCount} / ${chosenWorkflow.totalCount} 项启用`
                  : '还没有导入过 RunningHub 应用 —— 到「设置 · 工作流库」的「RunningHub 应用」那一档，填应用 ID（或粘详情页链接）导入一个')
                : chosenWorkflow
                ? `${appOnGenerateNode ? 'RunningHub 应用' : chosenWorkflow.provider === 'local' ? '本地 ComfyUI' : 'RunningHub（云端）'} · ${chosenWorkflow.enabledCount} / ${chosenWorkflow.totalCount} 项启用`
                : listedWorkflows.length
                  ? `先选一个工作流（这里只列${generatorKindLabel(purpose)}生成用、且属于「${engineProvider === 'local' ? '本地 ComfyUI' : 'RunningHub'}」的已保存配置）`
                  : otherSourceCount
                    ? `${generatorKindLabel(purpose)}工作流存了 ${otherSourceCount} 份，但都属于「${engineProvider === 'local' ? 'RunningHub（云端）' : '本机 ComfyUI'}」—— 把上面「引擎」切到那一档就选得到`
                    : appPurposeCount
                      ? `${generatorKindLabel(purpose)}应用倒是有 ${appPurposeCount} 份，但这个下拉只列工作流 —— 应用请用「RunningHub 应用」节点；要在这个节点上跑，先到设置页存一份${generatorKindLabel(purpose)}工作流`
                      : engineProvider === 'local'
                      ? `还没有保存过本机 ComfyUI 的${generatorKindLabel(purpose)}工作流 —— 到「设置 · 工作流」的「本机 ComfyUI」那一档，把 ComfyUI「导出（API）」的 JSON 贴进去就有了`
                      : `还没有保存过${generatorKindLabel(purpose)}工作流配置，先到设置页保存一份`}</span>
              {chosenWorkflow && chosenWorkflow.kind !== purpose && (
                <span className="cv-dock-hint warn">{workflowMismatchHint(purpose, chosenWorkflow)}</span>
              )}
              {chosenWorkflow && isRunningHubAppWorkflowId(chosenWorkflow.workflowId) && !isApp && (
                <span className="cv-dock-hint warn">{`这份「${workflowDisplayName(chosenWorkflow)}」是 RunningHub 应用，不是工作流 —— 「工作流」下拉里不再列应用。它还能跑，但应用该用「RunningHub 应用」节点（那份节点的卡片上就能直接改应用参数）。要在这个节点上继续用，从上面的下拉里换一份工作流。`}</span>
              )}
              {chosenWorkflow && (
                /*
                 * 「打开工作流配置」原地开浮层，不跳页（2026-10-01 徐先）。
                 * 原来这里是 `<a href="#/settings/providers/workflows?id=…">` —— 桌面版是
                 * **单窗口 hash 路由**，点一下整张画布就没了；他改的只是这一份工作流的字段绑定，
                 * 却要重新找路回来。现在交给画布：开工作流浮层、直接落在这一份，关掉即回画布。
                 */
                <button
                  className="cv-btn sm ghost"
                  type="button"
                  data-dock-wfcfg=""
                  onClick={() => data.onOpenWorkflow?.(String(chosenWorkflow.workflowId))}
                >
                  打开工作流配置
                </button>
              )}
            </>
          )}

          {/*
            超清那一份的说明。三种状态分开写，**不要把一个空 span 也渲染出来** ——
            `.cv-dock-row` 有 `gap: 10px`，一个空 span 照样占掉一格 10px 的空隙。
            （原来是「有候选但算不出目标时渲染一个空 span」，顺手收掉。）
          */}
          {upscalePurpose && !isApp && (upscaleChoiceStale ? (
            <span className="cv-dock-hint warn" data-dock-upscale-workflow-stale="">
              点名的那份超清工作流不在了（删了？还是改了工序 / 来源？）—— 现在按「自动」走
            </span>
          ) : upscaleTarget ? (
            <span className="cv-dock-hint">
              {`${generatorKindLabel(upscalePurpose)}超清 · 这次会用「${workflowDisplayName(upscaleTarget)}」`}
            </span>
          ) : !upscaleOptions.length ? (
            <span className="cv-dock-hint">
              还没有可用的{generatorKindLabel(upscalePurpose)}超清工作流 —— 到「设置 · 工作流」新建一份，把「工序」改成「超清」
            </span>
          ) : null)}

          {/*
            接续（2026-10-01 徐先）：原来是一颗「独立生成 / 接续上一段」的复选框，
            沉在下面单独占一行。现在只叫「接续」、做成胶囊、靠右挤进这一行 ——
            它和左边那句「这份工作流跑到哪、多少项启用」说的是同一件事（这一段接不接上一段），
            拆成两行只会让人以为两个设置没关系。亮着 = 接续上一段，暗着 = 独立生成。
            ⚠️ 两个前提：`!isImage`（图片节点不吃 latent）、以及它待的**这一整行本来就是 `!isGateway`**。
            后者顺带收掉一个死控件 —— `custom`（自定义接口）以前也画这颗开关，
            可 `CanvasEditor` 的 custom 分支压根不读 `continuationEnabled`，点了没用。
            ⚠️ 它带 `margin-left: auto`，**必须排在这一行最后一个**（排在它后面的会被推到右边去）。
          */}
          {!isGateway && !isImage && !audioOnly && (
            <button
              type="button"
              className={`cv-dock-chip cv-dock-cont${continuationOn ? ' on' : ''}`}
              data-dock-continuation=""
              aria-pressed={continuationOn}
              title={continuationOn
                ? '接着上一段的 latent 继续跑，画面与上一段连贯；再点一下改回独立生成'
                : '不接上一段，按提示词单独出这一段；再点一下改成接着上一段跑'}
              onClick={() => data.onField?.('continuationEnabled', continuationOn ? 'off' : 'on')}
            >接续</button>
          )}
        </div>
      )}

      {/* 图片：负向提示词按用户要求挪到自定义里 —— 它不是每次都要写的东西。 */}
      {isImage && !isGateway && (
        <div className="cv-dock-row">
          <label className="cv-dock-field wide">
            <span>负向提示词</span>
            <textarea
              className="cv-param-input neg"
              data-dock-negative=""
              aria-label="负向提示词"
              placeholder="不想出现的内容（可留空）"
              value={String(data.negativePrompt || '')}
              onChange={event => data.onField?.('negativePrompt', event.target.value)}
            />
          </label>
        </div>
      )}

      {/* 图片 + 工作流：采样那一组。不经过工作流那两档没有这些概念，留着只会让人以为生效了。 */}
      {isImage && !isGateway && (
        <div className="cv-dock-grid">
          <label className="cv-dock-field">
            <span>张数</span>
            <input className="cv-input sm num" type="number" min="1" max={MAX_BATCH} aria-label="张数"
              value={data.batchSize || IMAGE_DEFAULTS.batchSize}
              onChange={event => data.onField?.('batchSize', event.target.value)} />
          </label>
          <label className="cv-dock-field">
            <span>步数</span>
            <input className="cv-input sm num" type="number" min="1" max={MAX_STEPS} aria-label="步数"
              value={data.steps || IMAGE_DEFAULTS.steps}
              onChange={event => data.onField?.('steps', event.target.value)} />
          </label>
          <label className="cv-dock-field">
            <span>CFG</span>
            <input className="cv-input sm num" type="number" min="1" max={MAX_CFG} step="0.5" aria-label="CFG"
              value={data.cfg || IMAGE_DEFAULTS.cfg}
              onChange={event => data.onField?.('cfg', event.target.value)} />
          </label>
          <label className="cv-dock-field">
            <span>种子</span>
            <input className="cv-input sm num" type="number" min="-1" title="-1 表示每次随机" aria-label="种子"
              value={data.seed ?? IMAGE_DEFAULTS.seed}
              onChange={event => data.onField?.('seed', event.target.value)} />
          </label>
          <label className="cv-dock-field wide">
            <span>采样器</span>
            <select className="cv-select sm" aria-label="采样器"
              value={data.sampler || ''}
              onChange={event => data.onField?.('sampler', event.target.value)}>
              {SAMPLERS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
        </div>
      )}

      {/* 视频：网关的模型名。时长已经升进摘要弹层（每次都要动的东西不上这层）。
        接续开关**不在这一块**了 —— 2026-10-01 挪进上面那行工作流里（理由见那边的注释）。 */}
      {!isImage && engine === 'videoapi' && (
        <div className="cv-dock-grid">
          <label className="cv-dock-field">
            <span>模型</span>
            <input className="cv-input sm" placeholder="留空用 .env 里配的" aria-label="模型"
              title="留空则不发 model 字段，由网关用它自己的默认模型"
              value={String(data.videoApiModel || '')}
              onChange={event => data.onField?.('videoApiModel', event.target.value)} />
          </label>
        </div>
      )}

      {/* 参考图：这是「接了什么进来」的唯一答案，不能省。 */}
      <div className="cv-dock-row">
        <span className="cv-dock-hint">{isImage
          ? `${data.referenceCount || 0}/9 图 · 已连 ${slots.length} 个输入${data.paramCount ? ` · 自定义 ${data.paramCount} 行` : ''}`
          : `${data.referenceCount || 0}/9 图 · 接续 ${data.latentCount || 0}/2${data.paramCount ? ` · 自定义 ${data.paramCount} 行` : ''}${slots.length ? ` · 已连 ${slots.length} 个输入` : ''}`}</span>
        <button className="cv-btn sm ghost" type="button" onClick={pasteFromClipboard}>粘贴图片</button>
        {resultImage && <button className="cv-btn sm ghost" type="button" onClick={() => data.onPreview?.(resultImage)}>预览</button>}
        {resultUrl && !resultImage && <button className="cv-btn sm ghost" type="button" onClick={() => data.onPreview?.(resultUrl)}>预览</button>}
      </div>
    </div>
  );

  /* ---------------- 顶部：已接进来的图 ---------------- */
  const slotRow: ReactNode = (slots.length || data.onPasteImages) ? (
    <div className="cv-dock-slots nodrag nowheel">
      {slots.map(slot => (
        <div
          key={slot.id}
          className={`cv-slot ${slot.skipped ? 'skipped' : slot.ready ? 'ready' : 'pending'}`}
          title={`${slot.title}${slot.note ? ` · ${slot.note}` : ''}`}
        >
          {(slot.kind === 'image' || slot.kind === 'video-input' || slot.kind === 'frame-extract') && slot.thumb
            ? <img src={slot.thumb} alt={slot.title} onClick={() => slot.previewable && data.onPreview?.(String(slot.thumb))} />
            : <span className="cv-slot-code">{slot.thumb || slot.title.slice(0, 2)}</span>}
          <span className="cv-slot-note">{slot.kind === 'workflow' && slot.thumb ? slot.thumb.slice(-8) : slot.note}</span>
        </div>
      ))}
      {data.onPasteImages && (
        <label className="cv-slot-add" title="添加参考图（也可以选中节点后直接 Ctrl+V 粘贴）">
          <Plus size={16} strokeWidth={1.8} aria-hidden />
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={event => {
              const files = Array.from(event.target.files || []).filter(file => file.type.startsWith('image/'));
              event.target.value = '';
              if (files.length) data.onPasteImages?.(files);
            }}
          />
        </label>
      )}
    </div>
  ) : null;

  /* ---------------- 参数弹层（摘要 chip 点开） ---------------- */
  /*
   * 应用节点上这个弹层装的是**应用自己的参数**：比例 / 分辨率 / 时长那三档对应用不成立 ——
   * 它们不是应用的字段，提交时也不会进 `nodeInfoList`，摆在那儿只会让人以为改了有用。
   */
  const settingsPop = !pop ? null : (
    <div className="cv-dock-pop" data-dock-pop="">
      {isApp && appPanel}
      {!isApp && !audioOnly && ratioGroup}
      {!isApp && !audioOnly && resolutionGroup}
      {!isApp && sizeGroup}
      {!isApp && durationGroup}
      {/*
        这一行只在「填错了」时出现。静默失败是这个项目最忌讳的事：
        长宽填了一个 6，界面什么都不说、提交出去服务端才报错，用户只会看到「生成失败」。
      */}
      {sizeIssue && <span className="cv-dock-hint warn" data-dock-size-issue="">{sizeIssue}</span>}
    </div>
  );

  /*
   * 「超清」胶囊的弹层：触发 + 来源两行。
   *
   * 为什么是**两个各选一个**而不是一个四选一的下拉：「什么时候跑」和「用哪一份」是两件事，
   * 挤成一列的话「手动 + 本地」这种组合就没地方放了。
   */
  const upscalePop = !upPop || !upscalePurpose ? null : (
    <div className="cv-dock-pop" data-dock-upscale-pop="">
      <div className="cv-dock-row">
        <div className="cv-dock-field wide">
          <span>触发</span>
          <div className="cv-dock-upscale-modes" role="radiogroup" aria-label="超清触发方式">
            {UPSCALE_MODES.map(mode => (
              <button
                key={mode}
                type="button"
                className={`cv-dock-chip${upscaleMode === mode ? ' on' : ''}`}
                data-dock-upscale-mode={mode}
                aria-pressed={upscaleMode === mode}
                onClick={() => data.onField?.('upscaleMode', mode as UpscaleMode)}
              >
                {UPSCALE_MODE_LABELS[mode]}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="cv-dock-row">
        <div className="cv-dock-field wide">
          <span>来源</span>
          <div className="cv-dock-upscale-modes" role="radiogroup" aria-label="超清工作流来源">
            {UPSCALE_SOURCES.map(item => (
              <button
                key={item}
                type="button"
                className={`cv-dock-chip${upscaleSource === item ? ' on' : ''}`}
                data-dock-upscale-source={item}
                aria-pressed={upscaleSource === item}
                onClick={() => data.onField?.('upscaleSource', item as UpscaleSource)}
              >
                {UPSCALE_SOURCE_LABELS[item]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {/*
        选了「自动 / 手动」却找不到对应的那份时，在这里就把话说完：
        否则用户配好了触发方式，画布上什么都没有，只能猜是没生效还是没配好。
      */}
      {upscaleMode !== 'off' && !upscaleTarget && (
        <span className="cv-dock-hint warn" data-dock-upscale-missing="">
          {upscaleSource === 'follow'
            ? `这一档还没有${generatorKindLabel(upscalePurpose)}超清工作流`
            : `还没有${UPSCALE_SOURCE_LABELS[upscaleSource]} 的${generatorKindLabel(upscalePurpose)}超清工作流`}
          {' —— 到「设置 · 工作流」新建一份，把「工序」改成「超清」。'}
        </span>
      )}
    </div>
  );

  return (
    <div
      className="cv-dock nodrag"
      data-dock=""
      data-kind={kind}
      /* 探针要能一眼看出它是「挂在节点下方」还是「没有节点、退回 CSS 兜底位置」：
         单看坐标分不出「照着节点算的」和「碰巧算对了」。
         ⚠️ 2026-10-02 起不会再有 `above` —— 翻到节点上方那一支已删。 */
      data-dock-anchor={anchor ? 'below' : 'fixed'}
      data-dock-node={nodeId || ''}
      style={anchor
        ? {
          left: anchor.left,
          top: anchor.top,
          width: anchor.width,
          maxHeight: anchor.maxHeight,
        }
        : undefined}
    >
      {/*
        滚动区和操作排是**两个兄弟**，不再是「整块自己滚 + 操作排 sticky」：
        参数弹层要绝对定位在操作排上沿、往上浮（高出面板本体），它不能待在
        一个 overflow:auto 的容器里 —— 会被裁掉。所以面板本体只负责摆位置，
        滚动全交给里面的 `.cv-dock-scroll`。
      */}
      <div className="cv-dock-scroll">
        {slotRow}
        <textarea
          className="cv-dock-input nodrag nowheel"
          data-dock-prompt=""
          aria-label="提示词"
          placeholder="描述你想要生成的内容"
          value={String(data.text || '')}
          onChange={event => data.onText?.(event.target.value)}
        />
        {/*
          这一排现在只放「自定义接口的模型」下拉 —— 「优化提示词」挪去了操作排。

          原来它俩并排躺在提示词下面，问题是：优化**不是这句提示词的属性**，它是一次动作，
          和「发送」同级。混在提示词下面会读成「开/关」第二语义（像参考产品那个 use_pre_llm
          开关），可是我们这个是一次性的改写 —— 图标常亮会让用户以为提示词已经被优化过了。
          所以只有当它真的存在时才占一行，平时不空出一条。
        */}
        {customModelSelect ? (
          <div className="cv-dock-promptbar" data-dock-promptbar="">
            {customModelSelect}
            {/*
              下拉里除了占位项什么都没有时，必须说出来**为什么**：
              光一个「选一个模型」的下拉，用户只会以为这个功能坏了（或者以为点了会自己挑一个）。
            */}
            {custom.error && (
              <span className="cv-dock-hint warn" data-dock-custom-error="">
                自定义接口的清单没读出来（{custom.error}）—— 正在自动重试，已经选好的模型不用动
              </span>
            )}
            {!customModels.length && !custom.error && (
              <span className="cv-dock-hint warn" data-dock-custom-empty="">
                这一档要指定「用哪条自定义接口的哪个模型」，但现在一个能出{isImage ? '图' : '片'}的自定义模型都没有 —— 到「设置 · 模型服务 · 自定义接口」加一条，或者把引擎换回上面那几档
              </span>
            )}
            {customModelStale && (
              <span className="cv-dock-hint warn" data-dock-custom-stale="">
                选的那个模型已经不在清单里了（那条接口被删了？）—— 换一个
              </span>
            )}
          </div>
        ) : null}
        {moreBox}
      </div>

      <div className="cv-dock-bar nodrag nowheel">
        {/* 应用节点没有「引擎」这一说 —— 它只有云端一条路，摆一个下拉只会让人选到跑不通的那档。 */}
        {!isApp && engineSelect}
        {/* 应用节点没有「引擎」这一说，但**有规格** —— 它也是跑在 RunningHub 上的。 */}
        {instanceSelect}
        <button
          className={`cv-dock-chip cv-dock-summary${pop ? ' on' : ''}`}
          type="button"
          data-dock-summary=""
          aria-expanded={pop}
          title={isApp
            ? '这个 RunningHub 应用自己的参数 —— 点开可以改（只影响本节点）'
            : isImage ? '比例 · 分辨率 · 长宽' : '比例 · 分辨率 · 时长'}
          onClick={() => { setPop(value => !value); setUpPop(false); }}
        >
          <span className="cv-dock-summary-text">{summaryText || '—'}</span>
          <ChevronDown size={12} strokeWidth={2} className={pop ? 'flip' : ''} aria-hidden />
        </button>
        {/*
          「超清」胶囊（2026-10-02 徐先）：点开是「触发 + 来源」两行，长相跟左边那颗
          参数摘要一致（文字 + 下拉符号）—— 一排胶囊里混进一个形状不同的，扫一眼就读不出来。
          名字只有一个「超清」，后缀是**当前档位**，不靠换名字表示开关。
        */}
        {upscalePurpose && (
          <button
            className={`cv-dock-chip cv-dock-upscale${upPop ? ' on' : ''}`}
            type="button"
            data-dock-upscale=""
            aria-expanded={upPop}
            title={upscaleMode === 'off'
              ? '关着 —— 点开可以改成「生成好后自动超清」或「出结果后手动点」'
              : `超清：${UPSCALE_MODE_LABELS[upscaleMode]}（${upscaleSource === 'follow' ? '跟随节点的引擎' : UPSCALE_SOURCE_LABELS[upscaleSource]}）`}
            onClick={() => { setUpPop(value => !value); setPop(false); }}
          >
            <span className="cv-dock-summary-text">
              {upscaleMode === 'off' ? '超清' : `超清 · ${UPSCALE_MODE_LABELS[upscaleMode]}`}
            </span>
            <ChevronDown size={12} strokeWidth={2} className={upPop ? 'flip' : ''} aria-hidden />
          </button>
        )}
        <button
          className={`cv-dock-chip cv-dock-morebtn${more ? ' on' : ''}`}
          type="button"
          data-dock-more=""
          aria-expanded={more}
          title="自定义参数（工作流、负向提示词、张数 / 步数 / CFG / 种子 / 采样器）"
          onClick={() => setMore(value => !value)}
        >
          <SlidersHorizontal size={13} strokeWidth={1.9} aria-hidden />
        </button>
        <span className="cv-dock-spacer" />
        {/*
          这一排**不写状态文字**（2026-10-02 徐先：「这里不要显示文字」）。

          原来这里挂着一句 `data.result`（「生成完成」/「这一轮被放弃了 —— 已按失败处理。」这种），
          两个问题：
          ① **跟节点卡片上那条重复** —— 卡片本来就有一整条 `.cv-node-status`，同一句话在一屏里
             说两遍，工具栏那一条反而把「这一排是控件」这件事读乱了；
          ② 它最宽能到 160px（`.cv-dock-status` 的 `max-width`），是这一排**唯一会变的宽度** ——
             正因为它在，放弃那一句会把「优化 / 发送」挤到第二行去（2026-10-02 的截图就是这个）。
          去掉之后这一排宽度是**固定**的，多少条都只受引擎名长短影响。

          ⚠️ 别搬回来。要报进度/结果，位置在**节点卡片自己身上**（`.cv-node-status`）；
          真要在这里表达「在跑」，发送钮那颗已经会变成转圈（`running` 那支 `Loader`），
          旁边还有「放弃」。
        */}
        {/*
          「优化提示词」图标钮 —— 目标位置是操作排最右那一簇（参考图：… 参数图标 / ✦ / 发送）。
          放在发送钮左边是因为它俩同属「对提示词做点什么」的动作组；挨着发送，手不用挪。
          做成**纯图标**是为了不跟左边的引擎 chip 抢读序：那边的胶囊都在描述「用什么出」，
          这里开始是「做什么」。
          ⚠️ `data-dock-optimize` 钩子必须留着 —— 探针靠它点。
        */}
        <button
          className={`cv-dock-optbtn${optimizing ? ' on' : ''}`}
          type="button"
          data-dock-optimize=""
          aria-label="优化提示词"
          onClick={optimizePrompt}
          disabled={optimizing}
          title="优化提示词：用文本模型把这句话改写成一段能直接生成的提示词（设置 · 模型服务里配的那家）"
        >
          {/*
            图标尺寸跟着 CSS 里那个 `--cv-dock-ctl` 走（现在是 22）：
            钮再往下缩时，这串数字也得跟着缩（16 的图标塞进 20 高的钮就顶到边）。改那个变量时这里也得跟着改 ——
            图标是写死在 TSX 里的，CSS 变量管不到它。
          */}
          {optimizing
            ? <Loader size={13} strokeWidth={2.2} className="cv-spin" aria-hidden />
            : <Sparkles size={14} strokeWidth={1.8} aria-hidden />}
        </button>
        {/*
          「放弃这一轮」（2026-09-29）：只在运行中露出。
          以前卡住的任务只能干等 —— 发送钮是灰的，界面上也没处说「我不等了」。
          ⚠️ `data-dock-abandon` 钩子必须留着 —— 探针靠它点。
          ⚠️ 别在这里提「退积分」：工作流那一路花的是用户自己账号的钱，我们没扣过 ——
             说了一句没发生的事，比什么都不说更糟。
        */}
        {running && (
          <button
            className="cv-dock-abandon"
            type="button"
            data-dock-abandon=""
            onClick={() => data.onAbandon?.()}
            title="放弃这一轮：不再等它，这次按失败处理"
          >
            放弃
          </button>
        )}
        <button
          className="cv-dock-send"
          type="button"
          data-dock-run=""
          onClick={data.onGenerate}
          disabled={running}
          title="生成"
          aria-label="生成"
        >
          {running ? <Loader size={14} strokeWidth={2.2} className="cv-spin" aria-hidden /> : <ArrowUp size={15} strokeWidth={2.4} aria-hidden />}
        </button>
      </div>

      {settingsPop}
      {upscalePop}
    </div>
  );
}

/** 给探针用：面板上这一档当前是「按分辨率」还是「自定义长宽」。 */
export function dockSizeMode(data: NodeData) {
  return readImageSizeMode(data.sizeMode);
}

/** 给探针 / 单测用：这个节点实际会提交多大多小。 */
export function dockResolvedSize(data: NodeData) {
  return resolveImageSize(data);
}

export { deriveImageSize };
