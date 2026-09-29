import { api, apiUser, checkOrigin } from '@/lib/api';
import { readLocalCredentials } from '@/lib/providers/local/connection';
import { readLocalInventory } from '@/lib/providers/local/inventory';

/**
 * 本机 ComfyUI 的**家底**（版本 / 队列 / 节点类型 / 模型清单）。
 *
 * 与 `/api/local/connection/test` 的分工：那边回答「在不在」（轻，只打 `/system_stats`），
 * 这边回答「它有什么」（重，要读 `/object_info` —— 插件多时第一次要十几秒）。
 * 分开是因为界面上的用法完全不同：探活是每次打开页面都要跑的，
 * 而家底只在「已经连上了」之后才值得读一次。
 *
 * ⚠️ 只读：不拉起进程、不改任何配置。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const creds = await readLocalCredentials(user.id);
    return Response.json(await readLocalInventory(creds));
  });
}
