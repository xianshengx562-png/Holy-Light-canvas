import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { chargeWallet, costPerGenerationFen, isUnlimited, refundGeneration } from '@/lib/wallet';
import { db } from '@/lib/db';
import { markKeyOutcome, recordCall } from '@/lib/providers/keys';
import { rhModelKeyMissingMessage, resolveRhModelCredentials } from '@/lib/providers/runninghub/connection';
import { rhModelMediaUrl, submitRhModel } from '@/lib/providers/runninghub/model';
import { readRhModelParams, rhModelSpecOf, validateRhModelParams } from '@/lib/workflows/rhModelParams';
import { DUPLICATE_WINDOW_MS, isDuplicateSubmit } from '@/lib/submitGuard';

/**
 * RunningHub **标准模型 API** 通道 —— 视频生成节点选了「RunningHub 模型」引擎时走这里
 * （2026-10-11 徐先：他要在自己的画布里用上 RunningHub 家的模型，而不是走工作流）。
 *
 * 与 `/generation`（RunningHub 工作流）的差别是**整条链路都不一样**：
 * 没有节点图、没有 `nodeInfoList`、没有 latent 接续、没有参数绑定 ——
 * 参数就是「模型 + 提示词 + 分辨率 + 时长 + 比例 + 参考素材」，
 * 打的是 `/openapi/v2/<模型路径>` 而不是 `/run/workflow/<id>`。
 *
 * 与 `/videoapi`（通用视频网关）的差别：那一份是「换个网关改 .env」的通用适配，
 * 这一份是照 RunningHub 家实测出来的规格，而且**用的是另一把 Key**（企业级-共享）。
 *
 * 与图片侧同步出图的差别是**它是异步的**：提交只拿到上游的任务号，视频要等轮询
 * （`GET /api/tasks/[id]`，那边已按 `task.provider` 分派到 `queryRhModel`）。
 * 所以这里建一条 running 的 Task 就返回，落盘与积分结算都在轮询那一步发生。
 */
const schema = z.object({
  nodeId: z.string().min(1).max(120),
  /** 节点名快照：写进 `Task.nodeLabel`。历史要靠它显示「这条是谁跑的」（节点删了也还在）。 */
  nodeLabel: z.string().max(60).optional(),
  prompt: z.string().min(1).max(40000),
  /** 模型路径。**必填** —— 这一档没有「留空用 .env 里那个」的兜底，凭空猜一个等于交给另一档模型。 */
  model: z.string().min(1).max(120),
  duration: z.union([z.string().max(8), z.number().int()]).optional(),
  resolution: z.string().max(8).optional(),
  aspectRatio: z.string().max(12).optional(),
  /** AIGC 水印。不传按 `false`（自己出的片不额外盖章）。 */
  watermark: z.boolean().optional(),
  /*
   * 参考素材：画布上连上来的那些地址（`/api/assets/...`、`/api/canvas-media/...`、
   * 或者上一次上传拿到的 `download_url`）。**已经按连线顺序排好**，服务端只管裁到上限。
   *
   * ⚠️ 上限由**这一档模型**决定（`RH_MODELS` 里每一档都不同），不是由这里写死 ——
   * 给「图生视频」那档塞 9 张图，上游只认 `firstFrameUrl` 一张，多的会被静默丢掉。
   */
  imageUrls: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  videoUrls: z.array(z.string().trim().min(1).max(2000)).max(10).optional(),
  audioUrls: z.array(z.string().trim().min(1).max(2000)).max(10).optional(),
  /** 首帧 / 尾帧（`i2va` 那两档用）。与 `imageUrls` 是两套东西，见 `RhFrameSlot`。 */
  firstFrameUrl: z.string().trim().min(1).max(2000).optional(),
  lastFrameUrl: z.string().trim().min(1).max(2000).optional(),
  /** 「我就是要再跑一次」：跳过防重复提交那道闸（放弃 / 重跑用）。 */
  force: z.boolean().optional(),
});

