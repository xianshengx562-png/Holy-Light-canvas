import { api, apiUser, ApiError, checkOrigin } from '@/lib/api';
import { archiveUploadedImage } from '@/lib/media';
import { findOrCreateStudioProject } from '@/lib/studio';
import { IMAGE2_MAX_REFERENCES } from '@/lib/workflows/image2Params';

/**
 * 主页图片生成板块的参考图上传：把图落成**固定项目**的资产，回 `/api/assets/…` 地址。
 *
 * 与画布那条路（`/api/providers/runninghub/upload`，传上去拿的是 24 小时过期的远端文件名）
 * 不同：这里的地址要同时喂给两条路 —— 同步出图那档服务端读盘取字节、工作流引擎服务端读盘后
 * 重传 —— 两边都认本站资产地址（`resolveReferenceImages` 那条路），所以必须落盘成资产。
 *
 * 项目也是 find-or-create 的固定项目：参考图和之后用它生成的图落在同一个项目下，
 * 资产库里才看得出「这批图是一回事」。上传成功但那次生成没发出去（用户删了缩略图 /
 * 改了主意）时，图会留在资产里 —— 和画布上传参考图的行为一致，不做回收。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    if (!(request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
      throw new ApiError(400, '参考图要用 multipart/form-data 上传。');
    }
    const form = await request.formData();
    const files = form.getAll('files')
      .filter((item): item is File => item instanceof File && item.size > 0)
      .slice(0, IMAGE2_MAX_REFERENCES);
    if (!files.length) throw new ApiError(400, '没有收到可用的图片。');

    const projectId = await findOrCreateStudioProject(user.id);
    const refs: string[] = [];
    for (const file of files) {
      const saved = await archiveUploadedImage({ userId: user.id, projectId, file });
      if (!saved) throw new ApiError(400, '参考图存不下来 —— 确认它是 PNG / JPEG / WebP / GIF，且大小正常。');
      refs.push(saved.url);
    }
    return Response.json({ projectId, refs });
  });
}
