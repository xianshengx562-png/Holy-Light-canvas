'use client';

/*
 * 设置后台的工作流页，两种面孔：
 *
 * - **没有 `?id=`** —— 列出保存过的所有工作流（`WorkflowLibrary`）：就地改名、点进某一份配参数、
 *   填一个新 ID 开始配置。这是「这份工作流是干嘛的」唯一看得见的地方，不进来就只能看着一串数字猜。
 * - **有 `?id=`** —— 打开那一份的配置页（`WorkflowConfigurator`）。
 *
 * 两个参数都不报错处理：URL 是能手改的，为一个展示参数把页面打成 400 没意义（`?kind=` 同理，
 * 认不出来就退回默认用途；`?id=` 认不出来就当没传，回列表）。
 *
 * ⚠️ 「认不认识这个 `?id=`」**必须用 `lib/workflows/local.ts` 的 `isWorkflowId()`**，
 * 不能自己写一条只认数字的正则 —— 本地工作流的 ID 是 `local-xxxxxx` 这种形状。
 * 早先这里写的是 `/^\d{1,30}$/`（那是 RunningHub 的 ID 形状），后果很具体：
 * **任何一份本地工作流点「配置」都打不开配置页**，页面静悄悄退回列表，
 * 既不报错也不提示，看起来就像「这份工作流配置不了」。
 *
 * （2026-09-18）原来这一页是服务端组件，直接 `await listWorkflowDrafts()`。
 * 桌面版改成渲染进程取数：**只在列表形态下取一次**（`/api/workflows`），
 * 配置形态本来就是纯客户端组件，不需要任何预取。
 */
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import WorkflowConfigurator from '@/components/workflows/WorkflowConfigurator';
import WorkflowLibrary from '@/components/workflows/WorkflowLibrary';
import { defaultWorkflowId } from '@/lib/workflows/defaults';
import { isWorkflowId } from '@/lib/workflows/local';
import { readGeneratorKind } from '@/lib/workflows/purpose';
import { readWorkflowCategory } from '@/lib/workflows/category';
import { readWorkflowOperation } from '@/lib/workflows/operation';
import type { WorkflowSummary } from '@/lib/workflows/drafts';
import { useApi } from '@/lib/client';
import { useSearchParams } from 'next/navigation';
import './workflows.css';
import './bindings.css';

export default function WorkflowsPage() {
  const params = useSearchParams();
  const id = params.get('id');
  const kind = params.get('kind');
  const category = params.get('category');
  const operation = params.get('operation');

  const workflowId = (id || '').trim();
  /* 用途先定下来：分类的取值要按用途兜底，顺序不能反。 */
  const initialKind = readGeneratorKind(kind ?? undefined);

  /*
   * 是「配置某一份」还是「列个表」—— 用整套 ID 规则判定（云端纯数字 / 本地 `local-` 前缀）。
   * 这里用 `isWorkflowId()` 而不是自己写正则：多一处形状判断，就多一处漏掉本地工作流的机会。
   */
  const detail = isWorkflowId(workflowId);
  const { data, loading, error, reload } = useApi<{ workflows: WorkflowSummary[]; defaultWorkflowId: string }>(
    detail ? null : '/api/workflows',
  );

  if (detail) {
    return <main className="workflow-page">
      <header className="workflow-header"><Link href="/settings/providers/workflows" className="workflow-back"><ArrowLeft size={18} />工作流列表</Link><strong>Holy Light画布 / 工作流配置</strong><Link href="/">返回项目</Link></header>
      <WorkflowConfigurator
        initialWorkflowId={workflowId}
        initialKind={initialKind}
        initialCategory={readWorkflowCategory(category ?? undefined, initialKind)}
        initialOperation={readWorkflowOperation(operation ?? undefined)}
      />
    </main>;
  }

  return <main className="workflow-page">
    <header className="workflow-header"><Link href="/settings/model-services" className="workflow-back"><ArrowLeft size={18} />模型服务</Link><strong>Holy Light画布 / 工作流</strong><Link href="/">返回项目</Link></header>
    <div className="workflow-content">
      {error && <div className="notice error">读不到工作流列表：{error}</div>}
      {loading && !data && <div className="notice">正在读取工作流…</div>}
      {/*
       * `onRefresh` **必须**传：组件不传时就回落 `router.refresh()`，而桌面版那句的实现是
       * `location.reload()`（见 `src/shims/next-navigation.ts`）。整页重载的后果很具体 ——
       * 导入一份本地工作流之后页面闪一下、「已导入」的提示没了、来源又跳回「云端」，
       * 于是刚导进来的那份在界面上根本找不到。这条路上必须走「重新取列表」而不是重载。
       */}
      {data && <WorkflowLibrary
        workflows={data.workflows}
        defaultWorkflowId={data.defaultWorkflowId || defaultWorkflowId}
        onRefresh={reload}
      />}
    </div>
  </main>;
}
