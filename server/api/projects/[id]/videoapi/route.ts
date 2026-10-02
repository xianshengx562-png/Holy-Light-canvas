import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { chargeWallet, costPerGenerationFen, isUnlimited, refundGeneration } from '@/lib/wallet';
import { db } from '@/lib/db';
import { videoApiModel } from '@/lib/providers/videoapi/config';
import { markKeyOutcome, recordCall } from '@/lib/providers/keys';
import { missingCredentialsMessage, resolveVideoApiCredentials } from '@/lib/providers/resolve';
import { submitVideoApi } from '@/lib/providers/videoapi/client';
import { readFirstFrame } from '@/lib/providers/videoapi/reference';
import { readVideoApiParams, validateVideoApiParams } from '@/lib/workflows/videoApiParams';
import { DUPLICATE_WINDOW_MS, isDuplicateSubmit } from '@/lib/submitGuard';

/**
 * 视频网关通道 —— 视频生成节点选了「视频网关」引擎时走这里。
 *
 * 与 `/generation`（RunningHub 工作流）的差别是**整条链路都不一样**：
 * 没有工作流、没有 nodeInfoList、没有 latent 接续、没有参数绑定。
 * 参数就是模型 / 时长 / 分辨率 / 比例，外加可选的首帧图（图生视频）。
 *
 * 与图片侧同步出图的差别是**它是异步的**：提交只拿到网关那边的任务号，视频要等轮询
 * （`GET /api/tasks/[id]`，那边已按 `task.provider` 分派到 `queryVideoApi`）。
 * 所以这里建一条 running 的 Task 就返回，落盘与积分结算都在轮询那一步发生。
 */
const schema = z.object({
  nodeId: z.string().min(1).max(120),
  /** 节点名快照：写进 `Task.nodeLabel`。历史要靠它显示「这条是谁跑的」（节点删了也还在）。 */
  nodeLabel: z.string().max(60).optional(),
  prompt: z.string().min(1).max(40000),
  model: z.string().max(120).optional(),
  duration: z.union([z.string().max(8), z.number().int()]).optional(),
  resolution: z.string().max(8).optional(),
  aspectRatio: z.string().max(12).optional(),
  /**
   * 首帧图（图生视频）。传的是**能取到字节或能被网关下载的地址**：
   *   - `/api/assets/<id>/media.png` —— 已落盘的图，服务端读盘后以 multipart 转发出去；
   *   - `http(s)://...` —— 网关自己下得到的地址，原样传。
   * RunningHub 那条路上的 `remoteFile`（远端文件名）在这里**没有意义**，那个平台认不出。
   */
  firstFrame: z.string().trim().min(1).max(2000).optional(),
  /** 「我就是要再跑一次」：跳过防重复提交那道闸（放弃 / 重跑用）。 */
  force: z.boolean().optional(),
});

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
    const paramError = validateVideoApiParams(input);
    if (paramError) throw new ApiError(400, paramError);

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

    /** 账号自带的那把优先，没有才回落站点那把环境变量 key（顺序反了会变成「填了 key 还扣积分」）。 */
    const creds = await resolveVideoApiCredentials(user.id);
    if (!creds) throw new ApiError(400, missingCredentialsMessage('视频网关', 'VIDEO_API_KEY'));

    /*
     * 首帧图要在这里取成字节，**排在扣分之前**：
     * 图取不到（地址认不出 / 太大）时这次请求根本发不出去，
     * 先扣了分用户看到的就是「钱花了、报错了」。
     * 取不到也不许静默跳过 —— 那会变成「视频出来了，但和我的首帧图毫无关系」。
     */
    let firstFrame;
    try {
      firstFrame = await readFirstFrame(input.firstFrame, user.id);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, error instanceof Error ? error.message : '首帧图取不到字节。');
    }

    /** 落定之后的实际提交值。注意别叫 `request` —— 会盖住上面那个 HTTP 请求对象。 */
    const submitted = readVideoApiParams(input);
    const model = String(input.model || '').trim() || videoApiModel();

    /*
     * 以前这里写的是「一律按次计费」—— 那时候视频网关只有一把站点公用的 key。
     * 现在账号可以自带 key 了，所以改成和 RunningHub 同一套口径：**只有用站点那把才扣费**。
     * 任务是把 externalTaskId 带走的，轮询时按 task.provider 再取一次凭据，两边可以不同，
     * 但本轮先按同一套处理（见 `app/api/tasks/[id]/route.ts`）。
     * idempotencyKey 同时是余额账本的 refKey：提交失败要能原样退回去。
     */
    const key = `vapi:${user.id}:${id}:${input.nodeId}:${Date.now()}`;
    if (!isUnlimited(user.email) && creds.source === 'env') {
      const cost = costPerGenerationFen();
      const charged = await chargeWallet({ userId: user.id, amount: cost, refKey: key, note: `视频网关生成 · 节点 ${input.nodeId}` });
      if (!charged.ok) throw new ApiError(402, `余额不足（余额 ¥${(charged.balance / 100).toFixed(2)}，每次生成需要 ¥${(cost / 100).toFixed(2)}）。`);
    }

    let externalId: string;
    try {
      const result = await submitVideoApi({
        prompt: input.prompt,
        model,
        duration: submitted.duration,
        resolution: submitted.resolution,
        aspectRatio: submitted.aspectRatio,
        ...(firstFrame ? { image: firstFrame } : {}),
      }, creds);
      externalId = result.externalId;
    } catch (error) {
      /** 提交就失败：退分，并且**不留任务行**（与 RunningHub 通道同一口径）。 */
      await refundGeneration(user.id, key);
      const reason = error instanceof Error ? error.message : '视频网关提交失败。';
      if (creds.keyId) await markKeyOutcome(creds.keyId, false, reason);
      await recordCall({ userId: user.id, provider: 'videoapi', keyId: creds.keyId ?? undefined, ok: false, errorMessage: reason });
      throw new ApiError(502, `${reason}（本次不扣积分）`);
    }
    /** 提交成功本身就是一次健康检查：这把 key 能发出任务，说明它是活的。 */
    if (creds.keyId) await markKeyOutcome(creds.keyId, true);
    await recordCall({ userId: user.id, provider: 'videoapi', keyId: creds.keyId ?? undefined, ok: true });

    /** 与同步出图一样，Task 要挂在一行 Workflow 上，所以用模型名当它的标识。 */
    const workflow = await db.workflow.upsert({
      where: { provider_workflowId: { provider: 'videoapi', workflowId: model || 'default' } },
      create: {
        provider: 'videoapi', workflowId: model || 'default',
        name: model ? `视频网关 · ${model}` : '视频网关',
        type: 'video-generation', inputSchema: {}, inputMapping: {}, enabled: true,
      },
      update: { type: 'video-generation' },
    });

    const task = await db.task.create({ data: {
      userId: user.id, projectId: id, nodeId: input.nodeId, nodeLabel: input.nodeLabel || null, provider: 'videoapi', workflowId: workflow.id,
      externalTaskId: externalId, idempotencyKey: key,
      status: 'running',
      input: {
        engine: 'videoapi', prompt: input.prompt, ...submitted,
        /** `submitted.model` 是「画布上填的那个」，可能是空串；这里记的是**实际发出去的**（空则回落 .env）。 */
        model,
        /** 只记有没有首帧图：字节不进库，地址也可能过期，排查时知道「当时带没带图」就够了。 */
        hasFirstFrame: Boolean(firstFrame),
      } as Prisma.InputJsonValue,
    } });

    return Response.json({ taskId: task.id, externalTaskId: externalId, workflowId: model, status: 'RUNNING' });
  });
}
