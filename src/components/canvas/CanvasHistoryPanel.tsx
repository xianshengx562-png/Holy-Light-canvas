'use client';

import { useMemo, useState } from 'react';
import { ImageOff, Music2 } from 'lucide-react';
import CanvasOverlay from './CanvasOverlay';
import { useApi } from '@/lib/client';
import type { RunRecord } from '@/lib/runs';
import type { GenerationRun } from './types';

/**
 * 画布左轨「历史」弹出的大浮层：这张画布跑过的每一次生成，最新的在前。
 *
 * 🔴 **数据源是库，不是节点**（2026-10-02 改，徐先报的 bug）：
 * 以前读的是节点身上的 `data.runs`，由 `collectRuns` 从**当前画布上还存在的节点**汇总 ——
 * 于是删掉一个节点，它跑过的那些生成就一起消失了，画布一保存服务端那份也没了。
 * 现在读 `/api/projects/:id/runs`（`Task` 表，见 `lib/runs.ts`）：
 * 每一次生成本来就会写一条任务，删节点、改名字、复制节点都动不到它。
 *
 * `runs`（节点上那份）现在只当**兜底**：库里一条都没有 = 这是很早的画布
 * （Task 表还没记东西），用它兜着，免得升级之后「以前跑过的全没了」。
 *
 * ⚠️ 两件事别搞混：
 *
 * 1. **点一项是「回到那个节点」**，不是打开预览：落到画布上、选中它，接下来要改参数还是
 *    重跑都由用户决定。想看大图的话节点卡片上本来就有。
 *    **节点已经删掉时不跳** —— 记录还在（这正是这次修的东西），但没地方可去，画布上会说明一句。
 *
 * 2. **范围是这张画布**。右上角那个「生成结果」侧边栏汇总的是**所有**画布，
 *    这里只列当前这一张 —— 左轨上的东西都属于「当前画布」。
 */
type Filter = 'all' | 'success' | 'failed';

export default function CanvasHistoryPanel({
  projectId,
  runs,
  nodeIds,
  onClose,
  onPick,
}: {
  projectId: string;
  /** 节点上那份（内存里的兜底）。库里一条都没有时才用它。 */
  runs: GenerationRun[];
  /** 当前画布上还有哪些节点 —— 用来标出「生成它的节点已经删掉了」。 */
  nodeIds: string[];
  onClose: () => void;
  /** 点某一项：关掉浮层并选中生成它的那个节点。节点不在了由调用方决定怎么说。 */
  onPick: (nodeId?: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const { data } = useApi<{ runs: RunRecord[] }>(projectId ? `/api/projects/${projectId}/runs` : null);
  const alive = useMemo(() => new Set(nodeIds), [nodeIds]);

  const fromDb = data?.runs || [];
  const source: GenerationRun[] = fromDb.length ? fromDb : runs;

  const failed = source.filter(run => run.status === 'failed').length;
  const visible = filter === 'all' ? source : source.filter(run => run.status === filter);

  return (
    <CanvasOverlay
      title="生成历史"
      kicker="HISTORY"
      note="这张画布跑过的每一次生成 · 点一项会选中生成它的那个节点"
      nav={[
        { key: 'all', label: '全部', count: source.length },
        { key: 'success', label: '成功', count: source.length - failed },
        { key: 'failed', label: '失败', count: failed },
      ]}
      active={filter}
      onNav={key => setFilter(key as Filter)}
      onClose={onClose}
    >
      {!visible.length
        ? <p className="cv-ov-empty">{source.length ? '这一类还没有记录。' : '这张画布还没跑过生成 —— 选中一个生成节点，填上提示词后点「生成」就有了。'}</p>
        : (
          <div className="cv-hist-grid">
            {visible.map(run => {
              const first = run.results[0];
              /* 记录还在、节点没了：这就是「历史不随节点消失」之后会出现的状态，
                 要明说出来 —— 不然点下去没反应，用户只会以为坏了。 */
              const gone = !!run.nodeId && !alive.has(run.nodeId);
              return (
                <button
                  key={run.id}
                  type="button"
                  className="cv-hist"
                  data-run-status={run.status}
                  data-run-node-gone={gone ? 'yes' : undefined}
                  onClick={() => onPick(run.nodeId)}
                  title={run.error || ''}
                >
                  <span className="cv-hist-thumb">
                    {first?.kind === 'video' && <video src={first.url} preload="metadata" muted playsInline />}
                    {first?.kind === 'image' && <img src={first.url} alt="" loading="lazy" />}
                    {/* 音频没有缩略图可画：给一个音符占位，别去喂 `<img>`（会得到一张坏图）。 */}
                    {first?.kind === 'audio' && <span className="cv-hist-glyph"><Music2 size={16} strokeWidth={1.6} aria-hidden /></span>}
                    {!first && <span className="cv-hist-glyph"><ImageOff size={16} strokeWidth={1.6} aria-hidden /></span>}
                  </span>
                  <span className="cv-hist-meta">
                    <b>
                      {run.nodeLabel || '生成节点'} · 第 {run.index} 次
                      {gone ? <em className="cv-hist-gone">（节点已删除）</em> : null}
                    </b>
                    <small>
                      {run.at || (run.ts ? new Date(run.ts).toLocaleString('zh-CN', { hour12: false }) : '时间未知')}
                      {run.status === 'failed'
                        ? ` · 失败${run.error ? `：${run.error}` : ''}`
                        : ` · ${run.results.length} 个结果`}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        )}
    </CanvasOverlay>
  );
}
