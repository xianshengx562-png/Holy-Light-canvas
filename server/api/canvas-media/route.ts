import { db } from '@/lib/db';
import { api, apiUser, ApiError, checkOrigin } from '@/lib/api';
import { archiveCanvasMedia, type ArchivedCanvasMedia } from '@/lib/canvas-media';

/**
 * 画布素材落盘（桌面版）：拖进画布 / 粘进画布 / 在节点上选的那份媒体。
 *
 * 与 `/api/tools/archive` 那一条是**两回事**，别合并：那条是「实用工具算出来的成品」，
 * 要进资产库让人找得到；这一条是画布上的**输入素材**，用户明确要求它**不进资产库**
 * （2026-10-08 徐先：「从外面添加的图片拉入画布会自动进入资产库，这个 bug 也修复」）。
 * 所以它走 `lib/canvas-media.ts`，一个 Asset 记录都不建。
 *
 * 落盘之后仍然能参与生成：`lib/referenceImages.ts` 认得 `/api/canvas-media/...` 这个形状，
 * 提交时照样读盘重传给上游 —— 「不进资产库」说的是**界面**，不是**不能用**。
 */
const maxFiles = 30;
const maxTotal = 240 * 1024 * 1024;

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data'))
      throw new ApiError(400, '请选择要保存的文件。');

    const form = await request.formData();
    const projectId = String(form.get('projectId') || '');
    if (!projectId) throw new ApiError(400, '先选一个项目 —— 素材要挂在具体项目下。');
    /* 归属必须查：projectId 是前端给的任意字符串。 */
    const project = await db.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
    if (!project) throw new ApiError(404, '项目不存在，或者不属于当前账号。');

    const files = form.getAll('file').filter((item): item is File => item instanceof File && item.size > 0);
    if (!files.length) throw new ApiError(400, '没有可保存的文件。');
    if (files.length > maxFiles) throw new ApiError(400, `一次最多存 ${maxFiles} 个。`);
    if (files.reduce((sum, file) => sum + file.size, 0) > maxTotal)
      throw new ApiError(413, '这一批太大了（上限 240 MB），少放几个再试。');

    const items: ArchivedCanvasMedia[] = [];
    for (const file of files) {
      /* 单个失败不拖垮整批。 */
      const saved = await archiveCanvasMedia({ userId: user.id, projectId, file });
      if (saved) items.push(saved);
    }
    if (!items.length) throw new ApiError(400, '一个都没存下来：可能是格式不支持，或者单个文件超过 120 MB。');
    return Response.json({ items, projectId, skipped: files.length - items.length });
  });
}
