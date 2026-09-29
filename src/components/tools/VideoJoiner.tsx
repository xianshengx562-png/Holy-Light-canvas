'use client';

/*
 * 视频拼接。
 *
 * 原型是徐先自己的 Tkinter 小工具（`D:\ai\www\video_cutter_joiner.py`）——
 * 界面照着它那张三栏的样子来：**左素材 / 中预览 / 右参数**，底下一条导出栏。
 * 算法（逐段归一再 concat）原样搬到了 `lib/video-ffmpeg.ts`，这里只管界面。
 *
 * 三处与原型不同，都是因为进了 Holy Light画布：
 *  1. **素材从资产库来**：左侧那块「选择素材」是原型没有的（原型只有「添加视频」按钮）。
 *     资产与上传的落点是同一个 —— 都会变成资产，所以列表里两种来源混着排；
 *  2. **图片也能当素材**，而且要能填「这张图占几帧」（`imageFrames`）——
 *     漫剧里「一张定妆照停 5 帧」就是这么来的；
 *  3. 切片范围用**帧号**而不是秒：与 ffmpeg 的 `trim=start_frame` 同一套编号，
 *     界面上看到第几帧，切出来的就是第几帧。
 *
 * ⚠️ 进度只能轮询：后端进程把响应整块 buffer 完才写（SSE 流不出去），
 * 所以 POST 只起任务、拿 id，之后每 400ms 查一次。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  Plus,
  Scissors,
  Settings2,
  Trash2,
  Upload,
} from 'lucide-react';
import ToolShell from '@/components/tools/ToolShell';
import { apiGet, apiPost, useApi } from '@/lib/client';
import { canPickFile, openFolderPath, pickFilePath } from '@/lib/desktop-fs';
import { isDesktop } from '@/lib/edition';

type AssetLite = {
  id: string;
  name: string;
  type: string;
  url: string;
  sizeLabel: string;
  createdLabel: string;
  projectId: string;
  projectName: string;
};
type AssetsPayload = { items: AssetLite[]; projects: { id: string; name: string; count: number }[] };
type ProjectLite = { id: string; name: string };

type FfmpegStatus = {
  ffmpeg: string;
  ffprobe: string;
  source: 'custom' | 'detected' | 'none';
  ok: boolean;
  message: string;
  version: string;
};

/** 列表里的一段素材。图片与视频共用一套字段，图片那几项填 0 / 1。 */
type Clip = {
  key: string;
  assetId: string;
  name: string;
  kind: 'video' | 'image';
  url: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration: number;
  hasAudio: boolean;
  /** 起始帧（含）。 */
  start: number;
  /** 结束帧（含）。 */
  end: number;
  /** 图片专用：这张图在成品里占几帧。 */
  imageFrames: number;
};

type ProbeItem = Partial<Clip> & { assetId: string; error?: string };

type JobView = {
  id: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  pct: number;
  message: string;
  output: string | null;
  outputDir: string | null;
  error: string | null;
};

/** 与后端 `lib/video-ffmpeg.ts` 的默认值保持一致：改一处就得改两处。 */
const DEFAULT_IMAGE_FRAMES = 5;
const POLL_MS = 400;

let seq = 0;
const nextKey = () => `clip-${Date.now()}-${(seq += 1)}`;

