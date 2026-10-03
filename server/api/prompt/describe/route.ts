import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import {
  PromptAssistantError, PROMPT_ASSISTANT_MAX, describePrompt, loadSkillForPrompt,
} from '@/lib/promptAssistant';
import { resolvePromptImage } from '@/lib/promptImage';
import { recordCall } from '@/lib/providers/keys';

/**
 * 看图反推提示词（2026-10-03 徐先）。
 *
 * 与 `/api/prompt/optimize` 是一对：那边收一句话，这边收**一张图的地址**，
 * 回来的都是一段能直接喂给生成模型的中文提示词。
 *
 * 🔴 客户端交的是**地址**不是字节：画布上那张图大概率是已落盘的资产
 * （`/api/assets/<id>/media.<ext>`），服务端读盘取字节（见 `lib/promptImage.ts`），
 * 一张 4MB 的图不至于在渲染进程里先转一次 5MB 的 base64 再发过来。
 *
 * 三种失败要说清是谁的问题：
 * - 地址取不到字节 / 格式不认 → 指向「换一张图」（400，来自 `resolvePromptImage`）；
 * - 一家文本模型都没配 → 指向「设置 · 模型服务」（503，照 AIFISHER）；
 * - 这家模型看不了图 → 指向「换一个多模态模型」（400，`MODEL_NOT_VISION`）。
 */
const schema = z.object({
  image: z.string().trim().max(2048),
  /** 设置页「测一下这家」时指定厂商；节点上不传，走用户设的那家。 */
  provider: z.string().trim().max(120).optional(),
  skillId: z.string().trim().max(160).optional(),
  /** 用户自己填的一句附加要求。与优化那条同一套规矩：**不限字数**。 */
  note: z.string().trim().max(PROMPT_ASSISTANT_MAX).optional(),
  keepAlive: z.number().finite()
    .refine(v => v === -1 || (v >= 0 && v <= 3600), '保活秒数只能是 -1（一直装载）或 0~3600。')
    .optional(),
});

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const parsed = schema.safeParse(await jsonBody(request, 64 * 1024));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    const startedAt = Date.now();
    try {
      const image = await resolvePromptImage(parsed.data.image, user.id);
      const result = await describePrompt(
        user.id,
        image,
        parsed.data.provider,
        loadSkillForPrompt(parsed.data.skillId),
        { keepAliveSeconds: parsed.data.keepAlive, note: parsed.data.note },
      );
      /* 与优化那条同一套记账规矩：本地那一档不记（没有服务商、不花额度）。 */
      if (result.provider !== 'local') {
        await recordCall({
          userId: user.id,
          provider: result.provider as 'glm',
          ok: true,
          latencyMs: Date.now() - startedAt,
        }).catch(() => undefined);
      }
      return Response.json(result);
    } catch (error) {
      if (error instanceof PromptAssistantError) {
        if (error.code !== 'LOCAL_MODEL_UNAVAILABLE') {
          await recordCall({
            userId: user.id,
            provider: 'glm',
            ok: false,
            errorMessage: error.message,
            latencyMs: Date.now() - startedAt,
          }).catch(() => undefined);
        }
        throw new ApiError(error.status, error.message);
      }
      throw new ApiError(502, error instanceof Error ? error.message : '反推提示词失败。');
    }
  });
}
