'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { latentLabel } from './nodeMeta';
import { assetIdFromUrl, useAssetFileDrag } from '@/lib/file-drag';
import type { RunRecord, RunResultItem } from '@/lib/runs';
import type { GenerationRun, LatentRecord } from './types';

/**
 * 右上角「生成结果」侧边栏。**跨画布共通**：一张画布上看到的，是所有画布的生成结果。
 *
 * 为什么必须跨画布：
 * 生成是「排着队的」——提交完常常要等几分钟，人不会干盯着一张画布等，
 * 而是切到别的画布接着干活。**结果却只在产出它的那张画布上看得到**，
 * 于是「刚才那次跑出来没有」得靠回到原画布去翻，翻的时候还看不见别处又跑完了什么。
 * 汇总成一条流之后，不管人在哪张画布上，都能一眼看到全部结果，点一下就跳回那张画布。
 *
 * 三条刻意的取舍：
 *
 * 1. **每张画布都走接口，内存里那份只兜底。**
 *    库里那一份是准的（任务一提交就写库，删节点动不到它）；只有库里一条都没有时
 *    （很早的画布，Task 表还没记东西）才用 `currentRuns`，免得升级之后历史突然变空。
 * 2. **按项目逐个拉 `/api/projects/:id/runs`**（2026-10-02 改）。
 *    以前是拉整张画布再用 `collectRuns` 汇总 —— 节点一删，它身上的记录就跟着没了。
 *    顺带：拉的是一份几百条的记录，比拉整张画布小得多。
 * 3. **没有结果也要把话说清楚。** 「还没开始生成」和「加载失败了」是两回事，
 *    静默空列表会让人以为功能坏了。
 *
 * 结果**能直接拖到别的软件里**（2026-10-09 徐先：「生成结果也能拖到别的软件」）：
 * 图拖进 PS、视频拖进剪辑软件都是常见的一步。拖拽那一套与资产卡片共用一份
 * （`lib/file-drag.ts`），这里只多判一件事 —— **这条结果有没有本机文件**。
 * RunningHub 那类远程结果（`item.url` 不是 `/api/assets/…`）根本没有本机路径，
 * 那种不给拖，也不假装能拖（见下面 `assetIdFromUrl`）。
 */

/** `GET /api/projects` 只用得到这两个字段。 */
type ProjectRow = { id: string; name: string };

export type ResultsRun = GenerationRun & {
  projectId: string;
  projectName: string;
  /** 是不是当前这张画布（是的话不显示「打开这张画布」）。 */
  current: boolean;
};

/** 一次最多并发拉几张画布：项目多的时候别把接口打成一排。 */
const CONCURRENCY = 4;

/**
 * 一条结果。（单独抽出来是因为**每条要各自判一次「有没有本机文件」**，
 * 塞在 `.map()` 里就要靠 IIFE，读起来比一个组件糟。）
 */
function ResultMedia({
  item,
  index,
  onPrefetch,
  onDragStart,
}: {
  item: RunResultItem;
  /** 第几次生成 —— 只给图片的 alt 用。 */
  index: number;
  onPrefetch: (id: string) => void;
  onDragStart: (event: React.DragEvent, id: string) => void;
}) {
  /*
   * 只有「本机资产地址」这种形状拖得动 —— 见 `assetIdFromUrl`。
   * 远程结果（RunningHub 之类）**没有本机文件**，那种不给拖，也不假装能拖：
   * 让它拖起来、掉到目标软件里却是一串地址，比拖不动更让人困惑。
   */
  const assetId = assetIdFromUrl(item.url);
  const dragProps = assetId
    ? {
      draggable: true,
      onPointerDown: () => onPrefetch(assetId),
      onDragStart: (event: React.DragEvent) => onDragStart(event, assetId),
      title: '可以直接拖到别的软件里',
    }
    : { draggable: false, title: '这份结果只在云端，本机没有文件 —— 拖不出去，可以先存进资产库。' };

  return (
    <div
      className="cv-results-media"
      data-result-kind={item.kind}
      data-result-drag={assetId ? 'yes' : 'no'}
      {...dragProps}
    >
      {item.kind === 'image'
        /*
         * `draggable={false}` 必须给：`<img>` **默认就是可拖的**，不给的话这次拖拽的
         * 源头是那张图而不是外面这层 —— 落到目标软件里的是「一张图片」而不是那个文件
         * （资产卡片上同一个坑，见 `lib/file-drag.ts`）。
         */
        ? <img className="cv-video" src={item.url} alt={`第 ${index} 次生成的图片`} draggable={false} />
        /* 音频那一档：`<video>` 也能放 mp3，但拿一整块 16:9 黑框装一段只有波形的声音
           很难看，也看不出进度。用原生 `<audio>` —— 一条窄条，带播放与进度。 */
        /* `.cv-audio` 是那层带底色的壳，里面才是 `<audio>`（见 canvas.css）。 */
        : item.kind === 'audio'
          ? <span className="cv-audio"><audio src={item.url} controls preload="metadata" /></span>
          /* 文本结果（2026-10-04）：它的 url 是资产库里那份 `.txt`。这里不做内嵌预览，
             给一条能打开/下载的入口就行 —— 内嵌要么自己再抓一遍内容，要么把整段文字塞进列表，
             而这一栏是「历次生成的索引」，塞长文本会把别次的结果挤没。
             `<a href>` 同样默认可拖（拖出去的是链接），一并关掉。 */
          : item.kind === 'text'
            ? <a className="cv-results-text" href={item.url} target="_blank" rel="noreferrer" draggable={false}>
              文本结果 · 打开 / 下载 .txt
            </a>
            : <video className="cv-video" src={item.url} controls preload="metadata" />}
    </div>
  );
}

