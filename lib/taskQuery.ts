import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { refundGeneration } from '@/lib/wallet';
import { remoteStatusOf } from '@/lib/taskRemote';
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
import { archiveTaskMedia, type ArchivedMedia } from '@/lib/media';

/**
 * 查一次上游、把结果落库 —— 「轮询一个任务」这件事**只有这一份**（2026-10-03，N-112）。
 *
 * 原来这段逻辑内联在 `server/api/tasks/[id]/route.ts` 的 GET 里，于是 `sweepTasks()`
 * （打开画布时的扫尾）拿不到它 —— 它只能**报**哪些任务还在跑，不能真的去问上游一句。
 * 后果是：关掉软件那段时间跑完（或跑挂）的任务，重开后要么靠前端逐个轮询慢慢问，
 * 要么**永远没人问**（任务所属的节点已经被删了），库里就一直躺着一条 running。
 *
 * 抽出来之后两条路共用同一份判定：
 *   1. `GET /api/tasks/[id]` —— 前端轮询；
 *   2. `sweepTasks()` —— 打开画布 / 打开应用时主动扫一遍。
 *
 * 🔴 这一趟**不抛异常**。上游查不通（网络、本机 ComfyUI 没开、超时）时返回一句人话
 *    `notice`，任务**保持 running** 等下一轮 —— 抛出去的话会被 `api()` 兜成
 *    「服务暂时不可用，请稍后重试」，前端既看不懂，也不知道该不该继续等。
 *    「查不到」和「跑失败了」是两件事，后者才结单。
 */

export type PollableTask = {
  id: string;
  nodeId?: string | null;
  provider: string;
  externalTaskId: string | null;
  workflowId: string;
  projectId: string | null;
  input?: unknown;
  idempotencyKey: string;
};

export type PollOutcome = {
  /** 写库后的任务行；这一趟没查到时就是原行。 */
  task: { id: string; status: string; error?: string | null; result?: unknown; nodeId?: string | null; externalTaskId?: string | null; workflowId?: string };
  /** 这次**没问到**上游的人话（不写库，只给界面看）。问到了就是 null。 */
  notice: string | null;
  /** 本机任务的实时进度，别的 provider 是 null。 */
  progress: unknown;
  latents: unknown;
};

/**
 * 把结果里的远端 URL 换成本地落盘 URL。
 *
 * 必须整条替换后再写库——画布侧把 `result` 原样存进 `data.runs`，只在这里改写，
 * 前端一行都不用动。落盘失败的项留在原样（24 小时内还能用），不会被抹掉。
 */
function rewriteResultUrls(results: unknown, archived: ArchivedMedia[]) {
  if (!Array.isArray(results)) return results as Prisma.InputJsonValue;
  const map = new Map(archived.map(item => [item.originalUrl, item.url]));
  return results.map(item => {
    if (!item || typeof item !== 'object') return item;
    const url = (item as { url?: unknown }).url;
    const next = typeof url === 'string' ? map.get(url) : undefined;
    return next ? { ...(item as Record<string, unknown>), url: next } : item;
  }) as Prisma.InputJsonValue;
}

function asMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '未知错误';
}

