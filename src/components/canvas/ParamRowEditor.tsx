'use client';
import { useState } from 'react';
import { ListPlus, Plus, Trash2 } from 'lucide-react';
import type { ParamRow } from './types';
import { MAX_PARAM_ROWS } from './nodeMeta';
import WorkflowFieldPicker, { fieldValueHint, type WorkflowFieldCandidate } from './WorkflowFieldPicker';

/**
 * 自定义参数块的行编辑器。参数条和右侧属性面板共用这一份，
 * 所以两处的行为天然一致。
 *
 * 每一行都是「名字 + 节点 id + 字段名 + 值」四件套：名字只是给人看的，
 * 真正发出去的是节点 id + 字段名 + 值。
 *
 * **加行有两条路**，区别只是「要不要人自己知道节点号」：
 * - 「从工作流里挑」—— 弹出这份工作流扫出来的候选字段，选一项就自动填好四件套。
 *   节点号应该来自图本身，而不是让人回 ComfyUI 里对着数一遍。
 * - 「手填一行」—— 没连到生成节点（也就还不知道是哪份工作流）时的退路，
 *   以及「这个字段图上没有、我就是想临时加一个」这种场合。
 */
export default function ParamRowEditor({
  rows,
  onChange,
  workflowId,
  workflowNote,
  onNotice,
}: {
  rows: ParamRow[];
  onChange: (rows: ParamRow[]) => void;
  /**
   * 这份参数块最终写进哪份工作流 —— 由画布沿连线往**下游**找它喂到的那个生成节点算出。
   * 空 = 还没接到选好了工作流的生成节点，此时只能手填。
   */
  workflowId?: string;
  /** 「跟随哪个节点」的说明，显示在按钮旁边 / 弹层标题里。 */
  workflowNote?: string;
  onNotice?: (message: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const full = rows.length >= MAX_PARAM_ROWS;
  const canPick = Boolean(workflowId) && !full;
  const used = rows.map(row => `${row.nodeId}.${row.fieldName}`);

  const update = (id: string, part: Partial<ParamRow>) => onChange(rows.map(row => (row.id === id ? { ...row, ...part } : row)));

  const addBlank = () => onChange([...rows, { id: crypto.randomUUID(), name: '', nodeId: '', fieldName: 'value', value: '', enabled: true }]);

  const addFromField = (field: WorkflowFieldCandidate) => {
    setPicking(false);
    if (full) return;
    onChange([...rows, {
      id: crypto.randomUUID(),
      /** 名字先用候选里的显示名（多半是「VAE Decode · vae_name」这类看得懂的东西），
       *  比留空再让人输一遍强。真正发出去的是下面两个格子，名字随时能改。 */
      name: field.label,
      nodeId: field.nodeId,
      fieldName: field.fieldName,
      kind: field.kind,
      value: '',
      enabled: true,
    }]);
    onNotice?.(`已加入 ${field.nodeId}.${field.fieldName} · ${field.label} —— 记得填值，空值的行不会提交`);
  };

  return (
    <div className="cv-prows">
      {rows.length === 0 && (
        <p className="cv-note">
          {workflowId
            ? '还没有参数。点「从工作流里挑」选一个字段，或者「手填一行」自己填节点号与字段名。'
            : '还没有参数。先把它连到一个已经选好工作流的生成节点上，就能「从工作流里挑」；没连也可以「手填一行」。'}
        </p>
      )}
      {rows.map(row => (
        <div key={row.id} className={`cv-prow ${row.enabled ? '' : 'off'}`}>
          <div className="cv-prow-head">
            <input
              className="cv-prow-on"
              type="checkbox"
              checked={row.enabled}
              title="关掉就不参与这一次生成"
              aria-label="启用这一行"
              onChange={event => update(row.id, { enabled: event.target.checked })}
            />
            <input
              className="cv-input sm"
              value={row.name}
              placeholder="给它起个名字，例如「种子」"
              onChange={event => update(row.id, { name: event.target.value })}
            />
            <button className="cv-prow-del" type="button" title="删除这一行" aria-label="删除这一行" onClick={() => onChange(rows.filter(item => item.id !== row.id))}>
              <Trash2 size={13} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
          <div className="cv-prow-grid">
            <label className="cv-prow-cell">
              <span>节点 ID</span>
              <input className="cv-input sm" value={row.nodeId} placeholder="70" onChange={event => update(row.id, { nodeId: event.target.value })} />
            </label>
            <label className="cv-prow-cell">
              <span>字段名</span>
              <input className="cv-input sm" value={row.fieldName} placeholder="value" onChange={event => update(row.id, { fieldName: event.target.value })} />
            </label>
            <label className="cv-prow-cell wide">
              <span>值</span>
              <input
                className="cv-input sm"
                value={row.value}
                placeholder={row.kind ? fieldValueHint(row.kind) : '要传给这个字段的内容'}
                onChange={event => update(row.id, { value: event.target.value })}
              />
              {row.kind && <em className="cv-prow-kind">{fieldValueHint(row.kind)}</em>}
            </label>
          </div>
        </div>
      ))}

      <div className="cv-prows-add">
        <button
          className="cv-btn sm"
          type="button"
          disabled={!canPick}
          title={workflowId ? '打开这份工作流的字段列表挑一个' : '先把它连到一个已经选好工作流的生成节点上'}
          onClick={() => setPicking(true)}
        >
          <ListPlus size={13} strokeWidth={1.8} aria-hidden /> 从工作流里挑
        </button>
        <button className="cv-btn sm ghost" type="button" disabled={full} onClick={addBlank}>
          <Plus size={13} strokeWidth={1.8} aria-hidden /> 手填一行
        </button>
        {workflowNote && <span className="cv-note">{workflowNote}</span>}
      </div>

      {rows.length > 0 && (
        <span className="cv-note">
          这些行叠加在「设置 · 工作流库」那份配置之上：配置里没有的节点字段会被补上，已有的会被这里的值覆盖。
          空值不会提交。{full ? ` 已达上限 ${MAX_PARAM_ROWS} 行。` : ''}
        </span>
      )}

      {picking && workflowId && (
        <WorkflowFieldPicker
          workflowId={workflowId}
          workflowTitle={workflowNote}
          used={used}
          onPick={addFromField}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
