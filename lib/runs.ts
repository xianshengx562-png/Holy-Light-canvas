/**
 * 生成历史的数据源 —— 2026-10-02 起**不再挂在节点身上**。
 *
 * 以前「画布左轨 · 生成历史」读的是节点上的 `data.runs`，由 `collectRuns(nodes)`
 * 从**当前画布上还存在的节点**汇总。于是 `deleteNodes()` 一把节点过滤掉，
 * 它身上的生成记录一起消失 —— 画布一保存，服务端那份也没有了（徐先报的 bug）。
 *
 * 现在改成读库：每一次生成本来就会写一条 `Task`（四条路径全写：
 * `generation` / `videoapi` / `custom-image` / `custom-video`），
 * 它带 `nodeId` / `result` / `status` / `createdAt`，删节点动不到它。
 *
 * 🔴 两条纪律：
 * 1. **节点名要快照**（`nodeLabel`）。节点删掉之后就没人能回答「这条是谁跑的」了，
 *    所以建任务那一刻把名字写进 Task，不靠事后回画布去查。
 * 2. **这份文件在 `lib/`，别 import `src/components/canvas/*`** —— 它要被服务端跑。
 *    所以判定「视频 / 图片 / 音频」那三个正则放在 `lib/result-kind.ts`，
 *    与 `CanvasEditor` 里那段**共用同一份**（以前是照抄一份，改一边忘另一边的症状是
 *    同一条结果在历史里是音频、回到节点上却画成图片）。
 */

import { AUDIO_RESULT_RE, IMAGE_RESULT_RE, TEXT_RESULT_RE, VIDEO_RESULT_RE, resultKindOf, type ResultKind } from './result-kind';

export type RunResultItem = { url: string; kind: ResultKind };

export type RunRecord = {
  /** 就是 Task 的 id —— 前端内存里那一份用的是同一个 id，两边靠它去重。 */
  id: string;
  /** 同一个节点上的第几次生成，从 1 开始。按该节点的建单顺序算。 */
  index: number;
  workflowId: string;
  nodeId: string;
  /** 生成它的那个节点的名字（快照）。节点已经删了也要显示得出来。 */
  nodeLabel: string;
  /** 展示用的时间字符串。 */
  at: string;
  /** 排序用的时间戳（毫秒）。 */
  ts: number;
  status: 'success' | 'failed';
  error?: string;
  results: RunResultItem[];
};

/** 查库时 select 出来的那点字段，够转换就行。 */
export type TaskRunRow = {
  id: string;
  nodeId: string;
  workflowId: string;
  nodeLabel?: string | null;
  status: string;
  error?: string | null;
  result?: unknown;
  createdAt: Date | string | number;
  completedAt?: Date | string | number | null;
};

/** `Task.result` 到「可展示的结果列表」。与 `CanvasEditor` 里那段共用同一套判定。 */
export function resultsOfTask(result: unknown): RunResultItem[] {
  const list = Array.isArray(result)
    ? result
    : (result && typeof result === 'object' && Array.isArray((result as { results?: unknown[] }).results))
      ? (result as { results?: unknown[] }).results!
      : [];
  const items = list.filter((item): item is { url?: string; outputType?: string; text?: string } =>
    !!item && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string');
  const pick = (pattern: RegExp) =>
    items.find(item => pattern.test(`${item.outputType || ''} ${item.url}`));
  const videoItem = pick(VIDEO_RESULT_RE);
  const imageItem = pick(IMAGE_RESULT_RE);
  const audioItem = pick(AUDIO_RESULT_RE);
  /*
   * 文本结果（2026-10-04）：归档之后它是一条 `.txt` 地址；万一没落盘（下载失败、离线），
   * 它是一条**没有地址**、只有 `text` 的结果 —— 两种都要认。
   */
  const textItem = items.find(item => item.text && !item.url) ?? pick(TEXT_RESULT_RE);
  /** 既认不出 outputType 也没有扩展名时退回第一个结果 —— 保持旧行为（但退回的那条得有地址）。 */
  const ambiguous = !videoItem && !imageItem && !audioItem && !textItem && items[0]?.url ? items[0] : undefined;
  const out: RunResultItem[] = [];
  if (videoItem?.url) out.push({ url: String(videoItem.url), kind: 'video' });
  if (imageItem?.url && imageItem.url !== videoItem?.url) out.push({ url: String(imageItem.url), kind: 'image' });
  if (audioItem?.url && audioItem.url !== videoItem?.url && audioItem.url !== imageItem?.url)
    out.push({ url: String(audioItem.url), kind: 'audio' });
  if (textItem?.url && !out.some(item => item.url === String(textItem.url)))
    out.push({ url: String(textItem.url), kind: 'text' });
  if (!out.length && ambiguous?.url)
    out.push({ url: String(ambiguous.url), kind: resultKindOf(`${ambiguous.outputType || ''} ${ambiguous.url}`) ?? 'image' });
  return out;
}

export function formatRunAt(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  /* 坏了的时间戳别让整条列表挂掉：显示成空串，排序按 0。 */
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
}

function timeMs(value: Date | string | number): number {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * 一批 Task 行 → 历史记录。
 *
 * - **只留终态**：`queued` / `running` / `cancelled` 不进历史（它们是「还在跑」和「喊停了」，
 *   不是「跑出来过什么」；跑完那一次自己会补进来）。
 * - **第几次**按同一个节点分组、按建单时间升序算 —— 节点删了也还算得出来（分组键是 `nodeId`）。
 * - 时间用**完成时间**（`completedAt`），没有就退回建单时间。历史讲的是「什么时候出的片」，
 *   提交时间和出片时间差几分钟时，后者才是用户心里的那个「这次」。
 */
export function runRecordsFromTasks(
  rows: TaskRunRow[],
  /**
   * 「节点 id → 现在的名字」，用来补**老数据**：`Task.nodeLabel` 是这一版才加的，
   * 更早的任务都没存名字，全显示成「生成节点」。节点还在画布上的话，
   * 拿它现在的名字补上（节点已经删了就补不了，那也是没办法的事 —— 只能靠快照）。
   */
  labels?: Record<string, string>,
): RunRecord[] {
  const done = rows.filter(row => row.status === 'success' || row.status === 'failed');
  const order = new Map<string, number>();
  const counter = new Map<string, number>();
  /* 先按时间升序排一遍，「第几次」才是按发生顺序数出来的，不是按数组顺序。 */
  const sorted = [...done].sort((a, b) => timeMs(a.createdAt) - timeMs(b.createdAt));
  for (const row of sorted) {
    const next = (counter.get(row.nodeId) || 0) + 1;
    counter.set(row.nodeId, next);
    order.set(row.id, next);
  }
  return done.map(row => {
    const failed = row.status === 'failed';
    /* 显式标成 `RunRecord`：不标的话 `status` 会被推成 `string`（条件展开那一手把字面量类型冲掉了）。 */
    const record: RunRecord = {
      id: row.id,
      index: order.get(row.id) || 1,
      workflowId: String(row.workflowId || ''),
      nodeId: String(row.nodeId || ''),
      nodeLabel: String(row.nodeLabel || labels?.[String(row.nodeId || '')] || ''),
      at: formatRunAt(row.completedAt ?? row.createdAt),
      ts: timeMs(row.completedAt ?? row.createdAt),
      status: failed ? 'failed' : 'success',
      error: failed ? String(row.error || '生成失败') : undefined,
      results: failed ? [] : resultsOfTask(row.result),
    };
    return record;
  }).sort((a, b) => b.ts - a.ts);
}