export async function pollTaskOnce(userId: string, task: PollableTask): Promise<PollOutcome> {
  const isVideoApi = task.provider === 'videoapi';
  const isCustom = task.provider === 'custom';
  const isLocal = task.provider === 'local';
  let remote: { status: string; results?: { url: string; outputType?: string }[]; errorMessage?: string } | null = null;
  let notice: string | null = null;

  /*
   * 🔴 整段包在 try 里：查上游这一步**失败不等于任务失败** ——
   * 网络抖一下、本机 ComfyUI 还没开、上游慢，都会在这里抛。那种时候要的是
   * 「这次没问到，下一轮再问」，不是把任务判死，更不是抛给 `api()` 变成一句
   * 谁也看不懂的「服务暂时不可用」。
   */
  /*
   * 任务号是这一趟唯一的抓手：没有它连问都没处问。
   * 原来 route 里靠那条 early return 挡掉（没有 externalTaskId 就原样返回），
   * 这里同样要先挡 —— 否则下面每个 provider 都会拿着一个空号去查，
   * 报出来的错全是指不到根因的。
   */
  const externalId = task.externalTaskId ?? '';
  const projectId = task.projectId ?? '';
  if (!externalId) {
    const fresh = await db.task.findUnique({ where: { id: task.id } });
    return { task: (fresh || task) as PollOutcome['task'], notice: '这一条没有上游任务号，问不了 —— 重新生成一次吧。', progress: null, latents: null };
  }

  try {
    if (isLocal) {
      /*
       * 本地任务查的是本机 ComfyUI 的 `/history`。与视频网关同一条规矩：**重新读一次凭据**
       * （提交和查询隔着整个轮询周期，用户可能中途改了地址），而不是假设提交时那份还在。
       */
      const creds = await readLocalCredentials(userId);
      remote = await queryLocalHistory(externalId, creds);
    } else if (isVideoApi) {
      const creds = await resolveVideoApiCredentials(userId);
      if (!creds) notice = missingCredentialsMessage('视频网关', 'VIDEO_API_KEY');
      else remote = await queryVideoApi(externalId, creds);
    } else if (isCustom) {
      /*
       * 凭据的**定位信息在 task.input.model 里**（`<providerId>::<modelId>`），
       * 不是从「当前配了什么」反推 —— 那条接口可能已经被删了，这时候必须报
       * 「这条接口不存在」，而不是拿另一条接口的 Key 去查别人的任务号。
       */
      const target = splitCustomModelValue((task.input as { model?: unknown } | null)?.model);
      const creds = target ? await readCustomCredentials(userId, target.providerId) : null;
      if (!creds) notice = '这条自定义接口已经不存在了，或它的 Key 解不开 —— 请到「设置 · 模型服务」里检查。';
      else remote = await queryCustomVideo({ baseUrl: creds.baseUrl, apiKey: creds.apiKey }, externalId);
    } else {
      const { apiKey, message: keyMessage, baseUrl } = await resolveRunningHub(userId);
      if (!apiKey) notice = keyMessage || '尚未配置 RunningHub API Key。';
      else {
        /*
         * 应用任务的产出**不在** `/openapi/v2/query` 那套端点下 —— 它有自己的
         * `/task/openapi/outputs`。少了这一支，应用任务会永远停在 running。
         */
        const appWebId = webAppIdOf(task.workflowId);
        remote = appWebId
          ? await queryWebAppOutputs(externalId, apiKey, baseUrl)
          : await queryTask(externalId, apiKey, baseUrl) as { status: string; results?: { url: string }[]; errorMessage?: string };
      }
    }
  } catch (error) {
    /* 超时那条会被 `api()` 认成 504；这里只管把人话带出去，状态不动。 */
    notice = '这一轮没问到上游：' + asMessage(error) + ' —— 任务还在，稍后会自动再问。';
  }

  /* 这一趟没问到：任务原样留着，等下一轮（或等前端接着轮询）。 */
  if (!remote) {
    const fresh = await db.task.findUnique({ where: { id: task.id } });
    return { task: (fresh || task) as PollOutcome['task'], notice, progress: null, latents: null };
  }

  const status = remoteStatusOf(remote);
  /*
   * 本机任务顺带回一份**实时进度**（跑到哪个节点、百分之几）。
   * 它只是给界面看的：判定成功失败只看 `status`。终态之后立刻清掉 ——
   * 那个 Map 不是存储，攒着只会白白占内存。
   */
  const progress = isLocal ? readLocalProgress(externalId) : null;
  if (isLocal && (status === 'success' || status === 'failed')) clearLocalProgress(externalId);
  /*
   * 先把媒体抓下来存本地，再写库。落盘要走一遍下载，任务成功后第一次查询会慢一些，
   * 但换来的是结果永不过期；失败也不至于把状态查询搞挂（archiveTaskMedia 内部全部吞掉异常）。
   */
  const done = status === 'success' && Boolean(remote.results?.length);
  const media = done
    ? await archiveTaskMedia({ userId, projectId: projectId, taskId: task.id, results: remote.results })
      .catch(() => [] as ArchivedMedia[])
    : [];
  const updated = await db.task.update({
    where: { id: task.id },
    data: {
      status,
      result: done ? rewriteResultUrls(remote.results, media) : (remote.results ?? undefined),
      error: remote.errorMessage || undefined,
      completedAt: status === 'success' || status === 'failed' ? new Date() : undefined,
    },
  });
  let latents: unknown = null;
  if (done) {
    try {
      latents = await archiveTaskLatents({ userId, projectId: projectId, taskId: task.id, results: remote.results });
    } catch {
      latents = null;
    }
  }
  /*
   * 生成失败就把用公共 key 扣掉的积分退回去。
   * 🔴 界面上不要写「积分已退回」—— 用户自己账号那一路我们压根没扣钱，
   *    `refundGeneration` 查不到记录会自己返回 null，那是一句没发生过的话。
   */
  if (status === 'failed') {
    try { await refundGeneration(userId, task.idempotencyKey); } catch { /* 退款失败不该连带把查询弄挂 */ }
  }
  return { task: updated as PollOutcome['task'], notice: null, progress, latents };
}
