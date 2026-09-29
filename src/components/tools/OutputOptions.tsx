'use client';

/*
 * 「输出格式 + 质量」这一组控件。
 *
 * 三个实用工具都要它，抽出来的理由和 `ToolResult` 一样：写两遍的结果是两边
 * 迟早不一样 —— 一边记得 PNG 不该出质量滑块，另一边忘了。
 */
import { IMAGE_FORMATS, type ImageFormat } from '@/lib/image-tools';

export default function OutputOptions({
  format,
  onFormat,
  quality,
  onQuality,
}: {
  format: ImageFormat;
  onFormat: (value: ImageFormat) => void;
  quality: number;
  onQuality: (value: number) => void;
}) {
  const current = IMAGE_FORMATS.find((item) => item.value === format);
  return (
    <>
      <div className="field">
        <span>输出格式</span>
        <div className="assets-chips">
          {IMAGE_FORMATS.map((item) => (
            <button
              key={item.value}
              className={`assets-chip${format === item.value ? ' active' : ''}`}
              type="button"
              data-tool-format={item.value}
              onClick={() => onFormat(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {/* PNG 是无损的，给它一条质量滑块除了让人以为「这里能压」之外没有任何作用。 */}
      {current?.lossy && (
        <label className="field">
          <span>质量 {Math.round(quality * 100)}%</span>
          <input
            type="range"
            min={0.4}
            max={1}
            step={0.02}
            value={quality}
            data-tool-input="quality"
            onChange={(event) => onQuality(Number(event.target.value))}
          />
        </label>
      )}
      {format === 'jpeg' && <p className="tool-hint">JPEG 不存透明：原图里的透明区域会被填成白色。</p>}
    </>
  );
}
