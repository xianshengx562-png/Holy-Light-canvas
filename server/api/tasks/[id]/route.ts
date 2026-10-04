import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { api, apiUser, checkOrigin, jsonBody } from '@/lib/api';
import { refundGeneration } from '@/lib/wallet';
import { abandonMessage } from '@/lib/taskPoll';
import { failAndRefund } from '@/lib/taskSettle';
import { cancelUpstreamTask } from '@/lib/taskCancel';
import { pollTaskOnce } from '@/lib/taskQuery';
import { queryTask } from '@/lib/providers/runninghub/client';
import { queryWebAppOutputs } from '@/lib/providers/runninghub/webapp';
import { webAppIdOf } from '@/lib/workflows/runninghubApp';
import { resolveRunningHub } from '@/lib/providers/runninghub/connection';
import { missingCredentialsMessage, resolveVideoApiCredentials } from '@/lib/providers/resolve';
import { queryVideoApi } from '@/lib/providers/videoapi/client';
import { queryCustomVideo } from '@/lib/providers/custom/client';
import { readCustomCredentials, splitCustomModelValue } from '@/lib/providers/custom';
import { readLocalCredentials } from '@/lib/providers/local/connection';
import { queryLocalHistory } from '@/lib/providers/local/client';
import { clearLocalProgress, readLocalProgress } from '@/lib/providers/local/progress';
import { archiveTaskLatents } from '@/lib/latents';

/*
 * `failAndRefund` 已经抽到 `lib/taskSettle.ts`（2026-09-29）——
 * 会结单的只有两条路：用户点「放弃这一轮」，或上游报失败。规矩写在 lib 里那份注释上。
 */

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const user = await apiUser();
    const { id } = await params;
    const task = await db.task.findFirst({ where: { id, userId: user.id } });
    if (!task) return NextResponse.json({ error: '任务不存在。' }, { status: 404 });
    if (!task.externalTaskId || task.status === 'success' || task.status === 'failed') {
      return NextResponse.json(task);
    }
    /*
     * 这里**只查不问时间**（2026-09-30 定死）：任务只有成功与失败两种结果，
     * 跑多久是上游的事 —— 还在跑就原样报回去，由前端接着轮询。
     */

    /*
     * 查一次上游并把结果落库（2026-10-03，N-112）。
     *
     * 这段原来就写在这里，现在抽到 `lib/taskQuery.ts` 的 `pollTaskOnce()` ——
     * 扫尾（`sweepTasks()`）也要用同一份判定，不然它只能**报**哪些任务还在跑，
     * 不能真的去问上游一句，于是「节点已经被删了」的任务永远没人查。
     *
     * 🔴 它**不抛异常**：问不到上游会带一句人话回来（`notice`），任务保持 running ——
     *    那是「这次没问到」，不是「任务失败了」，两件事别混。
     */
    const outcome = await pollTaskOnce(user.id, task);
    return NextResponse.json({
      ...outcome.task,
      latents: outcome.latents,
      ...(outcome.progress ? { progress: outcome.progress } : {}),
      ...(outcome.notice ? { error: outcome.notice } : {}),
    });
  });
}

/**
 * 放弃这个任务（2026-09-29）。
 *
 * 用户点「放弃这一轮」时来这一趟。**结单必须是服务端的事**：前端放弃只代表
 * 「我不看了」，而任务算不算失败只有掌握状态的这一边说了算 ——
 * 以前前端自己标灰了事，服务端这边还一直是 running。
 *
 * 2026-10-04 起还多一件事：**真去把上游停掉**（云端 `/task/openapi/cancel`、
 * 本机 ComfyUI 的队列 / 打断）。在那之前「放弃」只是一句我们自己说的话 ——
 * 云端照烧积分、本机照占显卡。判定与读法在 `lib/cancelPlan.ts`。
 *
 * ⚠️ 这个 `POST` 与上面的 `GET` 在**同一个文件**里：桌面版那份路由表是按请求方法
 *    从模块里取导出的（`dispatch.ts` 的 `hit.mod[method]`），所以不用去重新生成路由表。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const task = await db.task.findFirst({ where: { id, userId: user.id } });
    if (!task) return NextResponse.json({ error: '任务不存在。' }, { status: 404 });
    /* 已经是终态就原样返回 —— 重放这一趟不该把一次成功的任务改成失败。 */
    if (task.status === 'success' || task.status === 'failed') return NextResponse.json(task);
    /*
     * 放弃的原因：前端点「放弃这一轮」时会带一句人话过来（2026-09-29），
     * 没带就用前端那句默认的「放弃」。上限 200 字 —— 这句话要写进库里的 error 字段。
     */
    const body = await jsonBody(request).catch(() => ({} as Record<string, unknown>));
    const given = typeof (body as { reason?: unknown }).reason === 'string'
      ? String((body as { reason?: unknown }).reason).trim().slice(0, 200)
      : '';
    /*
     * 🔴 **先去把上游停掉，再结单**（2026-10-04）。
     *
     * 原来这一趟只结我们自己的账：轮询停了、库里判了失败，而云端那条**照跑**
     * （烧他的积分）、本机 ComfyUI 那条**照跑**（占他的显卡）。徐先报的原话是
     * 「现在选择放弃，云端和本地的任务还不会停」。
     *
     * 顺序不能反：结单之后 `status` 就是终态了，那时再去取消等于对着一条已经结掉的任务
     * 补一刀 —— 而且以后有人重看这段代码会以为取消是可选的收尾。它**是**放弃的一部分。
     *
     * `cancelUpstreamTask()` 自己吞掉所有异常（放弃不该因为上游不搭话而失败），
     * 带回来的是一句给用户看的说明，跟着响应回前端、写在节点上。
     */
    const cancel = await cancelUpstreamTask({ userId: user.id, provider: task.provider, externalTaskId: task.externalTaskId });
    /* 没带 reason 就是前端那句默认的「放弃」 —— 这是现在唯一一种结单原因。 */
    const settled = await failAndRefund(user.id, task, given || abandonMessage());
    return NextResponse.json({ ...settled, cancel });
  });
}
