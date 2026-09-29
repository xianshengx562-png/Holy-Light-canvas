import { NextResponse } from 'next/server'; import { requireUser } from '@/lib/auth/session'; import { api, checkOrigin, jsonBody, ApiError } from '@/lib/api'; import { createProject, listProjects, projectName } from '@/lib/projects';

export async function GET(){return api(async()=>{const user=await requireUser();return NextResponse.json(await listProjects(user.id));});}

/**
 * POST 有两副面孔，由 `Accept` 决定：
 *
 *  - 要 JSON（渲染进程 `fetch` 过来的）：**回 `{ id }`**。桌面版没有服务端跳转这一步，
 *    重定向会被 fetch 静默跟掉，页面停在原地什么也不发生 —— 必须把 id 交回去，
 *    由前端路由自己跳到 `/projects/{id}`。
 *  - 不要 JSON（整页表单提交，web 版的老路径）：照旧 303 重定向。
 *
 * 「按 Accept 分流」而不是一律改成 JSON：web 版那个不带 JS 的表单仍然要靠重定向工作，
 * 一刀切会把它弄坏，而那边的回归测试是照着 303 写的。
 */
export async function POST(request:Request){
  return api(async()=>{
    checkOrigin(request);
    const user=await requireUser();
    const raw=request.headers.get('content-type')?.includes('form')?Object.fromEntries((await request.formData()).entries()):await jsonBody(request);
    const name=projectName(raw.name);
    const project=await createProject(user.id,name);
    if (request.headers.get('accept')?.includes('application/json')) {
      return NextResponse.json(project);
    }
    return NextResponse.redirect(new URL(`/projects/${project.id}`,request.url));
  });
}
