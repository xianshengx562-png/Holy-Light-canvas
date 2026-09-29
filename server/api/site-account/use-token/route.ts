import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { useSiteToken } from '@/lib/providers/site';

/**
 * 把站点上**已有**的某一把密钥加成 Holy Light画布的兼容接口（2026-09-25）。
 *
 * 界面上那张清单里的 key 是**打码**的（`sk-AB**********xyzw`）——
 * 它只能给人看，真去调 `/v1/*` 一律 401。所以这里不收 key，只收
 * 站点令牌表里的 `id`，由后端去 `POST /api/token/<id>/key` 换完整密钥。
 *
 * `kind` 决定建出来的接口归到哪一段（图片 / 视频 / 文本），
 * 拉到的模型也就按这个用途归档 —— 与「在哪一段添加」是同一件事。
 */
const schema = z.object({
  /** 站点令牌表里的 id（不是 key）。 */
  tokenId: z.number().int().positive('令牌 id 不对。'),
  kind: z.enum(['image', 'video', 'text']),
});

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const parsed = schema.safeParse(await jsonBody(request));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    try {
      const created = await useSiteToken(user.id, parsed.data.tokenId, parsed.data.kind);
      return Response.json({ ok: true, provider: created });
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : '添加这把令牌失败。');
    }
  });
}
