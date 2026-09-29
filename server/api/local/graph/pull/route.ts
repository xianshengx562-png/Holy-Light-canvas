import { api, apiUser, checkOrigin } from '@/lib/api';
import { readLocalCredentials } from '@/lib/providers/local/connection';
import { pullLatestLocalGraph } from '@/lib/providers/local/discovery';

/**
 * 从**正在运行的** ComfyUI 抓最近一次跑过的工作流图。
 *
 * 这条接口存在的原因很实在：接本地工作流原本要先在 ComfyUI 里手动「导出（API）」、
 * 再把那一大坨 JSON 贴回 Holy Light画布。改一次图就得重来一遍，于是「接本地」这件事实际上
 * 只做一次、之后再没人愿意动。而 ComfyUI 开着的时候，最近跑过的那份图就在 `/history` 里，
 * 直接取即可 —— 取回来的节点编号，与 ComfyUI 界面上（装了编号插件时）那些 `#12` 是一致的。
 *
 * 只返回图，**不落库**：要不要存、存成什么名字、归到哪个用途，交给
 * `POST /api/workflows/local`（那条路会顺带扫出字段并逐项让用户勾）。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const creds = await readLocalCredentials(user.id);
    const pulled = await pullLatestLocalGraph(creds);
    return Response.json(pulled);
  });
}
