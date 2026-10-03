import { api, apiUser, ApiError, checkOrigin } from '@/lib/api';
import { archiveUploadedMedia } from '@/lib/media';
import { db } from '@/lib/db';
import { createProject } from '@/lib/projects';

/**
 * 资产页手动上传（2026-09-25 徐先：按钮选图 + 直接把图拖进页面；2026-10-03 起也收视频）。
 *
 * 与 `studio/upload`（参考图）同一条落盘路 —— 只是这里走「图片 **和** 视频」那一档
 * （`archiveUploadedMedia({ allow: 'media' })`），因为资产库要的就是素材本身：
 * 一段导入进来的视频同样要能被超清（那正是这个功能存在的理由）。
 *
 * 差别在挂靠的项目：
 *   - 前端正筛在某个项目里（地址栏带 `?project=`）→ 落那个项目（先验归属）；
 *   - 否则落 find-or-create 的固定项目 —— 与 studio 固定项目同一套思路，
 *     拖进来的东西在资产库里能看出「这是一批手动传的」。
 */
const UPLOADS_PROJECT_NAME = '上传的素材';
/**
 * 老项目名（只有图片那会儿起的）。**已有的继续复用**：改名不该把一个用户攒的素材
 * 劈成两个项目，所以先找新名、再找老名，都没有才建新名。
 */
const LEGACY_UPLOADS_PROJECT_NAME = '上传的图片';
/** 一次最多收多少个：拖一整屏文件进来也不至于把请求撑爆。 */
const MAX_FILES = 20;

/** 找「手动上传」落点：新名优先、老名兜底，都没有才建。顺带把名字带回去给界面用。 */
async function uploadsProject(userId: string): Promise<{ id: string; name: string }> {
  const find = (name: string) => db.project.findFirst({
    where: { userId, name },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, name: true },
  });
  const hit = (await find(UPLOADS_PROJECT_NAME)) ?? (await find(LEGACY_UPLOADS_PROJECT_NAME));
  if (hit) return hit;
  const created = await createProject(userId, UPLOADS_PROJECT_NAME);
  return { id: created.id, name: UPLOADS_PROJECT_NAME };
}

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
    if (!files.length) throw new ApiError(400, '没有收到可用的文件。');

    const wanted = String(form.get('projectId') || '');
    let projectId = '';
    let projectName = '';
    if (wanted) {
      const owned = await db.project.findFirst({
        where: { id: wanted, userId: user.id },
        select: { id: true, name: true },
      });
      if (!owned) throw new ApiError(404, '目标项目不存在。');
      projectId = owned.id;
      projectName = owned.name;
    } else {
      const home = await uploadsProject(user.id);
      projectId = home.id;
      projectName = home.name;
    }

    const items: { id: string; url: string; name: string; type: string }[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      const saved = await archiveUploadedMedia({
        userId: user.id, projectId, file, source: 'assets-page-upload', allow: 'media',
      });
      if (!saved) { skipped.push(file.name); continue; }
      items.push({ id: saved.id, url: saved.url, name: saved.name, type: saved.type });
    }
    if (!items.length) {
      throw new ApiError(400, '这些文件都没存下来 —— 只收图片（PNG / JPEG / WebP / GIF）和视频（MP4 / WebM / MOV），单个不超过 120 MB。');
    }
    return Response.json({ projectId, projectName, saved: items.length, items, skipped });
  });
}
