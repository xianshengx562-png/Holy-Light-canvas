/**
 * 上游任务状态 → 我们这边的任务状态（2026-10-03，N-111）。
 *
 * 原来这份判定是内联在 `server/api/tasks/[id]/route.ts` 里的一个三元套三元：
 *
 *   const status = remote.status === 'SUCCESS' ? 'success'
 *                : remote.status === 'FAILED'  ? 'failed'
 *                : remote.status === 'QUEUED'  ? 'queued' : 'running';
 *
 * 它漏了一类：**上游明确说这个任务没了，但没给 FAILED**。
 * 实测 RunningHub `/query` 对过期任务回的是 `errorMessage:
 * "Task not found, please check the task ID | 任务不存在或已过期"`，`status` 并不是 FAILED ——
 * 于是任务被写成 running，前端一直转圈，用户只能点「放弃这一轮」手动结单。
 *
 * 抽出来就是为了这一条规则有地方待，也有地方测（route 里塞不下判据）。
 */

/** 各家 provider 查任务的结果都归一成这个形状（视频网关、本地 ComfyUI 都按 RunningHub 的词汇给）。 */
export type RemoteTaskState = {
  status?: unknown;
  errorMessage?: unknown;
};

export type TaskStatus = 'success' | 'failed' | 'queued' | 'running';

/**
 * 「这个任务已经没了」的说法。
 *
 * 🔴 只认**终态**字样，不认「有 errorMessage 就失败」：限流、临时抖动同样会带
 * errorMessage（`429`、网关重启那几秒），那种判失败等于把一张本来会出片的单子撕了。
 * 中英都要 —— 上游的原话常是英文在前、中文在后（`Task not found ... | 任务不存在或已过期`）。
 */
const TERMINAL_ERROR_PATTERN =
  /not\s*found|does\s*not\s*exist|no\s*such\s*task|不存在|已过期|已删除|已清理|expired|invalid\s*task/i;

/** 单独导出，好让单测直接打这一条，不必造完整报文。 */
export function isTerminalRemoteError(message: string): boolean {
  return typeof message === 'string' && message.trim().length > 0 && TERMINAL_ERROR_PATTERN.test(message);
}

/**
 * 🔴 顺序不能乱：先看 `status`（那是上游给的**权威**判定），只有它没落在已知档位上，
 * 才拿 errorMessage 去认终态。反过来的话，一条正在跑但顺带带了个警告的任务会被判死。
 */
export function remoteStatusOf(remote: RemoteTaskState | null | undefined): TaskStatus {
  const raw = typeof remote?.status === 'string' ? remote.status.trim().toUpperCase() : '';
  if (raw === 'SUCCESS') return 'success';
  if (raw === 'FAILED') return 'failed';
  if (raw === 'QUEUED') return 'queued';
  if (typeof remote?.errorMessage === 'string' && isTerminalRemoteError(remote.errorMessage)) return 'failed';
  return 'running';
}
