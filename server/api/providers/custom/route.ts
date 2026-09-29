import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import {
  createCustomProvider, listCustomModelOptions, listCustomProviders, readModels,
  CUSTOM_MODEL_BODY_BYTES, CUSTOM_MODEL_LIMIT,
} from '@/lib/providers/custom';

/**
 * 自定义接口的列表与新增（2026-09-21）。
 *
 * 两条规矩：
 * - **Key 只进不出**：列表里永远只有掩码，明文从这一层就不往回带；
 * - **新增即探活**：加了不给个准信，用户不知道是自己填错了还是这家不兼容，
 *   等到在节点上生成才失败，那时候已经分不清是接口的问题还是参数的问题。
 */
export async function GET() {
  return api(async () => {
    const user = await apiUser();
    return Response.json({
      providers: await listCustomProviders(user.id),
      models: {
        image: await listCustomModelOptions(user.id, 'image'),
        video: await listCustomModelOptions(user.id, 'video'),
        text: await listCustomModelOptions(user.id, 'text'),
      },
    });
  });
}

const createSchema = z.object({
  name: z.string().trim().min(1, '接口名称不能为空。').max(60),
  baseUrl: z.string().trim().min(1, '接口地址不能为空。').max(500),
  apiKey: z.string().trim().min(1, 'API Key 不能为空。').max(1000),
  /** 手动指定模型清单时用；留空则保存后自己点「拉取模型」。 */
  models: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().max(200).optional(),
    /** 用途多选。老调用方还在传单选的 `kind`，两种都收。 */
    kinds: z.array(z.enum(['image', 'video', 'text'])).max(3).optional(),
    kind: z.enum(['image', 'video', 'text']).optional(),
  })).max(CUSTOM_MODEL_LIMIT).optional(),
  enabled: z.boolean().optional(),
  /** 从「图片 / 视频 / 文本」哪一段加的 —— 没单独指定用途的模型按这个归档。 */
  defaultKind: z.enum(['image', 'video', 'text']).optional(),
});

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    /*
     * ⚠️ 这条接口要带**一整个模型清单**上来（中转站一次能报几百个），
     * 8KB 的旧上限在这里会直接报「请求内容过长」—— 拉到了却存不进去。
     */
    const parsed = createSchema.safeParse(await jsonBody(request, CUSTOM_MODEL_BODY_BYTES));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    const input = parsed.data;
    if (!/^https?:\/\//i.test(input.baseUrl)) {
      throw new ApiError(400, '接口地址要以 http:// 或 https:// 开头。');
    }
    try {
      const created = await createCustomProvider(user.id, {
        name: input.name,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        enabled: input.enabled ?? true,
        models: input.models
          ? readModels(input.models.map(item => ({ id: item.id, name: item.name || item.id, kinds: item.kinds, kind: item.kind ?? input.defaultKind })))
          : [],
      });
      return Response.json(created);
    } catch (error) {
      /** 重名那句是直接给用户看的，别包一层「创建失败」。 */
      throw new ApiError(400, error instanceof Error ? error.message : '保存自定义接口失败。');
    }
  });
}
