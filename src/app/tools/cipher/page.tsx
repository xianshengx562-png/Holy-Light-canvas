'use client';

/*
 * 路由入口。与其它工具页一样，这一层什么都不做 ——
 * 状态全在 `CipherTool` 里，以后「在资产库里选中几张图 → 直接加密」复用的是组件。
 */
import CipherTool from '@/components/tools/CipherTool';

export default function CipherPage() {
  return <CipherTool />;
}
