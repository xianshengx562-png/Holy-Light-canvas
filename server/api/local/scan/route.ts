import { api, apiUser, checkOrigin } from '@/lib/api';
import { readLocalCredentials } from '@/lib/providers/local/connection';
import { scanLocalCandidates } from '@/lib/providers/local/discovery';

/**
 * 扫一遍本机哪儿有 ComfyUI。
 *
 * 与 `/api/local/connection/test` 的分工：那边只回答「我填的这个地址通不通」，
 * 这边回答「那它到底在哪」—— 填的地址不通时，顺手把常见端口探一遍，
 * 探到了界面就能给一个「改用这个」的按钮，而不是让用户自己去猜端口号。
 *
 * ⚠️ 只读：不拉起进程、不改任何配置。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const creds = await readLocalCredentials(user.id);
    return Response.json(await scanLocalCandidates(creds));
  });
}
