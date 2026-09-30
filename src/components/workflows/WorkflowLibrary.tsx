'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppWindow, Check, Cpu, Download, FileJson, Film, ImageIcon, Pencil, Plus, SlidersHorizontal, Stethoscope, Trash2, Upload, X } from 'lucide-react';
/* 只能 `import type`：`WorkflowSummary` 所在的模块引了数据库，值导入会把 Prisma 拖进浏览器包。 */
import type { WorkflowSummary } from '@/lib/workflows/drafts';
import { normalizeWorkflowName, WORKFLOW_NAME_MAX, workflowDisplayName } from '@/lib/workflows/label';
import { GENERATOR_KIND_OPTIONS, generatorKindLabel, readGeneratorKind, type GeneratorKind } from '@/lib/workflows/purpose';
import { LOCAL_ID_PREFIX, LOCAL_PROVIDER } from '@/lib/workflows/local';
import { isRunningHubAppWorkflowId, parseWebAppInput } from '@/lib/workflows/runninghubApp';
import {
  categoriesFor,
  DEFAULT_WORKFLOW_CATEGORY,
  readWorkflowCategory,
  workflowCategoryLabel,
  type WorkflowCategory,
} from '@/lib/workflows/category';
import {
  DEFAULT_WORKFLOW_OPERATION,
  readWorkflowOperation,
  WORKFLOW_OPERATION_OPTIONS,
  workflowOperationLabel,
  type WorkflowOperation,
} from '@/lib/workflows/operation';

const kindIcon = (kind: GeneratorKind) => kind === 'image' ? <ImageIcon size={17} /> : <Film size={17} />;

/**
 * 来源切换。三档，因为它们**不是一个东西的三种存法**，而是三种不同的远端对象：
 * - `cloud` —— RunningHub **工作流**（一份 ComfyUI 图，按数字 ID 调）；
 * - `app`   —— RunningHub **应用**（`ai-detail/<id>` 上那个打包好的 AI 应用，参数由它自己公开）；
 * - `local` —— 本机 ComfyUI（图就在我们这边）。
 */
type WorkflowSource = 'cloud' | 'app' | 'local';

/** 一份从本机 .json 文件里读出来的工作流图。 */
type PickedFile = { name: string; graph: unknown; nodeCount: number };

/**
 * 图里有多少个节点。**只用来显示一句摘要** —— 真正的形状校验在服务端
 * （`parseLocalGraph`），规则只有一份，不在浏览器里抄第二遍。
 */
function countGraphNodes(graph: unknown): number {
  return graph && typeof graph === 'object' && !Array.isArray(graph) ? Object.keys(graph).length : 0;
}

/**
 * 用文件名当工作流的名字：去扩展名，再去 ComfyUI 导出去常带的 `_api` 后缀。
 *
 * 「xxx_api」不是人起的名字，那只是导出格式的标记，留在名字里只会让人以为它本来就叫这个。
 * 超长就地截断 —— 写入路径对**用户手打**的名字是报错的（见 `normalizeWorkflowName`，
 * 静默截断会让人以为自己起的名字存下来了），但这里是自动推出来的兜底名，
 * 报错等于让用户为一个他没打过的名字重来一遍。
 */
function nameFromFile(fileName: string): string {
  return fileName.replace(/\.json$/i, '').replace(/_api$/i, '').trim().slice(0, WORKFLOW_NAME_MAX);
}

async function readResponse(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || '请求失败，请重试。');
  return body;
}

/**
 * 设置后台的「工作流列表」—— 保存过配置的工作流都在这里，可以就地改名 / 改分类、点进去配参数。
 *
 * 为什么需要这个页面：加它之前，画布上选工作流看到的是一串 19 位数字，配置页也是「先知道 ID
 * 才能打开」。于是「这份是出图用的、那份是视频用的」这件事只存在于用户的记忆里，而选错工作流的
 * 后果是**静默**的（任务成功、产出另一种媒体）。名字把这件事变成界面上看得见的东西。
 *
 * **列表按「来源 + 用途 + 分类」筛**（视频的和图片的绝不混在一起显示）：
 * 用途决定它出现在哪类生成节点的下拉里，分类说明它吃什么样的参考输入；来源决定这部分工作流
 * 的图在哪 —— 本机的可以拖进来就配，云端的要先有一个 RunningHub 上的 ID。
 *
 * 列表从服务端传进来（`page.tsx` 直接查库），改名之后用 `router.refresh()` 让服务端重新给一份 ——
 * 不在客户端自己维护一份副本，否则「列表里已经改了、下拉里还是旧的」会同时对不上。
 */
