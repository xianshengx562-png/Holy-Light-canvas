'use client';

import { useCallback, useState } from 'react';
import WorkflowConfigurator from '@/components/workflows/WorkflowConfigurator';
import WorkflowLibrary from '@/components/workflows/WorkflowLibrary';
import type { WorkflowSource } from '@/components/workflows/WorkflowLibrary';
import type { WorkflowCategoryItem } from '@/lib/workflows/category';
import CanvasOverlay from './CanvasOverlay';
import { defaultWorkflowId } from '@/lib/workflows/defaults';
import type { WorkflowSummary } from '@/lib/workflows/drafts';
import type { GeneratorKind } from '@/lib/workflows/purpose';
import type { WorkflowOperation } from '@/lib/workflows/operation';
import { useApi } from '@/lib/client';
/* 这两份样式原来只在设置那一页的壳里 import（`.workflow-page` 下的输入框、绑定标签那一套）。
   浮层里要自己引 —— 不引的话输入框会退回浏览器默认那副样子，一眼就看得出是另一套东西。 */
import '@/app/settings/providers/workflows/workflows.css';
import '@/app/settings/providers/workflows/bindings.css';

/**
 * 画布上的「工作流配置」：列表 ←→ 配置两屏，都在原地切。
 *
 * 两种用法，同一个组件：
 * - 左轨「工作流」→ 自己就是那张居中大卡片（`embedded` 不传）。
 * - 设置浮层的「工作流配置」那一页 → 只出内容，壳由设置那张卡片给（`embedded`）。
 *   两处各写一份的话，「列表里改了名字、配置页还是旧的」这种事迟早再来一遍。
 *
 * ⚠️ 两件事别搞混：
 *
 * 1. **`WorkflowLibrary` 原来是靠 `router.push('/settings/providers/workflows?id=...')` 进配置的。**
 *    在画布里照字面跳就是「点了一下左轨，画布没了」—— 所以它多接了一个 `onOpen`，
 *    「要配哪一份」由这里记着（`spec`）。设置页那条路没动（不传 `onOpen` 就还是 push）。
 *
 * 2. **关之前要问一句**。配置页的 `beforeunload` 在浮层里**不会**触发（关浮层不是关页面），
 *    改了一屏字段再点 ✕ 就悄悄没了。所以 `WorkflowConfigurator` 把「有没有改过」报上来
 *    （`onDirtyChange`），这里在 `guard` 里拦一道。
 */

type Spec = { id: string; kind?: GeneratorKind; category?: string; operation?: WorkflowOperation };

