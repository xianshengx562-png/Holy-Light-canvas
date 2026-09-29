import { db } from '@/lib/db';
import { api, apiUser, ApiError, checkOrigin } from '@/lib/api';
import { archiveToolMedia } from '@/lib/media';

/**
 * 实用工具的成品入库（桌面版）。
 *
 * 三个工具（图片分割 / 格式转换 / 运镜效果）产出的是**浏览器里算出来的 Blob**，
 * 渲染进程没有写文件的权限，也没有 node —— 只能交回主进程落盘。
 * 所以这一层做的事很窄：验身份 → 验项目归属 → 逐个写盘 → 回 URL。
 *
 * ⚠️ 每个都走 `archiveToolMedia()`，不自己拼写文件的代码：那条路径里
 * 「先写文件再插记录」「扩展名认魔数不认文件名」都是硬要求，复制一份过来
 * 迟早会长歪（详见 `lib/media.ts` 的注释）。这里只多传一个 `source`，
 * 让资产库能区分「用户上传的参考图」和「工具算出来的成品」。
 *
 * 收的是**媒体**而不是「图片」：运镜效果出来的是 WebM / MP4，走图片那条路会被挡掉。
 */
const maxFiles = 60;
/** 单张上限跟着 `archiveUploadedImage` 走，这里再压一道总量，防止一次把内存吃掉。 */
const maxTotal = 240 * 1024 * 1024;

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data'))
      throw new ApiError(400, '请选择要保存的文件。');
    const contentType = request.headers.get('content-type')!;

    /* 边读边数：先把体积卡住再 parse，免得一个大包先进内存。 */
    if (!request.body) throw new ApiError(400, '上传内容为空。');
    const chunks: Uint8Array[] = [];
    const reader = request.body.getReader();
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxTotal) {
        await reader.cancel();
        throw new ApiError(413, '这一批太大了（上限 240 MB），少放几个再试。');
      }
      chunks.push(value);
    }
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } }).formData();

    const projectId = String(form.get('projectId') || '');
    if (!projectId) throw new ApiError(400, '先选一个项目 —— 成品要挂在具体项目下。');
    /* 归属必须查：projectId 是前端给的任意字符串，不验的话能往别人的项目里塞图。 */
    const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!project) throw new ApiError(404, '项目不存在，或者不属于当前账号。');

    const files = form.getAll('file').filter((item): item is File => item instanceof File && item.size > 0);
    if (!files.length) throw new ApiError(400, '没有可保存的文件。');
    if (files.length > maxFiles) throw new ApiError(400, `一次最多存 ${maxFiles} 个，试着少切几格或分批转正。`);

    const items: { id: string; url: string; name: string; size: number; type: string }[] = [];
    for (const file of files) {
      /* 单个失败不拖垮整批 —— 最后按实际入库数量如实汇报。 */
      const saved = await archiveToolMedia({ userId: user.id, projectId, file, source: 'tool-output' });
      if (saved) items.push(saved);
    }
    if (!items.length) throw new ApiError(400, '一个都没存下来：可能是格式不支持，或者单个文件超过 120 MB。');
    return Response.json({ items, projectId, skipped: files.length - items.length });
  });
}
