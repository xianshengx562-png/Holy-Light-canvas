'use client';

/*
 * 格式转换。
 *
 * YUH Studio 里这东西是「转格式 + 压体积」两件事合一的入口 —— 它的后端是 ffmpeg。
 * 这里不需要：浏览器 Canvas 原生就能编 PNG / JPEG / WebP，省掉一条跨进程的管子，
 * 也就省掉了「主进程里再塞一份编解码器」这件事。
 *
 * ⚠️ 原图**一个字节都不动**：产出的是新的 Blob，保存时写进资产库，落到磁盘的是另一份文件。
 * 用户在这里转 20 张图，磁盘上应该是 40 个文件（原图 + 成品），不是 20 个被覆盖掉的。
 */
import { useState } from 'react';
import { FileStack, Loader2, RefreshCw } from 'lucide-react';
import ToolShell from '@/components/tools/ToolShell';
import ToolResult, { type ToolOutput } from '@/components/tools/ToolResult';
import OutputOptions from '@/components/tools/OutputOptions';
import { convertImage, formatBytes, type ConvertResult, type ImageFormat } from '@/lib/image-tools';

/** 一次批量上限：后端一次最多存 60 张，这里就按 60 卡。 */
const MAX_FILES = 60;

type Picked = { key: string; file: File };

export default function ConverterTool() {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [format, setFormat] = useState<ImageFormat>('webp');
  const [quality, setQuality] = useState(0.85);
  const [scale, setScale] = useState(100);
  const [outputs, setOutputs] = useState<ToolOutput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* 列表里的 File 只是引用，不吃内存；合并两次 FileList 时 key 带上序号，同名文件不会互相顶掉。 */
  const add = (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    const rest = Math.max(0, MAX_FILES - picked.length);
    setPicked((prev) => [
      ...prev,
      ...list.slice(0, rest).map((file, index) => ({ key: `${prev.length}-${index}-${file.name}`, file })),
    ]);
    setError(list.length > rest ? `最多 ${MAX_FILES} 张，多出来的没加进来。` : null);
  };

  async function run() {
    if (!picked.length) return;
    setBusy(true);
    setError(null);
    const results: ToolOutput[] = [];
    try {
      /* 一张一张串行处理：浏览器的 canvas 是有限的 GPU/内存资源，
         几十张 4K 图并发解码会把标签页直接压死，而串行只是慢一点。 */
      for (const item of picked) {
        const result: ConvertResult = await convertImage({ file: item.file, format, quality, scale });
        const saved = result.before ? Math.round((1 - result.blob.size / result.before) * 100) : 0;
        results.push({
          key: `${item.key}->${result.name}`,
          name: result.name,
          blob: result.blob,
          note: `${result.width}×${result.height} · ${formatBytes(result.before)} → ${formatBytes(result.blob.size)}${
            saved > 0 ? ` · 省 ${saved}%` : saved < 0 ? ` · 大 ${-saved}%` : ''
          }`,
        });
      }
      setOutputs(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : '转换失败。');
      setOutputs([]);
    } finally {
      setBusy(false);
    }
  }

  const totalIn = picked.reduce((sum, item) => sum + item.file.size, 0);

  return (
    <ToolShell active="converter" eyebrow="FORMAT CONVERTER" title="格式转换" intro="PNG / JPEG / WebP 互转，顺手压一压体积">
      <section className="tool-panel">
        <div className="tool-pane">
          <label className="tool-drop">
            <input type="file" accept="image/*" multiple data-tool-input="convert-files" onChange={(event) => add(event.target.files)} />
            <span className="tool-drop-icon"><FileStack size={22} strokeWidth={1.4} aria-hidden /></span>
            <strong>{picked.length ? `已选 ${picked.length} 张图` : '选一批要转的图'}</strong>
            <small className="muted">可以多选 · 最多 {MAX_FILES} 张 · 原图不会被改动</small>
          </label>

          {picked.length > 0 && (
            <ul className="tool-filelist">
              {picked.map((item) => (
                <li key={item.key}>
                  <span>{item.file.name}</span>
                  <small className="muted">{formatBytes(item.file.size)}</small>
                  <button
                    className="text-link"
                    type="button"
                    onClick={() => setPicked((prev) => prev.filter((row) => row.key !== item.key))}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
          {totalIn > 0 && <p className="tool-meta">合计 {formatBytes(totalIn)}</p>}
        </div>

        <div className="tool-pane">
          <OutputOptions format={format} onFormat={setFormat} quality={quality} onQuality={setQuality} />
          <label className="field">
            <span>{scale === 100 ? '尺寸：原大小' : `尺寸：缩到 ${scale}%`}</span>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={scale}
              data-tool-input="scale"
              onChange={(event) => setScale(Number(event.target.value))}
            />
          </label>
          {format === 'png' && (
            <p className="tool-hint">PNG 是无损的：想压体积选 JPEG 或 WebP，这里只是换个容器。</p>
          )}
          {error && <p className="error">{error}</p>}
          <button className="button" type="button" disabled={!picked.length || busy} onClick={run} data-tool-run="convert">
            {busy ? <Loader2 className="asset-spin" size={14} aria-hidden /> : <RefreshCw size={14} aria-hidden />}
            {busy ? '正在转…' : `转换 ${picked.length} 张`}
          </button>
        </div>
      </section>

      <ToolResult outputs={outputs} emptyHint="还没有产出：左边选图、右边挑好目标格式，点「转换」。" onReset={() => setOutputs([])} />
    </ToolShell>
  );
}