export default function WorkflowLibrary({ workflows, defaultWorkflowId, onOpen, onRefresh }: {
  workflows: WorkflowSummary[];
  defaultWorkflowId: string;
  /**
   * 画布浮层里用：不跳页，**就地**切成配置页（`CanvasWorkflowPanel` 自己记着现在在配哪一份）。
   * 不传就走原来的 `router.push('/settings/providers/workflows?id=...')` —— 设置页那条路一点没动。
   *
   * 为什么不能沿用 `router.push`：在画布里跳 `/settings/...` 等于「点了一下左轨，画布没了」，
   * 而用户只是想改一个字段的绑定。
   */
  onOpen?: (spec: { id: string; kind?: GeneratorKind; category?: WorkflowCategory; operation?: WorkflowOperation }) => void;
  /** 画布浮层里用：让列表重新取一次。不传就 `router.refresh()`（让服务端重新出一份）。 */
  onRefresh?: () => void;
}) {
  const router = useRouter();
  /* 改名 / 改分类 / 导入 / 删除之后都要「画布下拉与这里看同一份数据」：
     浮层里是重新取一次，设置页里是刷新整页 —— 差别只在由谁来给这份新数据。 */
  const refresh = () => { if (onRefresh) onRefresh(); else router.refresh(); };
  const [editing, setEditing] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newId, setNewId] = useState('');
  const [newKind, setNewKind] = useState<GeneratorKind>('video');
  const [newCategory, setNewCategory] = useState<WorkflowCategory>(DEFAULT_WORKFLOW_CATEGORY);
  /** 两级筛选。**没有「全部用途」这一档** —— 那正是这次要去掉的东西。 */
  const [kindFilter, setKindFilter] = useState<GeneratorKind>('video');
  const [categoryFilter, setCategoryFilter] = useState<WorkflowCategory | 'all'>('all');
  const [source, setSource] = useState<WorkflowSource>('cloud');
  /** 本机 ComfyUI 那边的导入面板要不要展开 —— 贴一整张图占地方，默认收着。 */
  const [importOpen, setImportOpen] = useState(false);
  const [importName, setImportName] = useState('');
  const [importText, setImportText] = useState('');
  /**
   * 从**正在运行的** ComfyUI 抓回来的那份图。
   *
   * 它和粘贴框是同一个流程的两条入口，差别只在「图从哪来」：有了它，导入区就不再要求
   * 用户先去 ComfyUI 点一次「导出（API）」—— 那一步只要改一次图就得重来一遍，
   * 是「接本地工作流」这件事实际做不下去的真正原因。
   */
  const [pulled, setPulled] = useState<{ graph: unknown; nodeCount: number; promptId: string } | null>(null);
  /**
   * 从**本机 .json 文件**读进来的图（可以一次好几份）。
   *
   * 和 `pulled` 是同一个流程的第三条入口，差别只在「图从哪来」：之前只有粘贴框和
   * 「从正在运行的 ComfyUI 抓」两条，手上有个 workflow.json 就只能先打开、全选、
   * 复制、再粘进来 —— 那一步每改一次图就得重来一遍。
   *
   * 允许多份：工作流常常是一整个文件夹（改一版存一份），一份份点太难受。
   * 多份时名字各按文件名来，不再共用上面那个「名字」输入框。
   */
  const [picked, setPicked] = useState<PickedFile[] | null>(null);
  /** 拖放高亮。只为「松手会怎样」给个反馈 —— 没有它，用户看不出这块地方能拖。 */
  const [dragging, setDragging] = useState(false);
  /* 藏起来的文件选择框。藏它是因为系统那个框的样式改不了，
     露出来的应该是我们自己那个「选择 .json 文件」按钮。 */
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * 工序。也是**新建表单里那一项的值** —— 在「超清」这一格下填新 ID，
   * 进去的当然该是超清工作流，让人再选一遍等于多一次犯错机会。
   */
  const [operationFilter, setOperationFilter] = useState<WorkflowOperation>(DEFAULT_WORKFLOW_OPERATION);

  /* 改名输入框的即时校验（与服务端同一套规则，不另写一份长度判断）。 */
  const checked = normalizeWorkflowName(renameDraft);
  /*
   * 默认工作流还没被保存过配置时也要有个入口：它是 `.env` 里那条视频工作流，
   * 画布上新建的视频节点默认就指着它。列表里不出现它，用户会以为「画布上那个默认值不存在」。
   */
  const missingDefault = defaultWorkflowId && !workflows.some(item => item.workflowId === defaultWorkflowId) ? defaultWorkflowId : '';

  /*
   * 来源这一级筛选放在**最外层**：两份工作流的列表长得几乎一样（同样的名字 / 用途 / 分类），
   * 混着列时用户只能靠 hover 去看它是本机的还是云端的。而它们的差别恰恰是最大的一条 ——
   * 本机的图在我们这儿，可以随时换；云端的图在 RunningHub 那边，只能按 ID 拉。
   */
  /*
   * 应用与云端工作流共用 `provider: 'runninghub'`（图都不在本地），**靠 ID 前缀区分**：
   * 应用的 ID 是 `app-<数字>`。所以「云端」那一栏必须把应用**排除**掉，否则它会同时出现在
   * 两栏里 —— 而两栏的导入入口要求的输入根本不是同一样东西。
   */
  const isAppItem = (item: WorkflowSummary) => item.provider !== LOCAL_PROVIDER && isRunningHubAppWorkflowId(item.workflowId);
  const pool = source === 'local'
    ? workflows.filter(item => item.provider === LOCAL_PROVIDER)
    : source === 'app'
      ? workflows.filter(isAppItem)
      : workflows.filter(item => item.provider !== LOCAL_PROVIDER && !isAppItem(item));
  const localCount = workflows.filter(item => item.provider === LOCAL_PROVIDER).length;
  const appCount = workflows.filter(isAppItem).length;
  const cloudCount = workflows.length - localCount - appCount;

  /** 当前用途下可选的分类。切用途之后旧分类可能不成立，所以每次都按用途现算。 */
  const categoryOptions = categoriesFor(kindFilter);
  const newCategoryOptions = categoriesFor(newKind);
  /*
   * _filters 的兜底：切到「图片生成」时若当前选的是「视频参考」（只有视频才有），
   * 就地退回「全部」而不是显示一个永远为空的列表 —— 也不写回 state，
   * 免得切回视频时用户原来选的分类被悄悄改掉。
   */
  const activeCategory = categoryFilter !== 'all' && categoryOptions.some(item => item.value === categoryFilter)
    ? categoryFilter
    : 'all';
  const activeNewCategory = newCategoryOptions.some(item => item.value === newCategory)
    ? newCategory
    : DEFAULT_WORKFLOW_CATEGORY;

  const countOf = (kind: GeneratorKind, category: WorkflowCategory | 'all') => pool
    .filter(item => item.kind === kind && item.operation === operationFilter && (category === 'all' || item.category === category)).length;

  const visible = pool.filter(item => item.kind === kindFilter && item.operation === operationFilter && (activeCategory === 'all' || item.category === activeCategory));
  /** 未保存的默认工作流只在「云端 + 视频 + 全部 + 普通生成」里出现 —— 它是 RunningHub 上的一条 ID，本机来源下没有意义。 */
  const showMissingDefault = Boolean(missingDefault) && source === 'cloud' && kindFilter === 'video' && activeCategory === 'all' && operationFilter === 'generate';

  function startRename(item: WorkflowSummary) {
    setEditing(item.workflowId);
    /* 落回 ID 的那条（没起过名字）要按**空**填进去：把 ID 当名字填进去会让人以为它本来就叫这个。 */
    setRenameDraft(item.name);
    setError(''); setNotice('');
  }

  async function submitRename(workflowId: string) {
    if (!checked.ok) { setError(checked.message); return; }
    setBusy(workflowId); setError(''); setNotice('');
    try {
      const body = await readResponse(await fetch(`/api/workflows/${workflowId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: checked.name }),
      }));
      setEditing('');
      setNotice(body?.name ? `已重命名为「${body.name}」` : '已清掉名字，界面会显示工作流 ID');
      /* 让服务端重新出一份列表：画布下拉与这里必须看同一份数据。 */
      refresh();
    } catch (err) { setError(err instanceof Error ? err.message : '重命名失败。'); }
    finally { setBusy(null); }
  }

  /**
   * 就地改分类。选中即提交（不再加确认按钮——分类只是个标签，改错了改回来就行）。
   *
   * 走的是改名字那个独立接口，**不是**配置页那个 `PATCH .../config`：后者要整份配置加版本号，
   * 为一个标签把一百多个字段回写一遍、还递增一次版本，既慢又会给别的标签页制造假冲突。
   */
  async function submitCategory(item: WorkflowSummary, category: WorkflowCategory) {
    setBusy(item.workflowId); setError(''); setNotice('');
    try {
      const body = await readResponse(await fetch(`/api/workflows/${item.workflowId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category }),
      }));
      const saved = body?.category ?? category;
      /*
       * 改到当前筛选之外的分类时，这一行会**从列表里消失**。不说一句的话，
       * 用户的第一反应是「我把数据改没了」—— 这是就地改标签最容易招来的误会。
       */
      const hidden = activeCategory !== 'all' && saved !== activeCategory;
      setNotice(hidden
        ? `已改为「${workflowCategoryLabel(saved)}」—— 它不在当前的筛选条件下，所以从这一页移出去了（切到「全部」能看到它）`
        : `已改为「${workflowCategoryLabel(saved)}」`);
      refresh();
    } catch (err) { setError(err instanceof Error ? err.message : '改分类失败。'); }
    finally { setBusy(null); }
  }

  /**
   * 真正的那一次 POST。抽出来是为了「一份」和「一次好几份」共用同一条路 ——
   * 两条各写一遍，迟早会不一样（比如只有一条记得带上 `operation`）。
   */
  async function postImport(graph: unknown, name: string) {
    return readResponse(await fetch('/api/workflows/local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        graph, name, kind: newKind, category: activeNewCategory, operation: operationFilter,
      }),
    }));
  }

  async function doImport(graph: unknown, nameOverride?: string) {
    const cleaned = normalizeWorkflowName(nameOverride ?? importName);
    if (!cleaned.ok) { setError(cleaned.message); return; }
    setBusy('import'); setError(''); setNotice('');
    try {
      const body = await postImport(graph, cleaned.name);
      setImportText(''); setImportName(''); setImportOpen(false); setPulled(null); setPicked(null);
      setNotice(body?.notice ? `已导入 ${body.nodeCount} 个节点。${body.notice}` : '已导入这份本地工作流。');
      refresh();
    } catch (err) { setError(err instanceof Error ? err.message : '导入失败。'); }
    finally { setBusy(null); }
  }

  /**
   * 一次导入好几份（多选文件时用）。
   *
   * **一份一份来，坏掉的那份单独报出来** —— 一整批里有一份是 UI 格式就把其余的也丢掉，
   * 用户只会看到一句笼统的失败，还得自己猜是哪一份。
   */
  async function importPicked(list: PickedFile[]) {
    setBusy('import'); setError(''); setNotice('');
    const done: string[] = [];
    const bad: string[] = [];
    try {
      for (const item of list) {
        /*
         * 只有一份时**认上面那个「名字」输入框**：文件名是预填进去的，用户完全可以改，
         * 改了却仍按文件名存等于把他的输入悄悄扔掉。好几份时那份输入框没有意义，
         * 各按文件名来。
         */
        const wanted = list.length === 1 ? (importName.trim() || nameFromFile(item.name)) : nameFromFile(item.name);
        const cleaned = normalizeWorkflowName(wanted);
        if (!cleaned.ok) { bad.push(`${item.name}（${cleaned.message}）`); continue; }
        try {
          await postImport(item.graph, cleaned.name);
          done.push(cleaned.name);
        } catch (err) {
          bad.push(`${item.name}（${err instanceof Error ? err.message : '导入失败'}）`);
        }
      }
    } finally { setBusy(null); }
    setImportText(''); setImportName(''); setImportOpen(false); setPulled(null); setPicked(null);
    /* 一份都没成就**报错**，不说成成功：绿条里写「导入 0 份」是自相矛盾的，
       而这时候用户真正要看的正是那句失败原因。部分成功才用提示条 —— 成功了多少也要说。 */
    if (!done.length) setError(`这几份都没导进来：${bad.join('；')}`);
    else setNotice(bad.length
      ? `导入 ${done.length} 份：${done.join('、')}；${bad.length} 份没成：${bad.join('；')}`
      : `已导入 ${done.length} 份：${done.join('、')}`);
    refresh();
  }

  /**
   * 读一个或多个 .json 文件，把里面的图取出来。
   *
   * 这里只做「是不是合法 JSON」这一层判断；更细的形状问题（多半是 UI 格式）交给服务端
   * 那句更会说话的报错 —— 规则只有一份，在浏览器里抄一遍迟早会对不上。
   */
  async function pickFiles(fileList: FileList | null) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setBusy('pick'); setError(''); setNotice('');
    const ok: PickedFile[] = [];
    const bad: string[] = [];
    try {
      for (const file of files) {
        try {
          const graph = JSON.parse(await file.text()) as unknown;
          ok.push({ name: file.name, graph, nodeCount: countGraphNodes(graph) });
        } catch {
          bad.push(file.name);
        }
      }
    } finally { setBusy(null); }
    if (!ok.length) {
      setError(`这${files.length > 1 ? '些' : ''}个文件里读不出 JSON${bad.length ? `：${bad.join('、')}` : ''}。请确认拿的是 ComfyUI「导出（API）」出来的那份 .json。`);
      return;
    }
    setPicked(ok);
    setImportOpen(true);
    /* 单份时把文件名填进「名字」：文件名通常就是人已经起好的名字，让人再打一遍没道理。 */
    if (ok.length === 1 && !importName.trim()) setImportName(nameFromFile(ok[0].name));
    setNotice(bad.length
      ? `读到 ${ok.length} 份，另有 ${bad.length} 个不是合法 JSON：${bad.join('、')}`
      : `已从文件读到 ${ok.length} 份工作流。`);
  }

  /**
   * 从粘贴框导入一份。
   *
   * 先自己 `JSON.parse` 一次：贴错东西最常见的情况是少了一个大括号，那属于「用户该去改」，
   * 在这儿就报出来比让服务端回一句 400 干净（也更省一次几十 KB 的往返）。别的形状问题
   * （多半是贴成了 UI 格式）由服务端那句更会说话的报错负责。
   */
  async function submitImport() {
    let graph: unknown;
    try {
      graph = JSON.parse(importText);
    } catch {
      setError('这段不是合法的 JSON —— 请从 ComfyUI 里重新「导出（API）」，整段复制过来。');
      return;
    }
    await doImport(graph);
  }

  /**
   * 从正在运行的 ComfyUI 抓最近一次跑过的图。
   *
   * 抓回来**不直接入库**：用途（出图 / 出视频）必须让用户确认 —— 这一步猜错的后果是静默的
   * （生成照常成功、产出的是另一种媒体），而列表里目前改不了用途，只能删了重来。
   * 所以抓完只是把图留在手上、把导入区的粘贴框换成一份摘要，其余几项照旧让用户选。
   */
  async function pullFromComfyui() {
    setBusy('pull'); setError(''); setNotice('');
    try {
      const body = await readResponse(await fetch('/api/local/graph/pull', { method: 'POST' }));
      setPulled({ graph: body?.graph, nodeCount: Number(body?.nodeCount || 0), promptId: String(body?.promptId || '') });
      setImportOpen(true);
      setNotice(body?.status && body.status !== 'success'
        ? `抓到了（ComfyUI 最近一次跑的这份，它自己报的是 ${body.status}）—— 失败的图也能导进来改，照常确认下面几项。`
        : '抓到了 ComfyUI 最近一次跑过的那份图。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '抓取失败。');
    } finally { setBusy(null); }
  }

  /**
   * 检查一份**本机**工作流：这份图里用到的节点和模型，本机 ComfyUI 是不是都有。
   *
   * 放在列表上而不是配置页里，是因为它要回答的问题只有一个 —— 「这份图现在能不能跑」。
   * 缺节点 / 缺模型在 ComfyUI 那边要等到点了生成才报，而且报的是一堆节点编号；
   * 这里提前按本机的 `/object_info` 比对一遍，缺什么直接说出来（不替用户装任何东西）。
   */
  async function diagnoseWorkflow(item: WorkflowSummary) {
    setBusy(item.workflowId); setError(''); setNotice('');
    try {
      const body = await readResponse(await fetch('/api/local/diagnose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: item.workflowId }),
      }));
      setNotice(`「${workflowDisplayName(item)}」${String(body?.message || '检查完成。')}`);
    } catch (err) { setError(err instanceof Error ? err.message : '检查失败。'); }
    finally { setBusy(null); }
  }

  /**
   * 删掉一份已保存的配置。
   *
   * 本地工作流连带删掉那份图，所以**必须先问一句** —— 图没有第二份副本，
   * 删错了只能重新去 ComfyUI 导出。云端那份删的只是本地配置，RunningHub 上的工作流还在。
   */
  async function removeWorkflow(item: WorkflowSummary) {
    const isLocal = item.provider === LOCAL_PROVIDER;
    const isApp = isRunningHubAppWorkflowId(item.workflowId);
    const message = isLocal
      ? `删除「${workflowDisplayName(item)}」？这份工作流连它的图一起删掉（图没有别的副本），已经跑过的任务不受影响。`
      : `删除「${workflowDisplayName(item)}」？删的只是本地这份配置，RunningHub 上的${isApp ? '应用' : '工作流'}本体不会动。`;
    if (!window.confirm(message)) return;
    setBusy(item.workflowId); setError(''); setNotice('');
    try {
      await readResponse(await fetch(`/api/workflows/${item.workflowId}`, { method: 'DELETE' }));
      setNotice(`已删除「${workflowDisplayName(item)}」`);
      refresh();
    } catch (err) { setError(err instanceof Error ? err.message : '删除失败。'); }
    finally { setBusy(null); }
  }

  return <>
    <div className="workflow-title">
      <div><span className="workflow-kicker">Holy Light画布</span><h1>工作流库<span className="workflow-count-inline">{pool.length} 份已保存</span></h1></div>
      <div className="workflow-actions">
        <Link className="button secondary" href="/settings/model-services"><SlidersHorizontal size={16} />模型服务</Link>
      </div>
    </div>

    <div className="workflow-source">
    <div className="workflow-seg" role="tablist" aria-label="按来源筛选">
      <button
        type="button"
        role="tab"
        aria-selected={source === 'cloud'}
        className={source === 'cloud' ? 'active' : ''}
        onClick={() => { setSource('cloud'); setError(''); setNotice(''); }}
      >云端 RunningHub {cloudCount}</button>
      <button
        type="button"
        role="tab"
        aria-selected={source === 'app'}
        className={source === 'app' ? 'active' : ''}
        onClick={() => { setSource('app'); setError(''); setNotice(''); }}
      ><AppWindow size={14} />RunningHub 应用 {appCount}</button>
      <button
        type="button"
        role="tab"
        aria-selected={source === 'local'}
        className={source === 'local' ? 'active' : ''}
        onClick={() => { setSource('local'); setError(''); setNotice(''); }}
      ><Cpu size={14} />本机 ComfyUI {localCount}</button>
    </div>
      <p className="workflow-muted workflow-seg-hint">
        {source === 'cloud'
          ? '图保存在 RunningHub 那边，这里存的是「哪些字段怎么接画布」那份配置。'
          : source === 'app'
            ? 'RunningHub 上的 AI 应用（/ai-detail/…），参数是它自己公开的那一份 —— 导入时拉下来，再挑要用的接到画布上。'
            : '图存在本地，导入后自动扫出可配字段，和云端那边的配置方式完全一样。'}
      </p>
    </div>

    {source === 'local'
      ? (

        <div
          className={dragging ? 'workflow-new workflow-new-dragover' : 'workflow-new'}
          /* 只接住「拖的是文件」：拖一段选中的文字进来不该把这里点亮，
             也不该拦下浏览器默认的拖选行为。 */
          onDragOver={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); setDragging(true); }}
          /* 只看「真的离开了这一整块」：dragleave 会在移到子元素上时也冒上来，
             不加这道判断，高亮就会在块内移动时一路闪。 */
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={event => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault(); setDragging(false);
            void pickFiles(event.dataTransfer.files);
          }}
        >
          <p className="workflow-new-head">导入本机工作流<span className="workflow-muted"> · 图在本机 ComfyUI 上，导入后自动扫出可配字段，也可以直接把 .json 拖到这里</span></p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            hidden
            /* 读完就把 value 清掉：否则再选同一个文件不会触发 change，
               看着像「点了没反应」—— 改一份图重新导入正是最常见的用法。 */
            onChange={event => { void pickFiles(event.target.files); event.target.value = ''; }}
          />
          {!importOpen
            ? <div className="workflow-new-buttons">
              <button type="button" onClick={() => setImportOpen(true)} disabled={!!busy}><Upload size={16} />粘贴 ComfyUI 图</button>
              <button type="button" className="secondary" onClick={() => fileInputRef.current?.click()} disabled={!!busy}>
                <FileJson size={16} />{busy === 'pick' ? '正在读…' : '选择 .json 文件'}
              </button>
              <button type="button" className="secondary" onClick={() => void pullFromComfyui()} disabled={!!busy}>
                <Download size={16} />{busy === 'pull' ? '正在抓…' : '从正在运行的 ComfyUI 抓取'}
              </button>
              <span className="workflow-muted">手上已经有导出好的 .json 就直接选它（可以按住 Ctrl 一次选好几份，也可以直接把文件拖到这块地方）；ComfyUI 正开着的话，也能直接抓它最近一次跑过的那份图，不必先去导出。</span>
            </div>
            : <>
              <label htmlFor="import-name">名字<input id="import-name" value={importName} maxLength={WORKFLOW_NAME_MAX} placeholder="给它起个名字（留空 = 显示 ID）" onChange={event => setImportName(event.target.value)} /></label>
              <label htmlFor="import-kind">用途<select id="import-kind" value={newKind} onChange={event => setNewKind(readGeneratorKind(event.target.value))}>{GENERATOR_KIND_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label htmlFor="import-category">分类<select id="import-category" value={activeNewCategory} onChange={event => setNewCategory(readWorkflowCategory(event.target.value, newKind))}>{newCategoryOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label htmlFor="import-operation">工序<select id="import-operation" value={operationFilter} onChange={event => setOperationFilter(readWorkflowOperation(event.target.value))}>{WORKFLOW_OPERATION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              {picked
                ? <div className="workflow-pulled" data-workflow-picked={picked.length}>
                  <strong>{picked.length > 1 ? `已从 ${picked.length} 个文件读到工作流` : `已从「${picked[0].name}」读到 ${picked[0].nodeCount} 个节点`}</strong>
                  <span className="workflow-muted">
                    {picked.length > 1
                      ? `各按文件名起名：${picked.map(item => nameFromFile(item.name)).join('、')}。用途 / 分类 / 工序按上面这几项统一给。`
                      : '名字已经按文件名填进上面那格了，要改直接改。'}
                  </span>
                </div>
                : pulled
                ? <div className="workflow-pulled" data-workflow-pulled={pulled.nodeCount}>
                  <strong>已从 ComfyUI 抓到 {pulled.nodeCount} 个节点</strong>
                  <span className="workflow-muted">
                    就是它最近一次跑过的那份图{pulled.promptId ? `（任务 ${pulled.promptId.slice(0, 8)}）` : ''}。
                    节点编号与 ComfyUI 界面上看到的一致，配字段时照着填就行。
                  </span>
                </div>
                : <label className="workflow-import-json" htmlFor="import-graph">
                  ComfyUI「导出（API）」
                  <textarea
                    id="import-graph"
                    value={importText}
                    spellCheck={false}
                    placeholder={'在 ComfyUI 里选「工作流 → 导出（API）」，把整段 JSON 粘到这里。\n注意不是「导出」默认的 UI 格式 —— UI 格式的 inputs 是数组，存进来一个字段都写不进去。'}
                    onChange={event => { setImportText(event.target.value); setError(''); }}
                  />
                </label>}
              <div className="workflow-new-buttons">
                <button
                  type="button"
                  disabled={(pulled || picked ? false : !importText.trim()) || !!busy}
                  onClick={() => {
                    if (picked) void importPicked(picked);
                    else if (pulled) void doImport(pulled.graph);
                    else void submitImport();
                  }}
                >{busy === 'import' ? '正在导入…' : picked && picked.length > 1 ? `导入这 ${picked.length} 份` : '导入这份工作流'}</button>
                <button type="button" className="secondary" onClick={() => { setImportOpen(false); setImportText(''); setImportName(''); setPulled(null); setPicked(null); setError(''); }} disabled={busy === 'import'}>取消</button>
              </div>
              <span className="workflow-muted">导入后会自动扫出这份图里所有可填的节点字段（默认都不勾选），去配置页挑要用哪些、接到画布的提示词 / 参考图上。</span>
            </>}
        </div>
      )
      : source === 'app'
        ? (
          <form className="workflow-new" onSubmit={event => {
            event.preventDefault();
            const parsed = parseWebAppInput(newId);
            if (!parsed.ok) { setError(parsed.message); return; }
            setError('');
            /* 浮层里不跳页：把「要配哪一份」交回给壳，由它切到配置那一屏。 */
            if (onOpen) {
              onOpen({ id: parsed.workflowId, kind: newKind, category: activeNewCategory, operation: operationFilter });
              return;
            }
            router.push(`/settings/providers/workflows?id=${parsed.workflowId}&kind=${newKind}&category=${activeNewCategory}&operation=${operationFilter}`);
          }}>
            <p className="workflow-new-head">导入一个 RunningHub 应用<span className="workflow-muted"> · 填应用 ID，或把它的详情页链接整条粘进来</span></p>
            <label htmlFor="new-app-id">应用 ID / 链接<input id="new-app-id" value={newId} onChange={event => setNewId(event.target.value)} placeholder="例如 1939734…，或 https://www.runninghub.cn/ai-detail/1939734…" required /></label>
            <label htmlFor="new-app-kind">用途<select id="new-app-kind" value={newKind} onChange={event => setNewKind(readGeneratorKind(event.target.value))}>{GENERATOR_KIND_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label htmlFor="new-app-category">分类<select id="new-app-category" value={activeNewCategory} onChange={event => setNewCategory(readWorkflowCategory(event.target.value, newKind))}>{newCategoryOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label htmlFor="new-app-operation">工序<select id="new-app-operation" value={operationFilter} onChange={event => setOperationFilter(readWorkflowOperation(event.target.value))}>{WORKFLOW_OPERATION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <button disabled={!!busy}><Plus size={16} />导入这个应用</button>
            <span className="workflow-muted">导入时去 RunningHub 拉这个应用公开的参数（最多 256 项），再挑要启用的接到画布上。用途决定它出现在哪类节点的下拉里。</span>
          </form>
        )
        : (

        <form className="workflow-new" onSubmit={event => {
          event.preventDefault();
          const id = newId.trim();
          if (!/^\d{1,30}$/.test(id)) { setError('工作流 ID 必须为数字（在 RunningHub 的工作流链接里）。'); return; }
          setError('');
          /* 浮层里不跳页：把「要配哪一份」交回给壳，由它切到配置那一屏。 */
          if (onOpen) {
            onOpen({ id, kind: newKind, category: activeNewCategory, operation: operationFilter });
            return;
          }
          router.push(`/settings/providers/workflows?id=${id}&kind=${newKind}&category=${activeNewCategory}&operation=${operationFilter}`);
        }}>
          <p className="workflow-new-head">新建一份<span className="workflow-muted"> · 填 RunningHub 上的工作流 ID，再把它的字段接到画布上</span></p>
          <label htmlFor="new-workflow-id">工作流 ID<input id="new-workflow-id" value={newId} onChange={event => setNewId(event.target.value)} inputMode="numeric" pattern="[0-9]{1,30}" placeholder="例如 2099453228814528513" required /></label>
          <label htmlFor="new-workflow-kind">用途<select id="new-workflow-kind" value={newKind} onChange={event => setNewKind(readGeneratorKind(event.target.value))}>{GENERATOR_KIND_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label htmlFor="new-workflow-category">分类<select id="new-workflow-category" value={activeNewCategory} onChange={event => setNewCategory(readWorkflowCategory(event.target.value, newKind))}>{newCategoryOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label htmlFor="new-workflow-operation">工序<select id="new-workflow-operation" value={operationFilter} onChange={event => setOperationFilter(readWorkflowOperation(event.target.value))}>{WORKFLOW_OPERATION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <button disabled={!!busy}><Plus size={16} />配置这份工作流</button>
          <span className="workflow-muted">用途决定它出现在哪类生成节点的下拉里，分类说明它要喂什么参考素材，工序决定它是生成用的还是超清用的。名字进配置页再起。</span>
        </form>
        )}

    <div className="workflow-filters">
      <div className="workflow-filter-segs">
      <div className="workflow-seg" role="tablist" aria-label="按用途筛选">
        {GENERATOR_KIND_OPTIONS.map(option => <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={kindFilter === option.value}
          className={kindFilter === option.value ? 'active' : ''}
          onClick={() => setKindFilter(option.value)}
        >{kindIcon(option.value)}{option.label} {countOf(option.value, 'all')}</button>)}
      </div>
      <span className="workflow-vrule" aria-hidden />
      <div className="workflow-seg" role="tablist" aria-label="按工序筛选">
        {WORKFLOW_OPERATION_OPTIONS.map(option => <button
          key={option.value}
          type="button"
          role="tab"
          title={option.hint}
          aria-selected={operationFilter === option.value}
          className={operationFilter === option.value ? 'active' : ''}
          onClick={() => setOperationFilter(option.value)}
        >{option.label} {pool.filter(item => item.operation === option.value).length}</button>)}
      </div>
      </div>
      <div className="workflow-chiprow">
      <span className="workflow-filter-label">分类</span>
      <div className="workflow-chips" role="group" aria-label="按分类筛选">
        <button type="button" className={`workflow-chip ${activeCategory === 'all' ? 'active' : ''}`} onClick={() => setCategoryFilter('all')}>全部 {countOf(kindFilter, 'all')}</button>
        {categoryOptions.map(option => <button
          key={option.value}
          type="button"
          title={option.hint}
          className={`workflow-chip ${activeCategory === option.value ? 'active' : ''}`}
          onClick={() => setCategoryFilter(option.value)}
        >{option.label} {countOf(kindFilter, option.value)}</button>)}
      </div>
      </div>
    </div>

    {error && <div role="alert" className="workflow-error">{error}</div>}
    {notice && <div role="status" className="workflow-success"><Check size={16} />{notice}</div>}

    {visible.length === 0 && !showMissingDefault && <p className="workflow-empty">
      {source === 'local'
        ? '这个条件下还没有本地工作流 —— 在上面把 ComfyUI「导出（API）」的 JSON 贴进来，点「导入这份工作流」就有了。'
        : source === 'app'
          ? '这个条件下还没有导入过应用 —— 在上面填 RunningHub 应用的 ID（或粘它的详情页链接），点「导入这个应用」。'
          : <>这个条件下还没有工作流{generatorKindLabel(kindFilter)}共 {countOf(kindFilter, 'all')} 份{countOf(kindFilter, 'all') ? '，换个分类看看' : '，可以到另一个用途下找，或者在上面填一个新 ID'}。</>}
    </p>}

    {(visible.length > 0 || showMissingDefault) && <ul className="workflow-library">
      {showMissingDefault && <li className="workflow-lib-row">
        <span className="workflow-kind kind-video"><Film size={17} /></span>
        <div className="workflow-lib-main">
          <strong className="workflow-lib-name">{missingDefault}</strong>
          <small>默认工作流 · 还没保存过配置（画布上新建的视频节点默认就指着它）</small>
        </div>
        <div className="workflow-lib-actions">
          <span className="workflow-muted">未保存</span>
          {onOpen
            ? <button type="button" className="secondary" onClick={() => onOpen({ id: missingDefault, kind: 'video' })}>配置</button>
            : <Link className="button secondary" href={`/settings/providers/workflows?id=${missingDefault}&kind=video`}>配置</Link>}
        </div>
      </li>}
      {visible.map(item => {
        /*
         * 这份工作流**自己的用途**决定它能选哪些分类 —— 不是当前筛选的用途。
         * 一份图片工作流在「视频」筛选下不会显示（两条筛选各自独立），但万一显示了，
         * 它的下拉里也绝不能出现「视频参考」：出图工作流不会拿视频当参考。
         */
        const ownOptions = categoriesFor(item.kind);
        const ownCategory = ownOptions.some(option => option.value === item.category) ? item.category : DEFAULT_WORKFLOW_CATEGORY;
        const isLocal = item.provider === LOCAL_PROVIDER;
        const isApp = isRunningHubAppWorkflowId(item.workflowId);
        return <li key={item.workflowId} className={`workflow-lib-row ${editing === item.workflowId ? 'editing' : ''}`}>
          <span className={`workflow-kind kind-${item.kind}`}>{isLocal ? <Cpu size={17} /> : isApp ? <AppWindow size={17} /> : kindIcon(item.kind)}</span>
          <div className="workflow-lib-main">
            {editing === item.workflowId
              ? <>
                <div className="workflow-lib-rename">
                  <input
                    aria-label={`给工作流 ${item.workflowId} 起名字`}
                    autoFocus
                    value={renameDraft}
                    maxLength={WORKFLOW_NAME_MAX}
                    placeholder="给这份工作流起个名字（留空 = 显示 ID）"
                    onChange={event => { setRenameDraft(event.target.value); setError(''); }}
                    onKeyDown={event => { if (event.key === 'Escape') setEditing(''); }}
                    disabled={busy === item.workflowId}
                  />
                  <span className="workflow-lib-count">{renameDraft.trim().length} / {WORKFLOW_NAME_MAX}</span>
                  <button className="secondary workflow-icon" title="保存名字" aria-label="保存名字" disabled={!checked.ok || busy === item.workflowId} onClick={() => void submitRename(item.workflowId)}><Check size={16} /></button>
                  <button className="secondary workflow-icon" title="取消" aria-label="取消改名" disabled={busy === item.workflowId} onClick={() => { setEditing(''); setError(''); }}><X size={16} /></button>
                </div>
                {!checked.ok && <span className="workflow-lib-warn">{checked.message}</span>}
              </>
              : <>
                <strong className="workflow-lib-name">{workflowDisplayName(item)}</strong>
                <small>
                  {isLocal ? LOCAL_ID_PREFIX : isApp ? '' : '#'}{item.workflowId} · {generatorKindLabel(item.kind)} · {item.enabledCount} / {item.totalCount} 项启用
                  {/* 本地工作流才数得出来节点数 —— 云端那份图不在本地，别显示一个「0 个节点」。 */}
                  {isLocal && item.graphNodes > 0 && ` · ${item.graphNodes} 个节点`}
                  {/* 只在超清时才标：普通生成是绝大多数，标它等于每行都多一串字，反而看不出哪个是特殊的。 */}
                  {item.operation === 'upscale' && <b className="workflow-tag op-upscale">{workflowOperationLabel(item.operation)}</b>}
                  {item.isDefault && ' · 默认'}
                </small>
              </>}
          </div>
          <div className="workflow-lib-actions">
            {/*
              分类下拉直接显示当前值，所以 small 那行里不再重复写一遍分类标签 ——
              同一份信息在两处出现，改了一处忘另一处只是时间问题。
            */}
            <select
              className="workflow-lib-cat"
              aria-label={`改工作流 ${item.workflowId} 的分类`}
              title="改分类（说明它要喂什么参考素材）"
              value={ownCategory}
              disabled={busy === item.workflowId}
              onChange={event => void submitCategory(item, readWorkflowCategory(event.target.value, item.kind))}
            >{ownOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            <span className="workflow-muted">{new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
            {/* 只有本机的图能查：云端的图在 RunningHub 那边，本机这份清单跟它没关系。 */}
            {item.provider === LOCAL_PROVIDER && (
              <button
                className="secondary workflow-icon"
                title="检查这份图在本机 ComfyUI 上缺不缺节点 / 模型"
                aria-label="检查本机节点与模型"
                data-workflow-diagnose={item.workflowId}
                disabled={busy === item.workflowId}
                onClick={() => void diagnoseWorkflow(item)}
              >
                <Stethoscope size={16} />
              </button>
            )}
            {onOpen
              ? <button type="button" className="secondary" onClick={() => onOpen({ id: item.workflowId })}>配置</button>
              : <Link className="button secondary" href={`/settings/providers/workflows?id=${item.workflowId}`}>配置</Link>}
            <button className="secondary workflow-icon" title="给它起个名字（画布下拉里显示的就是名字）" aria-label="改名" onClick={() => (editing === item.workflowId ? setEditing('') : startRename(item))} disabled={busy === item.workflowId}><Pencil size={16} /></button>
            <button className="secondary workflow-icon danger" title="删除这份工作流" aria-label="删除这份工作流" disabled={busy === item.workflowId} onClick={() => void removeWorkflow(item)}><Trash2 size={16} /></button>
          </div>
        </li>;
      })}
    </ul>}
  </>;
}
