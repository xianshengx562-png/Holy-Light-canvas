import { api, apiUser } from '@/lib/api';
import { findOrCreateStudioProject } from '@/lib/studio';
import { STUDIO_PROJECT_NAME } from '@/lib/start/studio';

/**
 * 主页图片生成板块的「会话」：把出图要挂靠的固定项目 id 交给前端。
 *
 * 用 GET 是有意的 —— 它是幂等的 find-or-create：项目在就返回，不在就建一个，
 * 调一百次也只会有一份。前端 `useApi('/api/studio/session')` 进主页就会调它，
 * 所以第一次出图时项目一定已经在那儿了，不需要把「建项目」塞进生成请求里做两步事务。
 *
 * 不走 `POST /api/projects`：那条回 302（建项目的既有语义，e2e 靠它读重定向地址），
 * 这里要的是「JSON 进 JSON 出」。
 */
export async function GET() {
  return api(async () => {
    const user = await apiUser();
    const projectId = await findOrCreateStudioProject(user.id);
    return Response.json({ projectId, name: STUDIO_PROJECT_NAME });
  });
}
