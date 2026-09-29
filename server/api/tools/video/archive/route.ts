import { db } from '@/lib/db';
import { api, ApiError, apiUser, checkOrigin, jsonBody } from '@/lib/api';
import { archiveLocalFile, job } from '@/lib/video-ffmpeg';

/**
 * 把刚拼好的成品存进资产库。
 *
 * ⚠️ 收的是**任务号**而不是文件路径：成品路径由后端自己记着（任务表里那条 `output`），
 * 收路径就等于让渲染进程指哪拷哪 —— 一个改过的包能把盘上任意文件搬进资产库。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const body = await jsonBody(request);
    const id = String(body.id ?? '').trim();
    const projectId = String(body.projectId ?? '').trim();
    if (!id) throw new ApiError(400, '没有给任务号。');
    if (!projectId) throw new ApiError(400, '先选一个项目 —— 成品要挂在具体项目下。');

    const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!project) throw new ApiError(404, '项目不存在，或者不属于当前账号。');

    const found = job(id);
    if (!found || found.state !== 'done' || !found.output) {
      throw new ApiError(400, '这一批还没有导出成功 —— 先跑一次导出。');
    }
    const saved = await archiveLocalFile({
      userId: user.id,
      projectId,
      filePath: found.output,
      name: String(body.name ?? '').trim(),
    });
    return Response.json({ ...saved, projectId });
  });
}
