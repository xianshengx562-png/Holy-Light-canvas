import { ApiError, api, apiUser } from '@/lib/api';
import { assetLocalPath } from '@/lib/assets';

/**
 * 这一条资产在**本机磁盘上的绝对路径**（2026-10-09 徐先：
 * 「怎么还有下载，这不是本地的吗，直接换成打开文件所在位置就行了吧」）。
 *
 * 为什么单开一条、而不是把 `path` 塞进 `/api/assets` 的列表返回：
 *   · 列表是一次拉六十行的，每行都要 `resolveStoredPath()` 摸一次盘（那个函数要逐个候选路径
 *     做存在性检查）—— 为了一颗**按下去才会用到**的字段，不值得给每张卡片都算一遍；
 *   · 绝对路径是本机信息，只在用户真的点了那颗按钮时才交出去，边界清楚。
 *
 * 找不到文件时 404：那种情况下资源管理器打开的是一个空目录，不如当场说清楚。
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const user = await apiUser();
    const { id } = await params;
    const file = await assetLocalPath({ assetId: id, userId: user.id });
    if (!file) throw new ApiError(404, '这条资产的文件已经不在磁盘上了。');
    return Response.json({ path: file });
  });
}
