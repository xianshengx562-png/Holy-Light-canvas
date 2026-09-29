import { api, apiUser } from '@/lib/api';
import {
  ASSET_KINDS, listAssetCategories, listAssetProjects, listAssets, storageOverview,
  type AssetKind, type CategoryFilter,
} from '@/lib/assets';

/**
 * 资产列表（桌面版新增）。
 *
 * web 版这一页是服务端组件，直接在服务端调 `listAssets()`；桌面版没有服务端渲染，
 * 只能补一个接口。`?type=` / `?sub=` / `?project=` 三个筛选条件与页面上的筛选器一一对应。
 *
 * 一次最多 60 条，与页面上的 `PAGE_SIZE` 保持同一个数 ——
 * 两处不一致的表现是「明明有 80 项，却写着显示最近 60 项」这种对不上的话。
 */
const PAGE_SIZE = 60;

export async function GET(request: Request) {
  return api(async () => {
    const user = await apiUser();
    const params = new URL(request.url).searchParams;
    const rawType = params.get('type');
    const type = (ASSET_KINDS.find((kind) => kind.value === rawType)?.value || 'all') as AssetKind | 'all';
    const projectId = params.get('project') || '';
    /*
     * `?sub=` 是分类（**用户自己维护**的那张表，见 `/api/assets/categories`）。
     * 认不出的值一律当「全部」而不是报错：分类名是可以被删掉的，分享出去的旧链接里
     * 还留着它 —— 那种链接要能打开（显示空态），不能甩一个 400 给点链接的人。
     */
    const categories = await listAssetCategories(user.id);
    const rawSub = params.get('sub') ?? '';
    const known = rawSub === 'none' || categories.some((item) => item.name === rawSub);
    const category = (known ? rawSub : 'all') as CategoryFilter;

    const [assets, projects, storage] = await Promise.all([
      listAssets({ userId: user.id, type, category, projectId, take: PAGE_SIZE }),
      listAssetProjects(user.id),
      storageOverview(user.id),
    ]);
    return Response.json({ ...assets, projects, storage, categories });
  });
}
