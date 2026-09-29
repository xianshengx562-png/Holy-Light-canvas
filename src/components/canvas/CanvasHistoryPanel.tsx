'use client';

import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import CanvasOverlay from './CanvasOverlay';
import type { GenerationRun } from './types';

/**
 * 画布左轨「历史」弹出的大浮层：这张画布跑过的每一次生成，最新的在前。
 *
 * 数据就是节点上那份 `runs`（`collectRuns` 汇总出来的，与右上角「生成结果」同一份规则）——
 * 它随画布一起保存，所以刷新之后每一次生成都还在。
 *
 * ⚠️ 两件事别搞混：
 *
 * 1. **点一项是「回到那个节点」**，不是打开预览：落到画布上、选中它，接下来要改参数还是
 *    重跑都由用户决定。想看大图的话节点卡片上本来就有。
 *
 * 2. **范围是这张画布**。右上角那个「生成结果」侧边栏汇总的是**所有**画布，
 *    这里只列当前这一张 —— 左轨上的东西都属于「当前画布」。
 */
type Filter = 'all' | 'success' | 'failed';

export default function CanvasHistoryPanel({
  runs, onClose, onPick,
}: {
  runs: GenerationRun[];
  onClose: () => void;
  /** 点某一项：关掉浮层并选中生成它的那个节点。 */
  onPick: (nodeId?: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const failed = runs.filter(run => run.status === 'failed').length;
  const visible = filter === 'all' ? runs : runs.filter(run => run.status === filter);

  return (
    <CanvasOverlay
      title="生成历史"
      kicker="HISTORY"
      note="这张画布跑过的每一次生成 · 点一项会选中生成它的那个节点"
      nav={[
        { key: 'all', label: '全部', count: runs.length },
        { key: 'success', label: '成功', count: runs.length - failed },
        { key: 'failed', label: '失败', count: failed },
      ]}
      active={filter}
      onNav={key => setFilter(key as Filter)}
      onClose={onClose}
    >
      {!visible.length
        ? <p className="cv-ov-empty">{runs.length ? '这一类还没有记录。' : '这张画布还没跑过生成 —— 选中一个生成节点，填上提示词后点「生成」就有了。'}</p>
        : (
          <div className="cv-hist-grid">
            {visible.map(run => {
              const first = run.results[0];
              return (
                <button
                  key={run.id}
                  type="button"
                  className="cv-hist"
                  data-run-status={run.status}
                  onClick={() => onPick(run.nodeId)}
                  title={run.error || ''}
                >
                  <span className="cv-hist-thumb">
                    {first?.kind === 'video' && <video src={first.url} preload="metadata" muted playsInline />}
                    {first?.kind === 'image' && <img src={first.url} alt="" loading="lazy" />}
                    {!first && <span className="cv-hist-glyph"><ImageOff size={16} strokeWidth={1.6} aria-hidden /></span>}
                  </span>
                  <span className="cv-hist-meta">
                    <b>{run.nodeLabel || '生成节点'} · 第 {run.index} 次</b>
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
