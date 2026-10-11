import { api, ApiError, apiUser, checkOrigin, jsonBody } from '@/lib/api';
import { cutSegments, probeSegmentable, resolveSplitMaterial } from '@/lib/video-ffmpeg';

/**
 * 分段：把一条素材（视频 / 音频）按给定的起止切成 N 段，逐段入库。
 *
 * 两种模式（**模式是前端的事** —— 前端用 `splitPlan()` 算出起止，这里只认起止）：
 *   · 每段统一：前端按「总长 ÷ 每段秒数」算出来一串等长的段；
 *   · 自定义：前端按用户填的那串（`"10, 5, 20"`）算。
 * 判据放在前端算而不是这里算，是因为卡片上**还没切就要显示段列表**
 * （「会切成 6 段：0-10 / 10-20 / …」），那时候不能先跑一趟接口。
 *
 * 🔴 收的是**素材的「本机落盘」标识与起止**，不是文件路径 —— 路径由
 * `resolveSplitMaterial()` 自己查，渲染进程没有机会让 ffmpeg 去读盘上别的地方。
 *
 * 「本机落盘」有两种（`resolveSplitMaterial` 两支都认，2026-10-11 补的第二支）：
 *   · **资产 id**（`/api/assets/<id>/…` 那种地址里的 id）—— 生成出来的成果；
 *   · **画布素材地址**（`/api/canvas-media/<项目>/<uuid>.<ext>`）—— 拖 / 粘进画布的素材。
 *     它刻意不建 Asset 记录（见 `lib/canvas-media.ts` 的说明），所以只认资产 id 的那支
 *     查不到它 —— 「必须存进资产库才能切」就是这么来的，不是产品规矩。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const body = await jsonBody(request, 16384);
    /* `assetId` 是旧名（`split_probe.js` 还在用）；两支等价，都收。 */
    const source = String(body.source ?? body.assetId ?? '').trim();
    const projectId = String(body.projectId ?? '').trim();
    if (!source) throw new ApiError(400, '没有要给分的素材。');
    if (!projectId) throw new ApiError(400, '没有指定项目。');

    const raw = Array.isArray(body.segments) ? body.segments : [];
    const segments = raw
      .map((item: { index?: number; start?: number; end?: number }) => ({
        index: Number(item?.index) || 0,
        start: Number(item?.start) || 0,
        end: Number(item?.end) || 0,
      }))
      .filter((item: { index: number; start: number; end: number }) => item.end > item.start)
      .slice(0, 10);

    const material = await resolveSplitMaterial(source, user.id, projectId);
    const probe = await probeSegmentable(material.path);
    if (probe.kind === 'image') throw new ApiError(400, '这是一张图片 —— 只能给视频或音频分段。');
    /*
     * **没给段 = 只探一下**（卡片要拿总长预测「会切成几段」，那时候一次 ffmpeg 都还不该跑）。
     * 这一步单独存在，是因为 ffprobe 探一次几十毫秒，而切一次是每段一遍 ffmpeg ——
     * 让「填每段几秒」这种高频动作先跑个便宜的，是这里唯一划算的拆法。
     */
    if (!segments.length) {
      return Response.json({
        source, duration: probe.duration,
        media: probe.kind === 'audio' ? 'audio' : 'video',
        segments: [],
      });
    }
    /* `cutSegments` 内部会再探一次：它要拿分辨率 / 有没有音轨决定 ffmpeg 参数。 */
    const items = await cutSegments({ userId: user.id, projectId, assetId: source, segments });
    return Response.json({
      source,
      duration: probe.duration,
      media: probe.kind === 'audio' ? 'audio' : 'video',
      segments: items,
    });
  });
}
