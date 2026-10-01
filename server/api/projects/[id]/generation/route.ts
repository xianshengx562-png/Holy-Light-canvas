import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { chargeWallet, costPerGenerationFen, isUnlimited, refundGeneration } from '@/lib/wallet';
import { db } from '@/lib/db';
import { submitWorkflow, uploadMedia, type RunningHubResponse } from '@/lib/providers/runninghub/client';
import { submitWebApp } from '@/lib/providers/runninghub/webapp';
import { isRunningHubAppWorkflowId, webAppIdOf } from '@/lib/workflows/runninghubApp';
import { resolveRunningHub, type KeySource } from '@/lib/providers/runninghub/connection';
import { isDesktop } from '@/lib/edition';
import { readLocalCredentials } from '@/lib/providers/local/connection';
import { applyNodeInfoList, type LocalGraph } from '@/lib/providers/local/graph';
import { submitLocalPrompt, uploadLocalMedia } from '@/lib/providers/local/client';
import { watchLocalProgress } from '@/lib/providers/local/progress';
import { latentAssetPrefix, readLatentFile } from '@/lib/latents';
import {
  applyDefaultBindings, appendLatentEntries, applyLatentNodeIds, configurationSchema, consumedCanvasBindings,
  MAX_AUDIO_INPUTS, MAX_REFERENCE_IMAGES, MAX_VIDEO_INPUTS,
  mergeParamRows, paramRowSchema, toNodeInfoList,
  type CanvasBindingValues, type Configuration, type LatentNodeIds,
} from '@/lib/workflows/configuration';
import { validateImageParams, validateOutputSize } from '@/lib/workflows/imageParams';
import { readWorkflowProvider, workflowIdError } from '@/lib/workflows/local';
import { readWorkflowName } from '@/lib/workflows/label';
import { GENERATOR_KINDS, generatorKindNoun, readGeneratorKind } from '@/lib/workflows/purpose';
import { readWorkflowOperation, WORKFLOW_OPERATIONS, workflowOperationLabel } from '@/lib/workflows/operation';
import { resolveUpscaleInput } from '@/lib/upscale';
import { resolveAudioInput, resolveAudioInputs, resolveReferenceImages, resolveVideoInput, resolveVideoInputs } from '@/lib/referenceImages';
import { DUPLICATE_WINDOW_MS, isDuplicateSubmit } from '@/lib/submitGuard';

