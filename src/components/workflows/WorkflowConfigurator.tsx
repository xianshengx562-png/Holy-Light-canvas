'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AudioLines, Braces, Check, FileBox, Film, ImageIcon, List, Plus, Save, Search, Trash2, Type, Upload, X } from 'lucide-react';
import {
  CUSTOM_CLASS_TYPE, fieldKey, normalizeFieldLabel, bindingsForFields, isUpscaleInputBinding, mediaLoaderVerdict,
  nextSeriesBinding, canvasBindingLabels, configurationSchema, toNodeInfoList, defaultControlLabel,
  controlBinding, controlLabelOf, EMPTY_CANVAS_CONTROLS,
  MAX_CUSTOM_CONTROLS, MAX_REFERENCE_IMAGES, MAX_SLIDERS, MAX_TOGGLES,
  type CanvasBinding, type CanvasControls, type CustomControl, type SliderControl, type ToggleControl, type WorkflowField,
} from '@/lib/workflows/configuration';
import { normalizeWorkflowName, readWorkflowName, WORKFLOW_NAME_MAX, workflowDisplayName } from '@/lib/workflows/label';
import {
  categoriesFor,
  DEFAULT_WORKFLOW_CATEGORY,
  readWorkflowCategory,
  type WorkflowCategoryItem,
  type WorkflowCategoryOption,
} from '@/lib/workflows/category';
import {
  DEFAULT_WORKFLOW_OPERATION,
  readWorkflowOperation,
  WORKFLOW_OPERATION_OPTIONS,
  type WorkflowOperation,
} from '@/lib/workflows/operation';
import { DEFAULT_GENERATOR_KIND, GENERATOR_KIND_OPTIONS, generatorKindLabel, readGeneratorKind, type GeneratorKind } from '@/lib/workflows/purpose';
import { registerUnsaved } from '@/lib/unsaved';

const kindLabels = { text: '提示词 / 文本', number: '数字', boolean: '开关', image: '图像', video: '视频', audio: '音频', latent: 'H3 latent' };
/** 「自定义参数分类」一行能填几个预设值 —— 与 `customControlSchema.options` 的上限同一处口径。 */
const MAX_CUSTOM_OPTIONS = 60;
const kinds = Object.keys(kindLabels) as WorkflowField['kind'][];
const iconFor = (kind: WorkflowField['kind']) => kind === 'image' ? <ImageIcon size={17} /> : kind === 'video' ? <Film size={17} /> : kind === 'audio' ? <AudioLines size={17} /> : kind === 'latent' ? <FileBox size={17} /> : <Type size={17} />;

async function readResponse(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败，请重试。');
  return body;
}

/**
 * 工作流节点配置页。
 *
 * `initialKind` 是「从画布上某类生成节点点进来」时带的用途（`?kind=image`）—— 它只在
 * **这份工作流还没有草稿**时起作用（决定新建草稿的用途）；已经有草稿就以草稿上存的为准，
 * 否则会出现「页面显示图片、保存后变成图片」，把用户已经配好的视频工作流悄悄改掉。
 */
