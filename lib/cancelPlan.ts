/**
 * What "abandon this run" should actually stop, and how to read the upstream's answer.
 *
 * Until 2026-10-04 the 放弃 button only did two things: cut the local polling, and mark the
 * row failed in our own database. **Neither upstream was told anything** — the cloud task
 * kept burning his credits, the local ComfyUI kept holding his GPU. 徐先's words:
 *
 *     现在选择放弃，云端和本地的任务还不会停
 *
 * Both rules below come from **measured replies**, not from the docs — which is why they
 * live in a dependency-free module with a unit test (`C:/FRAME/_test-cancel-plan.py`).
 *
 * ### Cloud (RunningHub)
 *
 * ```
 * POST https://www.runninghub.cn/task/openapi/cancel   body {apiKey, taskId}
 *   code   0  success
 *   code 807  APIKEY_TASK_NOT_FOUND           — no such task (expired / purged / another account)
 *   code 817  APIKEY_TASK_CANCEL_NOT_ALLOWED  — found, but it is no longer in a cancellable state
 *   code 301  taskId must be positive         — malformed task id
 * ```
 *
 * 🔴 **817 does not mean "this key may not cancel tasks."** The same key asking about a
 *    task id that does not exist gets 807 — i.e. the credentials passed and the task was
 *    looked up; the refusal is about the task's state (it already finished). Reading 817
 *    as a permission problem would put a claim nobody can verify in front of the user.
 * 🔴 **Cancelling is not refunding.** Whatever the workflow already burned upstream stays
 *    burned; the note must not promise money back.
 *
 * ### Local (the user's own ComfyUI)
 *
 * ComfyUI has no per-task abort. What it has:
 *   - `POST /queue` `{"delete":["<prompt_id>"]}` — drop one **pending** item;
 *   - `POST /interrupt` — abort the **currently executing** prompt.
 *
 * 🔴 `/interrupt` is **global**: it stops whatever this machine is running right now. So it
 *    is only ever called when `/queue` says the running prompt *is* ours — otherwise we
 *    would silently kill the job he started by hand in the ComfyUI UI.
 */

/** Which upstream is holding the task. `none` = a gateway that has no cancel endpoint. */
export type CancelTarget = 'runninghub' | 'local' | 'none';

/** `Task.provider` → who to tell. `videoapi` / `custom` are gateways with no cancel API. */
export function cancelTargetFor(provider: unknown): CancelTarget {
  const text = String(provider ?? '').trim();
  if (text === 'runninghub') return 'runninghub';
  if (text === 'local') return 'local';
  return 'none';
}

/**
 * Site-root cancel endpoint (see `lib/providers/runninghub/urls.ts` for why it is not
 * under `/openapi/v2`).
 */
export const RUNNINGHUB_CANCEL_PATH = '/task/openapi/cancel';

export type RemoteCancelState = 'cancelled' | 'finished' | 'missing' | 'refused' | 'unknown';

export type RemoteCancelVerdict = {
  /** Did the upstream agree to stop it? A task that already finished is not a failure. */
  ok: boolean;
  state: RemoteCancelState;
  /** Short clause for the node card — parenthesised, so it can follow a full sentence. */
  note: string;
};

/**
 * Read RunningHub's answer to a cancel request.
 *
 * The messages deliberately talk about **the task**, never about credits: see the header.
 */
export function runningHubCancelVerdict(code: unknown, msg?: unknown): RemoteCancelVerdict {
  /*
   * 🔴 先看原文，**别直接 `Number(code)`**：`Number(null)`、`Number('')`、`Number(undefined)`
   *    全是 0 —— 于是「上游没给 code」会被读成「已停止」，我们又替上游说了一句它没说过的话。
   *    这一条是单测第一条就抓出来的（`_test-cancel-plan.py` §4），别顺手改回去。
   */
  const text = String(code ?? '').trim();
  const num = text === '' ? Number.NaN : Number(text);
  if (text === '0') {
    return { ok: true, state: 'cancelled', note: '（云端任务已请求停止）' };
  }
  if (num === 817) {
    return { ok: false, state: 'finished', note: '（云端说这条已经结束了，不用再停）' };
  }
  if (num === 807) {
    return { ok: false, state: 'missing', note: '（云端说没有这条任务了 —— 可能已过期或被清理）' };
  }
  if (num === 301) {
    return { ok: false, state: 'refused', note: '（云端说这个任务号不合法，没能去停它）' };
  }
  const said = String(msg ?? '').trim();
  return {
    ok: false,
    state: 'unknown',
    note: said ? `（云端没能停掉它：${said}）` : '（云端没能停掉它）',
  };
}

/** Where a prompt id sits in ComfyUI's `/queue` listing. */
export type LocalCancelState = 'queued' | 'running' | 'gone';

/**
 * Read `GET /queue` and say where our prompt is.
 *
 * Entries are arrays shaped `[number, prompt_id, graph, extra_outputs, outputs]` — the id
 * is at index 1. Anything we cannot parse counts as `gone`: better to report "nothing to
 * stop" than to fire `/interrupt` at a machine whose queue we did not understand.
 */
export function localQueueState(queue: unknown, promptId: unknown): LocalCancelState {
  const wanted = String(promptId ?? '').trim();
  if (!wanted) return 'gone';
  const row = queue && typeof queue === 'object' ? (queue as Record<string, unknown>) : {};
  const holds = (key: string) => (Array.isArray(row[key]) ? (row[key] as unknown[]) : [])
    .some(entry => Array.isArray(entry) && String(entry[1] ?? '').trim() === wanted);
  if (holds('queue_running')) return 'running';
  if (holds('queue_pending')) return 'queued';
  return 'gone';
}

/** Short clause for the node card, same style as the cloud notes. */
export function localCancelNote(state: LocalCancelState): string {
  if (state === 'queued') return '（本机那份已从队列里撤掉）';
  if (state === 'running') return '（已打断本机正在跑的那一份）';
  return '（本机队列里已经没有它了）';
}

/**
 * Reported when ComfyUI cannot be reached at all.
 *
 * It is the user's own machine, so the actionable next step belongs in the sentence — our
 * abandon already did its job, and the leftover job is one he can stop himself.
 */
export const LOCAL_UNREACHABLE_NOTE = '（连不上本机 ComfyUI —— 活还在你自己机器上，去 ComfyUI 点 Cancel）';

/** Nothing was submitted yet, so there is nothing upstream to stop. */
export const NOT_SUBMITTED_NOTE = '（还没提交到上游，这里停下就够了）';

/** `videoapi` / `custom` gateway tasks: their APIs expose no cancellation. */
export const NO_CANCEL_API_NOTE = '（这一路没有取消接口，只能我们这边不再等它）';
