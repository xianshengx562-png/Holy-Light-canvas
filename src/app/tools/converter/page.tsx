'use client';

/** 路由入口；转换的全部状态在 `ConverterTool` 里，理由见 `tools/splitter/page.tsx`。 */
import ConverterTool from '@/components/tools/ConverterTool';

export default function ConverterPage() {
  return <ConverterTool />;
}
