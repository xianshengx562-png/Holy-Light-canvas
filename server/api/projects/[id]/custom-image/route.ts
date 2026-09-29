import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { db } from '@/lib/db';
import {
  archiveInlineMedia, archiveTaskMedia, base64ToBuffer, imageExtOfBuffer, type ArchivedMedia,
} from '@/lib/media';
import { fetchReferenceBytes } from '@/lib/providers/referenceBytes';
import { generateCustomImage } from '@/lib/providers/custom/client';
import { readCustomCredentials, splitCustomModelValue } from '@/lib/providers/custom';
import { IMAGE2_MAX_REFERENCES, readImage2Params, validateImage2Params } from '@/lib/workflows/image2Params';

/**
 * 自定义接口出图（2026-09-21）—— 图片生成节点把引擎选成「自定义接口」时走这里。
 *
 * **同步**形状：一次请求拿回图，落盘 + 建一条已结束的 Task。
 * （2026-09-23 之前这里写的是「与 `/image2` 同一条形状」—— 那条链路已经删了，
 *   现在自定义接口是唯一走同步出图的一档。）
 * 差别只有两处：
 * - 凭据来自 `CustomProvider` 那张表（不是密钥池、也不是环境变量）；
 * - **不扣积分**：接口是用户自己找的、Key 是他自己的，Holy Light画布这边没有垫付任何成本。
 *   计费口径与「用自己的 key 不扣费」那条完全一致。
 *
 * ⚠️ 模型值形如 `<providerId>::<modelId>`（见 `splitCustomModelValue`）：值里自带
 * 「属于哪条接口」，所以那条接口被删掉之后这里能明确报「这条接口已经不存在」，
 * 而不是留一个谁也不认识的裸模型名。
 */
const schema = z.object({
  nodeId: z.string().min(1).max(120),
  prompt: z.string().min(1).max(40000),
  /** `<providerId>::<modelId>`。 */
  model: z.string().trim().min(1).max(400),
  ratio: z.string().max(20).optional(),
  resolution: z.string().max(8).optional(),
  referenceImages: z.array(z.string().trim().min(1).max(2000)).max(IMAGE2_MAX_REFERENCES).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const parsed = schema.safeParse(await jsonBody(request, 2 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, '生成参数无效。');
    const input = parsed.data;

    const paramError = validateImage2Params(input);
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

    /*
     * 参考图取字节，且**排在真正发请求之前**：取不到图这次根本发不出去，
     * 也不许静默跳过 —— 那会变成「图出来了，但和我的参考图毫无关系」。
     */
    let references;
    try {
      references = await fetchReferenceBytes({ userId: user.id, urls: input.referenceImages || [] });
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : '参考图取不到字节。');
    }

    const submitted = readImage2Params(input);
    const startedAt = Date.now();
    const remote = await generateCustomImage(
      { baseUrl: creds.baseUrl, apiKey: creds.apiKey },
      {
        model: target.modelId,
        prompt: input.prompt,
        size: submitted.size,
        images: references.map(item => new File([item.bytes], item.name, { type: item.mime })),
      },
    ).catch(error => ({
      status: 'FAILED' as const,
      results: [] as { b64?: string; url?: string }[],
      errorMessage: error instanceof Error ? error.message : '自定义接口调用失败。',
    }));
    if (remote.status !== 'SUCCESS') {
      throw new ApiError(502, `${creds.name}：${remote.errorMessage || '出图失败。'}`);
    }

    /** Task 挂在一行 Workflow 上，标识用「接口名::模型名」。 */
    const workflowKey = `${target.providerId}::${target.modelId}`;
    const workflow = await db.workflow.upsert({
      where: { provider_workflowId: { provider: 'custom', workflowId: workflowKey } },
      create: {
        provider: 'custom', workflowId: workflowKey,
        name: `${creds.name} · ${target.modelId}`, type: 'image-generation',
        inputSchema: {}, inputMapping: {}, enabled: true,
      },
      update: { type: 'image-generation', name: `${creds.name} · ${target.modelId}` },
    });
    const task = await db.task.create({ data: {
      userId: user.id, projectId: id, nodeId: input.nodeId, provider: 'custom', workflowId: workflow.id,
      status: 'running',
      input: {
        engine: 'custom', model: workflowKey, prompt: input.prompt, ...submitted,
        referenceCount: references.length, latencyMs: Date.now() - startedAt,
      } as Prisma.InputJsonValue,
    } });

    const archived: ArchivedMedia[] = [];
    for (const item of remote.results) {
      if (item.b64) {
        const bytes = base64ToBuffer(item.b64);
        archived.push(...await archiveInlineMedia({
          userId: user.id, projectId: id, taskId: task.id,
          items: [{ bytes, ext: imageExtOfBuffer(bytes) }],
        }).catch(() => [] as ArchivedMedia[]));
        continue;
      }
      if (item.url) {
        archived.push(...await archiveTaskMedia({
          userId: user.id, projectId: id, taskId: task.id,
          results: [{ url: item.url, outputType: 'image' }],
        }).catch(() => [] as ArchivedMedia[]));
      }
    }

    const results = archived.map(item => ({ url: item.url, outputType: 'image' as const }));
    if (!results.length) {
      await db.task.update({
        where: { id: task.id },
        data: { status: 'failed', error: '自定义接口返回了结果，但一张图都没能取回来（上游地址不可访问或格式不支持）。', completedAt: new Date() },
      });
      throw new ApiError(502, '自定义接口返回了结果，但一张图都没能取回来。');
    }

    const updated = await db.task.update({
      where: { id: task.id },
      data: { status: 'success', result: results as Prisma.InputJsonValue, completedAt: new Date() },
    });
    return Response.json({ taskId: updated.id, workflowId: workflowKey, status: 'success', results });
  });
}