const schema = z.object({
  nodeId: z.string().min(1).max(120),
  /** 工作流 ID。云端是 RunningHub 的纯数字，本地带 `local-` 前缀 —— 判定同 `lib/workflows/local.ts`。 */
  workflowId: z.string().refine(value => !workflowIdError(value), { message: '工作流 ID 无效。' }),
  /*
   * 这次跑的是哪类生成器。**必填**，因为它是「这个工作流配得上这个节点吗」的唯一依据 ——
   * 服务端从请求里看不出画布节点是什么类型，只能由客户端说明，而客户端说明的东西必须校验。
   * 不填就直接 400：给个默认值等于让「忘了带」这种客户端 bug 悄悄跑通。
   */
  kind: z.enum(GENERATOR_KINDS as unknown as [string, ...string[]]),
  /*
   * 跑的是哪道工序。**可选**（缺省 = 普通生成），因为它不是「必须申报才安全」的那种信息 ——
   * 漏填时我们会拿库里这份工作流自己的工序去复核，猜不出来才会错。真正的区别在于提交所需的东西：
   * 超清不要提示词、不要参考图，**唯一的输入就是待加工的那份媒体**。
   */
  operation: z.enum(WORKFLOW_OPERATIONS as unknown as [string, ...string[]]).optional(),
  nodeInfoList: z.array(z.object({ nodeId: z.string().min(1).max(100), fieldName: z.string().min(1).max(100), fieldValue: z.string().max(40000) })).max(400).optional(),
  /** 画布上「自定义参数块」节点里的行，叠加在配置生成的参数之上（同名节点字段覆盖）。 */
  paramRows: z.array(paramRowSchema).max(200).optional(),
  /*
   * 「接续上一段 / Latent 中转」节点上填的粗 / 精采样节点号：决定这条 latent 写进工作流的
   * 哪个节点，覆盖配置页里 `latent_1` / `latent_2` 所绑字段的节点号。
   * 留空 = 沿用配置页的绑定（老画布与没填的节点走这条路）。
   */
  latentNodeIds: z.object({
    coarse: z.string().trim().max(40).regex(/^[\w:-]*$/).optional(),
    fine: z.string().trim().max(40).regex(/^[\w:-]*$/).optional(),
  }).optional(),
  /**
   * 这个节点上用哪个「引擎」跑的。**可选**：老画布 / MCP 建出来的节点没有这个字段，
   * 缺省按 RunningHub（跟加引擎之前一样）。
   *
   * 它的作用只有一个 —— 把界面上那句「这份工作流跑在本机 / 云端」与本机实际走哪条链路**对上**。
   * 光看 `workflowId` 的前缀是不够的：前缀只说「这份工作流存在哪边」，
   * 而用户在下拉里选的是「这份工作流**这次**跑到哪边」。两者不一致时生成的产物一样成功，
   * 但扣的是另一边的账（云端扣积分、本机扣自己的电），界面上一个字都不说。
   */
  engine: z.string().max(20).optional(),
  instanceType: z.enum(['default', 'plus', 'ultra']).optional(),
  /** 「我就是要再跑一次」：跳过防重复提交那道闸（放弃 / 重跑用）。 */
  force: z.boolean().optional(),
  bindingValues: z.object({
    prompt: z.string().max(40000).optional(), duration: z.string().max(20).optional(),
    aspectRatio: z.string().max(100).optional(), megapixels: z.string().max(20).optional(),
    /** 参考图上限跟着配置页能绑的槽位数走（`MAX_REFERENCE_IMAGES`），两处不一致会出现「绑得到却传不上去」。 */
    referenceImages: z.array(z.string().min(1).max(40000)).max(MAX_REFERENCE_IMAGES).optional(),
    /*
     * 允许空串：latent 的槽位是**按编号对位**的（中转节点指定 #2 时，#1 的位置必须留空），
     * 空串表示「这个槽位不写」。`toNodeInfoList` 会跳过空值，不会往工作流里塞空参数。
     */
    latents: z.array(z.string().max(40000)).max(2).optional(),
    continuation: z.string().max(20).optional(),
    // 图片生成专用（视频生成不会提交这些）
    negativePrompt: z.string().max(40000).optional(),
    steps: z.string().max(20).optional(),
    cfg: z.string().max(20).optional(),
    seed: z.string().max(40).optional(),
    batchSize: z.string().max(20).optional(),
    sampler: z.string().max(120).optional(),
    /** 图片生成专用：由画布「比例 + 分辨率(MP)」自动换算的空 Latent 宽 / 高（像素，取整到 16 的倍数）。 */
    width: z.string().max(20).optional(),
    height: z.string().max(20).optional(),
    /** 超清唯一的输入：待加工媒体的地址（落盘地址或远端链接），服务端负责换成远端文件名。 */
    upscaleInput: z.string().max(40000).optional(),
    /**
     * 视频 / 音频输入节点上传上来的媒体（RunningHub 文件名，或落盘地址 / 远端链接）。
     * **可以多份**：画布上连了几个输入节点就交几份，配置页那边「视频输入 2」按顺序取第 2 份。
     */
    videoInputs: z.array(z.string().min(1).max(40000)).max(MAX_VIDEO_INPUTS).optional(),
    audioInputs: z.array(z.string().min(1).max(40000)).max(MAX_AUDIO_INPUTS).optional(),
    /** 只交一份时的老字段（MCP 还在用），服务端当 1 号槽位接住。 */
    videoInput: z.string().max(40000).optional(),
    audioInput: z.string().max(40000).optional(),
  }).optional(),
});
/** Values of the form `asset:<id>` point at an archived latent; re-upload it so RunningHub gets a fresh file name. */
async function resolveLatentValues(values: string[] | undefined, userId: string, apiKey: string, baseUrl: string) {
  if (!values?.length) return values;
  return Promise.all(values.map(async value => {
    // 空串是「该槽位留空」，不是要上传的文件
    if (!value || !value.startsWith(latentAssetPrefix)) return value;
    const file = await readLatentFile(value.slice(latentAssetPrefix.length), userId);
    const uploaded = await uploadMedia(new File([file.buffer], file.fileName), apiKey, baseUrl);
    return uploaded.fileName;
  }));
}

