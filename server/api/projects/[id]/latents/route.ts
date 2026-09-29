import { db } from '@/lib/db';
import { api, apiUser, ApiError, checkOrigin } from '@/lib/api';
import { archiveUserLatent, listProjectLatents } from '@/lib/latents';
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const user = await apiUser();
    const { id } = await params;
    const project = await db.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
    return Response.json({ latents: await listProjectLatents(id) });
  });
}

/**
 * 用户在画布上「上传 latent」挑的那份文件 —— 存进本项目的 latent 库，回 `asset:<id>`。
 *
 * 这里**不直传 RunningHub**：上传属于「把东西放进画布」，不该在没配 Key 的时候把节点废掉。
 * 存成本站资产之后，提交生成时 `/api/projects/[id]/generation` 里的 `resolveLatentValues()`
 * 会读盘重传（`asset:` 前缀就是为这条路准备的，节点上从 latent 库里挑的那一份走的也是它）。
 *
 * 于是「画布上放进任何东西」都不再依赖外部账号 —— 只有生成节点点了发送、
 * 且引擎选的是 RunningHub，才需要那个 Key。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const project = await db.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!project) throw new ApiError(404, '项目不存在，或者不属于当前账号。');
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data'))
      throw new ApiError(400, '请选择要上传的文件。');
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) throw new ApiError(400, '没有收到文件。');
    const saved = await archiveUserLatent({ userId: user.id, projectId: id, file });
    return Response.json(saved);
  });
}
