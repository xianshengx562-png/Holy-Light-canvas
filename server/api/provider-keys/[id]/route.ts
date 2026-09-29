import { z } from 'zod';
import { ApiError, api, apiUser, checkOrigin, jsonBody } from '@/lib/api';
import { deleteKey, readKey, updateKey } from '@/lib/providers/keys';

/** 越权一律回 404：回 403 等于替对方确认「这把 key 存在，只是不是你的」。 */
const NOT_FOUND = '找不到这把密钥。';

const patchSchema = z.object({
  label: z.string().trim().max(60).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  model: z.string().trim().max(200).optional(),
  enabled: z.boolean().optional(),
  /** `null` = 清掉到期日。 */
  expiresAt: z.string().trim().max(40).nullable().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const parsed = patchSchema.safeParse(await jsonBody(request, 8192));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    const input = parsed.data;
    let expiresAt: Date | null | undefined;
    if (input.expiresAt !== undefined) {
      if (input.expiresAt === null || input.expiresAt === '') expiresAt = null;
      else {
        const parsedDate = new Date(input.expiresAt);
        if (Number.isNaN(parsedDate.getTime())) throw new ApiError(400, '到期日期看不懂，请换个写法。');
        expiresAt = parsedDate;
      }
    }
    const updated = await updateKey(user.id, id, {
      label: input.label,
      baseUrl: input.baseUrl,
      model: input.model,
      enabled: input.enabled,
      expiresAt,
    });
    if (!updated) throw new ApiError(404, NOT_FOUND);
    return Response.json(updated);
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    /**
     * 用量流水是按 keyId 记的，**不建外键**正是为了删了 key 还能对上历史账。
     * 所以这里直接删，不做引用检查 —— 拦下来的话管理员就永远清不掉一把废 key。
     */
    if (!(await deleteKey(user.id, id))) throw new ApiError(404, NOT_FOUND);
    return Response.json({ ok: true });
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const user = await apiUser();
    const { id } = await params;
    const row = await readKey(user.id, id);
    if (!row) throw new ApiError(404, NOT_FOUND);
    return Response.json(row);
  });
}
