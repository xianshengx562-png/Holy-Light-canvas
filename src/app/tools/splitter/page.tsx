'use client';

/*
 * 路由入口。工具的全部状态都在 `SplitterTool` 里，这一层刻意什么都不做 ——
 * 页面可以被别的入口复用（以后「从资产右键 → 分割」也是挂同一个组件），
 * 而一旦这里塞了状态，两条路就要各自维护一份。
 */
import SplitterTool from '@/components/tools/SplitterTool';

export default function SplitterPage() {
  return <SplitterTool />;
}
