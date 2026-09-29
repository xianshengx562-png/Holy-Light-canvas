'use client';

import { useCallback, useState } from 'react';
import WorkflowConfigurator from '@/components/workflows/WorkflowConfigurator';
import WorkflowLibrary from '@/components/workflows/WorkflowLibrary';
import CanvasOverlay from './CanvasOverlay';
import { defaultWorkflowId } from '@/lib/workflows/defaults';
import type { WorkflowSummary } from '@/lib/workflows/drafts';
import type { GeneratorKind } from '@/lib/workflows/purpose';
import type { WorkflowCategory } from '@/lib/workflows/category';
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

type Spec = { id: string; kind?: GeneratorKind; category?: WorkflowCategory; operation?: WorkflowOperation };

export default function CanvasWorkflowPanel({
  onClose, onGotoSetting, embedded,
}: {
  /** 独立成一张卡片时才需要（左轨那一项）。嵌在设置里时壳是设置那张，没有自己的 ✕。 */
  onClose?: () => void;
  /** 列表里那句「前往模型服务」：不跳页，交给外面把设置浮层切到那一页。 */
  onGotoSetting?: (href: string) => void;
  /** 嵌进别的大浮层里：只出内容，不套自己的壳。 */
  embedded?: boolean;
}) {
  /** null = 列表那一屏；有值 = 正在配这一份。 */
  const [spec, setSpec] = useState<Spec | null>(null);
  const [dirty, setDirty] = useState(false);
  /* 配某一份时列表不用取（配置页自己会去拉那一份），回到列表时路径变回来、自动再取一次。 */
  const { data, loading, error, reload } = useApi<{ workflows: WorkflowSummary[]; defaultWorkflowId: string }>(
    spec ? null : '/api/workflows',
  );

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
                onRefresh={reload}
              />
            )}
          </div>
        )}
    </div>
  );

  if (embedded) return body;

  const nav = [{ key: 'library', label: '工作流库' }];
  if (spec) nav.push({ key: 'config', label: '配置这一份' });

  return (
    <CanvasOverlay
      title={spec ? '配置这一份工作流' : '工作流库'}
      kicker="WORKFLOWS"
      note={spec
        ? '改完记得「保存配置」—— 画布下拉里列的就是这里存的那份'
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
