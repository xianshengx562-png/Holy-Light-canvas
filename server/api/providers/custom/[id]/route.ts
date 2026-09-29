import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import {
  deleteCustomProvider, readModels, setCustomModelKinds, updateCustomProvider,
  CUSTOM_MODEL_BODY_BYTES, CUSTOM_MODEL_LIMIT,
} from '@/lib/providers/custom';

/** 改一条自定义接口。**改不到（不是你的 / 不存在）按 404 回**，与资产那套惯例一致。 */
const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  baseUrl: z.string().trim().min(1).max(500).optional(),
  /**
   * 留空 / 不传 = **沿用原来那把 Key**。
   * 编辑表单里那格空白的含义必须是「不改」，否则改名一次就把 Key 清成空串 ——
   * 界面上还显示着「已配置」，一跑就 401。
   */
  apiKey: z.string().trim().max(1000).optional(),
  models: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().max(200).optional(),
    /** 用途多选（`kinds`）；老的单选 `kind` 也还收。 */
    kinds: z.array(z.enum(['image', 'video', 'text'])).max(3).optional(),
    kind: z.enum(['image', 'video', 'text']).optional(),
  })).max(CUSTOM_MODEL_LIMIT).optional(),
  enabled: z.boolean().optional(),
  /** 单独改某个模型的用途。**多选** —— 传几个就是几个用途（至少留一个）。 */
  modelKinds: z.object({
    modelId: z.string().trim().min(1).max(200),
    kinds: z.array(z.enum(['image', 'video', 'text'])).min(1).max(3),
  }).optional(),
});

export type CustomPatchParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: CustomPatchParams) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    /* 同上：改一条接口时也要能带回一整个模型清单（「拉取模型」之后存的就是它）。 */
    const parsed = patchSchema.safeParse(await jsonBody(request, CUSTOM_MODEL_BODY_BYTES));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    const input = parsed.data;
    if (input.baseUrl !== undefined && !/^https?:\/\//i.test(input.baseUrl)) {
      throw new ApiError(400, '接口地址要以 http:// 或 https:// 开头。');
    }
    try {
      if (input.modelKinds) {
        const view = await setCustomModelKinds(user.id, id, input.modelKinds.modelId, input.modelKinds.kinds);
        if (!view) throw new ApiError(404, '这条自定义接口不存在。');
        return Response.json(view);
      }
      const view = await updateCustomProvider(user.id, id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        ...(input.models !== undefined
          ? { models: readModels(input.models.map(item => ({ id: item.id, name: item.name || item.id, kinds: item.kinds, kind: item.kind }))) }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      });
      if (!view) throw new ApiError(404, '这条自定义接口不存在。');
      return Response.json(view);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, error instanceof Error ? error.message : '保存失败。');
    }
  });
}

export async function DELETE(request: Request, { params }: CustomPatchParams) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const ok = await deleteCustomProvider(user.id, id);
    if (!ok) throw new ApiError(404, '这条自定义接口不存在。');
    return Response.json({ ok: true });
  });
}
