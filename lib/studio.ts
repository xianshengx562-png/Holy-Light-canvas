import 'server-only';
import { db } from '@/lib/db';
import { createProject } from '@/lib/projects';
import { STUDIO_PROJECT_NAME } from '@/lib/start/studio';

/**
 * 「主页图片生成」挂靠的固定项目：按名字找，没有就建。
 *
 * session / upload 两条路由都要它，抽成一份免得两处各写一遍 find-or-create
 * —— 那种重复的结局从来都是「一边加了排序、另一边没有」。
 *
 * 按 `updatedAt` 倒序取第一个：同名项目理论上有多个（用户手建过、或改名后又建了新的），
 * 用最近更新的那个，让新图落在用户最近还在看的那一份里。
 */
export async function findOrCreateStudioProject(userId: string) {
  const existing = await db.project.findFirst({
    where: { userId, name: STUDIO_PROJECT_NAME },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await createProject(userId, STUDIO_PROJECT_NAME);
  return created.id;
}
