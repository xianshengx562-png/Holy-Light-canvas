import { db } from '@/lib/db';
import { api, apiUser } from '@/lib/api';
import { runRecordsFromTasks } from '@/lib/runs';

/**
 * 一张画布的生成历史（`GET /api/projects/:id/runs`）。
 *
 * 数据源是 **Task 表**，不是画布里的节点 —— 2026-10-02 修的那个 bug 就在这：
 * 历史原来挂在节点身上，删节点等于把记录一起删了。任务表不受删节点影响。
 *
 * ⚠️ `take: 300` 会让「第几次」在被截断的那一头接着数（只取最近 300 条，
 * 更早的没进来）。可以接受 —— 这一页讲的是「最近跑过什么」，不是流水账；
 * 真要完整统计得另开一个接口。
 */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const user = await apiUser();
    const { id } = await params;
    const project = await db.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
    const tasks = await db.task.findMany({
      where: { userId: user.id, projectId: id },
      select: {
        id: true, nodeId: true, nodeLabel: true, workflowId: true,
        status: true, error: true, result: true, createdAt: true, completedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    /*
     * 老数据的名字补全：`Task.nodeLabel` 是这一版才有的字段，更早的任务都没存名字。
     * 节点还在这张画布上的话，拿它**现在的名字**补上，历史里才不会一片「生成节点」。
     */
    const canvas = await db.canvas.findFirst({ where: { projectId: id }, select: { nodes: true } });
    /* JSON 列读回来可能是对象也可能是字符串（SQLite 那一层两种都见过），两边都认。 */
    const raw = canvas?.nodes as unknown;
    let nodes: unknown[] = [];
    if (Array.isArray(raw)) nodes = raw;
    else if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) nodes = parsed;
      } catch { /* 画布坏了不影响历史，名字补不上而已 */ }
    }
    const labels: Record<string, string> = {};
    for (const node of nodes as { id?: unknown; data?: { label?: unknown } }[]) {
      const nodeId = String(node?.id || '');
      const label = String(node?.data?.label || '');
      if (nodeId && label) labels[nodeId] = label;
    }
    return Response.json({ runs: runRecordsFromTasks(tasks, labels) });
  });
}
