'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AssetCategoryItem } from '@/lib/asset-kinds';
import AssetCategoryDialog from './AssetCategoryDialog';

/*
 * 不从 `@/lib/assets` 引类型：那个模块顶部有 `import 'server-only'`，
 * `import type` 虽然会被擦除，但保险起见客户端组件一律自带这份字面量联合。
 */
export type Kind = 'video' | 'image' | 'audio' | 'latent';

type Props = {
  type: Kind | 'all';
  /** 分类筛选值：分类名 / `'none'`（没打分类）/ `'all'`（不筛）。 */
  category: string;
  projectId: string;
  kinds: { value: Kind | 'all'; label: string }[];
  categories: AssetCategoryItem[];
  projects: { id: string; name: string; count: number }[];
  /** 分类表被改过之后叫一次（页面重取 `/api/assets`，那份返回里带着新的分类列表）。 */
  onCategoriesChanged: () => void;
};

/**
 * 类型、分类与项目的筛选。
 *
 * 用 `router.push` 而不是 `<Link>`：项目数量不定，做成下拉更省地方，
 * 而 `<select>` 要么配一个提交按钮（多点一下），要么就得走 JS。这里选择走 JS。
 * 只用了 `useRouter`，没用 `useSearchParams`——后者会要求外层包 `<Suspense>`。
 *
 * **分类那一排恒显示**（2026-09-26）：以前只在「图片」这一档下才出现，因为那时分类
 * 是写死的「角色 / 场景 / 道具」三个词、只对图片有意义。现在分类由用户自己维护、
 * 任何类型的资产都能打，再藏起来就会让人以为「视频不能分类」。
 *
 * 换一级类型时**不再把分类清回「全部」** —— 两者已经互不影响，
 * 清掉反而等于把用户选好的条件偷偷改了。
 */
export default function AssetFilters({
  type, category, projectId, kinds, categories, projects, onCategoriesChanged,
}: Props) {
  const router = useRouter();
  const [managing, setManaging] = useState(false);
  const go = (patch: { type?: Kind | 'all'; category?: string; projectId?: string }) => {
    const next = { type, category, projectId, ...patch };
    const params = new URLSearchParams();
    if (next.type && next.type !== 'all') params.set('type', next.type);
    if (next.category && next.category !== 'all') params.set('sub', next.category);
    if (next.projectId) params.set('project', next.projectId);
    const query = params.toString();
    router.push(query ? `/assets?${query}` : '/assets');
  };

  return (
    <div className="assets-filters">
      <div className="assets-filter-rows">
        <div className="assets-chips" role="group" aria-label="按类型筛选">
          {kinds.map(kind => (
            <button
              key={kind.value}
              type="button"
              className={`assets-chip${kind.value === type ? ' active' : ''}`}
              aria-pressed={kind.value === type}
              onClick={() => go({ type: kind.value })}
            >
              {kind.label}
            </button>
          ))}
        </div>
        <div className="assets-sub-chips" role="group" aria-label="按分类筛选" data-assets-cat-row>
          <button
            type="button"
            className={`assets-chip${category === 'all' ? ' active' : ''}`}
            aria-pressed={category === 'all'}
            data-assets-cat="all"
            onClick={() => go({ category: 'all' })}
          >
            全部
          </button>
          {categories.map(cat => (
            <button
              key={cat.id}
              type="button"
              className={`assets-chip${cat.name === category ? ' active' : ''}`}
              aria-pressed={cat.name === category}
              data-assets-cat={cat.name}
              onClick={() => go({ category: cat.name })}
            >
              {cat.name}
            </button>
          ))}
          <button
            type="button"
            className={`assets-chip${category === 'none' ? ' active' : ''}`}
            aria-pressed={category === 'none'}
            data-assets-cat="none"
            onClick={() => go({ category: 'none' })}
          >
            未分类
          </button>
          <button
            type="button"
            className="assets-chip assets-chip-manage"
            data-assets-cat-manage
            onClick={() => setManaging(true)}
          >
            管理
          </button>
        </div>
      </div>
      {projects.length > 0 && (
        <label className="assets-picker">
          <span>项目</span>
          <select
            className="assets-select"
            value={projectId}
            onChange={event => go({ projectId: event.target.value })}
          >
            <option value="">全部项目</option>
            {projects.map(project => (
              <option key={project.id} value={project.id}>{project.name} · {project.count}</option>
            ))}
          </select>
        </label>
      )}
      {managing && (
        <AssetCategoryDialog
          categories={categories}
          onClose={() => setManaging(false)}
          onChanged={onCategoriesChanged}
        />
      )}
    </div>
  );
}
