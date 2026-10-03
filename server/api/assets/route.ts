import { api, apiUser } from '@/lib/api';
import {
  ASSET_KINDS, countAssetsOfKind, listAssetCategories, listAssetProjects, listAssets,
  pruneMissingAssets, storageOverview, type AssetKind, type CategoryFilter,
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

/**
 * 列之前先自动收掉「文件已经没了」的记录（2026-10-03 徐先：「没有的图就自动删除记录」）。
 *
 * 挂在这里的理由：这一页（以及生成页的历史栏，它读的也是这个接口）**就是用户看到坏图的地方**
 * —— 在列表里看到一张点不开的图，这句话是在说「这个列表本身该干净」。
 *
 * 🔴 **必须在 `Promise.all` 之前 await**：`storageOverview()` 也在那个 `Promise.all` 里，
 *    它算的正是「N 条记录的文件已不在磁盘上」那个数。放到后面就是「先报 3 条坏了、
 *    再悄悄删掉 3 条」—— 用户看到的数字是清理前的，下一刷又变，像在抽风。
 *
 * 🔴 范围跟着**当前这次查询**走（用户 + 有 `?project=` 时限定那个项目）：
 *    用户正在看的这一批自己会干净，不会顺手把别的项目的记录也动了。
 *
 * ⚠️ 这是 GET 里带写操作。可以接受的理由：它删的东西**已经被证明是死的**
 *    （文件早没了，取流地址一定 404），而且有三道闸门兜着（见 `lib/assets.ts`）。
 *    换来的是一条不需要用户理解、也不需要他点任何按钮的清理。
 */
async function autoPrune(userId: string, projectId: string) {
  try {
    await pruneMissingAssets({ userId, projectId: projectId || undefined });
  } catch {
    /* 清理失败不该让列表打不开 —— 大不了这一轮坏图还在，下次再收。 */
  }
}

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

    /* 先收掉幽灵记录，再列 —— 顺序不能反，见 `autoPrune` 那段。 */
    await autoPrune(user.id, projectId);

    const [assets, projects, storage, latentCount] = await Promise.all([
      listAssets({ userId: user.id, type, category, projectId, take: PAGE_SIZE }),
      listAssetProjects(user.id),
      storageOverview(user.id),
      /* 给「一键删除 Latent」那颗按钮用：没有 latent 时按钮不出现。 */
      countAssetsOfKind(user.id, 'latent'),
    ]);
    return Response.json({ ...assets, projects, storage, categories, latentCount });
  });
}
