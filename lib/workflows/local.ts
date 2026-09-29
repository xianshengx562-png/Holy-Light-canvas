/**
 * 本地工作流的身份约定 —— **一份 WorkflowDraft 跑在哪条路上，全靠这两样区分**：
 * `provider` 列 + `workflowId` 的前缀。
 *
 * 为什么走「给云端那份 WorkflowDraft 加一列」，而不是另开一张本地表：
 *   1. **字段配置只有一套**：`lib/workflows/configuration.ts` 里的 fieldSchema、画布绑定、
 *      `toNodeInfoList` 都是本地与云端共用的。另开一张表等于让用户为同一件事学两遍界面，
 *      也让「这行字段到底归在哪一边」这种问题永远修不完。
 *   2. **列表、筛选、名字、分类这些标签本来就是同一套**：画布下拉要把两者列在一起，
 *      设置页也要按同一个规则排序。分两张表就得在每个读的地方 union 一遍。
 *   3. 差别其实只有两处：**图在哪**（本地存在本行的 `graph`，云端在 RunningHub 那边）、
 *      **提交给谁**（本地投 `/prompt`，云端走 `submitWorkflow`）。这两处一列 `provider` 就够了。
 *
 * 本文件不 import 数据库，也不 import electron —— 回归脚本能直接加载。
 */

import { graphToFields, type WorkflowField } from './configuration';
import { isRunningHubAppWorkflowId, RUNNINGHUB_APP_PREFIX } from './runninghubApp';

export const LOCAL_PROVIDER = 'local';
export const RUNNINGHUB_PROVIDER = 'runninghub';
export type WorkflowProvider = typeof LOCAL_PROVIDER | typeof RUNNINGHUB_PROVIDER;

/** 本地工作流的 ID 前缀。带了前缀就不可能和 RunningHub 的纯数字 ID 撞在同一个唯一键上。 */
export const LOCAL_ID_PREFIX = 'local-';

/** RunningHub 的工作流 ID 就是一串数字。 */
const RUNNINGHUB_ID = /^\d{1,30}$/;
/** 本地 ID：前缀 + 一段小写字母数字。 */
const LOCAL_ID = /^local-[a-z0-9]{6,40}$/;

export function isLocalWorkflowId(value: unknown): boolean {
  return typeof value === 'string' && LOCAL_ID.test(value);
}

/**
 * 一个 ID 到底跑哪条路 —— **看前缀就够了**，不用查库。
 *
 * 这一点很重要：路由收到请求的第一时间就得知道「该按云端还是按本地校验」，
 * 而那时还没查过草稿（草稿可能压根不存在 —— 新建就是这么进来的）。
 */
export function providerFromWorkflowId(value: string): WorkflowProvider {
  return LOCAL_ID.test(value) ? LOCAL_PROVIDER : RUNNINGHUB_PROVIDER;
}

/**
 * 第三条路：RunningHub **应用**（`app-<数字>`）。
 *
 * 它的 `provider` 列仍然是 `runninghub`（图同样不在本地、同样按 ID 认），
 * 所以 `readWorkflowProvider` / `providerFromWorkflowId` 都不用改 ——
 * 只有「字段从哪儿拉」和「提交给谁」两处要看这个前缀，那两处各自在路由里判。
 */
export function isAppWorkflowId(value: unknown): boolean {
  return isRunningHubAppWorkflowId(value);
}

/**
 * 兜底读法：库里可能有别的版本写进去的值（外加刚补的那一列在老行上先是 NULL）。
 *
 * 认不出来的一律按「云端」处理 —— 这是这条路上最保守的假设：
 * 一条本来跑得好好的云端链路不会因为读不出一个字段就突然改投本地，而这种「改投」恰恰是最难察觉的。
 */
export function readWorkflowProvider(value: unknown): WorkflowProvider {
  return value === LOCAL_PROVIDER ? LOCAL_PROVIDER : RUNNINGHUB_PROVIDER;
}

/**
 * 校验工作流 ID。**返回一句中文理由**（合法就返回 `null`），让路由直接拿去报 400 ——
 * 「工作流 ID 必须为数字」这句老报错现在只说对了一半，而半句话比报错本身更容易把人带偏。
 */
export function workflowIdError(value: string): string | null {
  if (RUNNINGHUB_ID.test(value)) return null;
  /* 应用：`app-` + RunningHub 的应用 ID。它也是一串数字，但提交走的不是工作流那条路。 */
  if (isRunningHubAppWorkflowId(value)) return null;
  if (LOCAL_ID.test(value)) return null;
  if (value.startsWith(LOCAL_ID_PREFIX)) {
    return `本地工作流 ID 格式不对：${LOCAL_ID_PREFIX} 后面只能跟小写字母与数字。`;
  }
  if (value.startsWith(RUNNINGHUB_APP_PREFIX)) {
    return `应用 ID 格式不对：${RUNNINGHUB_APP_PREFIX} 后面只能跟 RunningHub 应用的那一串数字。`;
  }
  return '工作流 ID 得是 RunningHub 的纯数字工作流 ID，或者 `app-` 加应用 ID。';
}

/** `?provider=` 这类外部传进来的值认不认得 —— 不认识的直接 400，与前三个维度一个规矩。 */
export function isWorkflowProvider(value: unknown): value is WorkflowProvider {
  return value === LOCAL_PROVIDER || value === RUNNINGHUB_PROVIDER;
}

export function isWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && workflowIdError(value) === null;
}

/**
 * 生成一个新的本地工作流 ID。
 *
 * 前缀 + 时间戳 + 随机串，不引 uuid 依赖：这一段只要「本账号下不重复」就够了，
 * 真撞了由 `WorkflowDraft` 的 `[userId, workflowId]` 唯一键兜住（报 409，让用户再建一次）。
 */
export function newLocalWorkflowId(): string {
  const stamp = Date.now().toString(36);
  const salt = Math.random().toString(36).slice(2, 10);
  return `${LOCAL_ID_PREFIX}${stamp}${salt}`;
}

/** 图里有多少节点（列表页用来显示「这份图有多少节点」）。 */
export function graphNodeCount(graph: unknown): number {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return 0;
  return Object.keys(graph as Record<string, unknown>).length;
}

/**
 * 从本地那份 ComfyUI API 图扫出候选字段 —— 与云端「去 RunningHub 拉 getJsonApiFormat 再摊平」
 * 是同一份逻辑（见 `configuration.ts` 的 `graphToFields`），差别只有「图从哪来」。
 *
 * 扫出来的字段**默认不启用**（`enabled: false`）：它只代表「这份图里有哪些东西可填」，
 * 勾上哪些，哪些才变成真的会提交的参数。
 */
export function localGraphToFields(graph: unknown): WorkflowField[] {
  return graphToFields(graph);
}
