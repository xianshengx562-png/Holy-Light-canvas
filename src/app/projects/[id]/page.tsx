'use client';

/*
 * 项目画布页（2026-09-18 从服务端组件改成客户端取数）。
 *
 * 原来在服务端 `getProject()` 直读库、读不到就 `notFound()`。桌面版改成
 * `GET /api/projects/{id}`（新增接口），读不到就在页面上说清楚 —— 客户端没有
 * `notFound()` 那套 404 页，但用户需要的是「为什么打不开」，不是一个状态码。
 */
import CanvasEditor from '@/components/canvas/CanvasEditor';
import type { CanvasPayload } from '@/components/canvas/types';
import { useApi } from '@/lib/client';
import { useParams, useSearchParams } from 'next/navigation';
import { PROMPT_MAX } from '@/lib/start/quick';
import { readCanvasSeed } from '@/lib/start/compose';

type ProjectPayload = {
  id: string;
  name: string;
  canvas: { nodes: unknown; edges: unknown; viewport: unknown; version: number } | null;
};

export default function Project() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const { data: project, loading, error } = useApi<ProjectPayload>(id ? `/api/projects/${id}` : null);

  if (loading) {
    /*
     * 画布骨架（2026-10-07 徐先：「加载的界面优化一下」）。
     *
     * 原来是「一块空底 + 居中一个 ✦ 字符 + 正在打开画布…」（`.empty` 那套）。
     * 点进项目的第一眼是一块什么都没有的底板，然后整块画布**切**进来。
     * 现在先按**真实画布的形状**摆一个空壳：顶栏、左侧工具条、地板上的几个影子节点。
     * 数据回来时是「影子被真节点替换」，不是「整个界面换了一次」。
     *
     * ⚠️ 刻意**不画右侧参数栏** —— 真实画布刚打开时没选中任何节点，参数栏本来就不出现，
     *    画上去等于自己造一次布局跳动。
     * ⚠️ 用 `.flow-shell` 而不是自己写一套底色：`cv-*` 令牌都挂在它身上
     *    （tokens.css 里 `.flow-shell` / `[data-theme='dark'] .flow-shell` 两档），
     *    于是这块骨架自动跟着主题与画布配色走，不用再维护第三套颜色。
     */
    return (
      <div className="canvas-studio">
        <div className="flow-shell cv-booting" role="status" aria-live="polite" aria-busy="true">
          <div className="cv-boot-topbar">
            <span className="cv-boot-brand" />
            <span className="cv-boot-chip" />
            <span className="cv-boot-chip sm" />
            <span className="cv-boot-gap" />
            <span className="cv-boot-chip" />
            <span className="cv-boot-btn" />
          </div>
          <div className="cv-boot-body">
            <div className="cv-boot-rail">
              {[0, 1, 2, 3, 4].map(n => <span className="cv-boot-dot" key={n} />)}
            </div>
            <div className="cv-boot-floor">
              {[0, 1, 2].map(n => <span className="cv-boot-node" key={n} />)}
            </div>
          </div>
          <p className="cv-boot-tip">正在打开画布…</p>
        </div>
      </div>
    );
  }
  if (error || !project) {
    return (
      <div className="empty" style={{ padding: 48 }}>
        <div className="empty-icon">？</div>
        <h3>打不开这个项目</h3>
        <p className="muted">{error ?? '项目不存在。'}</p>
        <a className="button" href="#/">回主界面</a>
      </div>
    );
  }

  const canvas = project.canvas;
  const initial: CanvasPayload = {
    nodes: (Array.isArray(canvas?.nodes) ? canvas.nodes : []) as unknown as CanvasPayload['nodes'],
    edges: (Array.isArray(canvas?.edges) ? canvas.edges : []) as unknown as CanvasPayload['edges'],
    viewport: (canvas?.viewport && typeof canvas.viewport === 'object'
      ? canvas.viewport
      : { x: 0, y: 0, zoom: 1 }) as CanvasPayload['viewport'],
    version: canvas?.version ?? 0,
  };

  /*
   * 首页大输入框带过来的一路（见 `components/start/ComposeBar.tsx`）。两种形态：
   *   - 只带 `?prompt=`（老链接）：只把这句话填进提示词节点，节点结构原样不动；
   *   - 带 `?mode=` 的完整 seed：画布按它建对应的生成节点，并把参数与参考图一并接上。
   * 解析与兜底都归 `readCanvasSeed`（值域、长度上限、参考图地址白名单都在那儿），
   * 这里只管把结果递给画布 —— 它才知道节点长什么样。
   */
  const rawPrompt = search.get('prompt');
  const seedPrompt = typeof rawPrompt === 'string' ? rawPrompt.slice(0, PROMPT_MAX).trim() : '';
  const seed = readCanvasSeed(Object.fromEntries(search.entries()) as Record<string, string | string[] | undefined>);

  return (
    <div className="canvas-studio">
      <CanvasEditor projectId={project.id} projectName={project.name} initial={initial} seed={seed} seedPrompt={seedPrompt} />
    </div>
  );
}
