'use client';

/*
 * 工具产出的「后半段」：预览、勾选、存进资产库 / 下载到本地。
 *
 * 两个工具各自负责「算出什么」，这里统一负责「算完之后怎么办」——
 * 保存逻辑写两遍的代价不是重复，而是两边迟早长得不一样（一个另限大小、一个忘了显跳过数）。
 *
 * ⚠️ 预览要靠 ObjectURL，**必须在 outputs 变化时回收**：这里一次产出几十张 4K 分割图，
 * 每创建一次地址浏览器就多握一份完整字节，不 revoke 就是最典型的内存泄漏 ——
 * 而且它的表现很隐蔽：切几格没事，切 6×6 之后界面开始发粘。
 *
 * 产出的东西不一定是图：运镜效果出来的是一段视频。所以缩略图按 `blob.type` 分流 ——
 * 视频用 `<video>` 并带上 controls（不给控件的话，一段镜头根本没法回看）。
 *
 * ⚠️ 入库开关叫 `allowArchive` 而不是 `archive`：下面已经有一个 `async function archive()`，
 *    两者同名时**函数声明会盖掉带默认值的解构参数**（非简单参数列表会分出独立的参数作用域），
 *    于是 `archive && …` 永远为真 —— 关不掉入库。改名是最省事的解法。
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Download, Loader2, Save } from 'lucide-react';
import { apiPost, useApi } from '@/lib/client';
import { buildArchiveForm, downloadBlob, formatBytes } from '@/lib/image-tools';

export type ToolOutput = {
  /** 同一批里唯一的键：切图按 r1c1 命名，天然不撞。 */
  key: string;
  name: string;
  blob: Blob;
  note: string;
};

type ProjectCard = { id: string; name: string };

