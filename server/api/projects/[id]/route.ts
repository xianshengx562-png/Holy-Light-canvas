import { NextResponse } from 'next/server';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { deleteProject, getProject, renameProject } from '@/lib/projects';

/**
 * 单个项目（含画布）的只读视图（桌面版新增）。
 *
 * web 版 `/projects/[id]` 是服务端组件，直接 `getProject()`；桌面版改成渲染进程取数。
 * 只返回读的部分 —— 写画布走 `/api/projects/[id]/canvas`。
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const user = await apiUser();
    const { id } = await params;
    const project = await getProject(user.id, id);
    if (!project) throw new ApiError(404, '项目不存在，或者不属于当前账号。');
    return Response.json(project);
  });
}

/**
 * 改名（2026-09-25）—— 首页 / 项目列表页卡片右键菜单里的「重命名」。
 *
 * ⚠️ 用 `apiUser()`（未登录回 401）而不是 `requireUser()`：后者会 `redirect()`，
 * 在 API 路由里那是抛一个 NEXT_REDIRECT，被 `api()` 兜成 500「服务暂时不可用」——
 * 明明是没登录，却报成服务端故障。这个坑在 `/api/projects/quick` 那里已经踩过一次。
 *
 * 只接受 `{ name }` 一个字段。空值 / 超长的校验在 `projectName()`（与新建同一个入口）。
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const body = await jsonBody(request);
    return NextResponse.json(await renameProject(user.id, id, (body as { name?: unknown } | null)?.name));
  });
}

/**
 * 删项目（2026-09-25）—— 右键菜单里的「删除项目」。
 *
 * **连带**清掉这个项目的画布、任务、资产记录与磁盘文件（见 `deleteProject()`）。
 * 这是不可逆的，所以前端必须先明确确认一次；接口这边只负责「确认过的请求照做」。
 *
 * 返回删除明细（资产条数、文件删没删掉）而不是一个 `{ ok: true }`：
 * 文件没删干净时要能说出来，否则用户以为空间已经释放了，实际还在占着。
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const outcome = await deleteProject(user.id, id);
    if (outcome.status === 'not_found') throw new ApiError(404, '项目不存在，或者不属于当前账号。');
    return NextResponse.json(outcome);
  });
}
