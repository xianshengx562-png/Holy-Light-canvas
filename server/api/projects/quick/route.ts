import { NextResponse } from 'next/server';
import { api, apiUser, checkOrigin, jsonBody, ApiError } from '@/lib/api';
import { createProject } from '@/lib/projects';
import { archiveUploadedImage } from '@/lib/media';
import { db } from '@/lib/db';
import { PROMPT_MAX, projectNameFromPrompt } from '@/lib/start/quick';
import { MAX_REFS } from '@/lib/start/compose';

/**
 * 「快速开始」：首页那个大输入框的去画布那一路（生图 / 生成视频）走这里。
 *
 * 只做一件事：把一句话（外加可选的两三张参考图）变成一个项目，
 * 并把项目 id 回给前端 —— 前端再带着它跳 `/projects/<id>?…`，
 * 由**画布自己**按那份 seed 建节点（那条路已经在画布上存在，别在这里重造一份节点结构）。
 *
 * **两种入参形态**，按 `content-type` 分：
 *   - `application/json`（原来的、也是别的调用方在用的）：只建项目；
 *   - `multipart/form-data`：多带几段 `files`，建完项目顺手把图存成**本项目的资产**，
 *     回一份 `refs`（`/api/assets/…` 地址）让前端塞进 seed。
 *
 * 为什么参考图要并进这一条、而不是「先建项目再调上传接口」：图存不下来时项目已经建好了，
 * 用户拿到的会是一个「有项目、没图」的空画布 —— 而他要的正是「带着图进去」。
 * 并成一次请求之后，失败可以把刚建的项目**当场删掉**，对用户来说就是「什么都没发生」。
 *
 * 刻意**不走** `POST /api/projects`：那一条无论表单还是 JSON 都回 302，
 * 改成「JSON 进 JSON 出」会动到所有既有调用方（e2e 全靠那个 302 读重定向地址）。
 * 语义上这也是两件事：那条是「建一个项目」，这条是「给我开一张画布，我已经想好要做什么了」。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    /*
     * ⚠️ 这里必须用 `apiUser()`（回 401）而**不是** `requireUser()`（会 `redirect()`）。
     * API 路由里 `redirect()` 是**抛**一个 NEXT_REDIRECT，被 `api()` 的 catch 兜住之后
     * 变成一条 500「服务暂时不可用」—— 明明是没登录，却报成服务端故障，
     * 客户端只能看到一句误导人的话。未登录的接口应答就应该是 401。
     */
    const user = await apiUser();

    const isMultipart = request.headers.get('content-type')?.startsWith('multipart/form-data') ?? false;
    let prompt = '';
    let files: File[] = [];
    if (isMultipart) {
      const form = await request.formData();
      prompt = String(form.get('prompt') ?? '').trim();
      /* 上限与首页那个选图框同源（`MAX_REFS`）：让服务端拦住手改的请求，而不只是靠 `<input>`。 */
      files = form.getAll('files')
        .filter((item): item is File => item instanceof File && item.size > 0)
        .slice(0, MAX_REFS);
    } else {
      const raw = await jsonBody(request).catch(() => ({})) as { prompt?: unknown };
      prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
    }

    if (!prompt) throw new ApiError(400, '先说一句想做什么。');
    if (prompt.length > PROMPT_MAX) throw new ApiError(400, `想说的太长了，最多 ${PROMPT_MAX} 个字。`);

    const project = await createProject(user.id, projectNameFromPrompt(prompt));
    const refs: string[] = [];
    for (const file of files) {
      const saved = await archiveUploadedImage({ userId: user.id, projectId: project.id, file });
      if (!saved) {
        /*
         * 存不下就把整个项目撤掉 —— 用户要的是「带着这几张图进画布」，
         * 少一张都不该假装成功。已经落盘的那几张会变成孤儿文件，由清理任务按安全期回收。
         */
        await db.project.delete({ where: { id: project.id } }).catch(() => { /* 删不掉也不能报两个错 */ });
        throw new ApiError(400, '参考图存不下来 —— 确认它是 PNG / JPEG / WebP / GIF，且大小正常。');
      }
      refs.push(saved.url);
    }

    return NextResponse.json({ id: project.id, name: project.name, refs });
  });
}