export default function VideoJoiner() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [frame, setFrame] = useState(0);

  const [tab, setTab] = useState<'library' | 'upload'>('library');
  const [libraryProject, setLibraryProject] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [uploadProject, setUploadProject] = useState('');
  const [adding, setAdding] = useState(false);

  const [outputName, setOutputName] = useState(`joined-${new Date().toISOString().slice(0, 10)}`);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobView, setJobView] = useState<JobView | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveProject, setSaveProject] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  /** 帧范围那两个框。用字符串装：输入框允许中途是空串，用数字装会把「」变成 0。 */
  const [rangeStart, setRangeStart] = useState('0');
  const [rangeEnd, setRangeEnd] = useState('0');
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showEngine, setShowEngine] = useState(false);

  const { data: engineData, reload: reloadEngine } = useApi<FfmpegStatus>('/api/tools/video/ffmpeg');
  const { data: assetData, reload: reloadAssets } = useApi<AssetsPayload>('/api/assets');
  const { data: projects } = useApi<ProjectLite[]>('/api/projects');

  /* 上传落哪个项目：列表到了就选第一个，省得每次都先点一下下拉。 */
  useEffect(() => {
    if (!uploadProject && projects?.length) setUploadProject(projects[0].id);
  }, [projects, uploadProject]);
  useEffect(() => {
    if (!saveProject && projects?.length) setSaveProject(projects[0].id);
  }, [projects, saveProject]);

  const mediaAssets = useMemo(
    () => (assetData?.items ?? []).filter((item) => item.type === 'video' || item.type === 'image'),
    [assetData],
  );
  const shownAssets = useMemo(
    () => (libraryProject ? mediaAssets.filter((item) => item.projectId === libraryProject) : mediaAssets),
    [mediaAssets, libraryProject],
  );

  /* ---------------------------------------------------------------- *
   * 加素材
   * ---------------------------------------------------------------- */

  /** 把探测结果并进列表。读不出来的一段单独报出来，但不影响其余的。 */
  function mergeProbes(items: ProbeItem[]) {
    const ok: Clip[] = [];
    const failed: string[] = [];
    for (const item of items) {
      if (item.error || !item.kind) {
        failed.push(item.error || '读不出来。');
        continue;
      }
      const frames = Math.max(1, item.frames ?? 1);
      ok.push({
        key: nextKey(),
        assetId: item.assetId,
        name: item.name ?? '素材',
        kind: item.kind,
        url: item.url ?? '',
        width: item.width ?? 0,
        height: item.height ?? 0,
        fps: item.fps ?? 0,
        frames,
        duration: item.duration ?? 0,
        hasAudio: Boolean(item.hasAudio),
        start: 0,
        end: frames - 1,
        imageFrames: DEFAULT_IMAGE_FRAMES,
      });
    }
    if (ok.length) {
      setClips((prev) => [...prev, ...ok]);
      setCurrent((prev) => (prev === null ? 0 : prev));
      setFrame(0);
    }
    if (failed.length) setMessage({ ok: false, text: failed.slice(0, 3).join('；') });
    return ok.length;
  }

  async function addPicked() {
    if (!picked.length) return;
    setAdding(true);
    setMessage(null);
    try {
      const result = await apiPost<{ items: ProbeItem[] }>('/api/tools/video/probe', { assetIds: picked });
      const count = mergeProbes(result.items ?? []);
      if (count) {
        setPicked([]);
        setMessage({ ok: true, text: `已加入 ${count} 段素材。` });
      }
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : '读取素材失败。' });
    } finally {
      setAdding(false);
    }
  }

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    if (!uploadProject) {
      setMessage({ ok: false, text: '先选一个项目 —— 上传的素材要挂在具体项目下。' });
      return;
    }
    setAdding(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.set('projectId', uploadProject);
      for (const file of files) form.append('file', file);
      const uploaded = await apiPost<{ items: { id: string }[] }>('/api/tools/video/upload', form);
      const ids = (uploaded.items ?? []).map((item) => item.id);
      if (!ids.length) {
        setMessage({ ok: false, text: '一个都没传上去 —— 检查格式是不是常见的视频或图片。' });
        return;
      }
      const probed = await apiPost<{ items: ProbeItem[] }>('/api/tools/video/probe', { assetIds: ids });
      const count = mergeProbes(probed.items ?? []);
      /* 上传的东西也进了资产库 —— 不刷新的话「资产库」那一栏里还看不到它们，
         切过去会以为上传没生效（上传那一栏明明刚提示成功）。 */
      reloadAssets();
      setMessage({ ok: true, text: `已上传并加入 ${count} 段素材${count < ids.length ? `，${ids.length - count} 段读不出来` : ''}。` });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : '上传失败。' });
    } finally {
      setAdding(false);
    }
  }

  /* ---------------------------------------------------------------- *
   * 片段列表 / 参数
   * ---------------------------------------------------------------- */

  const active = current === null ? null : clips[current] ?? null;
  const maxFrame = active ? (active.kind === 'image' ? 0 : active.end) : 0;

  /* 换一段 / 这段的范围被改过，两个框就跟着回到它自己的值 —— 否则还留着上一段的数字。 */
  useEffect(() => {
    if (!active || active.kind === 'image') return;
    setRangeStart(String(active.start));
    setRangeEnd(String(active.end));
  }, [current, active?.start, active?.end, active?.kind]);

  function selectClip(index: number) {
    setCurrent(index);
    const clip = clips[index];
    setFrame(clip ? (clip.kind === 'image' ? 0 : clip.start) : 0);
    setPlaying(false);
  }

  function moveClip(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= clips.length) return;
    setClips((prev) => {
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
    setCurrent(target);
  }

  function removeClip(index: number) {
    setClips((prev) => prev.filter((_, i) => i !== index));
    setCurrent((prev) => (prev === null ? null : clips.length <= 1 ? null : Math.min(prev, clips.length - 2)));
    setPlaying(false);
  }

  /** 应用帧范围：夹回素材自己的范围里，越界不会静静生成一个空段。 */
  function applyRange() {
    if (!active || active.kind === 'image') return;
    const total = Math.max(1, active.frames);
    const start = Math.max(0, Math.min(Math.floor(Number(rangeStart) || 0), total - 1));
    const end = Math.max(start, Math.min(Math.floor(Number(rangeEnd) || total - 1), total - 1));
    setClips((prev) => prev.map((item, i) => (i === current ? { ...item, start, end } : item)));
    setFrame(start);
    setRangeStart(String(start));
    setRangeEnd(String(end));
  }

  function setImageFrames(value: string) {
    if (!active || current === null) return;
    const frames = Math.max(1, Math.min(3600, Math.floor(Number(value) || DEFAULT_IMAGE_FRAMES)));
    setClips((prev) => prev.map((item, i) => (i === current ? { ...item, imageFrames: frames } : item)));
  }

  /* 播放：按素材自己的帧率往前推。只在当前这段里循环到结尾就停。 */
  useEffect(() => {
    if (!playing || !active || active.kind === 'image') return;
    const step = Math.max(30, Math.round(1000 / (active.fps || 24)));
    const timer = window.setInterval(() => {
      setFrame((prev) => {
        if (prev >= active.end) {
          setPlaying(false);
          return active.end;
        }
        return prev + 1;
      });
    }, step);
    return () => window.clearInterval(timer);
  }, [playing, active]);

  /* ---------------------------------------------------------------- *
   * 导出
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const result = await apiGet<JobView>(`/api/tools/video/export?id=${encodeURIComponent(jobId)}`);
        if (cancelled) return;
        setJobView(result);
        if (result.state === 'running') timer = window.setTimeout(tick, POLL_MS);
      } catch (error) {
        if (cancelled) return;
        setMessage({ ok: false, text: error instanceof Error ? error.message : '查进度失败。' });
        setJobId(null);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [jobId]);

  async function startExport() {
    if (!clips.length) return;
    setMessage(null);
    setJobView(null);
    try {
      const result = await apiPost<{ id: string }>('/api/tools/video/export', {
        clips: clips.map((item) => ({
          assetId: item.assetId,
          start: item.start,
          end: item.end,
          imageFrames: item.imageFrames,
        })),
        outputName,
      });
      setJobId(result.id);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : '起不来导出任务。' });
    }
  }

  async function cancelExport() {
    if (!jobId) return;
    try {
      await apiPost('/api/tools/video/export/cancel', { id: jobId });
      setMessage({ ok: true, text: '已取消。' });
      setJobId(null);
      setJobView(null);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : '取消失败。' });
    }
  }

  async function archiveOutput() {
    if (!jobId || !saveProject) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await apiPost<{ id: string; projectId: string }>('/api/tools/video/archive', {
        id: jobId,
        projectId: saveProject,
        name: `${outputName}.mp4`,
      });
      setMessage({ ok: true, text: '已存进资产库。' });
      void result;
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : '存入资产库失败。' });
    } finally {
      setSaving(false);
    }
  }

  async function openOutputFolder() {
    if (!jobView?.outputDir) return;
    const result = await openFolderPath(jobView.outputDir);
    if (!result.ok) setMessage({ ok: false, text: result.message });
  }

  async function chooseFfmpeg() {
    const pickedPath = await pickFilePath({
      title: '选择 ffmpeg.exe',
      filters: [{ name: 'FFmpeg', extensions: ['exe'] }],
    });
    if (!pickedPath) return;
    try {
      const result = await apiPost<FfmpegStatus>('/api/tools/video/ffmpeg', { path: pickedPath });
      setMessage({ ok: result.ok, text: result.message });
      reloadEngine();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : '设置失败。' });
    }
  }

  /* ---------------------------------------------------------------- *
   * 渲染
   * ---------------------------------------------------------------- */

  const running = jobView?.state === 'running';
  const totalFrames = clips.reduce(
    (sum, item) => sum + (item.kind === 'image' ? item.imageFrames : item.end - item.start + 1),
    0,
  );

  return (
    <ToolShell
      active="video"
      eyebrow="VIDEO JOIN"
      title="视频拼接"
      intro="把几段视频和图片按顺序拼成一条 —— 尺寸与帧率跟着第一段走"
    >
      {/* FFmpeg 在哪：找得到就一句话带过，找不到才展开。 */}
      <div className={`vj-engine${engineData?.ok ? '' : ' warn'}`} data-vj-engine={engineData?.ok ? 'ok' : 'bad'}>
        <span className="vj-engine-dot" aria-hidden />
        <span className="vj-engine-text">
          {engineData ? engineData.message : '正在检查 FFmpeg…'}
          {engineData?.version && <em>{engineData.version}</em>}
        </span>
        <button className="button subtle small" type="button" onClick={() => setShowEngine((v) => !v)} aria-expanded={showEngine}>
          <Settings2 size={13} aria-hidden /> FFmpeg 设置
          {showEngine ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
        </button>
      </div>
      {showEngine && (
        <div className="vj-engine-panel">
          <p className="tool-hint">
            拼接要用本机的 FFmpeg。自动探测会去 PATH 和几个常见目录里找；找不到就在下面手动指一下
            —— 选 <code>ffmpeg.exe</code> 或它的 <code>bin</code> 目录都行（同目录有 ffprobe.exe 最好）。
          </p>
          <div className="vj-engine-row">
            <code className="vj-path">{engineData?.ffmpeg || '还没找到'}</code>
            {canPickFile() && (
              <button className="button secondary small" type="button" onClick={chooseFfmpeg}>
                <FolderOpen size={13} aria-hidden /> 选择 ffmpeg.exe
              </button>
            )}
          </div>
        </div>
      )}

      <section className="tool-panel vj-panel">
        {/* ---------------- 左：选素材 + 片段列表 ---------------- */}
        <div className="tool-pane vj-source">
          <div className="vj-picker" data-vj-picker>
            <div className="vj-picker-head">
              <strong>选择素材</strong>
              <small>从资产库挑，或者传自己的</small>
            </div>
            <div className="tool-tabs">
              <button type="button" className={tab === 'library' ? 'active' : undefined} onClick={() => setTab('library')}>
                资产库
              </button>
              <button type="button" className={tab === 'upload' ? 'active' : undefined} onClick={() => setTab('upload')}>
                上传
              </button>
            </div>

            {tab === 'library' ? (
              <div className="vj-library">
                <label className="field">
                  <span>哪个项目</span>
                  <select
                    className="assets-select"
                    value={libraryProject}
                    onChange={(event) => setLibraryProject(event.target.value)}
                    data-vj-library-project
                  >
                    <option value="">全部项目</option>
                    {(assetData?.projects ?? []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}（{item.count}）
                      </option>
                    ))}
                  </select>
                </label>
                {shownAssets.length ? (
                  <div className="vj-assets" data-vj-assets>
                    {shownAssets.map((item) => {
                      const on = picked.includes(item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`vj-asset${on ? ' active' : ''}`}
                          aria-pressed={on}
                          data-vj-asset={item.id}
                          onClick={() => setPicked((prev) => (prev.includes(item.id) ? prev.filter((x) => x !== item.id) : [...prev, item.id]))}
                        >
                          <span className="vj-asset-thumb">
                            {item.type === 'video' ? (
                              <video src={item.url} muted playsInline preload="metadata" />
                            ) : (
                              <img src={item.url} alt={item.name} />
                            )}
                          </span>
                          <span className="vj-asset-name">{item.name}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="tool-hint">
                    这个项目里还没有视频或图片。{' '}
                    <Link href="/projects/new">去建一个项目</Link>，或者直接切到「上传」。
                  </p>
                )}
                <button
                  className="button"
                  type="button"
                  disabled={!picked.length || adding}
                  onClick={addPicked}
                  data-vj-add-picked
                >
                  {adding ? <Loader2 className="asset-spin" size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
                  加入拼接列表{picked.length ? `（${picked.length}）` : ''}
                </button>
              </div>
            ) : (
              <div className="vj-upload">
                <label className="field">
                  <span>存到哪个项目</span>
                  <select
                    className="assets-select"
                    value={uploadProject}
                    onChange={(event) => setUploadProject(event.target.value)}
                    disabled={!projects?.length}
                    data-vj-upload-project
                  >
                    {!projects?.length && <option value="">还没有项目</option>}
                    {projects?.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label
                  className={`tool-drop${dragging ? ' dragging' : ''}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    void uploadFiles(Array.from(event.dataTransfer.files));
                  }}
                >
                  <Upload className="tool-drop-icon" size={22} strokeWidth={1.5} aria-hidden />
                  <strong>拖到这里，或点一下选文件</strong>
                  <small className="muted">视频：mp4 / mov / mkv / avi / webm · 图片：png / jpg / webp</small>
                  <input
                    type="file"
                    accept="video/*,image/*"
                    multiple
                    data-vj-file
                    onChange={(event) => {
                      void uploadFiles(Array.from(event.target.files ?? []));
                      event.target.value = '';
                    }}
                  />
                </label>
                {adding && <p className="tool-hint">正在上传并读取信息…</p>}
              </div>
            )}
          </div>

          <div className="vj-clips">
            <div className="vj-picker-head">
              <strong>拼接顺序</strong>
              <small>{clips.length ? `${clips.length} 段 · 共约 ${totalFrames} 帧` : '还没有素材'}</small>
            </div>
            {clips.length ? (
              <ul className="vj-clip-list" data-vj-clips>
                {clips.map((item, index) => (
                  <li key={item.key} className={index === current ? 'active' : undefined}>
                    <button type="button" className="vj-clip-main" onClick={() => selectClip(index)} data-vj-clip={index}>
                      <span className="vj-clip-index">{index + 1}</span>
                      <span className="vj-clip-name">{item.name}</span>
                      <span className="vj-clip-meta">
                        {item.kind === 'image'
                          ? `图片 · ${item.imageFrames} 帧`
                          : `${item.width}×${item.height} · ${item.fps ? item.fps.toFixed(2) : '—'} fps · ${item.end - item.start + 1} 帧`}
                      </span>
                    </button>
                    <span className="vj-clip-actions">
                      <button type="button" className="text-link" onClick={() => moveClip(index, -1)} disabled={index === 0} aria-label="上移">
                        <ChevronUp size={14} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => moveClip(index, 1)}
                        disabled={index === clips.length - 1}
                        aria-label="下移"
                      >
                        <ChevronDown size={14} aria-hidden />
                      </button>
                      <button type="button" className="text-link" onClick={() => removeClip(index)} aria-label="移除">
                        <Trash2 size={14} aria-hidden />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="tool-hint">左边加进来之后，这里的顺序就是成品里的顺序。</p>
            )}
          </div>
        </div>

        {/* ---------------- 中：预览 ---------------- */}
        <div className="tool-pane vj-stage-pane">
          <div className="tool-preview vj-stage" data-vj-stage>
            {active ? (
              active.kind === 'image' ? (
                <img src={active.url} alt={active.name} data-vj-frame />
              ) : (
                <img
                  src={`/api/tools/video/frame?asset=${encodeURIComponent(active.assetId)}&frame=${frame}`}
                  alt={`${active.name} 第 ${frame} 帧`}
                  data-vj-frame
                />
              )
            ) : (
              <span className="muted">选一段素材看这里的帧</span>
            )}
          </div>
          <div className="vj-controls">
            <button className="button subtle small" type="button" disabled={!active || active.kind === 'image'} onClick={() => setFrame((v) => Math.max(0, v - 1))}>
              上一帧
            </button>
            <button
              className="button subtle small"
              type="button"
              disabled={!active || active.kind === 'image'}
              onClick={() => setPlaying((v) => !v)}
              data-vj-play
            >
              {playing ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
              {playing ? '暂停' : '播放'}
            </button>
            <button
              className="button subtle small"
              type="button"
              disabled={!active || active.kind === 'image'}
              onClick={() => setFrame((v) => Math.min(maxFrame, v + 1))}
            >
              下一帧
            </button>
            {active && active.kind === 'video' && (
              <input
                type="range"
                min={0}
                max={maxFrame}
                value={frame}
                aria-label="帧"
                data-vj-scrub
                onChange={(event) => {
                  setPlaying(false);
                  setFrame(Number(event.target.value));
                }}
              />
            )}
            <span className="vj-frame-no">{active && active.kind === 'video' ? `帧 ${frame}` : '　'}</span>
          </div>
        </div>

        {/* ---------------- 右：参数 ---------------- */}
        <div className="tool-pane vj-params">
          <div className="vj-picker-head">
            <strong>当前片段</strong>
            <small>{active ? active.name : '未选择'}</small>
          </div>
          {active ? (
            <>
              <p className="tool-meta">
                {active.kind === 'image' ? (
                  <>
                    {active.width}×{active.height} · 图片
                    <br />
                    在成品里占 {active.imageFrames} 帧
                  </>
                ) : (
                  <>
                    {active.width}×{active.height} · {active.fps ? `${active.fps.toFixed(3)} fps` : '未知帧率'}
                    <br />
                    共 {active.frames} 帧 · {active.duration ? `${active.duration.toFixed(2)} 秒` : '—'}
                    <br />
                    {active.hasAudio ? '有音轨' : '无音轨（导出时补静音）'}
                  </>
                )}
              </p>

              {active.kind === 'image' ? (
                <label className="field">
                  <span>这张图显示几帧</span>
                  <input
                    type="number"
                    min={1}
                    max={3600}
                    value={active.imageFrames}
                    data-vj-image-frames
                    onChange={(event) => setImageFrames(event.target.value)}
                  />
                  <small className="muted">按成品帧率折算：填 5 就是这张图停 5 帧。</small>
                </label>
              ) : (
                <>
                  <div className="tool-row">
                    <label className="field">
                      <span>起始帧（含）</span>
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, active.frames - 1)}
                        value={rangeStart}
                        onChange={(event) => setRangeStart(event.target.value)}
                        data-vj-start
                      />
                    </label>
                    <label className="field">
                      <span>结束帧（含）</span>
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, active.frames - 1)}
                        value={rangeEnd}
                        onChange={(event) => setRangeEnd(event.target.value)}
                        data-vj-end
                      />
                    </label>
                  </div>
                  <button className="button secondary small" type="button" data-vj-apply onClick={applyRange}>
                    <Scissors size={13} aria-hidden /> 应用帧范围
                  </button>
                  <p className="tool-hint">只取 {active.start}–{active.end} 帧（共 {active.end - active.start + 1} 帧）。</p>
                </>
              )}
            </>
          ) : (
            <p className="tool-hint">在左边点一段素材，这里可以裁它的帧范围。</p>
          )}
        </div>
      </section>

      {/* ---------------- 底部：导出 ---------------- */}
      <section className="vj-export">
        <label className="field vj-export-name">
          <span>输出文件名</span>
          <input value={outputName} onChange={(event) => setOutputName(event.target.value)} data-vj-output />
          <small className="muted">.mp4</small>
        </label>
        <div className="vj-export-buttons">
          {running ? (
            <button className="button secondary" type="button" onClick={cancelExport} data-vj-cancel>
              取消
            </button>
          ) : (
            <button
              className="button"
              type="button"
              onClick={startExport}
              disabled={!clips.length || !engineData?.ok}
              data-vj-export
            >
              开始导出
            </button>
          )}
        </div>
        <div className="tool-progress" role="progressbar" aria-valuenow={jobView?.pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${jobView?.pct ?? 0}%` }} />
        </div>
        <p className="tool-hint" data-vj-status>
          {jobView ? jobView.message : '成品会写到「设置 · 输出目录」下的 joined 文件夹。'}
          {jobView?.error ? ` —— ${jobView.error}` : ''}
        </p>

        {jobView?.state === 'done' && (
          <div className="vj-done">
            {isDesktop && jobView.outputDir && (
              <button className="button secondary small" type="button" onClick={openOutputFolder}>
                <FolderOpen size={13} aria-hidden /> 打开文件夹
              </button>
            )}
            <label className="field">
              <span>存到哪个项目</span>
              <select className="assets-select" value={saveProject} onChange={(event) => setSaveProject(event.target.value)}>
                {projects?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="button small" type="button" onClick={archiveOutput} disabled={saving || !saveProject} data-vj-archive>
              {saving ? <Loader2 className="asset-spin" size={13} aria-hidden /> : <Upload size={13} aria-hidden />}
              存入资产库
            </button>
          </div>
        )}

        {message && (
          <p className={`notice ${message.ok ? 'ok' : ''}`} role="status" data-vj-message={message.ok ? 'ok' : 'fail'}>
            {message.text}
            {message.ok && saveProject && <>{' '}<Link href={`/assets?project=${saveProject}`}>去看看</Link></>}
          </p>
        )}
      </section>
    </ToolShell>
  );
}
