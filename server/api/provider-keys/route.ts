import { z } from 'zod';
import { ApiError, api, apiUser, checkOrigin, jsonBody } from '@/lib/api';
import { createKey } from '@/lib/providers/keys';
import { isProviderId, providerMeta } from '@/lib/providers/registry';

/**
 * 往密钥池里加一把 key ——「设置 · 模型服务」里填各家 key 走的就是这里。
 *
 * ⚠️ 这里原来还有一个 GET：一次把「服务商列表 + 已存的 key + 用量摘要」全给齐，
 * 那一份是给「设置 · 密钥中心」那一页的；那一页 2026-09-25 整页撤了，GET 跟着一起走。
 */

const createSchema = z.object({
  provider: z.string().trim().min(1),
  label: z.string().trim().max(60).optional(),
  apiKey: z.string().trim().min(8, 'API Key 太短了，请检查是不是复制全了。').max(500),
  baseUrl: z.string().trim().max(500).optional(),
  model: z.string().trim().max(200).optional(),
  /** ISO 日期串；空串 / 缺省 = 不设到期日。 */
  expiresAt: z.string().trim().max(40).optional(),
});

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const parsed = createSchema.safeParse(await jsonBody(request, 8192));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    const input = parsed.data;
    if (!isProviderId(input.provider)) throw new ApiError(400, `未知的服务商：${input.provider}`);
    const meta = providerMeta(input.provider)!;
    /** 只有池子里的两家支持新增 —— 另两家各有自己的历史连接，从这儿加会变成两处打架。 */
    if (meta.storage !== 'pool') {
      throw new ApiError(400, `${meta.label} 走的是它自己的连接设置，请到对应的区块里改。`);
    }
    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      const parsedDate = new Date(input.expiresAt);
      if (Number.isNaN(parsedDate.getTime())) throw new ApiError(400, '到期日期看不懂，请换个写法。');
      expiresAt = parsedDate;
    }
    return Response.json(await createKey(user.id, {
      provider: input.provider,
      label: input.label ?? '',
      apiKey: input.apiKey,
      baseUrl: input.baseUrl ?? '',
      model: input.model ?? '',
      expiresAt,
    }));
  });
}
