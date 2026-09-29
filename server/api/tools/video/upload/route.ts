import { db } from '@/lib/db';
import { api, ApiError, apiUser, checkOrigin } from '@/lib/api';
import { archiveUpload } from '@/lib/video-ffmpeg';

/**
 * 上传自己的视频 / 图片当素材。
 *
 * 与 `/api/tools/archive` 那条的差别只有两处：
 *  - 那边收的是「工具算出来的成品」，这里收的是**用户自己的素材**；
 *  - 那边只认魔数（认不出 mov / mkv / avi），这里先认扩展名再认魔数 ——
 *    否则「选了一个 .mov 却说格式不支持」这种话没法跟用户解释。
 *
 * 一样的是**落盘即入库**：上传完在资产库里就能再挑到它，不用传第二遍。
 */
const maxFiles = 20;
const maxTotal = 512 * 1024 * 1024;

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.startsWith('multipart/form-data')) throw new ApiError(400, '请选择要上传的文件。');

    /* ⚠️ `formData()` 只能读一次（body 是流）：先整包取出来，后面全用它。 */
    const form = await request.formData();
    const projectId = String(form.get('projectId') || '');
    if (!projectId) throw new ApiError(400, '先选一个项目 —— 上传的素材要挂在具体项目下。');
    /* 归属必须查：projectId 是前端给的任意字符串。 */
    const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!project) throw new ApiError(404, '项目不存在，或者不属于当前账号。');

    const files = form.getAll('file').filter((item): item is File => item instanceof File && item.size > 0);
    if (!files.length) throw new ApiError(400, '没有可上传的文件。');
    if (files.length > maxFiles) throw new ApiError(400, `一次最多 ${maxFiles} 个，分几批传。`);

    let bytes = 0;
    for (const file of files) bytes += file.size;
    if (bytes > maxTotal) throw new ApiError(413, '这一批超过 512 MB 了，少放几个再试。');

    const items: { id: string; url: string; name: string; size: number; type: string }[] = [];
    for (const file of files) {
      const saved = await archiveUpload({ userId: user.id, projectId, file });
      if (saved) items.push(saved);
    }
    if (!items.length) throw new ApiError(400, '一个都没存下来：可能是格式不支持（只认常见的视频与图片）。');
    return Response.json({ items, projectId, skipped: files.length - items.length });
  });
}
