import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { db } from '@/lib/db';
import { readLocalCredentials } from '@/lib/providers/local/connection';
import { diagnoseLocalGraph } from '@/lib/providers/local/diagnose';
import { parseLocalGraph } from '@/lib/providers/local/graph';

/**
 * 检查一份图在本机 ComfyUI 上跑不跑得起来：**缺哪个自定义节点 / 缺哪个模型**。
 *
 * 这一步的意义在于把 ComfyUI 自己的报错提前：现在缺节点、缺模型都只能等到点了生成，
 * 由 `/prompt` 回一个 `node_errors`，而那份错误是给 ComfyUI 的用户看的（一堆节点编号）。
 * 这里改成「点一下就知道缺什么」—— 查的是本机的 `/object_info`，也就是它自己认得的清单。
 *
 * ⚠️ **只诊断，不动手**：不拉起进程、不下载、不安装。用户说过「我只连我自己开的」。
 *
 * 两种用法：
 * - 带 `workflowId`：查工作流库里那条本地工作流（图存在库里，前端不必再传一次几十 KB）；
 * - 带 `graph`：查一段还没保存的图。
 *
 * 早先还有一种「都不带」—— 回落到设置页里手工粘的那份兜底图。那条路已经删了：
 * 图现在只跟着工作流走，设置页不再存图。
 */

const schema = z.object({
  workflowId: z.string().min(1).max(200).optional(),
  graph: z.unknown().optional(),
});

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const parsed = schema.safeParse(await jsonBody(request, 2 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '检查请求无效。');

    let raw: unknown;
    if (parsed.data.workflowId) {
      const draft = await db.workflowDraft.findFirst({
        where: { userId: user.id, workflowId: parsed.data.workflowId },
      });
      if (!draft) throw new ApiError(404, '这条工作流不存在。');
      raw = draft.graph;
    } else if (parsed.data.graph !== undefined) {
      raw = parsed.data.graph;
    } else {
      throw new ApiError(400, '还没有可检查的图 —— 指定一条本机 ComfyUI 工作流，或直接传一份图过来。');
    }

    let graph;
    try {
      graph = parseLocalGraph(raw);
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : '这份图无效。');
    }

    const creds = await readLocalCredentials(user.id);
    if (!creds.baseUrl) throw new ApiError(400, '还没填本机 ComfyUI 的地址 —— 填了才知道缺什么。');
    return Response.json(await diagnoseLocalGraph(graph, creds));
  });
}
