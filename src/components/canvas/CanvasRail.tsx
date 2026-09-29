'use client';

import type { MouseEvent } from 'react';
import { Clock, Image as ImageIcon, Plus, Settings, Wand2, Workflow } from 'lucide-react';

/**
 * 画布左侧悬浮条。
 *
 * 形态（2026-09-21 照参考图定的）：
 *
 *   深色实心圆形加号  →  5 个只放图标的入口  →  细横线  →  底部品牌标记
 *
 * ⚠️ 四件事别搞混：
 *
 * 1. **这里不再列节点类型**。参考图左侧只有上面那五样；节点统一从**画布右键**添加
 *    （空白处右键 →「添加节点」→ 选类型；节点上右键 →「接上新节点」，会带着上游自动连）。
 *    那 11 个 `CREATE_KINDS` 入口在右键菜单里本来就有一份，所以这不是删功能，是换入口。
 *
 * 2. **五项全部弹「居中大浮层」**（2026-09-21 改）：资产 / 工作流 / skill / 历史 / 设置
 *    共用一个壳（`CanvasOverlay`）—— 一张居中偏上的大卡片，顶栏一个 ✕，✕ 只关浮层、留在画布。
 *    之前只有「资产」会弹（还是贴着轨道的 340px 窄浮层），其余四项只给一句「还没做」。
 *
 * 3. 五项**全是 `<button>`**，点的是同一个 `onOpen(key)`：外面记着现在开着哪一项，
 *    再点一次同一项就是关（`CanvasEditor` 里的 `overlay` state）。
 *    `data-rail` 给探针认项用，别靠数第几个。
 *
 * 4. 这是**画布页**的左轨（`.cv-rail`），不是全站那条 248px 的 `.sidebar`。
 *    项目里两条都叫「侧边栏」，2026-09-21 上午就改错过一次 —— 只说「左边的侧边栏」
 *    时先默认是这里。
 *
 * 名字不写在条上（56px 放不下）：走 `data-tip`（悬浮，纯 CSS 伪元素）和 `aria-label`（读屏）。
 * Tooltip 用 CSS 做而不是 JS 定位：轨道位置固定，提示永远往右，没必要算坐标。
 */
const RAIL_ITEMS: { key: string; label: string; icon: typeof ImageIcon }[] = [
  { key: 'assets', label: '资产', icon: ImageIcon },
  { key: 'workflow', label: '工作流', icon: Workflow },
  { key: 'skill', label: 'skill', icon: Wand2 },
  { key: 'history', label: '历史', icon: Clock },
  { key: 'settings', label: '设置', icon: Settings },
];

export default function CanvasRail({
  onAddMenu, onOpen, openKey, onFit,
}: {
  /** 点顶部的大加号：打开「选类型」菜单，锚在按钮右侧 */
  onAddMenu: (event: MouseEvent<HTMLElement>) => void;
  /** 点左轨五项里的任一项：弹出对应那张浮层。再点一次同一项 = 关。 */
  onOpen: (key: string) => void;
  /** 现在开着哪一项 —— 只用来给按钮一个「按下去了」的样子 */
  openKey: string | null;
  onFit: () => void;
}) {
  return (
    <div className="cv-rail" role="toolbar" aria-label="画布工具">
      <button
        className="cv-rail-btn primary"
        type="button"
        onClick={onAddMenu}
        aria-label="添加节点"
        data-tip="添加节点"
      >
        <Plus size={20} strokeWidth={2.4} aria-hidden />
      </button>

      <div className="cv-rail-sep" />

      {RAIL_ITEMS.map(item => {
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            className={`cv-rail-btn${openKey === item.key ? ' on' : ''}`}
            data-tip={item.label}
            data-rail={item.key}
            aria-label={item.label}
            aria-haspopup="dialog"
            aria-expanded={openKey === item.key}
            onClick={() => onOpen(item.key)}
          >
            <Icon size={18} strokeWidth={1.8} aria-hidden />
          </button>
        );
      })}

      {/* 参考图里分隔线在五项**之下**，后面只跟一个品牌标记。 */}
      <div className="cv-rail-sep" />

      <button
        className="cv-rail-mark"
        type="button"
        onClick={onFit}
        aria-label="适应画布"
        data-tip="适应画布 · F"
      >
        <span aria-hidden>✦</span>
      </button>
    </div>
  );
}
