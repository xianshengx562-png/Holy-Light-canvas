'use client';
import { LATENT_SLOTS, latentSlotHint } from './nodeMeta';

/**
 * latent 的参数位编号（1 = 粗采样，2 = 精采样）。
 *
 * 括号里那个**节点号**是可以在节点上改的（`nodeIds`）：210 / 278 只是 RunningHub 那份
 * 默认工作流的编号，换一份工作流就对不上了 —— 而界面上继续显示 210 等于骗人。
 *
 * 参数条和右侧属性面板共用这一份，两处行为天然一致。
 * 可以多选：一条 latent 同时写进两个槽在某些工作流里是有意的（粗 + 精喂同一份）。
 * 一个都不选 = 交给「按连上的顺序自动填空位」的老行为，所以这里永远要留一条说明。
 */
export default function LatentSlotPicker({
  indexes,
  onChange,
  disabled,
  nodeIds,
}: {
  indexes: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
  /** 节点上填的粗 / 精采样节点号；没填时提示回落到 210 / 278。 */
  nodeIds?: { coarse?: string; fine?: string };
}) {
  const picked = new Set(indexes);
  const toggle = (slot: number) => {
    const next = new Set(picked);
    if (next.has(slot)) next.delete(slot); else next.add(slot);
    // 存成升序，界面上和提交时的顺序才稳定
    onChange([...next].sort((a, b) => a - b));
  };

  return (
    <div className={`cv-slot-pick ${disabled ? 'off' : ''}`}>
      <span>写入槽位</span>
      <div className="cv-slot-pick-row">
        {Array.from({ length: LATENT_SLOTS }, (_, i) => i + 1).map(slot => (
          <button
            key={slot}
            type="button"
            className={`cv-slot-chip ${picked.has(slot) ? 'on' : ''}`}
            disabled={disabled}
            aria-pressed={picked.has(slot)}
            title={latentSlotHint(slot, slot === 1 ? nodeIds?.coarse : nodeIds?.fine)}
            onClick={() => toggle(slot)}
          >
            #{slot}
            <em>{latentSlotHint(slot, slot === 1 ? nodeIds?.coarse : nodeIds?.fine)}</em>
          </button>
        ))}
      </div>
      <span className="cv-param-hint">
        {picked.size ? `写入 latent_${[...picked].join(' / latent_')}` : '不选则按连上的顺序自动填空位'}
      </span>
    </div>
  );
}
