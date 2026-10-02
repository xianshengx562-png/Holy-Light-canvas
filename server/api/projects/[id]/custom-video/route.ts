import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { db } from '@/lib/db';
import { submitCustomVideo } from '@/lib/providers/custom/client';
import { readCustomCredentials, splitCustomModelValue } from '@/lib/providers/custom';
import { readFirstFrame } from '@/lib/providers/videoapi/reference';
import { readVideoApiParams, validateVideoApiParams } from '@/lib/workflows/videoApiParams';

/**
 * 自定义接口出片（2026-09-21）—— 视频生成节点把引擎选成「自定义接口」时走这里。
 *
 * 与 `/videoapi` 同一条形状：**异步**（提交拿任务号 → `GET /api/tasks/[id]` 轮询）。
 * 选异步而不是同步，是因为视频普遍要跑几分钟，同步请求会先在网关 / 反向代理那层超时，
 * 那时候用户看到的是 504 而不是进度。
 *
 * 与 `/videoapi` 的差别只有凭据来源（自定义接口表）与**不扣积分**（Key 是用户自己的），
 * 其余照搬，包括「提交失败不留任务行」这条 —— 留下一行永远 running 的任务
 * 等于给用户一个永远转圈的假象。
 */
/**
 * 「480p / 720p / 1080p + 16:9」→ OpenAI 风格的 `"1280x720"`。
 *
 * 各家的字段名不统一（`size` / `resolution` / `aspect_ratio`），但**像素尺寸字符串是最大公约数**，
 * 而且我们这边下拉里选的本来就是「分辨率 + 比例」两档，正好能拼出来。
 * 宽高都取偶数：几家网关对奇数边长会直接 400。
 */
function sizeFrom(resolution: string, aspectRatio: string) {
  const height = { '480p': 480, '720p': 720, '1080p': 1080 }[resolution] ?? 720;
  const [w, h] = aspectRatio.split(':').map(Number);
  const ratio = w > 0 && h > 0 ? w / h : 16 / 9;
  const width = Math.round(height * ratio);
  return `${width - (width % 2)}x${height - (height % 2)}`;
}

const schema = z.object({
  nodeId: z.string().min(1).max(120),
  /** 节点名快照：写进 `Task.nodeLabel`。历史要靠它显示「这条是谁跑的」（节点删了也还在）。 */
  nodeLabel: z.string().max(60).optional(),
  prompt: z.string().min(1).max(40000),
  /** `<providerId>::<modelId>`。 */
  model: z.string().trim().min(1).max(400),
  duration: z.union([z.string().max(8), z.number().int()]).optional(),
  resolution: z.string().max(8).optional(),
  aspectRatio: z.string().max(12).optional(),
  /** 首帧图（图生视频）：已落盘资产地址，或网关自己下得到的地址。 */
  firstFrame: z.string().trim().min(1).max(2000).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const parsed = schema.safeParse(await jsonBody(request, 2 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, '生成参数无效。');
    const input = parsed.data;

    const paramError = validateVideoApiParams(input);
    if (paramError) throw new ApiError(400, paramError);
    const project = await db.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!project) throw new ApiError(404, '项目不存在。');

    const target = splitCustomModelValue(input.model);
    if (!target) throw new ApiError(400, '模型值不对（应为「接口 ID::模型 ID」），请到节点上重新选一次模型。');
    const creds = await readCustomCredentials(user.id, target.providerId);
    if (!creds) throw new ApiError(400, '这条自定义接口已经不存在了，或它的 Key 解不开 —— 请到「设置 · 模型服务」里重新添加。');
    if (!creds.models.some(item => item.id === target.modelId)) {
      throw new ApiError(400, `这条接口上没有「${target.modelId}」这个模型了，请到「设置 · 模型服务」里重新拉取模型清单。`);
    }

    let firstFrame;
    try {
      firstFrame = await readFirstFrame(input.firstFrame, user.id);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, error instanceof Error ? error.message : '首帧图取不到字节。');
    }

    const submitted = readVideoApiParams(input);
    /** 只有拿到了本地字节才走 multipart；网关自己下得到的地址就原样给它。 */
    const imageFile = firstFrame && 'file' in firstFrame ? firstFrame.file : undefined;
    const imageUrl = firstFrame && 'url' in firstFrame ? firstFrame.url : '';

    let externalId: string;
    try {
      const result = await submitCustomVideo(
        { baseUrl: creds.baseUrl, apiKey: creds.apiKey },
        {
          model: target.modelId,
          prompt: input.prompt,
          seconds: submitted.duration,
          size: sizeFrom(submitted.resolution, submitted.aspectRatio),
          ...(imageFile ? { image: imageFile } : {}),
          ...(imageUrl ? { extra: { image_url: imageUrl } } : {}),
        },
      );
      externalId = result.externalId;
    } catch (error) {
      throw new ApiError(502, `${creds.name}：${error instanceof Error ? error.message : '提交失败。'}`);
    }

    const workflowKey = `${target.providerId}::${target.modelId}`;
    const workflow = await db.workflow.upsert({
      where: { provider_workflowId: { provider: 'custom', workflowId: workflowKey } },
      create: {
        provider: 'custom', workflowId: workflowKey,
        name: `${creds.name} · ${target.modelId}`, type: 'video-generation',
        inputSchema: {}, inputMapping: {}, enabled: true,
      },
      update: { type: 'video-generation', name: `${creds.name} · ${target.modelId}` },
    });

    const task = await db.task.create({ data: {
      userId: user.id, projectId: id, nodeId: input.nodeId, nodeLabel: input.nodeLabel || null, provider: 'custom', workflowId: workflow.id,
      externalTaskId: externalId,
      idempotencyKey: `cvid:${user.id}:${id}:${input.nodeId}:${Date.now()}`,
      status: 'running',
      input: {
        engine: 'custom', prompt: input.prompt, ...submitted,
        /** 放在 `submitted` **之后**：它自带的 `model` 是画布上填的裸模型名，这里要记的是带接口 ID 的那份。 */
        model: workflowKey,
        hasFirstFrame: Boolean(firstFrame),
      } as Prisma.InputJsonValue,
    } });

    return Response.json({ taskId: task.id, externalTaskId: externalId, workflowId: workflowKey, status: 'RUNNING' });
  });
}
