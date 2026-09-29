import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { probeCustomProvider, readCustomCredentials } from '@/lib/providers/custom';

/**
 * 探活一条自定义接口（`GET ${baseUrl}/models`）。
 *
 * 两种用法：
 * - **带 id**：测已经存好的那条（用库里的 Key，表单里不用再填一遍）；
 * - **不带 id**：填完表单还没保存时先试一下（用请求体里的 Key）。
 *
 * 拉到的模型清单**顺手写回**那条记录（保留用户手动改过的用途档位）——
 * 探活和拉清单本来就是同一个请求，没必要让人点两次。
 */
const schema = z.object({
  id: z.string().trim().max(120).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  apiKey: z.string().trim().max(1000).optional(),
  /** 在「图片 / 视频 / 文本」哪一段点的拉取 —— 新拉到的模型默认就是这个用途。 */
  kind: z.enum(['image', 'video', 'text']).optional(),
});

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const parsed = schema.safeParse(await jsonBody(request, 8192));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    const input = parsed.data;
    const defaultKind = input.kind;
    if (input.id) {
      const creds = await readCustomCredentials(user.id, input.id);
      if (!creds) throw new ApiError(404, '这条自定义接口不存在，或者它的 Key 解不开。');
      return Response.json(await probeCustomProvider({
        userId: user.id, id: input.id, baseUrl: creds.baseUrl, apiKey: creds.apiKey, defaultKind,
      }));
    }
    return Response.json(await probeCustomProvider({
      baseUrl: input.baseUrl || '', apiKey: input.apiKey || '', defaultKind,
    }));
  });
}
