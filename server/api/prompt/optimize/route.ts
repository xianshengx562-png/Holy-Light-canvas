import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import {
  PromptAssistantError, PROMPT_ASSISTANT_MAX, loadSkillForPrompt, optimizePrompt,
} from '@/lib/promptAssistant';
import { buildOptimizeInstruction, isFreeformSkill } from '@/lib/optimizeOptions';
import { recordCall } from '@/lib/providers/keys';

/**
 * 提示词优化（2026-09-21）。
 *
 * 节点上那个「优化提示词」按钮打的就是这里。它**不生成任何媒体** ——
 * 只把一句话扩写成一段能直接喂给图片 / 视频模型的中文提示词，
 * 所以走的是文本模型（设置页「官方大语言模型」那一栏给的就是它）。
 *
 * 两种失败要说清是谁的问题：
 * - 一句话都没填 → 提示他去填（400）；
 * - 一家文本模型都没配 → 明确指向「设置 · 模型服务」（503，照 AIFISHER 的
 *   `AI_CONFIGURATION_REQUIRED`）。**别含糊成「优化失败」** —— 用户会以为是这句话有问题。
 */
const schema = z.object({
  prompt: z.string().trim().max(PROMPT_ASSISTANT_MAX),
  /** 设置页「测一下这家」时指定厂商；节点上不传，走用户设的那家。 */
  provider: z.string().trim().max(120).optional(),
  /**
   * 技能 id（就是目录名 slug，dock 上「优化提示词」旁边选的那个）。
   * 给了就把那个技能的写法规范一起塞进 system —— 优化出来的提示词得是**那个技能**
   * 要的格式，不然用户选它干嘛。
   *
   * 🔴 留空与哨兵 `__free__` 是**两档**（2026-10-08 徐先）：留空 = 不指定技能，
   * 但仍走通用写法那套补全规矩；哨兵 = 连那套规矩也不套，只按「补充要求」写。
   * 见 `lib/optimizeOptions.ts` 里 `OPTIMIZE_SKILL_FREE` 那条注释。
   */
  skillId: z.string().trim().max(160).optional(),
  /**
   * 走本地模型时跑完**卸不卸**（2026-09-26，节点上那两档）。
   * `-1` = 一直装载（等用户手动卸载）；`0` = 写完立刻卸；正数 = 过这么些秒再卸。
   * 不传 = 跟着设置里的「保活秒数」—— 设置页「测一下」走的就是这条路。
   */
  /**
   * 改写幅度（2026-09-29）：`light` 轻度润色 / `standard` 标准补全 / `heavy` 重度扩写。
   * 不传 = 用户没选过 —— **不要替他默认成 standard**：老节点上没这个字段，
   * 替它们塞一句等于悄悄改了所有老画布的优化结果。认不出的值同样当「没选过」。
   */
  strength: z.string().trim().max(20).optional(),
  /**
   * 用户自己填的一句附加要求（如「保持中文」「不要写镜头语言」）。
   * 🔴 **不限字数**（2026-09-29 徐先定的）：这里原来有 `.max(OPTIMIZE_NOTE_MAX)`，
   * 现在整条去掉 —— 前端也去掉了 `maxLength`，两边都不截，免得「界面上能写、送出去被切」。
   */
  note: z.string().trim().optional(),
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
      /*
       * 「什么都不填」那一档（2026-10-08）：`skillId` 里装的是哨兵值，它**不是**一个技能。
       * 直接喂给 `loadSkillForPrompt` 也能跑（拿不到技能就退回通用写法），
       * 但那样就把「用户明确选了什么都不填」这个信息丢了 —— 必须先在这里认出来。
       */
      const freeform = isFreeformSkill(parsed.data.skillId);
      const result = await optimizePrompt(
        user.id,
        parsed.data.prompt,
        parsed.data.provider,
        loadSkillForPrompt(freeform ? undefined : parsed.data.skillId),
        {
          keepAliveSeconds: parsed.data.keepAlive,
          freeform,
          /* 拼成一段指令在这里做：**只写一份**（`lib/optimizeOptions.ts`），
             界面与后端看到的是同一句话，不会出现「界面说是轻度、发出去的是标准」。
             🔴 freeform 时**不传 strength**：强度那句本身就是一套「补全 / 扩写」的
             写法规矩，留着它这一档就等于没选 —— 只留补充要求。 */
          instruction: buildOptimizeInstruction({
            strength: freeform ? undefined : parsed.data.strength,
            note: parsed.data.note,
          }),
        },
      );
      /*
       * 记一笔流水：文本调用同样要能被「最近三十天跑了几次」看见。
       *
       * ⚠️ **本地模型不记**：那套流水是按「服务商」聚合的（谁家跑了几次、Key 额度还剩多少），
       * 而本地没有服务商、不花额度、也没有 Key 可轮换 —— 写进去只会在用量里多出一行
       * 看不懂的 `local`。
       */
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
        /* 本地那一档的失败同样不记：它的失败原因是本机环境（没模型 / 缺运行库），不是服务商。 */
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
      throw new ApiError(502, error instanceof Error ? error.message : '提示词优化失败。');
    }
  });
}
