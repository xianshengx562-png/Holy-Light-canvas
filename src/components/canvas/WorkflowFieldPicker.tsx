'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader, Search, X } from 'lucide-react';
import type { WorkflowField } from '@/lib/workflows/configuration';

/**
 * 参数块的「挑一个字段」弹层 —— 在画面正中弹出，而不是贴在按钮下面。
 *
 * 为什么不全用下拉：一份 ComfyUI 图摊平出来动辄上百个字段，在 `<select>` 里
 * 找想要的那个要滚很久，而且得先看懂节点号才知道自己在看哪个节点。
 * 这里给的是「搜索 + 列表 + 每行都标着节点类型与编号」的形状 ——
 * 用户是在**这份工作流里挑一个字段**，不是在手填两个自己也不知道从哪来的编号。
 */

/** `/api/workflows/[id]/fields` 返回的一条：与 `WorkflowField` 同构，只是不带 `value`。 */
export type WorkflowFieldCandidate = Pick<WorkflowField, 'key' | 'nodeId' | 'fieldName' | 'label' | 'kind' | 'classType'> & {
  enabled: boolean;
  binding: WorkflowField['binding'];
};

/** 每种字段在列表里配一句说明 —— 图 / 视频 / 音频 / latent 填的都不是文本，不标的话会被填成随手一个字符串。 */
export const PARAM_KIND_HINTS: Record<WorkflowField['kind'], string> = {
  text: '文本',
  number: '数字',
  boolean: '开关 · true / false',
  image: '图片 · 填已上传的图片文件名',
  video: '视频 · 填已上传的视频文件名',
  audio: '音频 · 填已上传的音频文件名',
  latent: 'Latent · 填已归档的 latent',
};

/** 这一行的值该按什么类型填；参数行是绕过画布绑定直填的，所以这句说明比在配置页更重要。 */
export function fieldValueHint(kind: WorkflowField['kind']) {
  return PARAM_KIND_HINTS[kind] || '文本';
}

/**
 * 来源写在页脚那半句里 —— 三种来源「不够的时候该怎么补」完全不同：
 * 图扫出来的要回工作流库重新导图，存下来的要去配置页勾选，出厂那份补不了只能换工作流。
 */
const SOURCE_NOTE: Record<'graph' | 'config' | 'builtin', string> = {
  graph: ' · 按当前图扫出来的',
  builtin: ' · 内置出厂配置',
  config: ' · 来自已保存的配置',
};

function matches(field: WorkflowFieldCandidate, query: string) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [field.label, field.nodeId, field.fieldName, field.classType, field.key]
    .some(part => String(part).toLowerCase().includes(needle));
}