export default function ToolResult({
  outputs,
  emptyHint,
  onReset,
  allowArchive = true,
  archiveHint,
}: {
  outputs: ToolOutput[];
  emptyHint: string;
  onReset: () => void;
  /**
   * 关掉「存进资产库」，只留下载。
   *
   * 图片加密那一档用得上：打乱后的图就是一堆噪点，进资产库只会把列表搅乱。
   * 默认 true —— 其余工具的产出本来就是要入库的。
   */
  allowArchive?: boolean;
  /** 不给入库时，把原因说清楚，否则用户只看到按钮少了一个。 */
  archiveHint?: string;
}) {
  const { data: projects } = useApi<ProjectCard[]>('/api/projects');
  const [projectId, setProjectId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<'save' | 'download' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  /* 产出换了就是新一轮：默认全选，提示清零。 */
  useEffect(() => {
    setSelected(outputs.map((item) => item.key));
    setMessage(null);
  }, [outputs]);

  /* 项目列表到了才选得出`projectId`，所以这里补一个默认：否则用户一进来就得先点一下下拉。 */
  useEffect(() => {
    if (!projectId && projects?.length) setProjectId(projects[0].id);
  }, [projects, projectId]);

  /* 每个产出一个预览地址。**必须存进 state**：写在 JSX 里的话每次渲染都新建一份，
     既泄漏旧地址、也让 <img> 每次重绘时被换 src 闪一下。 */
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    const urls = outputs.map((item) => URL.createObjectURL(item.blob));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [outputs]);

  const picked = useMemo(() => outputs.filter((item) => selected.includes(item.key)), [outputs, selected]);
  const totalSize = picked.reduce((sum, item) => sum + item.blob.size, 0);
  /* 量词跟着产出走：一段视频说「1 张」很怪，但一叠切图说「12 个」也不对。 */
  const unit = outputs.every((item) => item.blob.type.startsWith('image/')) ? '张' : '个';

  if (!outputs.length) {
    return <div className="notice">{emptyHint}</div>;
  }

  const toggle = (key: string) =>
    setSelected((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
  const selectAll = (all: boolean) => setSelected(all ? outputs.map((item) => item.key) : []);

  async function archive() {
    if (!projectId || !picked.length) return;
    setBusy('save');
    setMessage(null);
    try {
      const result = await apiPost<{ items: unknown[]; skipped: number }>(
        '/api/tools/archive',
        buildArchiveForm(picked.map((item) => ({ ...item })), projectId),
      );
      setMessage({
        ok: true,
        text: `已存进项目 ${result.items.length} ${unit}${result.skipped ? `，${result.skipped} ${unit}没存下（格式不支持或体积超限）` : ''}。`,
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : '保存失败。' });
    } finally {
      setBusy(null);
    }
  }

  function download() {
    setBusy('download');
    picked.forEach((item) => downloadBlob(item.blob, item.name));
    setMessage({ ok: true, text: `已导出 ${picked.length} ${unit}到浏览器的下载目录。` });
    setBusy(null);
  }

  return (
    <section className="tool-result">
      <div className="tool-result-bar">
        <div className="tool-result-count">
          <strong>{outputs.length}</strong> {unit} · 已选 {picked.length} {unit} · {formatBytes(totalSize)}
        </div>
        <div className="tool-result-actions">
          <button className="assets-chip" type="button" onClick={() => selectAll(true)}>
            全选
          </button>
          <button className="assets-chip" type="button" onClick={() => selectAll(false)}>
            全不选
          </button>
          <button className="button subtle" type="button" onClick={onReset}>
            清空重来
          </button>
        </div>
      </div>

      <div className="tool-grid">
        {outputs.map((item, index) => {
          const on = selected.includes(item.key);
          return (
            <button
              key={item.key}
              type="button"
              className={`tool-card${on ? ' active' : ''}`}
              onClick={() => toggle(item.key)}
              aria-pressed={on}
            >
              <span className="tool-card-thumb">
                {item.blob.type.startsWith('video/') ? (
                  <video src={previews[index]} data-tool-thumb={index} controls muted playsInline preload="auto" />
                ) : (
                  <img src={previews[index]} alt={item.name} data-tool-thumb={index} />
                )}
                {on && (
                  <span className="tool-card-check">
                    <Check size={14} strokeWidth={2.4} aria-hidden />
                  </span>
                )}
              </span>
              <span className="tool-card-body">
                <strong>{item.name}</strong>
                <small className="muted">{item.note}</small>
              </span>
            </button>
          );
        })}
      </div>

      <div className="tool-save">
        {allowArchive ? (
          <label className="field tool-save-project">
            <span>存到哪个项目</span>
            <select
              className="assets-select"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              disabled={!projects?.length}
            >
              {!projects?.length && <option value="">还没有项目</option>}
              {projects?.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          archiveHint && <p className="tool-hint tool-save-project">{archiveHint}</p>
        )}
        <div className="tool-save-buttons">
          {allowArchive && !projects?.length && (
            <Link className="button small" href="/projects/new">
              先去建一个
            </Link>
          )}
          <button className="button secondary" type="button" onClick={download} disabled={busy !== null || !picked.length}>
            {busy === 'download' ? <Loader2 className="asset-spin" size={14} aria-hidden /> : <Download size={14} aria-hidden />}
            下载所选
          </button>
          {allowArchive && (
            <button className="button" type="button" onClick={archive} data-tool-save="1" disabled={busy !== null || !picked.length || !projectId}>
              {busy === 'save' ? <Loader2 className="asset-spin" size={14} aria-hidden /> : <Save size={14} aria-hidden />}
              存进资产库
            </button>
          )}
        </div>
      </div>

      {message && (
        <p className={`notice ${message.ok ? 'ok' : 'error'}`} role="status" data-tool-save-result={message.ok ? 'ok' : 'fail'}>
          {message.text}
          {message.ok && allowArchive && projectId && (
            <>
              {' '}
              <Link href={`/assets?project=${projectId}`}>去看看</Link>
            </>
          )}
        </p>
      )}
    </section>
  );
}
