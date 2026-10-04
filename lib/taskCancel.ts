import 'server-only';
import {
  cancelTargetFor, LOCAL_UNREACHABLE_NOTE, NO_CANCEL_API_NOTE, NOT_SUBMITTED_NOTE,
  type CancelTarget,
} from '@/lib/cancelPlan';
import { cancelLocalPrompt } from '@/lib/providers/local/client';
import { readLocalCredentials } from '@/lib/providers/local/connection';
import { cancelTask } from '@/lib/providers/runninghub/client';
import { resolveRunningHub } from '@/lib/providers/runninghub/connection';

/**
 * Tell the upstream to stop a task we are abandoning (2026-10-04).
 *
 * Why this exists: 放弃 used to be a purely local act — polling stopped, the row was marked
 * failed, and **both upstreams kept going**. Cloud: his credits kept burning. Local: his GPU
 * kept working on a result nobody would ever look at. 徐先's words:
 *
 *     现在选择放弃，云端和本地的任务还不会停
 *
 * The rules — which upstream to tell, and how to read its answer — live in
 * `lib/cancelPlan.ts` (dependency-free, unit-tested, derived from measured replies).
 * This file is only the plumbing: who to talk to, and never letting a failure here block
 * the abandon itself.
 *
 * 🔴 **This must never throw.** Abandoning is the user telling us "I am done waiting"; if
 *    the cancel request fails we still owe him a settled task and an honest sentence.
 *
 * 🔴 **A cancel is not a refund.** Whatever the workflow already burned upstream stays
 *    burned (RunningHub says so explicitly). The note never promises money back — a claim
 *    none of us can verify is worse than saying nothing (the same rule as
 *    `abandonMessage()`).
 */

export type CancelAttempt = {
  /** Did we even try? `false` = nothing upstream to tell (not submitted / no cancel API). */
  attempted: boolean;
  /** Did the upstream agree to stop it? A task that already finished is not a failure. */
  ok: boolean;
  /** Short parenthesised clause for the node card. Always set. */
  note: string;
};

/** Task fields this needs — deliberately structural so tests and callers can pass rows. */
export type CancellableTask = {
  userId: string;
  provider: string | null;
  externalTaskId: string | null;
};

export async function cancelUpstreamTask(task: CancellableTask): Promise<CancelAttempt> {
  const target: CancelTarget = cancelTargetFor(task.provider);
  if (target === 'none') return { attempted: false, ok: false, note: NO_CANCEL_API_NOTE };

  /*
   * 还没有 `externalTaskId` 说明这一轮卡在**提交之前**（传参考图、传 latent 那一段）。
   * 上游没收到过这条任务，也就没有东西可停 —— 报一句实话，别去猜一个任务号。
   */
  const externalTaskId = String(task.externalTaskId ?? '').trim();
  if (!externalTaskId) return { attempted: false, ok: false, note: NOT_SUBMITTED_NOTE };

  try {
    if (target === 'local') {
      const credentials = await readLocalCredentials(task.userId);
      const result = await cancelLocalPrompt(externalTaskId, credentials);
      return { attempted: true, ok: result.ok, note: result.note };
    }
    const resolved = await resolveRunningHub(task.userId);
    if (!resolved.apiKey) {
      /* 没有 key 就去不了上游。不报「已停止」—— 那是一句我们不知道真假的话。 */
      return { attempted: false, ok: false, note: '（没有可用的 RunningHub Key，没能去停它）' };
    }
    const verdict = await cancelTask(externalTaskId, resolved.apiKey, resolved.baseUrl);
    return { attempted: true, ok: verdict.ok, note: verdict.note };
  } catch (error) {
    /*
     * 本机那一支的措辞要分开：连不上 ComfyUI 时，那句话得**指出活还在他机器上**
     * （其他错误照原文带出来，方便他自己判断）。
     */
    if (target === 'local') {
      const message = error instanceof Error ? error.message : '';
      const unreachable = /fetch failed|ECONNREFUSED|abort|timeout|The operation was aborted/i.test(message);
      return { attempted: true, ok: false, note: unreachable ? LOCAL_UNREACHABLE_NOTE : `（没能停下本机那一份：${message || '未知原因'}）` };
    }
    const message = error instanceof Error ? error.message : '';
    return { attempted: true, ok: false, note: `（没能停下云端那一份：${message || '未知原因'}）` };
  }
}
