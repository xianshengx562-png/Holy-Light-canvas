import { NextResponse } from 'next/server';
import { z } from 'zod';
import { api, apiUser, checkOrigin, jsonBody } from '@/lib/api';
import { sweepTasks } from '@/lib/taskSettle';

const schema = z.object({
  /** 限定在这一张画布里扫。不传 = 扫这个用户所有项目（画布打开时永远会传）。 */
  projectId: z.string().min(1).max(120).optional(),
});

/**
 * 扫尾（2026-09-29）：打开画布时来这一趟。
 *
 * 关掉软件那段时间没人轮询，任务会永远停在 running —— 界面上那个节点一直转圈、
 * 发送按钮是灰的，只能删节点重建。过早那一版把结单挂在「有人来查这个任务」上，
 * 可重开之后**没有任何人会去查它**，所以必须有这一趟主动扫。
 *
 * 只回一份 `running`（2026-09-29 改）：**不结单**。任务只有成功与失败两种结果，
 * 上游还在跑就继续跑 —— 前端按任务号接着轮询，想停由用户自己点「放弃这一轮」。
 *
 * ⚠️ 桌面版：这是一个**新文件**，所以 `electron/main/routes.generated.ts` 必须加一条，
 *    而且条目要排在 `/api/tasks/[id]` **之前** —— 否则 `scan` 会被当成 `[id]` 匹配掉。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const parsed = schema.safeParse(await jsonBody(request));
    const result = await sweepTasks(user.id, parsed.success ? (parsed.data.projectId || null) : null);
    return NextResponse.json(result);
  });
}
