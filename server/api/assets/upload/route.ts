import { api, apiUser, ApiError, checkOrigin } from '@/lib/api';
import { archiveUploadedImage } from '@/lib/media';
import { db } from '@/lib/db';
import { createProject } from '@/lib/projects';

/**
 * 资产页手动上传（2026-09-25 徐先：按钮选图 + 直接把图拖进页面）。
 *
 * 与 `studio/upload`（参考图）同一条落盘路 —— `archiveUploadedImage()`，只收
 * PNG / JPEG / WebP / GIF，存成正式资产。差别在挂靠的项目：
 *   - 前端正筛在某个项目里（地址栏带 `?project=`）→ 图落那个项目（先验归属）；
 *   - 否则落 find-or-create 的固定项目「上传的图片」—— 与 studio 固定项目同一套
 *     思路，拖进来的图在资产库里能看出「这是一批手动传的」。
 */
const UPLOADS_PROJECT_NAME = '上传的图片';
/** 一次最多收多少张：拖一整屏文件进来也不至于把请求撑爆。 */
const MAX_FILES = 20;

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    if (!(request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
      throw new ApiError(400, '上传要用 multipart/form-data。');
    }
    const form = await request.formData();
    const files = form.getAll('files')
      .filter((item): item is File => item instanceof File && item.size > 0)
      .slice(0, MAX_FILES);
    if (!files.length) throw new ApiError(400, '没有收到可用的图片。');

    const wanted = String(form.get('projectId') || '');
    let projectId = '';
    if (wanted) {
      const owned = await db.project.findFirst({
        where: { id: wanted, userId: user.id },
        select: { id: true },
      });
      if (!owned) throw new ApiError(404, '目标项目不存在。');
      projectId = owned.id;
    } else {
      const existing = await db.project.findFirst({
        where: { userId: user.id, name: UPLOADS_PROJECT_NAME },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });
      projectId = existing?.id ?? (await createProject(user.id, UPLOADS_PROJECT_NAME)).id;
    }

    const items: { id: string; url: string; name: string }[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      const saved = await archiveUploadedImage({
        userId: user.id, projectId, file, source: 'assets-page-upload',
      });
      if (!saved) { skipped.push(file.name); continue; }
      items.push({ id: saved.id, url: saved.url, name: saved.name });
    }
    if (!items.length) {
      throw new ApiError(400, '这些文件都没存下来 —— 只收 PNG / JPEG / WebP / GIF 图片。');
    }
    return Response.json({ projectId, saved: items.length, items, skipped });
  });
}
