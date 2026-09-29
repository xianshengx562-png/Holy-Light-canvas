import { api, apiUser, checkOrigin } from '@/lib/api';
import { cleanupOrphans, formatSize } from '@/lib/assets';

/**
 * 清掉磁盘上没有对应记录的落盘文件（孤儿文件）。
 *
 * 这些文件是各种失败留下的尾巴：
 *  - 删资产时 `unlink` 没成功（记录已删、文件留在盘上，见 `deleteAsset` 里的取舍）；
 *  - 落盘中途失败（`db.asset.create` 之后的写入 / 更新没走完）；
 *  - 测试脚本直接删库里的用户或资产，级联删记录但不碰磁盘。
 *
 * 记录没了就意味着 `/api/assets/{id}/media.*` 一定 404，所以删它们是安全的。
 * 路径**不接受调用方指定**，全部来自服务端自己扫目录的结果（见 `cleanupOrphans`）。
 *
 * `recent` 是「刚落盘、还没过安全期」而被跳过的文件数，会回给前端说明——它让
 * 「点完清理数字没归零」有个解释，而不是看起来像没生效。
 */
export async function DELETE(request: Request) {
  return api(async () => {
    checkOrigin(request);
    await apiUser();
    const result = await cleanupOrphans();
    return Response.json({
      removed: result.removed,
      bytes: result.bytes,
      sizeLabel: formatSize(result.bytes),
      failed: result.failed,
      recent: result.recent,
    });
  });
}