export default function CanvasWorkflowPanel({
  onClose, onGotoSetting, embedded, initialWorkflowId, onPickWorkflow, pickKind, pickSource,
}: {
  /** 独立成一张卡片时才需要（左轨那一项）。嵌在设置里时壳是设置那张，没有自己的 ✕。 */
  onClose?: () => void;
  /** 列表里那句「前往模型服务」：不跳页，交给外面把设置浮层切到那一页。 */
  onGotoSetting?: (href: string) => void;
  /** 嵌进别的大浮层里：只出内容，不套自己的壳。 */
  embedded?: boolean;
  /**
   * 一打开就落在这一份的配置屏（2026-10-01）。
   *
   * 「打开工作流配置」原来跳 `#/settings/providers/workflows?id=…` —— 用户要的是
   * 在画布里配完就回来，所以现在由画布开这张浮层，并把「配哪一份」直接传进来：
   * 先进列表再让人点一次是白白多一步。
   */
  initialWorkflowId?: string;
  /**
   * 「用这一份」（2026-10-01 徐先：「这里的工作流选择可以下拉，也可以从工作流库中选择」）。
   *
   * 传了它就说明这次是**给画布上某个节点挑一份工作流**：列表里多出一颗「用这一份」，
   * 选中就直接写回那个节点并关掉浮层 —— 不用先点「配置」进去再退出来。
   * 不传（左轨那张库、设置浮层那一页）= 一个字都不变。
   */
  onPickWorkflow?: (workflowId: string) => void;
  /** 挑的时候「用途」筛选的初值：从哪个节点的下拉跳进来，就先看它要的那一档。 */
  pickKind?: GeneratorKind;
  /** 挑的时候「来源」筛选的初值（云端 / 应用 / 本机）—— 按那个节点的引擎定，见 WorkflowLibrary 的注释。 */
  pickSource?: WorkflowSource;
}) {
  /** null = 列表那一屏；有值 = 正在配这一份。 */
  const [spec, setSpec] = useState<Spec | null>(initialWorkflowId ? { id: initialWorkflowId } : null);
  const [dirty, setDirty] = useState(false);
  /* 配某一份时列表不用取（配置页自己会去拉那一份），回到列表时路径变回来、自动再取一次。 */
  const { data, loading, error, reload } = useApi<{ workflows: WorkflowSummary[]; defaultWorkflowId: string }>(
    spec ? null : '/api/workflows',
  );

  /*
   * 自建分类清单**自己取**，不从外面接（2026-10-01 真机抓到的 bug）。
   *
   * 原来是从画布那边传进来的（那份跟着 `/api/workflows` 一起取）。问题是「新建分类」之后
   * 要刷新的是**外层画布的 state**，而这里刷的是自己那份列表 —— 结果分类建成了、
   * 弹窗里那行却要等下次重开才出现（真机第一遍：接口 200、提示「已添加」，行没出来）。
   * 自己持有一份就只有一个新鲜度来源：谁改的都刷它。
   */
  const cats = useApi<{ categories: WorkflowCategoryItem[] }>('/api/workflows/categories');
  const customCategories = cats.data?.categories || [];

  const openSpec = useCallback((next: Spec) => { setSpec(next); setDirty(false); }, []);
  const back = useCallback(() => { setSpec(null); setDirty(false); }, []);
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);

  const guard = useCallback(() => {
    if (!dirty) return true;
    return window.confirm('这份工作流的配置还没保存，关掉就没了。确定关闭？');
  }, [dirty]);

  const body = (
    <div className="workflow-page cv-ov-wf">
      {spec
        ? (
          <WorkflowConfigurator
            categories={customCategories}
            initialWorkflowId={spec.id}
            initialKind={spec.kind}
            initialCategory={spec.category}
            initialOperation={spec.operation}
            onBack={back}
            onDirtyChange={onDirtyChange}
          />
        )
        : (
          <div className="workflow-content">
            {error && <div className="notice error">读不到工作流列表：{error}</div>}
            {loading && !data && <div className="notice">正在读取工作流…</div>}
            {data && (
              <WorkflowLibrary
                workflows={data.workflows}
                defaultWorkflowId={data.defaultWorkflowId || defaultWorkflowId}
                onOpen={openSpec}
                /* 列表与分类一起刷：改完分类名 / 删掉分类，筛选条上那几个 chip 也得跟着变。 */
                onRefresh={() => { reload(); cats.reload(); }}
                onPick={onPickWorkflow}
                initialKind={pickKind}
                initialSource={pickSource}
                categories={customCategories}
              />
            )}
          </div>
        )}
    </div>
  );

  if (embedded) return body;

  const nav = [{ key: 'library', label: '工作流库' }];
  if (spec) nav.push({ key: 'config', label: '配置这一份' });

  /** 这次是「给某个节点挑一份」—— 列表屏要说的话跟着换。 */
  const picking = !!onPickWorkflow;

  return (
    <CanvasOverlay
      title={spec ? '配置这一份工作流' : picking ? '从工作流库选一份' : '工作流库'}
      kicker="WORKFLOWS"
      note={spec
        ? '改完记得「保存配置」—— 画布下拉里列的就是这里存的那份'
        : picking
          ? '点「用这一份」直接填到画布上那个生成节点；想先改字段就点「配置」'
          : '名字 / 用途 / 分类都在这一屏改，点「配置」进到那一份的字段绑定'}
      nav={nav}
      active={spec ? 'config' : 'library'}
      onNav={key => { if (key === 'library') back(); }}
      onClose={onClose ?? (() => {})}
      guard={guard}
      onHref={onGotoSetting}
    >
      {body}
    </CanvasOverlay>
  );
}