export default function WorkflowFieldPicker({
  workflowId,
  workflowTitle,
  used,
  title,
  initialQuery = '',
  onPick,
  onClose,
}: {
  workflowId: string;
  /** 界面上给这份工作流的称呼（跟随哪个节点选的），没有就只显示编号。 */
  workflowTitle?: string;
  /** 参数块里已经登记过的「节点号.字段名」，列表里标成「已添加」，避免同一个字段加两行。 */
  used: string[];
  /**
   * 弹层标题（2026-10-05）。参数块说「选一个字段加进参数块」，
   * 「指定节点上传」要的是「挑一个节点接收这份图 / 视频」—— 同一个列表、两种问法，
   * 文案不对会让他在挑的时候不确定自己挑的是什么。
   */
  title?: string;
  /**
   * 打开时**预填**的搜索词（2026-10-05）。**不是过滤** —— 一条都不删，
   * 清空搜索框就能看到全部字段。
   *
   * 为什么不直接按 kind 过滤：工作流的字段类型是按 `class_type` 猜的，
   * LoadImage 那个 `image` 字段完全可能被判成 `text`（它在图里就是个字符串控件）。
   * 一刀切过滤会**一条都不剩**，而那看起来就像「这份工作流里没有能接图的节点」。
   * 预填一个 `image` / `video` 只是帮他把最可能的那一批顶到前面。
   */
  initialQuery?: string;
  onPick: (field: WorkflowFieldCandidate) => void;
  onClose: () => void;
}) {
  const [fields, setFields] = useState<WorkflowFieldCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  /** 接口失败要**把原因打在弹层里**并留一条手填的退路，不能让「添加参数」点了没反应。 */
  const [error, setError] = useState('');
  /** 候选来自哪儿：本地那份按图扫出来的 / 已保存的配置 / 默认工作流的出厂配置。 */
  const [source, setSource] = useState<'graph' | 'config' | 'builtin'>('config');
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/fields`);
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(String(body?.error || `读取候选字段失败（${response.status}）`));
        }
        const body = await response.json();
        if (!alive) return;
        setFields(Array.isArray(body.fields) ? body.fields as WorkflowFieldCandidate[] : []);
        /*
         * 三种来源都要认下来 —— 写成「不是 graph 就算 config」会把出厂那份说成「来自已保存的配置」，
         * 而这两种「不够时该怎么补」完全不同（一个是存出来的、一个是装好就有的），
         * 说错了用户会去配置页找一个根本没存过的配置。认不出来时宁可取 config（最接近的默认猜测）。
         */
        setSource(body.source === 'graph' || body.source === 'builtin' ? body.source : 'config');
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : '读取候选字段失败');
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => { alive = false; };
  }, [workflowId]);

  const usedKeys = useMemo(() => new Set(used), [used]);
  const visible = useMemo(() => fields.filter(field => matches(field, query.trim())), [fields, query]);

  /** 搜索词一变就把高亮挪回第一行：留在一个看不见的位置，按 Enter 会加到一条意料之外的字段。 */
  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.cv-fpk-item.on');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, visible.length]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, visible.length - 1)); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); return; }
    if (event.key === 'Enter') {
      const pick = visible[active];
      if (!pick) return;
      event.preventDefault();
      onPick(pick);
    }
  };

  /*
   * 弹层挂到画布外壳上，**不能留在节点里**：
   * React Flow 的节点外层带着 `transform`，那是 `position: fixed` 的包含块 ——
   * 留在原处的「全屏遮罩」只会盖住那张卡片本身，还会跟着画布缩放漂。
   * 挂 `.flow-shell` 而不是 `document.body`，是因为那些 `cv-*` 变量定义在画布外层容器上，
   * 挂到 body 会一个都取不到值，弹层会变成一块没有配色的白板。
   */
  if (typeof document === 'undefined') return null;
  const host = document.querySelector<HTMLElement>('.flow-shell') || document.body;

  return createPortal((
    <div className="cv-fpk-mask" onMouseDown={onClose}>
      <div
        className="cv-fpk"
        role="dialog"
        aria-label="选择工作流字段"
        tabIndex={-1}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="cv-fpk-head">
          <div className="cv-fpk-title">
            <span>{title || '选一个字段加进参数块'}</span>
            <em>{workflowTitle ? `${workflowTitle} · ${workflowId}` : `工作流 ${workflowId}`}</em>
          </div>
          <button className="cv-fpk-x" type="button" aria-label="关闭" onClick={onClose}>
            <X size={14} strokeWidth={1.8} aria-hidden />
          </button>
        </div>

        <div className="cv-fpk-search">
          <Search size={13} strokeWidth={1.8} aria-hidden />
          <input
            ref={searchRef}
            value={query}
            placeholder="搜字段名字 / 节点号 / 节点类型，例如 seed 或 KSampler"
            onChange={event => setQuery(event.target.value)}
          />
        </div>

        <div className="cv-fpk-list" ref={listRef}>
          {loading && (
            <div className="cv-fpk-state">
              <Loader size={14} strokeWidth={1.8} className="cv-spin" aria-hidden /> 正在读取这份工作流的字段…
            </div>
          )}
          {!loading && error && <div className="cv-fpk-state bad">{error}</div>}
          {!loading && !error && visible.length === 0 && (
            <div className="cv-fpk-state">
              {fields.length === 0
                ? (source === 'graph'
                  ? '这份图里没有可以外接的字段（输入多半是由别的节点连死的线，而不是一个可填的值）。'
                  : source === 'builtin'
                    ? '这份工作流的出厂配置里没有可挑的字段。'
                    : '这份工作流还没有保存过字段配置 —— 先到「设置 · 工作流库」打开它保存一次，这里才会有得挑。')
                : `没有匹配「${query.trim()}」的字段。`}
            </div>
          )}
          {visible.map((field, index) => {
            const taken = usedKeys.has(`${field.nodeId}.${field.fieldName}`);
            return (
              <button
                key={field.key}
                type="button"
                className={`cv-fpk-item${index === active ? ' on' : ''}${taken ? ' taken' : ''}`}
                title={taken ? '这一条已经在参数块里了' : undefined}
                onMouseEnter={() => setActive(index)}
                onClick={() => onPick(field)}
              >
                <span className="cv-fpk-main">
                  <span className="cv-fpk-label">{field.label}</span>
                  <span className="cv-fpk-sub">{field.classType} · 节点 {field.nodeId} · {field.fieldName}</span>
                </span>
                <span className="cv-fpk-tags">
                  {field.enabled && <em className="cv-fpk-tag live">配置中已启用</em>}
                  {taken && <em className="cv-fpk-tag">已添加</em>}
                  <em className="cv-fpk-tag kind">{PARAM_KIND_HINTS[field.kind]}</em>
                </span>
              </button>
            );
          })}
        </div>

        <div className="cv-fpk-foot">
          <span>
            {loading ? ' ' : `${visible.length} / ${fields.length} 个字段${SOURCE_NOTE[source]}${
              initialQuery ? ` · 已按「${initialQuery}」预筛，清空搜索框看全部` : ''}`}
          </span>
          <span className="cv-fpk-keys">↑↓ 选择 · Enter 加入 · Esc 关闭</span>
        </div>
      </div>
    </div>
  ), host);
}