export default function WorkflowConfigurator({ initialWorkflowId, initialKind = DEFAULT_GENERATOR_KIND, initialCategory = DEFAULT_WORKFLOW_CATEGORY, initialOperation = DEFAULT_WORKFLOW_OPERATION, categories, onBack, onDirtyChange }: {
  initialWorkflowId: string;
  initialKind?: GeneratorKind;
  /** 分类的值**不再限于内置枚举**：2026-10-01 起可以是用户自建的分类名（见下面的 `categories`）。 */
  initialCategory?: string;
  initialOperation?: WorkflowOperation;
  /**
   * 画布浮层里用：顶上那个「工作流列表」不跳页，回壳里的列表那一屏。
   * 不传就照旧渲染成 `<Link href="/settings/providers/workflows">`（设置页那条路不变）。
   */
  onBack?: () => void;
  /**
   * 把「有未保存的改动」报给外面。浮层靠它在关之前问一句 ——
   * 页面里是 `beforeunload` 兜着，浮层关掉**不会**触发 beforeunload，
   * 不说一声的话改了一屏字段然后点 ✕ 就全没了，而且没有任何提示。
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * 用户**自建**的分类（2026-10-01 徐先：「分类我自己能加」）。与内置那五个拼在一起给下拉用。
   * 不传 = 只有内置的那几个（设置页之外的老调用点不受影响）。
   */
  categories?: WorkflowCategoryItem[];
}) {
  const [workflowId, setWorkflowId] = useState(initialWorkflowId);
  const [idInput, setIdInput] = useState(initialWorkflowId);
  const [kind, setKind] = useState<GeneratorKind>(initialKind);
  const [category, setCategory] = useState<string>(initialCategory);
  const [operation, setOperation] = useState<WorkflowOperation>(initialOperation);
  const [nameInput, setNameInput] = useState('');
  const [fields, setFields] = useState<WorkflowField[]>([]);
  /*
   * 画布控件（开关 / 数字滑块 / 自定义参数分类）的**定义**（2026-10-10 徐先）。
   *
   * 与 `fields` 分开存：字段是「工作流里有哪些参数位」，控件是「为其中某个位造的旋钮」。
   * 两者在提交时才合到一起（`toNodeInfoList` 按 binding 取值）。
   */
  const [controls, setControls] = useState<CanvasControls>(EMPTY_CANVAS_CONTROLS);
  const [version, setVersion] = useState(-1);
  const [selectedKey, setSelectedKey] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('recommended');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'upload' | null>('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState<WorkflowField['kind']>('text');
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [loaded, setLoaded] = useState(false);

  async function load(id: string, kindHint: GeneratorKind = kind) {
    setBusy('load'); setError(''); setNotice('');
    try {
      /*
       * 带上用途去问：没有草稿时服务端按它生成默认配置，这样「从图片节点点进来配一份新的出图工作流」
       * 打开就是图片那一档，不用先看着视频版配完再回头改。
       */
      const body = await readResponse(await fetch(`/api/workflows/${id}/config?kind=${kindHint}`));
      const config = configurationSchema.parse(body.config);
      setFields(config.fields); setControls(config.controls); setVersion(body.version); setWorkflowId(id); setIdInput(id);
      const loadedKind = readGeneratorKind(body.kind);
      setKind(loadedKind);
      /* 分类同样以服务端返回的为准，并且**按用途兜底** —— 服务端已经兜过一次，这里是双保险。 */
      setCategory(readWorkflowCategory(body.category, loadedKind));
      setOperation(readWorkflowOperation(body.operation));
      /* 名字跟着一起读：没有草稿时服务端回空串，界面就按「还没起名字」显示 ID。 */
      setNameInput(readWorkflowName(body.name));
      setSelectedKey(config.fields.find(f => f.recommended)?.key || config.fields[0]?.key || '');
      setDirty(false); setLoaded(true);
      /* 拉取成功 / 失败的原因（无草稿的新 ID 去 RunningHub 拉过节点时由接口填）。 */
      if (body.nodeNotice) setNotice(body.nodeNotice);
    } catch (err) { setError(err instanceof Error ? err.message : '加载失败。'); }
    finally { setBusy(null); }
  }
  useEffect(() => { void load(initialWorkflowId, initialKind); }, [initialWorkflowId, initialKind]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  /* 浮层关掉不走 beforeunload，所以「有没有改过」得主动报给壳，由它在 ✕ / Esc / 点灰上时问一句。 */
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (adding || preview) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [adding, preview]);

  const selected = fields.find(f => f.key === selectedKey);
  const visible = fields.filter(f => (filter === 'all' || (filter === 'recommended' ? f.recommended : filter === 'enabled' ? f.enabled : f.kind === filter)) && `${f.nodeId} ${f.fieldName} ${f.label} ${f.classType}`.toLowerCase().includes(query.toLowerCase()));
  /* 控件和字段一起解析：少一个的话保存出去的配置会把它整块丢掉（schema 补默认值）。 */
  const parsed = configurationSchema.safeParse({ fields, controls });
  const enabledCount = fields.filter(f => f.enabled).length;
  /** 名字的即时校验：与服务端**同一套规则**（`lib/workflows/label.ts`），不另写一份长度判断。 */
  const checkedName = normalizeWorkflowName(nameInput);
  /** 页面标题显示的名字：起过就是名字，没起过回落工作流 ID。 */
  const displayName = workflowDisplayName({ name: nameInput, workflowId });

  /*
   * 登记进「未保存登记处」（2026-09-30）。
   *
   * `beforeunload` 只兜得住「刷新 / 关页面」这一条路，而离开这一屏还有两条它碰不到的：
   *   - 点「返回项目」「工作流列表」这些 `<Link>` —— 它们是 hash 路由，只改 hash，
   *     页面根本没卸载，`beforeunload` 不触发；
   *   - 桌面版点右上角关闭 —— 主进程先拦下再推 IPC，弹的是 `CloseConfirmDialog` 自己的框。
   * 这两条路都得有人主动问一句「还有没保存的」，问的人就是 `lib/unsaved.ts`。
   *
   * 登记的是 `dirty` 这屏自己的状态：谁脏谁知道，不该让问的人去猜。
   * `displayName` 进依赖是因为提醒里要说清是**哪一份**（起过名就是名字，没起过就是 ID）。
   */
  useEffect(() => registerUnsaved(`工作流「${displayName}」`, () => dirty), [displayName, dirty]);
  /** 当前用途那一档的说明（「含接续 latent…」/「含步数 / CFG…」），只有一处文案来源。 */
  const kindHint = GENERATOR_KIND_OPTIONS.find(option => option.value === kind)?.hint ?? '';
  /**
   * 当前用途下能选的分类：内置那五个（按用途筛）+ 用户自建的（不绑用途，见 `category.ts`）。
   * 自建的那几个包成同一形状，好让下拉只认一种东西。
   */
  const categoryOptions: WorkflowCategoryOption[] = [
    ...categoriesFor(kind),
    ...(categories || []).map(item => ({ value: item.name, label: item.name, hint: '你自己建的分类', kinds: [kind] })),
  ];
  const activeCategory = categoryOptions.some(option => option.value === category) ? category : DEFAULT_WORKFLOW_CATEGORY;
  const categoryHint = categoryOptions.find(option => option.value === activeCategory)?.hint ?? '';
  const operationHint = WORKFLOW_OPERATION_OPTIONS.find(option => option.value === operation)?.hint ?? '';
  /**
   * 超清工作流的**唯一必需品**：有一个字段绑到「超清」上。
   *
   * 没绑就点超清，界面上会是一片安静 —— 任务跑成功、产出一份和源视频毫无关系的东西，
   * 而没有任何地方会说「你的输入没接上」。所以在这里**保存之前**就说清楚，
   * 并且直接告诉他下一步是去勾选哪个字段（超清不吃提示词，那套字段勾了也没用）。
   */
  const upscaleWired = operation !== 'upscale' || fields.some(field => field.enabled && isUpscaleInputBinding(field.binding));
  /*
   * 这份配置里**有没有文本字段** —— 决定下面那条提示词警告怎么说。
   * 没绑提示词有两种成因：有字段没勾（可修，指路有用）／压根没这个字段（修不了，指路是骗人）。
   * 只看 `kind === 'text'`，不看 `enabled` —— 答的是「有没有这个去处」，不是「眼下开没开」。
   */
  const hasTextField = fields.some(field => String(field?.kind || '') === 'text');
  /**
   * 改一个字段。
   *
   * `key` 是「选中哪一行」的句柄，**必须跟着 `nodeId` / `fieldName` 一起变** ——
   * 它是这两个字段现算出来的（`fieldKey`）。早先这里只写 `change`、不动 `key`，
   * 于是在节点 ID 里改一个数字，界面回填的还是旧 key：`patch()` 按 key 找行、
   * 下一轮 `patch()` 就找不到自己刚改过的那一行了。改完顺手把选中项指到新 key 上，
   * 否则右边编辑区会因为「选中项已不存在」而整块消失。
   */
  function patch(key: string, change: Partial<WorkflowField>) {
    setFields(current => current.map(f => {
      if (f.key !== key) return f;
      const next = { ...f, ...change };
      const nextKey = fieldKey(next.nodeId, next.fieldName);
      if (nextKey !== key) setSelectedKey(currentKey => (currentKey === key ? nextKey : currentKey));
      return { ...next, key: nextKey };
    }));
    setDirty(true); setNotice('');
  }
  /** 改控件那一块（三类共用）：动过就算脏，和改字段一个待遇。 */
  function patchControls(change: Partial<CanvasControls>) {
    setControls(current => ({ ...current, ...change }));
    setDirty(true); setNotice('');
  }
  function patchToggle(index: number, change: Partial<ToggleControl>) {
    patchControls({ toggles: controls.toggles.map((item, i) => (i === index ? { ...item, ...change } : item)) });
  }
  function patchSlider(index: number, change: Partial<SliderControl>) {
    patchControls({ sliders: controls.sliders.map((item, i) => (i === index ? { ...item, ...change } : item)) });
  }
  function patchCustom(index: number, change: Partial<CustomControl>) {
    patchControls({ customs: controls.customs.map((item, i) => (i === index ? { ...item, ...change } : item)) });
  }
  async function save() {
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    /* 名字超长要挡在提交之前：服务端也会拒，但那已经是一趟往返，用户填了一屏字段却没存上。 */
    if (!checkedName.ok) { setError(checkedName.message); return; }
    setBusy('save'); setError(''); setNotice('');
    try {
      const body = await readResponse(await fetch(`/api/workflows/${workflowId}/config`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: parsed.data, version, kind, category: activeCategory, operation, name: checkedName.name }),
      }));
      /* 用途以服务端返回的为准回填：保存失败或并发改动都可能让它不是我们刚提交的那个值。名字同理。 */
      const savedKind = readGeneratorKind(body.kind);
      setVersion(body.version);
      setKind(savedKind);
      setCategory(readWorkflowCategory(body.category, savedKind));
      setOperation(readWorkflowOperation(body.operation));
      setNameInput(readWorkflowName(body.name));
      setDirty(false); setNotice('配置已保存');
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败。'); }
    finally { setBusy(null); }
  }
  async function upload(file: File, field: WorkflowField) {
    if (file.size > 100 * 1024 * 1024) { setError('文件不能超过 100 MB。'); return; }
    setBusy('upload'); setError(''); setNotice('');
    try {
      const form = new FormData(); form.set('file', file);
      const result = await readResponse(await fetch('/api/providers/runninghub/upload', { method: 'POST', body: form }));
      patch(field.key, { value: result.fileName, uploadedAt: result.uploadedAt, enabled: true });
      setNotice('文件已上传，配置尚未保存');
    } catch (err) { setError(err instanceof Error ? err.message : '上传失败。'); }
    finally { setBusy(null); }
  }
  /**
   * 值那一栏的编辑控件 —— **有可选项就给下拉**（2026-10-10 徐先）。
   *
   * `aspect` 这类字段在 ComfyUI 里是九选一（`adaptive / 16:9 / 9:16 / …`），但工作流图里
   * 只存着**当前那一个字符串值**，光看着它我们只能画个文本框 —— 于是出现了
   * 「明明是个枚举，却要手打 `16:9`」这种事。选项由服务端拿 `classType + fieldName`
   * 去问本机 ComfyUI 的 `/object_info` 得来（见 `lib/workflows/fieldOptions.ts`），
   * 查不到就没有、界面照旧是文本框 —— **没查到不等于没有选项**，所以这里不另作提示。
   *
   * 🔴 **存着的值不在选项里时要单独给一条**：受控 `<select>` 的 value 若不在 options 里，
   * 浏览器会显示成第一项，看上去值没变、一保存却被悄悄改掉了 —— 正是这套界面一直在防的那种静默失败。
   */
  /**
   * 这一条该不该用下拉呈现：**有可选项、且它本来就是「填一个值」的字段**。
   *
   * 后半个条件是为了不越界：媒体类型（image / video / audio / latent）的值是文件路径，
   * 服务端也不会给它们挂选项（见 `lib/workflows/fieldOptions.ts` 的媒体那一条），
   * 但用户手动把「输入类型」改成图片时，这一栏不该从上传控件变成下拉。
   */
  function choiceListOf(field: WorkflowField): string[] {
    if (field.kind !== 'text' && field.kind !== 'number') return [];
    return field.options ?? [];
  }

  function valueEditor(field: WorkflowField) {
    if (field.kind === 'boolean')
      return <input type="checkbox" checked={field.value === 'true'} onChange={e => patch(field.key, { value: String(e.target.checked) })} />;
    const options = choiceListOf(field);
    if (options.length)
      return (
        <select data-workflow-options="" aria-label={`${field.label} 可选项`} value={field.value} onChange={e => patch(field.key, { value: e.target.value })}>
          {!options.includes(field.value) && <option value={field.value}>{field.value || '（空）'}</option>}
          {options.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      );
    if (field.kind === 'text')
      return <textarea rows={9} value={field.value} onChange={e => patch(field.key, { value: e.target.value })} />;
    return <input type={field.kind === 'number' ? 'number' : 'text'} step="any" value={field.value} onChange={e => patch(field.key, { value: e.target.value, uploadedAt: undefined })} />;
  }

  function addField(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nodeId = String(form.get('nodeId')).trim();
    const fieldName = String(form.get('fieldName')).trim();
    if (fields.some(f => f.nodeId === nodeId && f.fieldName === fieldName)) { setError('该节点字段已存在，请搜索后编辑。'); return; }
    const label = String(form.get('label')).trim();
    /*
     * `key` 也走 `fieldKey()`，和图上扫出来的字段同一套 —— 手加的字段照样能改 ID / 字段名，
     * 用随机 UUID 的话它就成了唯一一个「改了名字 key 不跟着变」的特例。
     */
    const field: WorkflowField = { key: fieldKey(nodeId, fieldName), nodeId, fieldName, label: label || normalizeFieldLabel(fieldName), kind: newKind, value: newKind === 'boolean' ? 'false' : '', enabled: false, binding: 'manual', recommended: true, classType: CUSTOM_CLASS_TYPE };
    setFields(current => [...current, field]); setSelectedKey(field.key); setFilter('all'); setQuery(''); setDirty(true); setAdding(false); setError(''); setNotice('');
  }

  return <div className="workflow-content">
    <div className="workflow-title"><div><span className="workflow-kicker">RUNNINGHUB</span><h1>{displayName}</h1></div><div className="workflow-actions"><span className="workflow-muted">{dirty ? '有未保存的更改' : version >= 0 ? '已保存' : '未保存'}</span>{onBack
  ? <button type="button" className="secondary" onClick={onBack}><List size={16} />工作流列表</button>
  : <Link className="button secondary" href="/settings/providers/workflows"><List size={16} />工作流列表</Link>}<button className="secondary" disabled={!loaded || !!busy} onClick={() => setPreview(true)}><Braces size={16} />参数预览</button><button disabled={!loaded || !!busy} onClick={save}><Save size={16} />{busy === 'save' ? '保存中…' : '保存配置'}</button></div></div>
    {/*
      名字单独一行、**不放进下面那个 ID 表单里**：那个表单一回车就会重新加载配置
      （`type="submit"`），名字连带没保存的改动会被一起冲掉。
    */}
    <div className="workflow-name">
      <label htmlFor="workflow-name">名称</label>
      <input id="workflow-name" value={nameInput} maxLength={WORKFLOW_NAME_MAX} placeholder="给这份工作流起个名字，画布下拉里就显示它（留空 = 显示工作流 ID）" onChange={event => { setNameInput(event.target.value); setDirty(true); setNotice(''); }} disabled={!!busy} />
      <span className="workflow-lib-count">{nameInput.trim().length} / {WORKFLOW_NAME_MAX}</span>
      <span className="workflow-muted">名字只用来认人对得上号：保存之后，画布上的{generatorKindLabel(kind)}生成节点列的就是这个名字。</span>
      {!checkedName.ok && <span role="alert" className="workflow-lib-warn">{checkedName.message}</span>}
    </div>
    <form className="workflow-id" onSubmit={event => { event.preventDefault(); if (dirty && !window.confirm('放弃未保存的修改并加载配置？')) return; void load(idInput.trim()); }}><label htmlFor="workflow-id">工作流 ID</label><input id="workflow-id" value={idInput} onChange={e => setIdInput(e.target.value)} pattern="([0-9]{1,30}|local-[a-z0-9]{6,40})" title="RunningHub 的纯数字 ID，或本地工作流的 local- 开头 ID" required disabled={!!busy} /><button className="secondary" disabled={!!busy}>加载</button><label htmlFor="workflow-kind">用途</label><select id="workflow-kind" value={kind} onChange={event => { setKind(readGeneratorKind(event.target.value)); setDirty(true); setNotice(''); }} disabled={!!busy}>{GENERATOR_KIND_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><label htmlFor="workflow-category">分类</label><select id="workflow-category" value={activeCategory} onChange={event => { setCategory(readWorkflowCategory(event.target.value, kind)); setDirty(true); setNotice(''); }} disabled={!!busy}>{categoryOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><label htmlFor="workflow-operation">工序</label><select id="workflow-operation" value={operation} onChange={event => { setOperation(readWorkflowOperation(event.target.value)); setDirty(true); setNotice(''); }} disabled={!!busy}>{WORKFLOW_OPERATION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><span className="workflow-count">{fields.length} 个字段 / {enabledCount} 个已启用</span><span className="workflow-muted">画布上的{generatorKindLabel(kind)}生成节点只会列出这一档的工作流（{kindHint}）。分类说的是它要喂什么参考素材（{categoryHint}），用来在列表里筛。改了用途要回画布确认节点上选的那条还对不对。</span></form>
    {/*
      超清工作流没绑定输入时**在保存之前**说清：这一步没做，点超清会得到一份和源素材无关的产出，
      而界面上没有任何地方会报错 —— 正是这套 UI 一直在防的那种静默失败。
    */}
    {!upscaleWired && <p role="alert" className="workflow-lib-warn">这份工作流是「超清」工序，但还没有字段承接待加工的媒体 —— 在下面勾选那个上传字段，把「画布绑定」选成「画布 · 参考图 1」（图）或「画布 · 视频输入 1」（视频），否则点超清时输入会被丢掉。</p>}
    {/*
      提示词没接进来（2026-10-08 徐先：「不绑定提示词节点id也能生成」）。
      **只说、不拦**：空提示词交给工作流自己的默认值本来就是合法用法，
      但「画布上写了提示词、它一个字都没进提交体」是静默的坏结果 ——
      任务照样成功、出来的画面和写的那句毫无关系，全程零报错。
      超清那一份不查：它加工的是现成媒体，压根不该有提示词位。
    */}
    {operation !== 'upscale' && !fields.some(f => f.enabled && f.binding === 'prompt') && (hasTextField ? (
      /* 有文本字段，只是还没绑 → 支到下面那条列表上，勾一下就好。 */
      <p role="alert" className="workflow-lib-warn" data-wf-prompt-unwired="bindable">这份工作流还没有字段绑到「画布 · 提示词」—— 生成照跑不误（不会报错），但画布上写的提示词不会送进工作流，出来的是它自己的默认值。在下面勾选提示词那个字段，把「画布参数绑定」选成「画布 · 提示词」。</p>
    ) : (
      /*
        整份配置里一个文本字段都没有（典型：RunningHub 应用，只有参考图位）。
        ⚠️ 这时候叫人去「勾选提示词那个字段」是句空话 —— 列表里根本没有那一条
        （2026-10-08 徐先在「Krea2 资产库角色（四视图）」上撞到的就是这堵墙）。
        如实讲：提示词由它自己带着，画布上的字送不进去，照样能生成。
      */
      <p role="alert" className="workflow-lib-warn" data-wf-prompt-unwired="none">这份配置里没有能接提示词的文本字段 —— 生成照跑不误（不会报错），提示词以它自带的为准，画布上写的那句不会送进去。要改就改它自己的参数。</p>
    ))}
    {/*
      画布控件（2026-10-10 徐先）：在这里**造旋钮**，再回到下面选一个字段、把
      「画布参数绑定」选成它 —— 之后它出现在节点卡片右上角的胶囊里。

      三类各一组、组内可以造多个（开关 1 之后还能有开关 2）：绑的字段不同、各调各的。
      ⚠️ **只给删最后一个**：槽位号是数组下标 + 1，删中间一个会让后面所有编号前移，
      而节点上存的值按**编号**取 —— 「滑块 2」会突然变成原来「滑块 3」的值，
      界面上一个字都不会说。删最后一个不会有这种错位。
    */}
    <section className="workflow-controls" aria-label="画布控件">
      <div className="workflow-controls-head">
        <h2>画布控件</h2>
        <span className="workflow-muted">造一个旋钮、再到下面选中某个字段把「画布参数绑定」选成它 —— 之后它出现在节点卡片右上角的胶囊里。值存在<b>节点</b>上，同一份工作流挂在几个节点上就各有各的值。</span>
      </div>

      <div className="workflow-control-group">
        <div className="workflow-control-group-head">
          <strong>开关</strong>
          <span className="workflow-muted">节点上就是一个开 / 关，提交 <code>true</code> / <code>false</code>。</span>
          <button type="button" className="secondary" disabled={!loaded || !!busy || controls.toggles.length >= MAX_TOGGLES} onClick={() => patchControls({ toggles: [...controls.toggles, { label: '', on: false }] })}><Plus size={14} />添加开关</button>
        </div>
        {controls.toggles.length === 0
          ? <p className="workflow-empty">还没有开关。</p>
          : controls.toggles.map((item, index) => (
            <div className="workflow-control-row" key={`toggle-${index}`}>
              <code className="workflow-control-code">{controlBinding('toggle', index + 1)}</code>
              <label>显示名称<input value={item.label} maxLength={60} placeholder={defaultControlLabel('toggle', index + 1)} onChange={event => patchToggle(index, { label: event.target.value })} /></label>
              <label className="workflow-control-inline">默认<input type="checkbox" checked={item.on} onChange={event => patchToggle(index, { on: event.target.checked })} /></label>
              {index === controls.toggles.length - 1 && <button type="button" className="secondary workflow-icon" title="删除最后一个开关" aria-label="删除最后一个开关" disabled={!!busy} onClick={() => patchControls({ toggles: controls.toggles.slice(0, -1) })}><Trash2 size={14} /></button>}
            </div>
          ))}
      </div>

      <div className="workflow-control-group">
        <div className="workflow-control-group-head">
          <strong>数字滑块</strong>
          <span className="workflow-muted">默认 -1 ~ 1，两头和小数位数都能改。</span>
          <button type="button" className="secondary" disabled={!loaded || !!busy || controls.sliders.length >= MAX_SLIDERS} onClick={() => patchControls({ sliders: [...controls.sliders, { label: '', min: -1, max: 1, precision: 2, value: 0 }] })}><Plus size={14} />添加滑块</button>
        </div>
        {controls.sliders.length === 0
          ? <p className="workflow-empty">还没有数字滑块。</p>
          : controls.sliders.map((item, index) => (
            <div className="workflow-control-row" key={`slider-${index}`}>
              <code className="workflow-control-code">{controlBinding('slider', index + 1)}</code>
              <label>显示名称<input value={item.label} maxLength={60} placeholder={defaultControlLabel('slider', index + 1)} onChange={event => patchSlider(index, { label: event.target.value })} /></label>
              <label>最小<input type="number" step="any" value={item.min} onChange={event => patchSlider(index, { min: Number(event.target.value || 0) })} /></label>
              <label>最大<input type="number" step="any" value={item.max} onChange={event => patchSlider(index, { max: Number(event.target.value || 0) })} /></label>
              <label>小数位<input type="number" min={0} max={6} step={1} value={item.precision} onChange={event => patchSlider(index, { precision: Math.max(0, Math.min(6, Math.round(Number(event.target.value || 0)))) })} /></label>
              <label>默认<input type="number" step="any" value={item.value} onChange={event => patchSlider(index, { value: Number(event.target.value || 0) })} /></label>
              {index === controls.sliders.length - 1 && <button type="button" className="secondary workflow-icon" title="删除最后一个滑块" aria-label="删除最后一个滑块" disabled={!!busy} onClick={() => patchControls({ sliders: controls.sliders.slice(0, -1) })}><Trash2 size={14} /></button>}
            </div>
          ))}
      </div>

      <div className="workflow-control-group">
        <div className="workflow-control-group-head">
          <strong>自定义参数分类</strong>
          <span className="workflow-muted">自己填几个预设值，节点上就是下拉（一行一个）。</span>
          <button type="button" className="secondary" disabled={!loaded || !!busy || controls.customs.length >= MAX_CUSTOM_CONTROLS} onClick={() => patchControls({ customs: [...controls.customs, { label: '', options: [], value: '' }] })}><Plus size={14} />添加分类</button>
        </div>
        {controls.customs.length === 0
          ? <p className="workflow-empty">还没有自定义参数分类。</p>
          : controls.customs.map((item, index) => {
            /*
             * 空串是「边打字边提交」留下的中间态（刚敲下回车那一行还是空的），
             * 存下来没关系（读的一侧会滤），但**显示**的时候要滤掉，
             * 否则下拉里会多一个空选项。
             */
            const options = item.options.filter(Boolean);
            return (
              <div className="workflow-control-row" key={`custom-${index}`}>
                <code className="workflow-control-code">{controlBinding('custom', index + 1)}</code>
                <label>显示名称<input value={item.label} maxLength={60} placeholder={defaultControlLabel('custom', index + 1)} onChange={event => patchCustom(index, { label: event.target.value })} /></label>
                <label className="workflow-control-wide">预设值（一行一个）<textarea rows={3} value={item.options.join('\n')} onChange={event => {
                  const lines = event.target.value.split('\n').map(line => line.trim()).slice(0, MAX_CUSTOM_OPTIONS);
                  const clean = lines.filter(Boolean);
                  /*
                   * 填了预设值就把「默认」落到**第一项**（用户没另选过时）。
                   *
                   * 为什么不留「不选」：留着的话这一档**一个值都不提交** ——
                   * 工作流走自己的默认值，任务照样成功，而用户在节点上明明看见一个下拉
                   * （还显示着第一项），会以为传的就是它。属于「看着对、其实没生效」。
                   * 想让它不传，下拉里那项「（不选）」还在。
                   */
                  const value = clean.includes(item.value) ? item.value : (clean[0] ?? '');
                  patchCustom(index, { options: lines, value });
                }} /></label>
                <label>默认
                  <select value={options.includes(item.value) ? item.value : ''} onChange={event => patchCustom(index, { value: event.target.value })}>
                    <option value="">（不选）</option>
                    {options.map(option => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
                {options.length === 0 && <span className="workflow-lib-warn" data-control-empty="">还没填预设值 —— 节点上的下拉会是空的。</span>}
                {index === controls.customs.length - 1 && <button type="button" className="secondary workflow-icon" title="删除最后一个分类" aria-label="删除最后一个分类" disabled={!!busy} onClick={() => patchControls({ customs: controls.customs.slice(0, -1) })}><Trash2 size={14} /></button>}
              </div>
            );
          })}
      </div>
    </section>
    {error && <div role="alert" className="workflow-error">{error}</div>}
    {notice && <div role="status" className="workflow-success"><Check size={16} />{notice}</div>}
    <div className="workflow-layout">
      <section className="workflow-list" aria-label="工作流字段">
        <div className="workflow-search"><Search size={16} /><input aria-label="搜索节点" placeholder="搜索 ID、名称或字段" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <div className="workflow-filter"><select aria-label="筛选字段" value={filter} onChange={e => setFilter(e.target.value)}><option value="recommended">常用字段</option><option value="all">全部字段</option><option value="enabled">已启用</option>{kinds.map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select><button className="secondary workflow-icon" title="添加节点字段" aria-label="添加节点字段" disabled={!loaded || !!busy} onClick={() => { setError(''); setAdding(true); }}><Plus size={18} /></button></div>
        <div className="workflow-rows">{busy === 'load' ? <p className="workflow-empty">正在加载…</p> : visible.length === 0 ? <p className="workflow-empty">没有匹配的字段</p> : visible.map(field => <button key={field.key} className={`workflow-row ${selectedKey === field.key ? 'selected' : ''}`} onClick={() => setSelectedKey(field.key)} aria-pressed={selectedKey === field.key}><span className={`workflow-kind kind-${field.kind}`}>{iconFor(field.kind)}</span><span className="workflow-row-copy"><strong>{field.label}</strong><small>#{field.nodeId} / {field.fieldName}</small></span><span className={`workflow-dot ${field.enabled ? 'enabled' : ''}`} title={field.enabled ? '已启用' : '未启用'} /></button>)}</div>
      </section>
      <section className="workflow-editor" aria-label="字段编辑器">
        {selected && (() => {
          /*
           * 序列型绑定（参考图 / 视频 / 音频）**按需长出来**：这一份配置用到第 N 个，
           * 下拉里才出现第 N+1 个 —— 一上来铺 20 个「参考图 N」只会让人翻不到底。
           */
          /* 带上 `controls`：造过的控件才进下拉（没造过的绑上去等于绑到一个没有量程的东西）。 */
          const contextBindings = bindingsForFields(fields, kind, operation, controls);
          const options = Array.from(new Set<CanvasBinding>(['manual', ...contextBindings, selected.binding]));
          const next = nextSeriesBinding(fields, selected.binding);
          return (
            <>
              <label className="workflow-binding-select">画布参数绑定
                <select data-workflow-binding value={selected.binding} onChange={e => patch(selected.key, { binding: e.target.value as CanvasBinding, enabled: true })}>
                  {/* 控件用**改过的名字**（没改名就回落那张静态表）—— 直接读表会把用户起的名字丢掉。 */}
                  {options.map(value => <option key={value} value={value}>{controlLabelOf(controls, value) ?? canvasBindingLabels[value]}</option>)}
                </select>
              </label>
              {next && <span className="workflow-binding-hint">还能再加一份 —— 把另一个字段绑到「{canvasBindingLabels[next]}」。</span>}
              {selected.binding === 'reference_count' && <span className="workflow-binding-hint">这个值不用填 —— 提交时按画布上实际接进来的参考图张数写入（最多 {MAX_REFERENCE_IMAGES} 张），增删参考图它自己会变。</span>}
            </>
          );
        })()}
        {selected ? <fieldset disabled={!!busy}><div className="workflow-editor-head"><div><span className="workflow-kicker">NODE {selected.nodeId}</span><h2>{selected.label}</h2><span className="workflow-muted">{selected.classType}</span></div><label className="workflow-toggle"><input type="checkbox" checked={selected.enabled} onChange={e => patch(selected.key, { enabled: e.target.checked })} />启用覆盖</label></div>
          <div className="workflow-grid"><label>节点 ID<input value={selected.nodeId} onChange={e => patch(selected.key, { nodeId: e.target.value })} /></label><label>字段名<input value={selected.fieldName} onChange={e => patch(selected.key, { fieldName: e.target.value })} /></label><label>显示名称<input value={selected.label} onChange={e => patch(selected.key, { label: e.target.value })} /></label><label>输入类型<select value={selected.kind} onChange={e => { const kind = e.target.value as WorkflowField['kind']; patch(selected.key, { kind, value: kind === 'boolean' ? 'false' : selected.value, uploadedAt: undefined }); }}>{kinds.map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label></div>
          <label className="workflow-value">{selected.kind === 'boolean' ? '参数开关' : choiceListOf(selected).length ? `可选项（${choiceListOf(selected).length} 项）` : selected.kind === 'text' ? '文本内容' : selected.kind === 'number' ? '数值' : '文件路径 / URL'}{valueEditor(selected)}</label>
          {/* 选项是从本机 ComfyUI 问来的，说清出处：用户改了节点包、又发现下拉没跟着变时，至少知道该去看哪一边。 */}
          {choiceListOf(selected).length > 0 && <span className="workflow-muted">这些取值由本机 ComfyUI 的 {selected.classType} 节点给出 —— 节点包更新后重新加载这份配置才会刷新。</span>}
          {['image', 'video', 'audio', 'latent'].includes(selected.kind) && <div className="workflow-upload"><label className="button secondary"><Upload size={16} />{busy === 'upload' ? '正在上传…' : '上传文件'}<input type="file" aria-label="上传素材文件" accept={selected.kind === 'image' ? 'image/*' : selected.kind === 'video' ? 'video/*' : selected.kind === 'audio' ? 'audio/*' : '.latent,.safetensors,.pt,.pth,.bin'} onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file, selected); e.target.value = ''; }} /></label><span className="workflow-muted">最大 100 MB</span>{selected.uploadedAt && <p className="workflow-muted">上传于 {new Date(selected.uploadedAt).toLocaleString()}。RunningHub 上传链接有效期为 24 小时。</p>}</div>}
          {/*
            媒体字段那句「当前导入的工作流没有 X 加载节点」。
            原先它**只看字段类型、一句都不查**：选中的字段是音频就弹，于是从云端读回来的音频字段
            （`MiniMaxH3AudioConditioningT8` 那一类，它本来就是这条工作流自己的音频输入节点）
            和 RunningHub 应用的音频字段全都在弹「没有音频加载节点」—— 明明有，界面偏说没有
            （2026-10-04 徐先：「不管是应用还是工作流，都有加载音频的功能啊」）。
            现在改成真判断：字段是工作流自己带来的（classType 是真类名）就**不弹**，
            只有手加的字段（Custom）才说「我们无从得知」。判定见 `mediaLoaderVerdict`。
          */}
          {(() => {
            if (selected.kind !== 'video' && selected.kind !== 'audio') return null;
            /* 工作流自己带来的字段 = 云端确实有这个节点，不用提醒。 */
            const verdict = mediaLoaderVerdict(fields, selected);
            if (!verdict.handAdded) return null;
            const label = selected.kind === 'video' ? '视频' : '音频';
            return <p className="workflow-warning">{verdict.nativeCount > 0
              ? `这个${label}字段是你手动加的（Custom），云端有没有这个节点我们无从得知 —— 节点 ID 和字段名要和云端对得上。这份配置里另有 ${verdict.nativeCount} 个${label}字段是工作流自己带来的，拿不准就改绑到其中一个。`
              : `当前导入的工作流没有${label}加载节点 —— 这个字段是你手动加的（Custom），云端工作流中需存在对应节点和字段（节点 ID、字段名都要对得上）。`}</p>;
          })()}
          {/* latent 那句是格式上的提醒（不是「有没有」），任何来源都成立，照旧显示。 */}
          {selected.kind === 'latent' && <p className="workflow-warning">文件格式需与云端 H3 latent 加载节点兼容。</p>}
          {selected.enabled && !parsed.success && <p className="workflow-error">{parsed.error.issues.filter(issue => issue.path[1] === fields.indexOf(selected)).map(issue => issue.message).join(' ')}</p>}
          <div className="workflow-editor-footer"><code>{selected.nodeId}.{selected.fieldName}</code>{selected.classType === 'Custom' && <button className="secondary workflow-icon" title="删除自定义字段" aria-label="删除自定义字段" onClick={() => { setFields(current => current.filter(f => f.key !== selected.key)); setSelectedKey(''); setDirty(true); }}><Trash2 size={16} /></button>}</div>
        </fieldset> : <div className="workflow-empty">选择一个节点字段</div>}
      </section>
    </div>
    <dialog ref={dialogRef} className="workflow-dialog" onCancel={() => { setAdding(false); setPreview(false); }}><div className="workflow-dialog-head"><h2>{adding ? '添加节点字段' : '提交参数预览'}</h2><button className="secondary workflow-icon" title="关闭" aria-label="关闭" onClick={() => { setAdding(false); setPreview(false); }}><X size={18} /></button></div>
      {adding ? <form ref={formRef} onSubmit={addField} className="workflow-add-form"><label>输入类型<select value={newKind} onChange={e => setNewKind(e.target.value as WorkflowField['kind'])}>{kinds.map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label><label>节点 ID<input name="nodeId" required pattern="[A-Za-z0-9_:\-]+" maxLength={100} /></label><label>字段名<input name="fieldName" required maxLength={100} /></label><label>显示名称<input name="label" required maxLength={160} /></label>{(newKind === 'video' || newKind === 'audio' || newKind === 'latent') && <p className="workflow-warning">需填写云端{newKind === 'video' ? '视频' : newKind === 'audio' ? '音频' : 'H3 latent'}加载节点的实际 ID 和字段名。</p>}{error && <p role="alert" className="workflow-error">{error}</p>}<button type="submit"><Plus size={16} />添加字段</button></form> : <><p className="workflow-muted">工作流 {workflowId} / {enabledCount} 个覆盖参数</p>{parsed.success ? <pre>{JSON.stringify({ nodeInfoList: toNodeInfoList(parsed.data) }, null, 2)}</pre> : <p className="workflow-error">{parsed.error.issues[0].message}</p>}</>}
    </dialog>
  </div>;
}