/** 三路素材在 `input` 里的键名，与请求体一致（下面要循环处理，写一份免得手抄错）。 */
const MEDIA_KEYS = ['imageUrls', 'videoUrls', 'audioUrls'] as const;
type MediaKey = (typeof MEDIA_KEYS)[number];

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const parsed = schema.safeParse(await jsonBody(request, 2 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, '生成参数无效。');
    const input = parsed.data;

    /*
     * 参数在服务端再校验一遍：下拉只挡得住鼠标，手改画布、老画布、直接打接口都拦不住。
     * 位置在扣分**之前** —— 参数根本跑不通还要扣一次积分是没道理的。
     */
    const paramError = validateRhModelParams(input);
    if (paramError) throw new ApiError(400, paramError);
    const spec = rhModelSpecOf(input.model);
    if (!spec) throw new ApiError(400, `模型「${input.model}」不在可选列表里。`);

    const project = await db.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!project) throw new ApiError(404, '项目不存在。');

    /* 防重复提交：同一节点 60 秒内已经有在跑的任务 —— 直接把那一条交回去，不建新任务、也不扣第二次分。 */
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
     * 🔴 凭据走**企业级那把**，不是 `resolveRunningHub()` 那把：
     * 模型 API 只认企业级-共享 Key，拿消费级那把去打是 `1014 Access Denied`。
     * 两把分开取正是为了让「工作流能跑、模型一律 1014」这件事在界面上说得出根因。
     */
    const creds = await resolveRhModelCredentials(user.id);
    if (!creds) throw new ApiError(400, rhModelKeyMissingMessage());

    /*
     * 参考素材要在这里变成**上游能下载的 URL**，**排在扣分之前**（理由同 `/videoapi`）：
     * 素材取不到时这次请求根本发不出去，先扣了分用户看到的就是「钱花了、报错了」。
     *
     * 取不到一律**抛错而不是跳过** —— 跳过会得到「任务成功，但这一份素材根本没交上去」，
     * 那是最难发现的一类坏结果（画面与素材无关，界面一个字都不说）。
     */
    const media: Partial<Record<MediaKey, string[]>> = {};
    /** 一份素材 -> 上游能下载的 URL。取不到一律抛错，绝不静默跳过。 */
    const toUrl = async (source: string) => {
      try {
        return await rhModelMediaUrl(source, user.id, creds);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, error instanceof Error ? error.message : '参考素材取不到字节。');
      }
    };
    for (const field of MEDIA_KEYS) {
      const slot = spec[field === 'imageUrls' ? 'image' : field === 'videoUrls' ? 'video' : 'audio'];
      if (!slot) continue;                       // 这一档不收这类素材：一个都不取，也不提示
      const sources = (input[field] || []).slice(0, slot.max);
      if (!sources.length) continue;
      const urls: string[] = [];
      for (const source of sources) {
        const url = await toUrl(source);
        if (url) urls.push(url);
      }
      if (urls.length) media[field] = urls;
    }

    /*
     * 首尾帧（`i2va` 那两档）：**两张图各有各的字段**，不是「最多两张的列表」。
     * 只给首帧是合法的（那就是图生视频），所以两张各自独立取，取到几张算几张。
     */
    const frames = spec.frames
      ? {
        first: input.firstFrameUrl ? await toUrl(input.firstFrameUrl) : '',
        last: input.lastFrameUrl ? await toUrl(input.lastFrameUrl) : '',
      }
      : null;

    /** 落定之后的实际提交值。注意别叫 `request` —— 会盖住上面那个 HTTP 请求对象。 */
    const submitted = readRhModelParams(input);

    /*
     * 计费口径与 `/videoapi` 一致：**只有用站点那把才扣费**，用户自带的企业级 Key 不扣
     * （他花的是自己账号里的额度）。任务把 externalTaskId 带走，轮询时按 task.provider 再取一次凭据。
     */
    const key = `rhmdl:${user.id}:${id}:${input.nodeId}:${Date.now()}`;
    if (!isUnlimited(user.email) && creds.source === 'env') {
      const cost = costPerGenerationFen();
      const charged = await chargeWallet({ userId: user.id, amount: cost, refKey: key, note: `RunningHub 模型生成 · 节点 ${input.nodeId}` });
      if (!charged.ok) throw new ApiError(402, `余额不足（余额 ¥${(charged.balance / 100).toFixed(2)}，每次生成需要 ¥${(cost / 100).toFixed(2)}）。`);
    }

    let externalId: string;
    try {
      const result = await submitRhModel({
        model: submitted.model,
        prompt: input.prompt,
        duration: submitted.duration,
        resolution: submitted.resolution,
        aspectRatio: submitted.aspectRatio,
        watermark: input.watermark ?? false,
        imageUrls: media.imageUrls,
        videoUrls: media.videoUrls,
        audioUrls: media.audioUrls,
        firstFrameUrl: frames?.first || undefined,
        lastFrameUrl: frames?.last || undefined,
      }, creds);
      externalId = result.externalId;
    } catch (error) {
      /** 提交就失败：退分，并且**不留任务行**（与工作流通道同一口径）。 */
      await refundGeneration(user.id, key);
      const reason = error instanceof Error ? error.message : 'RunningHub 模型提交失败。';
      if (creds.keyId) await markKeyOutcome(creds.keyId, false, reason);
      await recordCall({ userId: user.id, provider: 'runninghub-enterprise', keyId: creds.keyId ?? undefined, ok: false, errorMessage: reason });
      throw new ApiError(502, `${reason}（本次不扣积分）`);
    }
    /** 提交成功本身就是一次健康检查：这把 key 能发出任务，说明它是活的。 */
    if (creds.keyId) await markKeyOutcome(creds.keyId, true);
    await recordCall({ userId: user.id, provider: 'runninghub-enterprise', keyId: creds.keyId ?? undefined, ok: true });

    /** Task 要挂在一行 Workflow 上，所以用模型路径当它的标识。 */
    const workflow = await db.workflow.upsert({
      where: { provider_workflowId: { provider: 'rh-model', workflowId: submitted.model } },
      create: {
        provider: 'rh-model', workflowId: submitted.model,
        name: `RunningHub 模型 · ${spec.label}`,
        type: 'video-generation', inputSchema: {}, inputMapping: {}, enabled: true,
      },
      update: { type: 'video-generation' },
    });

    const task = await db.task.create({ data: {
      userId: user.id, projectId: id, nodeId: input.nodeId, nodeLabel: input.nodeLabel || null, provider: 'rh-model', workflowId: workflow.id,
      externalTaskId: externalId, idempotencyKey: key,
      status: 'running',
      input: {
        engine: 'rh-model', prompt: input.prompt, ...submitted,
        watermark: input.watermark ?? false,
        /** 只记**数量**：URL 可能过期，排查时知道「当时带了几份素材」就够了。 */
        media: {
          image: media.imageUrls?.length || 0,
          video: media.videoUrls?.length || 0,
          audio: media.audioUrls?.length || 0,
          firstFrame: frames?.first ? 1 : 0,
          lastFrame: frames?.last ? 1 : 0,
        },
      } as Prisma.InputJsonValue,
    } });

    return Response.json({ taskId: task.id, externalTaskId: externalId, workflowId: submitted.model, status: 'RUNNING' });
  });
}
