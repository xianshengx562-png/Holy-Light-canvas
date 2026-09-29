import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { db } from '@/lib/db';
import { parseLocalGraph } from '@/lib/providers/local/graph';
import { localGraphToFields, LOCAL_PROVIDER, newLocalWorkflowId } from '@/lib/workflows/local';
import { normalizeWorkflowName, readWorkflowName } from '@/lib/workflows/label';
import { DEFAULT_GENERATOR_KIND, GENERATOR_KINDS, readGeneratorKind } from '@/lib/workflows/purpose';
import { categoriesFor, DEFAULT_WORKFLOW_CATEGORY, readWorkflowCategory, WORKFLOW_CATEGORIES, workflowCategoryLabel } from '@/lib/workflows/category';
import { DEFAULT_WORKFLOW_OPERATION, readWorkflowOperation, WORKFLOW_OPERATIONS } from '@/lib/workflows/operation';

/*
 * 导入一份本机 ComfyUI 工作流。
 *
 * 它是 `PATCH /api/workflows/[workflowId]/config` 之外的另一条建库入口，区别只有一处：
 * **这份工作流的 ID 由服务端生成**（`local-` 前缀），因为本地工作流在 RunningHub 那边
 * 没有对应的数字 ID —— 让用户自己编一个编号，得到的只会是一串没有意义还得记住的东西。
 *
 * 扫出来的字段在这一步就已写进 `config`（全部 `enabled: false`）：
 * 后面配什么都是「从这份图里挑」，不需要用户先知道节点编号。
 */

const importSchema = z.object({
  graph: z.unknown(),
  name: z.string().optional(),
  kind: z.enum(GENERATOR_KINDS as unknown as [string, ...string[]]).optional(),
  category: z.enum(WORKFLOW_CATEGORIES as unknown as [string, ...string[]]).optional(),
  operation: z.enum(WORKFLOW_OPERATIONS as unknown as [string, ...string[]]).optional(),
});

/** 单次导入的字段上限，与 `configurationSchema` 的 400 对齐。 */
const MAX_FIELDS = 400;

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    /* 一份 ComfyUI 图几十 KB 很正常，这里的上限照抄本地连接那条路线（2 MB）。 */
    const parsed = importSchema.safeParse(await jsonBody(request, 2 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '本地工作流导入请求无效。');

    let graph: ReturnType<typeof parseLocalGraph>;
    try {
      graph = parseLocalGraph(parsed.data.graph);
    } catch (error) {
      /* `parseLocalGraph` 抛的都是「用户该去改」的事（多半是贴成了 UI 格式），翻成 400。 */
      throw new ApiError(400, error instanceof Error ? error.message : '这份本地工作流图无效。');
    }

    const scanned = localGraphToFields(graph);
    const truncated = scanned.length > MAX_FIELDS;

    const kind = readGeneratorKind(parsed.data.kind ?? DEFAULT_GENERATOR_KIND);
    const categoryInput = parsed.data.category ?? DEFAULT_WORKFLOW_CATEGORY;
    if (!categoriesFor(kind).some(item => item.value === categoryInput)) {
      const allowed = categoriesFor(kind).map(item => item.label).join(' / ');
      throw new ApiError(400, `分类「${workflowCategoryLabel(categoryInput)}」不适用于这个用途，只能选：${allowed}。`);
    }
    let name = '';
    if (parsed.data.name !== undefined) {
      const cleaned = normalizeWorkflowName(parsed.data.name);
      if (!cleaned.ok) throw new ApiError(400, cleaned.message);
      name = cleaned.name;
    }

    const draft = await db.workflowDraft.create({ data: {
      userId: user.id,
      workflowId: newLocalWorkflowId(),
      provider: LOCAL_PROVIDER,
      graph: graph as unknown as Prisma.InputJsonValue,
      config: { fields: scanned.slice(0, MAX_FIELDS) } as unknown as Prisma.InputJsonValue,
      name,
      kind,
      category: readWorkflowCategory(categoryInput, kind),
      operation: readWorkflowOperation(parsed.data.operation ?? DEFAULT_WORKFLOW_OPERATION),
    } });

    return Response.json({
      workflowId: draft.workflowId,
      provider: LOCAL_PROVIDER,
      name: readWorkflowName(draft.name),
      kind: readGeneratorKind(draft.kind),
      category: readWorkflowCategory(draft.category, readGeneratorKind(draft.kind)),
      operation: readWorkflowOperation(draft.operation),
      totalCount: Math.min(scanned.length, MAX_FIELDS),
      nodeCount: Object.keys(graph).length,
      notice: truncated
        ? `这份图扫出 ${scanned.length} 个可配置字段，已截断到 ${MAX_FIELDS} 项。`
        : `已扫出 ${scanned.length} 个节点字段，去配置页勾选要用的那些。`,
    });
  });
}