export default function CanvasResultsPanel({
  projectId,
  projectName,
  currentRuns,
  latents,
}: {
  projectId: string;
  projectName: string;
  /** 当前画布的生成记录（内存里那一份，可能还没保存）。 */
  currentRuns: GenerationRun[];
  /** 当前项目的 Latent 包索引。Latent 是按项目归档的，不跨画布。 */
  latents: LatentRecord[];
}) {
  const [loaded, setLoaded] = useState<ResultsRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [projectCount, setProjectCount] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch('/api/projects');
        if (!response.ok) throw new Error('列不出项目');
        const rows = (await response.json()) as ProjectRow[];
        if (!alive) return;
        setProjectCount(rows.length);
        /* 当前这张画布也一起拉：删掉节点之后，「历史」得靠库里那份才还在。 */
        const targets = rows;
        const found: ResultsRun[] = [];
        let cursor = 0;
        /* 并发拉画布，但一次只放 CONCURRENCY 个 —— 项目一多，
           一股脑几十个请求出去只会把本机服务堵住，反而更慢。 */
        const worker = async () => {
          while (alive) {
            const index = cursor++;
            if (index >= targets.length) return;
            const row = targets[index];
            try {
              const runsResponse = await fetch(`/api/projects/${row.id}/runs`);
              if (!runsResponse.ok) continue;
              const payload = await runsResponse.json() as { runs?: RunRecord[] };
              for (const run of Array.isArray(payload?.runs) ? payload.runs : []) {
                found.push({
                  ...run,
                  projectId: row.id,
                  projectName: row.name || '未命名项目',
                  current: row.id === projectId,
                });
              }
            } catch {
              /* 某一张画布拉不动不该让整个列表空掉，跳过它继续 */
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
        if (!alive) return;
        setLoaded(found);
      } catch {
        if (alive) setError('没能读出其他画布的生成结果。');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    /* 面板一关 `CanvasDrawer` 就卸载，这个 cleanup 是把「卸载后还在跑的请求」的结果丢掉，
       不然会出现「关掉再打开，列表被上一次的结果覆盖」这种顺序错乱。 */
    return () => { alive = false; };
  }, [projectId, reloadSeq]);

  const runs = useMemo(() => {
    /* 库里那一份是准的；只有库里一条都没有时（很早的画布）才落回节点上那份。 */
    const fromDb = loaded.filter(run => run.current);
    const mine: ResultsRun[] = fromDb.length
      ? fromDb
      : currentRuns.map(run => ({ ...run, projectId, projectName: projectName || '未命名项目', current: true }));
    return [...mine, ...loaded.filter(run => !run.current)].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  }, [currentRuns, loaded, projectId, projectName]);

  const reload = useCallback(() => setReloadSeq(seq => seq + 1), []);

  /*
   * 拖不动 / 还没准备好时的一句话（2026-10-09）。
   *
   * 这一栏没有资产页那种常驻提示条，所以自己留一行字；**说完 1.8s 自己收掉** ——
   * 拖拽是「试一下才知道」的动作，回执一直挂着会挡住结果本身。
   */
  const [dragMsg, setDragMsg] = useState('');
  const dragTimer = useRef<number | null>(null);
  const sayNotice = useCallback((text: string) => {
    setDragMsg(text);
    if (dragTimer.current) window.clearTimeout(dragTimer.current);
    dragTimer.current = window.setTimeout(() => { setDragMsg(''); dragTimer.current = null; }, 1800);
  }, []);
  const { prefetch, beginDrag } = useAssetFileDrag(sayNotice);
  /* 面板一关就卸载，定时器要跟着走，不然会在一个死组件上 setState。 */
  useEffect(() => () => {
    if (dragTimer.current) window.clearTimeout(dragTimer.current);
  }, []);

  return (
    <div className="cv-results">
      <div className="cv-results-bar">
        <span>
          共 {projectCount} 张画布 · {runs.length} 条结果
        </span>
        <button
          className="cv-results-reload"
          type="button"
          data-results-reload=""
          aria-label="刷新其他画布的结果"
          data-tip="刷新"
          onClick={reload}
        >
          {loading ? <Loader2 size={13} strokeWidth={2} className="cv-spin" aria-hidden /> : <RefreshCw size={13} strokeWidth={2} aria-hidden />}
        </button>
      </div>

      {dragMsg && <p className="cv-results-empty" data-results-drag-msg>{dragMsg}</p>}

      <div className="cv-results-list" data-results-list="">
        <div className="cv-results-section-title">Latent 包 · 当前画布</div>
        {latents.length === 0
          ? <p className="cv-results-empty">还没有归档。任务完成后粗采样 / 精采样会打包编号存到这里。</p>
          : latents.slice(0, 16).map(item => (
            <Link key={item.id} className="cv-link" href={`/api/assets/${item.id}/download`}>
              <Download size={13} strokeWidth={1.8} aria-hidden /> {latentLabel(item)}
            </Link>
          ))}

        <div className="cv-results-section-title">生成结果 · 全部画布</div>
        {error ? <p className="cv-results-empty">{error}</p> : null}
        {!error && runs.length === 0
          ? <p className="cv-results-empty">{loading ? '正在读其他画布…' : '还没有生成结果。跑一次生成，结果会出现在这里 —— 别的画布上的也算。'}</p>
          : null}
        {runs.map(run => (
          <div key={`${run.projectId}-${run.id}`} className="cv-results-item" data-results-item="">
            <div className="cv-results-head">
              <b>{`第 ${run.index} 次`}</b>
              <span className="cv-results-node">{run.nodeLabel || ''}</span>
              <span className={`cv-results-proj${run.current ? ' current' : ''}`}>
                {run.current ? '这张画布' : run.projectName}
              </span>
            </div>
            {!run.current && (
              /* 跳回产出它的那张画布：App 按 pathname 换 Page 实例，hash 路由下这一跳是整页重挂，
                 所以不用管那边的画布是不是已经开着。 */
              <Link className="cv-results-open" href={`/projects/${run.projectId}`}>打开这张画布</Link>
            )}
            {run.at ? <div className="cv-results-at">{run.at}</div> : null}
            {run.status === 'failed'
              ? <div className="cv-msg error">{run.error || '生成失败'}</div>
              : run.results.length === 0
                ? <p className="cv-results-empty">这次没有返回可播放的结果。</p>
                /*
                 * 这里原来挂着一颗「下载」。**去掉了**：`item.url` 有两种 ——
                 * 本机的 `/api/assets/<id>/media.mp4`，和 RunningHub 的远程链接。
                 * HTML 的 `download` 属性只在**同源**时生效，跨域那一类点下去根本不下载
                 * （要么没反应、要么直接跳去那个地址）—— 一半结果上是坏的，
                 * 留着比没有更糟。现在换成往别处拖（只有本机那一种拖得动，见 `ResultMedia`）。
                 */
                : run.results.map(item => (
                  <ResultMedia
                    key={item.url}
                    item={item}
                    index={run.index}
                    onPrefetch={prefetch}
                    onDragStart={beginDrag}
                  />
                ))}
          </div>
        ))}
      </div>
    </div>
  );
}
