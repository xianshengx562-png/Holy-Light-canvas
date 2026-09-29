import { api, ApiError, apiUser } from '@/lib/api';
import { framePng, probeFile, resolveMaterial } from '@/lib/video-ffmpeg';

/**
 * 抽一帧当预览图。
 *
 * ⚠️ 必须**由 ffmpeg 抽**而不能让浏览器用 `<video>` 自己 seek：
 * 界面上的帧号和导出的 `trim=start_frame=N` 是同一个编号体系，
 * 换成浏览器的 `currentTime` 就会差一帧 —— 「看着是这帧，切出来是下一帧」。
 *
 * 图片素材也走这里（`-ss` 那一段跳过），顺手把超大图压到 960 宽。
 */
export async function GET(request: Request) {
  return api(async () => {
    const user = await apiUser();
    const params = new URL(request.url).searchParams;
    const assetId = String(params.get('asset') || '').trim();
    if (!assetId) throw new ApiError(400, '没有给素材。');
    const frame = Math.max(0, Math.floor(Number(params.get('frame') || 0)) || 0);

    const material = await resolveMaterial(assetId, user.id);
    const probe = await probeFile(material.path);
    const png = await framePng({
      file: material.path,
      kind: probe.kind,
      fps: probe.fps,
      frame,
      cacheKey: `${assetId}-${probe.kind}-${frame}`,
    });
    return new Response(new Uint8Array(png), {
      headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=600' },
    });
  });
}
