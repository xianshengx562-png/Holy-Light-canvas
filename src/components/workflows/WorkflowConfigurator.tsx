'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AudioLines, Braces, Check, FileBox, Film, ImageIcon, List, Plus, Save, Search, Trash2, Type, Upload, X } from 'lucide-react';
import { fieldKey, normalizeFieldLabel, bindingsForFields, isUpscaleInputBinding, nextSeriesBinding, canvasBindingLabels, configurationSchema, toNodeInfoList, MAX_REFERENCE_IMAGES, type CanvasBinding, type WorkflowField } from '@/lib/workflows/configuration';
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
      setFields(config.fields); setVersion(body.version); setWorkflowId(id); setIdInput(id);
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
  const parsed = configurationSchema.safeParse({ fields });
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
    const field: WorkflowField = { key: fieldKey(nodeId, fieldName), nodeId, fieldName, label: label || normalizeFieldLabel(fieldName), kind: newKind, value: newKind === 'boolean' ? 'false' : '', enabled: false, binding: 'manual', recommended: true, classType: 'Custom' };
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
          const contextBindings = bindingsForFields(fields, kind, operation);
          const options = Array.from(new Set<CanvasBinding>(['manual', ...contextBindings, selected.binding]));
          const next = nextSeriesBinding(fields, selected.binding);
          return (
            <>
              <label className="workflow-binding-select">画布参数绑定
                <select data-workflow-binding value={selected.binding} onChange={e => patch(selected.key, { binding: e.target.value as CanvasBinding, enabled: true })}>
                  {options.map(value => <option key={value} value={value}>{canvasBindingLabels[value]}</option>)}
                </select>
              </label>
              {next && <span className="workflow-binding-hint">还能再加一份 —— 把另一个字段绑到「{canvasBindingLabels[next]}」。</span>}
              {selected.binding === 'reference_count' && <span className="workflow-binding-hint">这个值不用填 —— 提交时按画布上实际接进来的参考图张数写入（最多 {MAX_REFERENCE_IMAGES} 张），增删参考图它自己会变。</span>}
            </>
          );
        })()}
        {selected ? <fieldset disabled={!!busy}><div className="workflow-editor-head"><div><span className="workflow-kicker">NODE {selected.nodeId}</span><h2>{selected.label}</h2><span className="workflow-muted">{selected.classType}</span></div><label className="workflow-toggle"><input type="checkbox" checked={selected.enabled} onChange={e => patch(selected.key, { enabled: e.target.checked })} />启用覆盖</label></div>
          <div className="workflow-grid"><label>节点 ID<input value={selected.nodeId} onChange={e => patch(selected.key, { nodeId: e.target.value })} /></label><label>字段名<input value={selected.fieldName} onChange={e => patch(selected.key, { fieldName: e.target.value })} /></label><label>显示名称<input value={selected.label} onChange={e => patch(selected.key, { label: e.target.value })} /></label><label>输入类型<select value={selected.kind} onChange={e => { const kind = e.target.value as WorkflowField['kind']; patch(selected.key, { kind, value: kind === 'boolean' ? 'false' : selected.value, uploadedAt: undefined }); }}>{kinds.map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label></div>
          <label className="workflow-value">{selected.kind === 'text' ? '文本内容' : selected.kind === 'number' ? '数值' : selected.kind === 'boolean' ? '参数开关' : '文件路径 / URL'}{selected.kind === 'text' ? <textarea rows={9} value={selected.value} onChange={e => patch(selected.key, { value: e.target.value })} /> : selected.kind === 'boolean' ? <input type="checkbox" checked={selected.value === 'true'} onChange={e => patch(selected.key, { value: String(e.target.checked) })} /> : <input type={selected.kind === 'number' ? 'number' : 'text'} step="any" value={selected.value} onChange={e => patch(selected.key, { value: e.target.value, uploadedAt: undefined })} />}</label>
          {['image', 'video', 'audio', 'latent'].includes(selected.kind) && <div className="workflow-upload"><label className="button secondary"><Upload size={16} />{busy === 'upload' ? '正在上传…' : '上传文件'}<input type="file" aria-label="上传素材文件" accept={selected.kind === 'image' ? 'image/*' : selected.kind === 'video' ? 'video/*' : selected.kind === 'audio' ? 'audio/*' : '.latent,.safetensors,.pt,.pth,.bin'} onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file, selected); e.target.value = ''; }} /></label><span className="workflow-muted">最大 100 MB</span>{selected.uploadedAt && <p className="workflow-muted">上传于 {new Date(selected.uploadedAt).toLocaleString()}。RunningHub 上传链接有效期为 24 小时。</p>}</div>}
          {selected.kind === 'video' && <p className="workflow-warning">当前导入的工作流没有视频加载节点。云端工作流中需存在对应节点和字段。</p>}
          {selected.kind === 'audio' && <p className="workflow-warning">当前导入的工作流没有音频加载节点。云端工作流中需存在对应节点和字段。</p>}
          {selected.kind === 'latent' && <p className="workflow-warning">文件格式需与云端 H3 latent 加载节点兼容。</p>}
          {selected.enabled && !parsed.success && <p className="workflow-error">{parsed.error.issues.filter(issue => issue.path[1] === fields.indexOf(selected)).map(issue => issue.message).join(' ')}</p>}
          <div className="workflow-editor-footer"><code>{selected.nodeId}.{selected.fieldName}</code>{selected.classType === 'Custom' && <button className="secondary workflow-icon" title="删除自定义字段" aria-label="删除自定义字段" onClick={() => { setFields(current => current.filter(f => f.key !== selected.key)); setSelectedKey(''); setDirty(true); }}><Trash2 size={16} /></button>}</div>
        </fieldset> : <div className="workflow-empty">选择一个节点字段</div>}
      </section>
    </div>
    <dialog ref={dialogRef} className="workflow-dialog" onCancel={() => { setAdding(false); setPreview(false); }}><div className="workflow-dialog-head"><h2>{adding ? '添加节点字段' : '提交参数预览'}</h2><button className="secondary workflow-icon" title="关闭" aria-label="关闭" onClick={() => { setAdding(false); setPreview(false); }}><X size={18} /></button></div>
      {adding ? <form ref={formRef} onSubmit={addField} className="workflow-add-form"><label>输入类型<select value={newKind} onChange={e => setNewKind(e.target.value as WorkflowField['kind'])}>{kinds.map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label><label>节点 ID<input name="nodeId" required pattern="[A-Za-z0-9_:\-]+" maxLength={100} /></label><label>字段名<input name="fieldName" required maxLength={100} /></label><label>显示名称<input name="label" required maxLength={160} /></label>{newKind === 'video' && <p className="workflow-warning">需填写云端视频加载节点的实际 ID 和字段名。</p>}{error && <p role="alert" className="workflow-error">{error}</p>}<button type="submit"><Plus size={16} />添加字段</button></form> : <><p className="workflow-muted">工作流 {workflowId} / {enabledCount} 个覆盖参数</p>{parsed.success ? <pre>{JSON.stringify({ nodeInfoList: toNodeInfoList(parsed.data) }, null, 2)}</pre> : <p className="workflow-error">{parsed.error.issues[0].message}</p>}</>}
    </dialog>
  </div>;
}