/**
 * Refuse to run when the canvas handed over an input that the saved config has nowhere to put.
 *
 * Dropping an unplaceable value is the binding mechanism's normal behaviour, which means an
 * unwired input vanishes with no trace: the任务 succeeds and comes back with a video that
 * ignored the prompt. Anything the user definitely typed or picked deserves a loud error
 * rather than a silent no-op — and the fix (rebind the field on the workflow config page) is
 * something only they can do, so the message has to name it.
 */
function assertInputsAreWired(
  config: Configuration,
  values: CanvasBindingValues | undefined,
  latentNodeIds?: LatentNodeIds,
) {
  if (!values) return;
  const consumed = consumedCanvasBindings(config);
  const has = (prefix: string) => [...consumed].some(binding => binding.startsWith(prefix));
  const orphaned: string[] = [];
  if (values.prompt?.trim() && !consumed.has('prompt')) orphaned.push('提示词');
  // 负向提示词和提示词同性质：写了一段话却没有任何字段承接，等于白写。
  // 步数 / CFG / 种子 / 张数 / 采样器**不在这里检查**——它们有默认值、每次都会提交，
  // 而很多图片工作流压根不暴露这些字段，一旦检查就变成「不绑就永远生成不了」。
  if (values.negativePrompt?.trim() && !consumed.has('negative_prompt')) orphaned.push('负向提示词');
  const images = values.referenceImages?.length ?? 0;
  if (images && !has('reference_image_')) orphaned.push(`${images} 张参考图`);
  const latents = values.latents?.filter(Boolean).length ?? 0;
  /*
   * 节点上填了粗 / 精采样节点号时，latent **有地方可去**（服务端会按那个号改写或补一条），
   * 不该再算「没接进工作流」—— 否则报错会把用户支到配置页去配一个他已经在画布上配好的东西。
   */
  const latentPlaced = has('latent_')
    || Boolean(String(latentNodeIds?.coarse || '').trim() || String(latentNodeIds?.fine || '').trim());
  if (latents && !latentPlaced) orphaned.push(`${latents} 个接续 latent`);
  /*
   * 超清只有这一个输入，**它没地方去就等于整次操作白做**：任务会跑成功、产出一份
   * 和源视频毫无关系的素材，而界面上什么都不说。所以这里必须拦，而且要说清去哪儿补救。
   */
  if (values.upscaleInput?.trim() && !consumed.has('upscale_input')) orphaned.push('待超清的媒体');
  if (!orphaned.length) return;
  throw new ApiError(400, `${orphaned.join('、')}没有接进工作流，生成出来不会带上它们。请到「设置 · 工作流配置」把对应字段的「画布绑定」选成画布值，并确认该字段已启用。`);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const parsed = schema.safeParse(await jsonBody(request, 2 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, '生成参数无效。');
    const input = parsed.data;
    /*
     * 出图参数的范围在服务端再拦一遍：UI 的 `min/max` 只挡得住鼠标点箭头，
     * 手敲越界值照样能提交。放在扣分**之前**——不然参数根本跑不通还要扣一次积分。
     */
    const paramError = validateImageParams(input.bindingValues);
    if (paramError) throw new ApiError(400, paramError);
    /*
     * 长宽同样要在这里拦一遍（2026-09-21 起画布上可以手填宽高）。
     * 界面那两个框的 `min` / `max` 只挡得住鼠标点箭头，手敲一个 99999 照样能提交；
     * 换算那一档算出来的数也该有个上限兜底。边界与界面用的是同一句措辞
     * （`lib/workflows/imageParams.ts` 的 `validateOutputSize`）。
     */
    const sizeError = validateOutputSize(input.bindingValues?.width, input.bindingValues?.height);
    if (sizeError) throw new ApiError(400, sizeError);
    const project = await db.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!project) throw new ApiError(404, '项目不存在。');

    /*
     * 防重复提交（2026-09-29）：同一个节点 60 秒内已经有在跑的任务 ——
     * 直接把那一条交回去，不建新任务、也就不扣第二次积分。
     *
     * 为什么不是「按参数指纹去重」：`idempotencyKey` 里带 `Date.now()`，
     * 所以「重试不会重复扣」那句老注释其实是假的 —— 两笔提交的 key 必然不同，
     * 账本去重永远命中不了。而按参数指纹去重会让「同参数再来一张」变成白嫖，
     * 那是另一种 bug。所以按**时间窗**：挡住双击与两个窗口，窗口之外照旧出新任务。
     *
     * `force` 是「我就是要再跑一次」的口子（放弃 / 重跑走它）。
     */
    if (!input.force) {
      const recent = await db.task.findFirst({
        where: {
          userId: user.id, projectId: id, nodeId: input.nodeId,
          status: { in: ['queued', 'running'] },
          createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, externalTaskId: true, createdAt: true },
      });
      if (recent && isDuplicateSubmit(new Date(recent.createdAt).getTime(), Date.now())) {
        return Response.json({
          taskId: recent.id, externalTaskId: recent.externalTaskId, status: 'RUNNING', deduped: true,
        });
      }
    }
    /*
     * 用途核对。视频与图片用的是两套不同的工作流，选错的症状是**任务成功、但产出是另一种媒体** ——
     * 没有报错、也没有任何界面会提示，只能靠人眼看结果。所以这里必须硬拦：
     * 前端下拉虽然已经按用途过滤，但过滤只挡得住鼠标，挡不住手改画布、老画布、以及直接打接口。
     *
     * 位置：在扣分**之前**（配错工作流不该让用户白花一次积分），也在 `resolveLatentValues`
     * **之前** —— 那一步会真的把 latent 传到 RunningHub，给一个注定被拒的请求白传一遍文件
     * 是没道理的。它只需要 userId + workflowId，所以能放到这么早。
     */
    /*
     * 工序核对。超清工作流的内容是「拿一份现成媒体再加工」，它没有提示词位、没有参考图位，
     * 拿去当普通生成跑出来的会是一份全新素材 —— 同样是「任务成功、产出不是要的东西」。
     * 所以跟用途一样硬拦，位置也一样：**在扣分之前**，也在取字节之前。
     */
    const operation = readWorkflowOperation(input.operation);
    const draft = await db.workflowDraft.findUnique({ where: { userId_workflowId: { userId: user.id, workflowId: input.workflowId } } });
    if (draft) {
      const draftKind = readGeneratorKind(draft.kind);
      if (draftKind !== input.kind) {
        throw new ApiError(400, `工作流 ${input.workflowId} 是${generatorKindNoun(draftKind)}，而这个节点是${generatorKindNoun(input.kind)}。请在这个节点上换一个${generatorKindNoun(input.kind)}，或到「设置 · 工作流配置」把它的用途改成${generatorKindNoun(input.kind)}。`);
      }
      const draftOperation = readWorkflowOperation(draft.operation);
      if (draftOperation !== operation) {
        throw new ApiError(400, `工作流 ${input.workflowId} 的工序是「${workflowOperationLabel(draftOperation)}」，不能当「${workflowOperationLabel(operation)}」用。请到「设置 · 工作流配置」改它的工序，或者换一份工作流。`);
      }
    }
    /*
     * 本地模式的判定。**放在取 RunningHub 密钥之前**：本地模式压根不需要那把 key，
     * 先去取一次会把它「还没配」的报错抛给一个根本用不上它的人。
     *
     * 走本机的两种来源：
     *   1. **这份工作流本身就是本地的**（`provider === 'local'`）—— 它带自己的图，编号天然一致，
     *      无论桌面版还是云端版都只能跑本机，这不是一个可以关的开关。
     *   2. **桌面版 / 打开了本地模式开关**（云端版的本地模式是可选项）—— 但**图仍然只从这一行草稿来**。
     *      早先还能回落到设置页里手工粘的「兜底图」好让 RunningHub 编号的云端工作流也跑本机，
     *      那条路已经删了（见下面 `graphSource` 那段）。
     */
    const draftIsLocal = draft ? readWorkflowProvider(draft.provider) === 'local' : false;
    /*
     * 这份是不是 RunningHub **应用**（`app-<数字>`）。它和工作流共用 `WorkflowDraft` 这一行，
     * 差别只有「提交给谁」—— 所以在这里一次性认出来，下面提交那一段就不用再判一次。
     */
    const appWebId = webAppIdOf(input.workflowId);
    const local = await readLocalCredentials(user.id);
    /*
     * 2026-09-26：桌面版**不再**恒走本机。
     *
     * 原来这里写 `isDesktop || ...`（「桌面版只有本机这一条路」）。可桌面版同样要能跑
     * RunningHub —— 云端工作流、以及后加的「应用」，那条路才是大多数人真正买的算力。
     * 恒 true 的后果是：桌面版上配一份云端工作流，点生成报的是「这个工作流不是本机
     * ComfyUI 工作流，没有可跑的图」，把人支到一个跟他的意图毫无关系的动作上去。
     *
     * 所以改成**按这份工作流自己属于哪一边决定**：
     *   - 本机工作流（`local-` 前缀）一定跑本机 —— 那是它唯一的去处；
     *   - 其余的走云端。云端版的「本地模式」开关照旧生效（它在那边本来就是可选项）。
     */
    const useLocal = draftIsLocal || (!isDesktop && local.enabled);
    /*
     * 本地工作流必须知道往哪儿提交。地址为空时报出来，而不是让它带着一个空 baseUrl
     * 去 fetch —— 那种请求会卡到超时为止，用户只会看到「一直在转」。
     */
    if (draftIsLocal && !local.baseUrl) {
      throw new ApiError(400, '这份工作流是本机的 ComfyUI 工作流，但还没有配过本机地址 —— 到「设置 · ComfyUI 服务」填上服务地址（一般是 http://127.0.0.1:8188）。');
    }
    /*
     * 「引擎选的那一档」与「这份工作流实际属于哪一边」必须一致。
     *
     * 为什么这一条不能省：界面上引擎与工作流是**两个独立的下拉**，切了引擎之后那份工作流
     * 可能还停在原处（老画布、手改过的画布、或者直接打接口）。这时两边说的不一样，
     * 而生成的**结果照样成功** —— 只是活交给了另一边：选了「本地 ComfyUI」却跑了云端，
     * 用户以为没扣钱、其实扣了积分；反过来选了 RunningHub 却跑了本机，用户会以为
     * 云端出了什么怪问题（本地那份图跟云端那份根本不是同一份）。
     *
     * 位置与用途 / 工序那两条一致：**在扣分之前、在取字节之前**。引擎只填了「网关」那一档
     * （videoapi / custom）时不查 —— 那条路压根不经过工作流，也就不存在「哪一边的工作流」这个问题。
     */
    const engineText = String(parsed.data.engine || '').trim();
    const engineWantsLocal = engineText === 'local';
    const engineIsWorkflow = !engineText || engineText === 'local' || engineText === 'runninghub' || engineText === 'workflow';
    if (engineIsWorkflow && engineWantsLocal !== draftIsLocal) {
      throw new ApiError(400, engineWantsLocal
        ? `这个节点上的引擎选的是「本地 ComfyUI」，但工作流 ${input.workflowId} 是 RunningHub（云端）的 —— 两者不是同一条链路。请换一份本机的工作流，或把引擎改回「RunningHub」。`
        : `这个节点上的引擎选的是「RunningHub」，但工作流 ${input.workflowId} 是本地 ComfyUI 的 —— 两者不是同一条链路。请换一份云端的工作流，或把引擎改成「本地 ComfyUI」。`);
    }
    let apiKey = '';
    /**
     * 打**哪个站**的地址（国内 / 海外）。**必须跟凭据一起走**：两个站是独立账号，
     * 拿海外站的 Key 打国内站会拿到 401 或「工作流不存在」—— 一个完全指不到根因的错。
     */
    let runningHubBase = '';
    let source: KeySource = 'none';
    if (!useLocal) {
      const resolved = await resolveRunningHub(user.id);
      apiKey = resolved.apiKey || '';
      runningHubBase = resolved.baseUrl;
      source = resolved.source;
      if (!apiKey) throw new ApiError(400, resolved.message || '尚未配置 RunningHub API Key。');
    }
    /*
     * latent 接续是 RunningHub 那边的做法（把上一轮的 latent 传上去再接着跑），本机这份图
     * 里没有对应节点。**明确报错而不是静默丢弃** —— 丢掉的后果是「出片和上一轮毫无关系」。
     */
    if (useLocal && (input.bindingValues?.latents?.filter(Boolean).length ?? 0) > 0) {
      throw new ApiError(400, isDesktop
        ? '桌面版不支持 latent 接续 —— 那是 RunningHub 专属的做法。请把节点上的接续 latent 去掉。'
        : '本地模式不支持 latent 接续 —— 那是 RunningHub 专属的做法。请把节点上的接续 latent 去掉，或到「设置 · 本地模式」关掉本地模式。');
    }
    /*
     * 超清的输入要把本地地址换成 RunningHub 的文件名。放在扣分**之前**：这份媒体超过 100 MB
     * 就传不上去，那会儿用户还没花积分，现在拒绝是最省事也最体面的时机。
     */
    const inputMedia = operation === 'upscale' ? input.bindingValues?.upscaleInput : undefined;
    if (operation === 'upscale' && !inputMedia) {
      throw new ApiError(400, '没有拿到要超清的媒体 —— 请先在节点上生成一次，再点「超清」。');
    }
    /*
     * 视频 / 音频统一按**数组**处理：`videoInputs` 是新客户端（画布上可以连多个输入节点），
     * 老客户端只给单值 `videoInput` —— 那就当 1 号，别两条路都走（同一份媒体传两次）。
     */
    const videoList = input.bindingValues?.videoInputs?.length
      ? input.bindingValues.videoInputs
      : (input.bindingValues?.videoInput ? [input.bindingValues.videoInput] : undefined);
    const audioList = input.bindingValues?.audioInputs?.length
      ? input.bindingValues.audioInputs
      : (input.bindingValues?.audioInput ? [input.bindingValues.audioInput] : undefined);
    /** 参考图 / 视频 / 音频「取字节」那一段两条路一样，只有最后一步送哪儿不同，所以换掉上传函数即可。 */
    /**
     * 上传送到哪儿：本地模式送本机 ComfyUI，其余送**当前那个站**的 RunningHub。
     *
     * ⚠️ 别再留 undefined —— 一留 undefined，参考图 / 超清 / 视频 / 音频那四条路会各自
     * 回落到客户端里的默认地址（国内站），海外站的账号就会拿到「文件不存在」。
     */
    const uploader: (file: File) => Promise<string> = useLocal
      ? (file: File) => uploadLocalMedia(file, local)
      : (file: File) => uploadMedia(file, apiKey, runningHubBase).then(item => item.fileName);
    const bindingValues = input.bindingValues
      ? {
        ...input.bindingValues,
        latents: useLocal ? input.bindingValues.latents : await resolveLatentValues(input.bindingValues.latents, user.id, apiKey, runningHubBase),
        /** 图片生成节点跑出来的图是本地资产，必须重传成对端认得的文件名才能当参考图喂给工作流。 */
        referenceImages: await resolveReferenceImages(input.bindingValues.referenceImages, user.id, apiKey, uploader),
        ...(operation === 'upscale' ? { upscaleInput: await resolveUpscaleInput(inputMedia!, user.id, apiKey, uploader) } : {}),
        /*
         * 视频 / 音频**故意不进** `assertInputsAreWired` 那条「有值却没接进工作流就报错」的检查：
         * 它们是**可选**的补充输入 —— 视频输入节点还有「首帧当参考图」那条主路，绑不绑都能出片。
         * 一旦检查，接了视频却只配了参考图绑定的用户会莫名其妙生成不了。
         */
        videoInputs: await resolveVideoInputs(videoList, user.id, apiKey, uploader),
        audioInputs: await resolveAudioInputs(audioList, user.id, apiKey, uploader),
        /* 数组接管之后这两个单值就不再作数 —— 留着会让「哪一份才生效」有第二个答案。 */
        videoInput: undefined,
        audioInput: undefined,
      }
      : undefined;
    let nodeInfoList = input.nodeInfoList;
    if (!nodeInfoList) {
      if (!draft) throw new ApiError(400, '请先保存该工作流的节点配置。');
      /*
       * Must go through applyDefaultBindings, exactly like GET /api/workflows/[id]/config does.
       * A config saved before bindings existed carries no `binding` key at all, and
       * configurationSchema would default every one of the 122 fields to 'manual' — which turns
       * the prompt / reference image / latent fields into fixed-value fields with no value, so
       * every canvas input gets dropped and the run still reports success.
       */
      const config = configurationSchema.safeParse(applyDefaultBindings(draft.config));
      if (!config.success) throw new ApiError(400, '节点配置无效，请重新保存。');
      assertInputsAreWired(config.data, bindingValues, input.latentNodeIds);
      /*
       * latent 的落点可能要按画布上填的节点号改写（配置页没绑 latent 时还要补一条），
       * 所以这里过一遍这两步，再交给 `toNodeInfoList`。
       */
      const redirected = applyLatentNodeIds(config.data, input.latentNodeIds);
      nodeInfoList = appendLatentEntries(
        toNodeInfoList(redirected, bindingValues),
        redirected,
        bindingValues,
        input.latentNodeIds,
      );
    }
    // 自定义参数块是叠加层：放在最后，所以同名的节点字段以画布上的为准。
    if (input.paramRows?.length) nodeInfoList = mergeParamRows(nodeInfoList || [], input.paramRows);
    /*
     * 用站长的公共 key 要花费余额，用自己的 key 或白名单账号不花。idempotencyKey 同时是余额账本的
     * refKey —— 扣费和退款都挂在这一串上，所以后面提交失败能原样退回去，重试也不会重复扣。
     */
    const key = `${useLocal ? 'local' : 'rh'}:${user.id}:${id}:${input.nodeId}:${Date.now()}`;
    /** 本地模式跑的是用户自己的机器，一分钱都不该收。 */
    if (!useLocal && source === 'env' && !isUnlimited(user.email)) {
      const cost = costPerGenerationFen();
      const charged = await chargeWallet({ userId: user.id, amount: cost, refKey: key, note: `画布生成 · 节点 ${input.nodeId}` });
      if (!charged.ok) throw new ApiError(402, `余额不足（余额 ¥${(charged.balance / 100).toFixed(2)}，每次生成需要 ¥${(cost / 100).toFixed(2)}）。到「设置 · 密钥中心」填上自己的 RunningHub API Key 就不再扣费。`);
    }
    /** 两条路归一成这三个值，后面的建行 / 落库就不必再分叉一次。 */
    let externalId: string;
    let initialStatus: string;
    let initialResults: Prisma.InputJsonValue | undefined;

    if (useLocal) {
      /*
       * 图只有一处来源：这一行草稿自己带的。
       *
       * 早先还有第二条路 —— 回落到「设置 · 本机 ComfyUI」里手工粘的那份「兜底图」，
       * 好让 RunningHub 编号的云端工作流也能跑在本机上。那条路已经删了：
       * 那份图必须和云端工作流的节点编号完全一致才写得进去，对不上就报一句谁也看不懂的错，
       * 而设置页里也没有任何东西能校验这件事。现在想跑本机，就去「设置 · 工作流配置」
       * 导入一份本机 ComfyUI 工作流，图跟着工作流走，编号天然对得上。
       */
      const graphSource = draft?.graph;
      if (!graphSource) {
        throw new ApiError(400, draftIsLocal
          ? '这份本地工作流没有图 —— 到「设置 · 工作流配置」里重新导入一次 ComfyUI「导出（API）」的 JSON。'
          : '这个工作流不是本机 ComfyUI 工作流，没有可跑的图 —— 到「设置 · 工作流配置」里用「本机 ComfyUI 导入」导入一份，再回来选它。');
      }
      let graph: LocalGraph;
      try {
        graph = applyNodeInfoList(graphSource as LocalGraph, nodeInfoList || []);
      } catch (error) {
        throw new ApiError(400, error instanceof Error ? error.message : '本地工作流图无效。');
      }
      /*
       * `clientId` 要留下来：ComfyUI 的 WebSocket 是按它认人的 ——
       * 同一条连接上会广播所有客户端的任务，看护得靠 clientId 才能找到自己那一拨消息
       * （拿到之后进度还是按 prompt_id 归档，所以界面上不会串）。
       */
      const clientId = randomUUID();
      try {
        const submitted = await submitLocalPrompt({ graph, clientId }, local);
        externalId = submitted.externalId;
        /*
         * 实时进度。**不 await，也不 try**：它只影响「界面上能不能看到百分之几」，
         * 连不上 / 运行时没有 WebSocket 都只是没有进度，`/history` 轮询照旧。
         */
        watchLocalProgress({
          credentials: local,
          clientId,
          promptId: externalId,
          nodeTypes: Object.fromEntries(
            Object.entries(graph).map(([nodeId, node]) => [nodeId, String(node?.class_type || '')]),
          ),
        });
      } catch (error) {
        await refundGeneration(user.id, key);
        throw new ApiError(502, error instanceof Error ? error.message : '本机 ComfyUI 提交失败。');
      }
      initialStatus = 'RUNNING';
    } else {
      let remote: RunningHubResponse;
      try {
        /*
         * `kind` 与 `operation` 都是本路由自己的概念（用来核对草稿），**都不发给上游** ——
         * 显式拆出来而不是整份 spread，免得哪天上游多了个同名字段、被我们顺手喂进去一个它不认识的值。
         */
        const { kind: _kind, operation: _operation, latentNodeIds: _latentNodeIds, ...runInput } = input;
        /*
         * 应用走的是另一条端点（`/task/openapi/ai-app/run`，按 `webappId` 认），
         * 工作流那条 `/run/workflow/<id>` 对应用 ID 是不认的 —— 拿应用 ID 去打它，
         * 报的是「工作流不存在」，而工作流明明就在那儿。
         */
        remote = appWebId
          ? await submitWebApp({ webAppId: appWebId, nodeInfoList: nodeInfoList || [], instanceType: runInput.instanceType }, apiKey, runningHubBase)
          : await submitWorkflow({ ...runInput, nodeInfoList }, apiKey, runningHubBase);
      } catch (error) {
        await refundGeneration(user.id, key);
        throw error;
      }
      if (!remote.taskId || remote.status === 'FAILED') {
        await refundGeneration(user.id, key);
        throw new ApiError(502, remote.errorMessage || 'RunningHub 未返回任务 ID。');
      }
      externalId = remote.taskId;
      initialStatus = remote.status || 'RUNNING';
      initialResults = remote.results ? remote.results as Prisma.InputJsonValue : undefined;
    }
    const workflowType = operation === 'upscale'
      ? `${input.kind}-upscale`
      : input.kind === 'image' ? 'image-generation' : 'video-generation';
    /*
     * 登记表（`Workflow`）按「谁跑的 + 跑的哪一份」建键：
     *   - 本地工作流：键就是它自己的 ID（`local-…`），一次一份，名字与来源都对得上；
     *   - 云端编号的工作流跑在本机：本地模式下真正跑的是用户贴的那份图，没有一个云端 ID
     *     能代表它，所以这一方的键固定是字符串 `'local'`（所有这类运行共用一个登记行）。
     *     注意 `input.workflowId` 本身还留在节点上 —— 字段绑定是按那份编号写的，只是执行的机器换了。
     * `useLocal` 为真时 `draftIsLocal` 也一定为真或二者等价，所以 provider 直接跟着 `useLocal` 走。
     */
    const registryProvider = useLocal ? 'local' : 'runninghub';
    const registryWorkflowId = draftIsLocal ? input.workflowId : (useLocal ? 'local' : input.workflowId);
    const registryName = draftIsLocal
      ? (readWorkflowName(draft?.name) || input.workflowId)
      : (useLocal ? '本机 ComfyUI' : (appWebId ? 'RunningHub 应用' : 'RunningHub workflow'));
    const workflow = await db.workflow.upsert({
      where: { provider_workflowId: { provider: registryProvider, workflowId: registryWorkflowId } },
      create: {
        provider: registryProvider,
        workflowId: registryWorkflowId,
        name: registryName,
        type: workflowType, inputSchema: {}, inputMapping: {}, enabled: true,
      },
      /*
       * 老行可能记着 `video-generation`（加用途之前所有工作流都写成了视频）。
       * 这里跟着最新一次运行纠正过来：这张表是登记表，type 该反映它实际在干什么。
       */
      update: { type: workflowType },
    });
    const task = await db.task.create({ data: {
      userId: user.id, projectId: id, nodeId: input.nodeId, provider: useLocal ? 'local' : 'runninghub', workflowId: workflow.id,
      externalTaskId: externalId, idempotencyKey: key,
      status: initialStatus === 'SUCCESS' ? 'success' : initialStatus === 'QUEUED' ? 'queued' : 'running',
      input: nodeInfoList as Prisma.InputJsonValue,
      result: initialResults,
    } });
    return Response.json({ taskId: task.id, externalTaskId: externalId, status: initialStatus });
  });
}
