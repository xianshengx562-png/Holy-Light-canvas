'use client';

import CanvasOverlay from './CanvasOverlay';
import SkillLibrary from './SkillLibrary';
import type { CodexSkill } from '@/lib/desktop-codex';

/**
 * 画布左轨「skill」弹出的大浮层 —— **SKILL 社区**（2026-09-25 把内容填上了）。
 *
 * 之前这里是空状态占位（「这一块还没做」），现在填的是从 AIFISHER 迁过来的技能库：
 * 自带的七个 + 自己导入的，**都在一份列表里**，选一个就能挂到 Codex 上让它照着写。
 *
 * 左列只留一个「skill」当栏目名（徐先 2026-09-25：不要「官方推荐」那栏了，
 * 那七个直接跟自己导入的放在一起）。一个分类也留着这根左列 —— 它是这张浮层的栏目名，
 * 去掉的话浮层就只剩一屏卡片，看不出自己站在哪儿。
 */
export default function CanvasSkillPanel({
  onClose,
  onUseInCodex,
}: {
  onClose: () => void;
  /**
   * 「在 Codex 中使用」：画布那边负责把 Codex 侧栏打开并挂上这个技能。
   * 这里不自己跳过去 —— 浮层不该知道 Codex 侧栏怎么开。
   */
  onUseInCodex?: (skill: CodexSkill) => void;
}) {
  return (
    <CanvasOverlay
      title="SKILL 社区"
      kicker="SKILLS"
      note="选一个技能挂到 Codex 上，它就照这套写法干活；也能挂到节点底栏的「优化提示词」上"
      nav={[{ key: 'skill', label: 'skill' }]}
      active="skill"
      onClose={onClose}
    >
      <SkillLibrary
        embedded
        onPick={skill => {
          onUseInCodex?.(skill);
          onClose();
        }}
      />
    </CanvasOverlay>
  );
}
