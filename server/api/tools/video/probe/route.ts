import { api, ApiError, apiUser, checkOrigin, jsonBody } from '@/lib/api';
import { probeFile, resolveMaterial } from '@/lib/video-ffmpeg';

/**
 * 读素材的宽高 / 帧率 / 帧数 / 有没有音轨。
 *
 * 收的是**资产 id** 而不是路径 —— 路径由 `resolveMaterial()` 从库里拿出来，
 * 渲染进程没有机会让它去读盘上别的地方。
 *
 * 一次可以给好几个（`assetIds`），省得「从资产库勾了五段」要发五个请求。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const body = await jsonBody(request, 16384);
    const raw = Array.isArray(body.assetIds) ? body.assetIds : [body.assetId];
    const ids = raw.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 60);
    if (!ids.length) throw new ApiError(400, '没有要给读的素材。');

    /* 两种行会长得不一样（成功的带探测结果，失败的只有一句原因），所以给个宽松的行类型。 */
    const items: { assetId: string; error?: string; [key: string]: unknown }[] = [];
    for (const assetId of ids) {
      try {
        const material = await resolveMaterial(assetId, user.id);
        const probe = await probeFile(material.path);
        items.push({ assetId, name: material.name, type: probe.kind, url: material.url, ...probe });
      } catch (error) {
        /* 一个读不出来不拖垮整批：界面上按名字如实报出来，剩下的照常加进列表。 */
        items.push({ assetId, error: error instanceof Error ? error.message : '读不出来。' });
      }
    }
    return Response.json({ items });
  });
}
