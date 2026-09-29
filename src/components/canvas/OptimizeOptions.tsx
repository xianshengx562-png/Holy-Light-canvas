'use client';
/*
 * 「优化提示词」节点那四项参数（2026-09-29 徐先：「优化提示词节点可以调整参数」）。
 *
 * 单独成一个组件，跟 `LatentSlotPicker` 同一个路子：这四项**要去服务端问清单**
 * （有哪些文本模型、哪些技能标了「用于提示词优化」），而参数条是给所有节点用的 ——
 * 塞进 `NodeParamBar` 顶部的话，选中**任何一个**节点都会发这两个请求。
 *
 * 四项：
 *   1. 文本模型 —— 节点级覆盖「设置 · 模型服务」里那家（字段早就有了，只是没露出）；
 *   2. 写法规范 —— 照哪个技能写（同上）；
 *   3. 改写幅度 —— 轻度润色 / 标准补全 / 重度扩写；
 *   4. 补充要求 —— 一句自由文本。
 *
 * 🔴 默认值一律是「不动」：四项都留空时，送出去的请求跟加这个功能之前**一模一样**，
 * 老画布的优化结果一个字都不会变。见 `lib/optimizeOptions.ts` 里那条注释。
 */
import { useApi } from '@/lib/client';
import { OPTIMIZE_STRENGTHS, normalizeOptimizeNote, resolveStrength } from '@/lib/optimizeOptions';
import type { NodeData } from './types';

/** `/api/skills` 里只用到这三列 —— 别把整个 `SkillItem` 搬进来。 */
type SkillOption = { id: string; title: string; optimize: boolean };

export default function OptimizeOptions({ data }: { data: NodeData }) {
  const textModels = useApi<{
    items: { value: string; label: string; configured: boolean }[];
    resolvedLabel: string | null;
  }>('/api/prompt/models');
  const skillList = useApi<{ skills: SkillOption[] }>('/api/skills');

  const items = textModels.data?.items || [];
  const resolvedLabel = String(textModels.data?.resolvedLabel || '').trim();
  const model = String(data.promptModel || '');
  /** 存的那个值已经不在选项里了（那条自定义接口被删了）—— 照常列出来，别让下拉悄悄跳回「自动」。 */
  const missingModel = model && !items.some(item => item.value === model) ? model : '';

  const skills = (skillList.data?.skills ?? []).filter(item => item.optimize);
  const skill = String(data.promptSkill || '');
  const missingSkill = skill && !skills.some(item => item.id === skill) ? skill : '';

  const strength = resolveStrength(data.promptStrength);
  const strengthHint = OPTIMIZE_STRENGTHS.find(item => item.value === strength)?.hint || '';
  const note = normalizeOptimizeNote(data.promptNote);

  return (
    <div className="cv-param-opts" data-opt-box="">
      <label className="cv-field">
        <span>文本模型</span>
        <select
          className="cv-select"
          data-opt-model=""
          aria-label="用哪个文本模型改写"
          title="只影响这一个节点；留空则跟随「设置 · 模型服务」里指定的那家"
          value={model}
          onChange={event => data.onField?.('promptModel', event.target.value)}
        >
          <option value="">{`自动（跟随设置 · ${resolvedLabel || '还没配置'}）`}</option>
          {missingModel ? <option value={missingModel}>{`${missingModel} · 这一项已经不存在了`}</option> : null}
          {items.map(item => (
            <option key={item.value} value={item.value}>
              {item.configured ? item.label : `${item.label} · 未配置`}
            </option>
          ))}
        </select>
      </label>

      <label className="cv-field">
        <span>改写幅度</span>
        <select
          className="cv-select"
          data-opt-strength=""
          aria-label="改写幅度"
          title={strengthHint}
          value={strength}
          onChange={event => data.onField?.('promptStrength', event.target.value)}
        >
          {OPTIMIZE_STRENGTHS.map(item => (
            <option key={item.value} value={item.value} title={item.hint}>{item.label}</option>
          ))}
        </select>
      </label>

      <label className="cv-field wide">
        <span>写法规范（照哪个技能写）</span>
        <select
          className="cv-select"
          data-opt-skill=""
          aria-label="照哪个技能的写法改写"
          title="选了之后，改写结果会按那个技能要求的格式来写"
          value={skill}
          onChange={event => data.onField?.('promptSkill', event.target.value)}
        >
          <option value="">— 通用写法（不指定）—</option>
          {missingSkill ? <option value={missingSkill}>{`${missingSkill} · 这个技能已经不在了`}</option> : null}
          {skills.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>

      <label className="cv-field wide">
        <span>补充要求（可留空）</span>
        {/*
          🔴 多行框（2026-09-29 不限字数之后）：单行里写几百字只能横着滚、看不全。
          没有 `maxLength` —— 字数是用户自己的事，截了他也看不出来（那句会静默变短）。
        */}
        <textarea
          className="cv-input sm"
          rows={2}
          data-opt-note=""
          aria-label="补充要求"
          placeholder="例如：保持中文 · 不要写镜头语言 · 控制在 60 字内"
          title="这句会作为附加要求一起交给模型；它跟改写幅度冲突时以这句为准；不限字数"
          value={note}
          onChange={event => data.onField?.('promptNote', event.target.value)}
        />
      </label>

      <span className="cv-param-hint" data-opt-hint="">{strengthHint}</span>
    </div>
  );
}
