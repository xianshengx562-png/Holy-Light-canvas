import { db } from '@/lib/db';
import { refundGeneration } from '@/lib/wallet';

/**
 * 把一个还在跑的任务**结掉**：标 failed，并按 idempotencyKey 退掉这次**真的扣过**的钱。
 *
 * 两处会走到这里：
 *   1. 用户点「放弃这一轮」（`POST /api/tasks/[id]`）；
 *   2. 查询单个任务时上游已经报失败（`GET /api/tasks/[id]`）。
 *
 * ⚠️ 退款只对「走站点公共 key 那一路」有意义（2026-09-29）：那条路是我们代付、
 *    提交那刻就扣了，判 failed 就该退。用户自己账号那一路我们压根没扣钱，
 *    `refundGeneration` 查不到扣款记录会自己返回 null —— 所以界面上
 *    不要写「积分已退回」这种通用说法，那是一句没发生过的话。
 *
 * 放在 `lib/` 而不是某个 route 里，就是因为上面那三处都要用它（2026-09-29 从
 * `[id]/route.ts` 里抽出来给 scan 用）。
 */
export async function failAndRefund(
  userId: string,
  task: { id: string; idempotencyKey: string },
  reason: string,
) {
  const updated = await db.task.update({
    where: { id: task.id },
    data: { status: 'failed', error: reason, completedAt: new Date() },
  });
  try {
    await refundGeneration(userId, task.idempotencyKey);
  } catch {
    /* 退款失败不该连带把这一次查询弄挂 —— 任务状态已经落库了，下次还能再退。 */
  }
  return updated;
}

export type RunningTask = {
  taskId: string;
  nodeId: string;
  externalTaskId: string | null;
  workflowId: string;
};

/**
 * 扫一遍某个用户（或某个项目）还没落地任务：**只报，不结** —— 前端拿到这份列表接着轮询。
 *
 * 为什么要这一趟（2026-09-29）：
 * 关掉软件那段时间没人轮询，任务会永远停在 running；而重开之后前端**没有任何恢复逻辑**
 * —— 节点上写着「生成中」，按钮是灰的，只能删节点重建。
 * 以前「结单」只挂在「有人来查这个任务」上，可重开后没人去查它。
 *
 * `running` 那一份是给前端**恢复轮询**用的：还在跑说明上游可能还在算，
 * 这时候直接判失败等于把一张本来会出片的单子撕了。
 */
export async function sweepTasks(userId: string, projectId: string | null): Promise<{ running: RunningTask[] }> {
  const tasks = await db.task.findMany({
    where: {
      userId,
      status: { in: ['queued', 'running'] },
      ...(projectId ? { projectId } : {}),
    },
    select: {
      id: true, nodeId: true, externalTaskId: true, workflowId: true,
      idempotencyKey: true, createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
    /** 上限只是安全带：正常项目不该有几百个在跑的任务，真有也不该一次全结。 */
    take: 200,
  });
  /*
   * 只报，不结（2026-09-30 定死）：这一趟不结任何单，也不按等待时长做判定 ——
   * 任务只有成功与失败两种结果，跑多久是上游的事。
   * 前端拿到这份列表去**接着轮询**，用户想停由他自己点「放弃这一轮」。
   */
  return {
    running: tasks.map(task => ({
      taskId: task.id,
      nodeId: task.nodeId,
      externalTaskId: task.externalTaskId,
      workflowId: task.workflowId,
    })),
  };
}
