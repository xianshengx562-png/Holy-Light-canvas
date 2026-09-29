import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { api, apiUser } from '@/lib/api';
import { refundGeneration } from '@/lib/wallet';
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
     * 按 provider 取远端状态。
     *
     * 视频网关那条链路是**异步**的（提交拿号 → 轮询），所以它必须走这里 —— 而这一层原本
     * 是写死 RunningHub 的。两家的响应结构不一样，但 `queryVideoApi` 已经把状态归一成
     * RunningHub 那套词汇（SUCCESS / FAILED / QUEUED / RUNNING），所以下面的落盘、
     * 退款、状态映射一份代码就够，不需要为它再开一条分支。
     *
     * 现在这里是**三条路**：RunningHub（默认）、视频网关（异步）、本地 ComfyUI（`local`）。
     * ⚠️ 再接第四个 provider 时这里要跟着加，否则任务会永远停在 running（界面只转圈）。
     */
    const isVideoApi = task.provider === 'videoapi';
    const isCustom = task.provider === 'custom';
    const isLocal = task.provider === 'local';
    let remote: { status: string; results?: { url: string; outputType?: string }[]; errorMessage?: string };
    if (isLocal) {
      /*
       * 本地任务查的是本机 ComfyUI 的 `/history`。与视频网关同一条规矩：**重新读一次凭据**
       * （提交和查询隔着整个轮询周期，用户可能中途改了地址），而不是假设提交时那份还在。
       */
      const creds = await readLocalCredentials(user.id);
      remote = await queryLocalHistory(task.externalTaskId, creds);
    } else if (isVideoApi) {
      /*
       * 提交和查询是**两次独立的 HTTP 请求**，中间隔着一整个轮询周期，所以这里必须重新取一次凭据，
       * 不能假设「提交时那把还在」。用户级优先、回落 env 的规则要和提交那侧完全一致 ——
       * 不一致的症状是「任务提交成功、永远卡在 running」，而且看日志只会看到查询失败。
       */
      const creds = await resolveVideoApiCredentials(user.id);
      if (!creds) return NextResponse.json({ ...task, error: missingCredentialsMessage('视频网关', 'VIDEO_API_KEY') });
      remote = await queryVideoApi(task.externalTaskId, creds);
    } else if (isCustom) {
      /*
       * 自定义接口（2026-09-21）：与视频网关同一条异步节奏，凭据要从 `CustomProvider` 取。
       *
       * ⚠️ 凭据的**定位信息在 task.input.model 里**（`<providerId>::<modelId>`），
       * 不是从「当前配了什么」反推 —— 那条接口可能已经被删了，这时候必须报
       * 「这条接口不存在」，而不是拿另一条接口的 Key 去查别人的任务号。
       */
      const target = splitCustomModelValue((task.input as { model?: unknown } | null)?.model);
      const creds = target ? await readCustomCredentials(user.id, target.providerId) : null;
      if (!creds) {
        return NextResponse.json({ ...task, error: '这条自定义接口已经不存在了，或它的 Key 解不开 —— 请到「设置 · 模型服务」里检查。' });
      }
      remote = await queryCustomVideo({ baseUrl: creds.baseUrl, apiKey: creds.apiKey }, task.externalTaskId);
    } else {
      /*
       * 查询也要带上**站**：提交与查询是两次独立的 HTTP 请求，中间隔着一整个轮询周期，
       * 两边打到不同站的话，症状是「提交成功、永远查不到」。
       */
      const { apiKey, message: keyMessage, baseUrl } = await resolveRunningHub(user.id);
      if (!apiKey) return NextResponse.json({ ...task, error: keyMessage || '尚未配置 RunningHub API Key。' });
      /*
       * 应用任务的产出**不在** `/openapi/v2/query` 那套端点下 —— 它有自己的
       * `/task/openapi/outputs`。少了这一支，应用任务会永远停在 running（界面只转圈），
       * 而提交明明成功了 —— 又是一个「看起来像上游坏了」的静默失败。
       */
      const appWebId = webAppIdOf(task.workflowId);
      remote = appWebId
        ? await queryWebAppOutputs(task.externalTaskId, apiKey, baseUrl)
        : await queryTask(task.externalTaskId, apiKey, baseUrl) as { status: string; results?: { url: string }[]; errorMessage?: string };
    }
    const status = remote.status === 'SUCCESS' ? 'success' : remote.status === 'FAILED' ? 'failed' : remote.status === 'QUEUED' ? 'queued' : 'running';
    /*
     * 本机任务顺带回一份**实时进度**（跑到哪个节点、百分之几）。
     * 它只是给界面看的：`/history` 才是判定成功失败的根据，进度有没有都不影响上面的 status。
     * 终态之后立刻清掉 —— 那个 Map 不是存储，攒着只会白白占内存。
     */
    const progress = isLocal ? readLocalProgress(task.externalTaskId) : null;
    if (isLocal && (status === 'success' || status === 'failed')) clearLocalProgress(task.externalTaskId);
    /*
     * 先把媒体抓下来存本地，再写库。落盘要走一遍下载，任务成功后第一次查询会慢一些，
     * 但换来的是结果永不过期；失败也不至于把状态查询搞挂（archiveTaskMedia 内部全部吞掉异常）。
     */
    const done = status === 'success' && Boolean(remote.results?.length);
    const media = done
      ? await archiveTaskMedia({ userId: user.id, projectId: task.projectId, taskId: id, results: remote.results })
        .catch(() => [] as ArchivedMedia[])
      : [];
    const updated = await db.task.update({
      where: { id },
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
        latents = await archiveTaskLatents({ userId: user.id, projectId: task.projectId, taskId: id, results: remote.results });
      } catch {
        latents = null;
      }
    }
    /*
     * 生成失败就把用公共 key 扣掉的积分退回去。上面那个 early return 保证这条分支对同一个任务
     * 只会走一次；refundGeneration 本身也按 idempotencyKey 去重，双保险。
     */
    if (status === 'failed') {
      try { await refundGeneration(user.id, task.idempotencyKey); } catch { /* 退款失败不该连带把任务状态查询弄挂 */ }
    }
    return NextResponse.json({ ...updated, latents, ...(progress ? { progress } : {}) });
  });
}
