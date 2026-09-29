import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { ApiError, api, apiUser, checkOrigin, jsonBody } from '@/lib/api';

const point = z.object({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) });
const canvasNode = z.object({ id: z.string().min(1).max(120), type: z.string().min(1).max(80), position: point, data: z.record(z.string(), z.unknown()).optional() });
const canvasEdge = z.object({ id: z.string().min(1).max(160), source: z.string().min(1).max(120), target: z.string().min(1).max(120), sourceHandle: z.string().max(80).nullable().optional(), targetHandle: z.string().max(80).nullable().optional(), type: z.string().max(80).optional() });
const schema = z.object({
  nodes: z.array(canvasNode).max(200),
  edges: z.array(canvasEdge).max(400),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().finite().min(0.1).max(4) }),
  /**
   * 客户端手上那份画布的版本号。
   * 带上它 = 要求「只有服务端还是这一版才允许写」，对不上就 409；
   * 不带 = 老行为，无条件覆盖（几个老脚本和早期客户端还在这么发）。
   */
  version: z.number().int().min(0).optional(),
});

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const user = await apiUser();
    const { id } = await params;
    const project = await db.project.findFirst({ where: { id, userId: user.id }, include: { canvas: true } });
    if (!project?.canvas) return NextResponse.json({ error: '项目不存在。' }, { status: 404 });
    return NextResponse.json({ nodes: project.canvas.nodes, edges: project.canvas.edges, viewport: project.canvas.viewport, version: project.canvas.version });
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    /**
     * 用 safeParse：`parse` 抛出的 ZodError 会落到 api() 的兜底分支变成 500，
     * 而画布格式不对是客户端的问题，得回 400。节点 / 连线超限也走这里。
     */
    const parsed = schema.safeParse(await jsonBody(request, 2 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, '画布数据格式无效，请刷新页面后重试。');
    const input = parsed.data;
    const project = await db.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!project) return NextResponse.json({ error: '项目不存在。' }, { status: 404 });
    const data = {
      nodes: input.nodes as Prisma.InputJsonValue,
      edges: input.edges as Prisma.InputJsonValue,
      viewport: input.viewport as Prisma.InputJsonValue,
      version: { increment: 1 },
    };
    /**
     * 版本比对和写入必须是同一条语句：先读一次版本、再无条件 update 的话，
     * 两个窗口可以在「读」和「写」之间双双通过检查，冲突照样发生。
     * 把版本放进 updateMany 的 WHERE 里，影响行数就是判定结果。
     */
    if (typeof input.version === 'number') {
      const { count } = await db.canvas.updateMany({ where: { projectId: id, version: input.version }, data });
      if (count === 0) {
        const current = await db.canvas.findUnique({ where: { projectId: id }, select: { version: true } });
        return NextResponse.json({ error: '画布已在其他窗口被修改，这次改动没有保存。', version: current?.version ?? null }, { status: 409 });
      }
    } else {
      await db.canvas.update({ where: { projectId: id }, data });
    }
    const canvas = await db.canvas.findUniqueOrThrow({ where: { projectId: id }, select: { version: true, updatedAt: true } });
    await db.project.update({ where: { id }, data: { updatedAt: new Date() } });
    return NextResponse.json({ ok: true, ...canvas });
  });
}
