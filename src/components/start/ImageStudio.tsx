'use client';

/*
 * 图片生成全页界面（`/image`，入口是首页「图片生成」卡片）。
 *
 * 版式照徐先给的参考（即梦那种）：**左侧历史缩略图栏 + 中间大区 + 底部居中生成条**。
 * 历史栏读的是「图片生成」固定项目的图片资产（`/api/assets?project=…&type=image`）；
 * 中间大区没有结果时是空态，出完图放大显示最新一批；生成条收参考图 / 提示词 /
 * 引擎 / 比例 / 分辨率，Enter 或点按钮直接出片。
 *
 * 引擎三条路（2026-09-25 起加「自定义接口」；2026-09-23 删掉的是直连 Image 2.0 那一档）：
 *   - `local` / `runninghub`：走工作流（`/api/projects/<id>/generation`），异步，
 *     轮询 `/api/tasks/<id>`（节奏照画布 `CanvasEditor.poll`：越等越慢，一直问到有结果）。
 *     下拉只列「图片用途 + 对应来源」的工作流，提交的 bindingValues 与画布出图节点同构。
 *   - `custom`：走 `/api/projects/<id>/custom-image`（与画布自定义接口同一入口），**同步**出图，
 *     参数是 image2Params 那套比例 / 分辨率 + 模型（`<接口Id>::<模型Id>`，来自 `/api/providers/custom`）。
 *
 * 出图挂靠「图片生成」固定项目（`lib/start/studio.ts` 的约定），任务与资产都有归属。
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, Loader2, Plus, Sparkles, X } from 'lucide-react';
import {
  defaultEngine, defaultParams, ENGINES_FOR, ENGINE_META, paramSummary, ratioOptions, resolutionOptions,
  type ComposeEngine, type ComposeParams,
} from '@/lib/start/compose';
import { STUDIO_PROMPT_MAX, studioImageSize, studioNodeId, studioSizeLabel } from '@/lib/start/studio';
import {
  IMAGE_DEFAULTS, IMAGE_SIZE_MODES, MAX_CUSTOM_SIDE, MAX_MEGAPIXELS, MIN_CUSTOM_SIDE,
  MIN_MEGAPIXELS, validateImageParams, type ImageSizeMode,
} from '@/lib/workflows/imageParams';
import {
  IMAGE2_MAX_REFERENCES, IMAGE2_SIZE_AUTO, readImage2Params, validateImage2Params,
} from '@/lib/workflows/image2Params';
import { apiPost, useApi, useSession } from '@/lib/client';
import { customEngineVisible } from '@/lib/providers/custom-visible';
/* 出图结束时顺手刷站点余额（走自定义接口那一档才真花钱）。 */
import { refreshSiteAccount } from '@/lib/site-account';
import { pollDelayMs } from '@/lib/taskPoll';
import '@/app/image-studio.css';

/** `GET /api/workflows` 的一行 —— 这里只认 workflowId / 名字 / 来源三个字段。 */
type WorkflowRow = { workflowId: string; name?: string; provider?: string };
/** `GET /api/assets` 的一行 —— 历史栏只需要地址与名字。 */
type AssetRow = { id: string; name?: string; url: string };
/** `GET /api/skills` 里只用到这三个字段 —— 别把整个 SkillView 搬进这一页。 */
type SkillOption = { id: string; title: string; optimize: boolean };

async function readJson(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
}

/** 等一个异步任务跑完，回图片地址列表。节奏与画布同款：3 秒一轮，最多 240 轮。 */
/**
 * 等一个异步任务跑完，回图片地址列表。
 *
 * 节奏与画布同一套（`lib/taskPoll`：越等越慢 3s→6s→12s→20s）。
 * 这里**没有等待上限**（2026-09-30 定死）：出图只有成功与失败，跑多久是上游的事，
 * 一直问到有结果为止。
 */
async function pollTask(taskId: string, onStatus: (text: string) => void): Promise<string[]> {
  const startedAt = Date.now();
  for (;;) {
    /* 一直问到有结果：出图只有成功与失败，不按等待时长做任何判定。 */
    const delay = pollDelayMs(Date.now() - startedAt);
    await new Promise(resolve => setTimeout(resolve, delay));
    const task = await readJson(await fetch(`/api/tasks/${taskId}`));
    if (task.status === 'success') {
      const list: { url?: string }[] = Array.isArray(task.result) ? task.result : [];
      return list.map(item => String(item?.url || '')).filter(Boolean);
    }
    if (task.status === 'failed') throw new Error(String(task.error || '任务失败了。'));
    const waited = Math.round((Date.now() - startedAt) / 1000);
    if (typeof task.progress === 'string' && task.progress) onStatus(`正在出图 · ${task.progress}（已等 ${waited} 秒）`);
    else onStatus(`正在出图…（已等 ${waited} 秒）`);
  }
}


export default function ImageStudio() {
  const { user } = useSession();
  /** 默认引擎跟着 `compose.ts` 走 —— 那一处改了这里立刻跟着，不用再来改一遍。 */
  const [engine, setEngine] = useState<ComposeEngine>(defaultEngine('image'));
  const [params, setParams] = useState<ComposeParams>(() => defaultParams('image', defaultEngine('image')));
  const [workflowId, setWorkflowId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  /** 固定项目：进页面就 find-or-create（GET 幂等），出图与传图都打在它下面。 */
  const { data: session } = useApi<{ projectId: string }>(user ? '/api/studio/session' : null);
  const projectId = session?.projectId ?? '';
  /** 历史栏：这个项目下落盘的图片资产，出完图 reload 一次。 */
  const { data: assetData, reload: reloadAssets } = useApi<{ items: AssetRow[] }>(
    user && projectId ? `/api/assets?project=${projectId}&type=image` : null,
  );
  const history = assetData?.items ?? [];
  /** 出图现在只剩工作流来源，所以这一份**总是**要；按「图片用途」过滤，来源在下面自己分。 */
  const { data: wfData } = useApi<{ workflows: WorkflowRow[] }>(
    user ? '/api/workflows?kind=image' : null,
  );
  const workflows = (wfData?.workflows ?? []).filter(row => (row.provider === 'local' ? 'local' : 'runninghub') === engine);
  /** 自定义接口的模型清单（画布 dock 用的同一个接口）。模型值形如 `<接口Id>::<模型Id>`。 */
  const { data: customData } = useApi<{ models: { image: { value: string; label: string }[] } }>(
    user ? '/api/providers/custom' : null,
  );
  const customModels = customData?.models.image ?? [];
  /** 「优化提示词时照哪个技能」的候选（`/api/skills`，与画布 dock 读的是同一份）。 */
  const { data: skillData } = useApi<{ skills: SkillOption[] }>(user ? '/api/skills' : null);
  const [customModel, setCustomModel] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  /*
   * 只收 `optimize` 标过的 —— 与画布 dock 同一条规矩，理由也一样：全列出来会有十几项，
   * 而技能是分方向的（文戏 / 武戏 / 资产），一股脑摆进来等于没分。哪个技能进这一格，
   * 由 SKILL 社区里那颗「用于优化提示词」的开关决定，两边读的是同一个字段。
   * 一个都没标就整格不渲染 —— 摆一个只有「不指定」的下拉只会让人以为这功能坏了。
   */
  const optimizeSkills = (skillData?.skills ?? []).filter(item => item.optimize);
  const [promptSkill, setPromptSkill] = useState('');
  /* 优化完那句「已按…改写」要留在条上（`.studio-status` 只在 busy 时渲染），单开一个位子。 */
  const [notice, setNotice] = useState('');
  /** 「长宽」那一格（2026-09-26）：两档来源 + 手填的宽高，见下面 `.studio-size` 那段说明。 */
  const [sizeMode, setSizeMode] = useState<ImageSizeMode>('resolution');
  const [sizeW, setSizeW] = useState('');
  const [sizeH, setSizeH] = useState('');
  const [sizeOpen, setSizeOpen] = useState(false);
  const sizeRef = useRef<HTMLSpanElement>(null);
  /*
   * 那一格显示的读数与提交给工作流的宽高**来自同一个函数**（`studioImageSize`）——
   * 画布那条注释里「面板写着 1024×1024、实际提交另一个数」的错在这里同样成立，
   * 而且没有任何报错，只能等用户看出图不对。
   */
  const imageSize = studioImageSize({
    sizeMode, customWidth: sizeW, customHeight: sizeH,
    ratio: params.ratio, megapixels: params.resolution,
  });

  /*
   * 「优化提示词」（2026-09-26，徐先按参考图点名要的）：把一句话扩写成一段能直接生成的提示词。
   *
   * ⚠️ 它调的是**文本模型**（设置 · 模型服务 · 官方大语言模型那一栏），不生成任何媒体。
   *   一家都没配时服务端会回一句指到那一页的话 —— 原样转发给用户，别含糊成「优化失败」，
   *   否则用户会以为是自己这句话有问题（与画布 dock 那条同一条规矩）。
   */
  async function optimize() {
    const raw = prompt.trim();
    if (!raw) { setError('先写一句提示词再优化。'); return; }
    if (optimizing) return;
    setOptimizing(true); setError(''); setNotice('');
    try {
      const result = await apiPost<{ optimizedPrompt: string }>('/api/prompt/optimize', {
        prompt: raw,
        /*
         * 选了技能就带上：优化出来的提示词得是**那个技能**要的格式，不然用户选它干嘛
         * （与画布 dock 同一条）。
         * ⚠️ 没选时**不带这个键**，别发空串 —— 那会把「没选」和「传了个识别不出的 id」
         *    混成同一个值，服务端那边就再也分不出来了。
         */
        ...(promptSkill ? { skillId: promptSkill } : {}),
      });
      const next = String(result?.optimizedPrompt || '').trim();
      if (!next) throw new Error('文本模型给回来的内容是空的，再点一次试试。');
      setPrompt(next.slice(0, STUDIO_PROMPT_MAX));
      /* 回执要说清是「按谁的写法」改的 —— 否则用户没法判断那颗下拉到底起没起作用。 */
      const used = optimizeSkills.find(item => item.id === promptSkill);
      setNotice(used ? `已按「${used.title}」的写法改写提示词` : '已用文本模型改写提示词');
    } catch (e) {
      const message = e instanceof Error ? e.message : '提示词优化失败。';
      /*
       * 401 / 403 是**那家密钥**的问题，不是这句提示词的问题 —— 上游那句话原样给回
       * （里面有接口地址和请求 id，排查要用），再补一句指到「设置 · 模型服务」，
       * 别让人以为是自己写的句子不对（与「别含糊成优化失败」同一条规矩）。
       */
      setError(/401|403|invalid token/i.test(message)
        ? `${message} —— 去「设置 · 模型服务」检查这家的密钥。`
        : message);
    } finally {
      setOptimizing(false);
    }
  }

  function switchEngine(next: ComposeEngine) {
    if (next === engine) return;
    setEngine(next);
    setWorkflowId('');
    setParams(defaultParams('image', next));
    /** 换引擎 = 换一整套值域（MP / 比例都不是同一套），手填的宽高与那一档也跟着回默认。 */
    setSizeMode('resolution');
    setSizeW('');
    setSizeH('');
    setSizeOpen(false);
  }

  function pickParam(key: 'ratio' | 'resolution', value: string) {
    setParams(cur => ({ ...cur, [key]: value }));
  }

  /*
   * 切「长宽」那一档。
   *
   * 切到手填时**把当前读数预填进两个框**：徐先说的是「手动调整」—— 从已有的 1024×1024
   * 改一条边，比对着两个空框从零填顺手得多。已经填过就别覆盖：来回切一档不该把人填的数抹掉。
   */
  function pickSizeMode(next: ImageSizeMode) {
    setSizeMode(next);
    if (next !== 'custom' || sizeW || sizeH) return;
    const cur = studioImageSize({ sizeMode: 'resolution', ratio: params.ratio, megapixels: params.resolution });
    setSizeW(String(cur.width));
    setSizeH(String(cur.height));
  }

  /* 弹层的两种关法：点外面 / 按 Esc。不挂监听的话它会一直浮在生成条上，把出图钮挡住。 */
  useEffect(() => {
    if (!sizeOpen) return;
    const onDown = (event: MouseEvent) => {
      if (sizeRef.current && !sizeRef.current.contains(event.target as Node)) setSizeOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSizeOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [sizeOpen]);

  async function onFiles(list: FileList | null) {
    const picked = Array.from(list ?? []).filter(file => file.size > 0);
    if (fileRef.current) fileRef.current.value = '';
    if (!picked.length) return;
    const room = IMAGE2_MAX_REFERENCES - refs.length;
    if (room <= 0) { setError(`参考图最多 ${IMAGE2_MAX_REFERENCES} 张。`); return; }
    setUploading(true); setError('');
    try {
      const form = new FormData();
      picked.slice(0, room).forEach(file => form.append('files', file));
      const body = await readJson(await fetch('/api/studio/upload', { method: 'POST', body: form }));
      setRefs(cur => [...cur, ...(body.refs ?? [])].slice(0, IMAGE2_MAX_REFERENCES));
    } catch (e) {
      setError(e instanceof Error ? e.message : '参考图上传失败。');
    } finally {
      setUploading(false);
    }
  }

  async function generate() {
    if (busy) return;
    setError('');
    if (!user) { setError('还没登录 —— 点右上角登录后再出图。'); return; }
    if (!projectId) { setError('出图项目还没就绪，稍等一下再点。'); return; }
    const text = prompt.trim().slice(0, STUDIO_PROMPT_MAX);
    if (!text) { setError('先写一句提示词。'); return; }
    setBusy(true); setResults([]); setStatus('提交中…'); setSizeOpen(false); setNotice('');
    /*
     * 同步那一档（自定义接口）才挂计时器 —— 工作流那一路 `pollTask` 自己就在报
     * 「已等 N 秒」，再挂一个只会和它抢同一行字。
     */
    let ticker = 0;
    try {
      if (engine === 'custom') {
        if (!customModel) throw new Error('先在「自定义接口」里挑一个模型（接口在「设置 · 模型服务」里加）。');
        const bad = validateImage2Params({ ratio: params.ratio, resolution: params.resolution });
        if (bad) throw new Error(bad);
        /* 与画布同一条规矩：把这一次真正发出去的尺寸说出来，别让「选 4K 出 1K」无从查起。 */
        const customSize = readImage2Params({ ratio: params.ratio, resolution: params.resolution });
        const sizeNote = customSize.size === IMAGE2_SIZE_AUTO
          ? '尺寸由接口决定（想固定就选一个比例）'
          : customSize.size + '（' + String(customSize.resolution).toUpperCase() + '）';
        setStatus('提交中 · ' + sizeNote);
        /*
         * 「有时候会卡住」的另一半（2026-09-29）：这一路是同步请求，以前从点下去到
         * 回包之间**一个字都不变** —— 上游在排队、或者 4K 那档图大，界面看着就是死机。
         * 这里每 5 秒把已等秒数写进状态条，「在跑」和「真卡住」一眼能分开
         * （真到点服务端也会按 150 秒的总预算自己回一句超时，不会无限等）。
         */
        const startedAt = Date.now();
        ticker = window.setInterval(() => {
          setStatus('提交中 · 已等 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒 · ' + sizeNote);
        }, 5000);
        const body = await readJson(await fetch(`/api/projects/${projectId}/custom-image`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            nodeId: studioNodeId(), prompt: text, model: customModel,
            ratio: params.ratio, resolution: params.resolution, referenceImages: refs,
          }),
        }));
        const urls = (Array.isArray(body.results) ? body.results : [])
          .map((item: { url?: string }) => String(item?.url || ''))
          .filter(Boolean);
        if (!urls.length) throw new Error('自定义接口没有返回可用的图片。');
        setResults(urls);
      } else {
        if (!workflowId) throw new Error(engine === 'local' ? '先选一份本机 ComfyUI 的工作流。' : '先选一份 RunningHub 的工作流。');
        /* 手填那一档填得不对就在这里停 —— 别等服务端在扣分之后才回一句。 */
        if (imageSize.error) throw new Error(imageSize.error);
        const imageValues = {
          negativePrompt: '', steps: IMAGE_DEFAULTS.steps, cfg: IMAGE_DEFAULTS.cfg,
          seed: IMAGE_DEFAULTS.seed, batchSize: IMAGE_DEFAULTS.batchSize, sampler: IMAGE_DEFAULTS.sampler,
          megapixels: params.resolution,
        };
        const bad = validateImageParams(imageValues);
        if (bad) throw new Error(bad);
        const body = await readJson(await fetch(`/api/projects/${projectId}/generation`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            nodeId: studioNodeId(), workflowId, kind: 'image', engine,
            bindingValues: {
              prompt: text, referenceImages: refs,
              aspectRatio: params.ratio,
              width: String(imageSize.width), height: String(imageSize.height),
              ...imageValues,
            },
          }),
        }));
        const taskId = String(body.taskId || '');
        if (!taskId) throw new Error('任务没有建出来。');
        setResults(await pollTask(taskId, setStatus));
      }
      setStatus('');
      /** 新图已落进固定项目，历史栏跟着刷一次。 */
      reloadAssets();
      /*
       * 余额刷一次（2026-09-28）。只有 `custom` 那一档可能走站点中转账号 ——
       * RunningHub / 本机 ComfyUI 都不碰站点余额，不判这一下就是白打站点。
       */
      if (engine === 'custom') void refreshSiteAccount();
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败。');
      setStatus('');
    } finally {
      if (ticker) window.clearInterval(ticker);
      setBusy(false);
    }
  }

  const ratioList = ratioOptions('image', engine);
  const resolutionList = resolutionOptions('image', engine);
  /*
   * 自定义接口那一项**显不显示**（画布 dock 同一条规矩：没配就不列）—— 但「没配」
   * 得是**问到过**才算（2026-09-29）。清单那一趟失败时 `customModels` 是空的，
   * 照空来判断就会把这一档藏掉，而这一页正是用户出图的主场。
   */
  const engineItems: ComposeEngine[] = customEngineVisible({ loaded: Boolean(customData), count: customModels.length })
    ? [...ENGINES_FOR.image, 'custom']
    : [...ENGINES_FOR.image];

  return <div className="studio">
    <div className="studio-main">
      <aside className="studio-rail" aria-label="历史出图">
        {history.length
          ? history.map(item => (
            <a className="studio-rail-item" key={item.id} href={item.url} target="_blank" rel="noreferrer" title={item.name || ''}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.url} alt={item.name || '历史出图'} loading="lazy" />
            </a>
          ))
          : <span className="studio-rail-empty">还没有出过图</span>}
      </aside>

      {/* 大区只负责「出结果之后的样子」—— 空态不在它里面，见下面那段说明。 */}
      <div className="studio-stage">
        {results.length > 0 && (
          /* `multi` 与 `data-studio-results` 只给 CSS 排格子用（一张铺满 / 多张两张一行），
             也顺手给探针当判据的钩子。 */
          <div className={`studio-stage-results${results.length > 1 ? ' multi' : ''}`}
            data-studio-results={results.length}>
            {results.map(url => (
              <a key={url} href={url} target="_blank" rel="noreferrer" title="点开看原图">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="生成结果" />
              </a>
            ))}
          </div>
        )}
      </div>

      {/*
        空态 / 出图中那段字。

        ⚠️ 它**不能放在 `.studio-stage` 里**居中：大区是从左侧历史栏（76px）+ 间距（14px）
           之后才开始的，照它居中，块心会比**整个生成区**的中线右 45px（2026-09-26 实测，
           徐先一眼看出来了）。现在它是 `.studio-main` 的绝对定位子元素（`inset: 0`），
           基准就是整个生成区 —— 横向归零，纵向本来就对。
        ⚠️ `pointer-events: none` 是配套的：它只是一块牌子，不许挡住历史栏和底下的大区。
      */}
      {results.length === 0 && (
        <div className="studio-empty" data-studio-empty="">
          {busy ? (
            <>
              <Loader2 className="studio-spin" size={22} aria-hidden />
              <p className="muted">{status || '正在出图…'}</p>
            </>
          ) : (
            <>
              <h3>给你的下一幅杰作，留个位置。</h3>
              <p className="muted">选好引擎与比例，在下面写一句提示词就开始。</p>
            </>
          )}
        </div>
      )}
    </div>

    <div className="studio-dock">
      {/*
        上段卡片：参考图一排 + 提示词。
        原来所有东西挤在同一行（+ / 输入框 / 四个下拉 / 出图），参数把输入框挤成一条缝；
        照图 2 拆成上下两段后，上段只管「说什么」，下段只管「用什么出」。
      */}
      <div className="studio-compose">
        <div className="studio-refs" data-studio-refs="">
          {refs.map((url, index) => (
            <span className="studio-ref" key={url}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={`参考图 ${index + 1}`} />
              <button type="button" className="studio-ref-x" aria-label={`去掉参考图 ${index + 1}`}
                onClick={() => setRefs(cur => cur.filter((_, i) => i !== index))}><X size={12} /></button>
            </span>
          ))}
          {/*
            传图入口（图 2 那个虚线方框）：**常显**，不是有图才出现 —— 唯一的传图入口藏起来
            就没人找得到。满了（IMAGE2_MAX_REFERENCES）整格收掉：留一个点不动的方块只会骗人。
          */}
          {refs.length < IMAGE2_MAX_REFERENCES && (
            <label className="studio-ref-add" data-studio-add=""
              title={uploading ? '正在上传…' : `上传参考图（还能加 ${IMAGE2_MAX_REFERENCES - refs.length} 张）`}>
              {uploading
                ? <Loader2 className="studio-spin" size={16} aria-hidden />
                : <Plus size={16} aria-hidden />}
              <input ref={fileRef} type="file" accept="image/*" multiple hidden disabled={uploading}
                onChange={event => onFiles(event.target.files)} />
            </label>
          )}
        </div>
        <textarea
          className="studio-input"
          rows={2}
          value={prompt}
          maxLength={STUDIO_PROMPT_MAX}
          placeholder="描述你想要生成的内容"
          onChange={event => setPrompt(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              generate();
            }
          }}
        />
      </div>

      {/* 下段：四颗参数胶囊 + 右侧两个动作（优化提示词 / 出图）。它自己没有边框 —— 边框在上段那张卡上。 */}
      <div className="studio-dockbar">
        <span className="studio-pill">
          <select className="studio-select" value={engine} aria-label="引擎"
            onChange={event => switchEngine(event.target.value as ComposeEngine)}
            title={ENGINE_META[engine].hint}>
            {/*
              ⚠️ 这里用**短名字**（`short`），不是 `label` —— 这颗胶囊右边就挨着「选工作流…」，
                 再写一遍「工作流」会把整排撑到 904px，发送钮就掉到第二行了（见 ENGINE_META 那段）。
                 `<select>` 显示的永远是选中项的文本，所以下拉列表里也会是短名字 —— 这一页只有
                 两三项，标题（hint）里仍然带着完整说法，认得出来。
            */}
            {engineItems.map(item => (
              <option key={item} value={item}>{ENGINE_META[item].short}</option>
            ))}
          </select>
          <ChevronDown size={13} strokeWidth={2} aria-hidden />
        </span>
        {engine === 'custom' ? (
          <span className="studio-pill">
            <select className="studio-select" value={customModel} aria-label="模型"
              onChange={event => setCustomModel(event.target.value)}>
              <option value="">{customModels.length ? '选模型…' : '无自定义模型…'}</option>
              {customModels.map(item => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <ChevronDown size={13} strokeWidth={2} aria-hidden />
          </span>
        ) : (
          <span className="studio-pill">
            <select className="studio-select" value={workflowId} aria-label="工作流"
              onChange={event => setWorkflowId(event.target.value)}>
              <option value="">{workflows.length ? '选工作流…' : '无工作流…'}</option>
              {workflows.map(row => (
                <option key={row.workflowId} value={row.workflowId}>{row.name || row.workflowId}</option>
              ))}
            </select>
            <ChevronDown size={13} strokeWidth={2} aria-hidden />
          </span>
        )}
        <span className="studio-pill">
          <select className="studio-select" value={params.ratio} aria-label="比例"
            onChange={event => pickParam('ratio', event.target.value)}>
            {ratioList.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <ChevronDown size={13} strokeWidth={2} aria-hidden />
        </span>
        {/*
          「分辨率 / 长宽」那一格（2026-09-26，徐先：「只能选这几个参数，我要能手填」）。
          ⚠️ 自定义接口那档**不显示这一格**：它的参数是发给第三方接口的（只吃比例 + 分辨率
             两个字符串），宽高填了也没处放 —— 那一档上面就是普通下拉。
        */}
        {engine === 'custom' ? (
          <span className="studio-pill">
            <select className="studio-select" value={params.resolution} aria-label="分辨率"
              onChange={event => pickParam('resolution', event.target.value)}>
              {resolutionList.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <ChevronDown size={13} strokeWidth={2} aria-hidden />
          </span>
        ) : (
          /*
           * 工作流那两档（RunningHub / 本机 ComfyUI）：显示**换算出来的读数**（如 `1024 × 1024`）
           * —— 用户真正关心的是最后那张图多大。点开是小弹层，里面两档：
           *   · 按分辨率 —— MP 除了那几档还能手填（真实值域是连续区间，那几档只是常用值）；
           *   · 自定义长宽 —— 直接填宽高像素（64–8192，自动对齐到 16 的倍数）。
           */
          <span className="studio-size" data-studio-size="" ref={sizeRef}>
            <button type="button" className={`studio-size-btn${sizeOpen ? ' on' : ''}`}
              data-studio-size-btn="" aria-haspopup="dialog" aria-expanded={sizeOpen}
              aria-label={`长宽 ${studioSizeLabel(imageSize)}`}
              title={imageSize.mode === 'custom'
                ? '长宽是你手填的像素（点开可改）'
                : '长宽由「比例 + 分辨率」算出来；点开可以手填像素，或者直接改分辨率'}
              onClick={() => setSizeOpen(cur => !cur)}>
              {studioSizeLabel(imageSize)}
              <ChevronDown size={13} strokeWidth={2} aria-hidden />
            </button>
            {sizeOpen && (
              <div className="studio-pop" data-studio-pop="" role="dialog" aria-label="长宽">
                <div className="studio-pop-modes" data-studio-sizemode-row="">
                  {IMAGE_SIZE_MODES.map(item => (
                    <button key={item.value} type="button"
                      className={`studio-chip${imageSize.mode === item.value ? ' on' : ''}`}
                      data-studio-sizemode={item.value}
                      aria-pressed={imageSize.mode === item.value}
                      onClick={() => pickSizeMode(item.value)}>
                      {item.label}
                    </button>
                  ))}
                </div>
                {imageSize.mode === 'custom' ? (
                  <>
                    <label className="studio-pop-field">
                      <span>宽（像素）</span>
                      <input className="studio-pop-num" data-studio-w="" type="number" inputMode="numeric"
                        min={MIN_CUSTOM_SIDE} max={MAX_CUSTOM_SIDE} step="16" placeholder="1024"
                        value={sizeW} onChange={event => setSizeW(event.target.value)} />
                    </label>
                    <label className="studio-pop-field">
                      <span>高（像素）</span>
                      <input className="studio-pop-num" data-studio-h="" type="number" inputMode="numeric"
                        min={MIN_CUSTOM_SIDE} max={MAX_CUSTOM_SIDE} step="16" placeholder="1024"
                        value={sizeH} onChange={event => setSizeH(event.target.value)} />
                    </label>
                    <p className="studio-pop-hint">
                      {MIN_CUSTOM_SIDE}–{MAX_CUSTOM_SIDE} 像素，会自动对齐到 16 的倍数。
                    </p>
                    {imageSize.error
                      ? <p className="studio-pop-err" data-studio-size-err="" role="alert">{imageSize.error}</p>
                      : <p className="studio-pop-read" data-studio-size-read="">
                        提交 {imageSize.width} × {imageSize.height}
                      </p>}
                  </>
                ) : (
                  <>
                    <label className="studio-pop-field">
                      <span>分辨率（百万像素）</span>
                      <input className="studio-pop-num" data-studio-mp="" type="number" inputMode="decimal"
                        min={MIN_MEGAPIXELS} max={MAX_MEGAPIXELS} step="0.1" placeholder="1"
                        value={params.resolution}
                        onChange={event => pickParam('resolution', event.target.value)} />
                    </label>
                    {/* 常用值仍然留着：手填是「我要别的数」，不是「以后都得我自己敲」。 */}
                    <div className="studio-pop-steps" data-studio-mpsteps="">
                      {resolutionList.map(item => (
                        <button key={item.value} type="button"
                          className={`studio-chip sm${params.resolution === item.value ? ' on' : ''}`}
                          data-studio-mpstep={item.value}
                          aria-pressed={params.resolution === item.value}
                          onClick={() => pickParam('resolution', item.value)}>
                          {item.value}
                        </button>
                      ))}
                    </div>
                    <p className="studio-pop-read" data-studio-size-read="">
                      {imageSize.width} × {imageSize.height}
                    </p>
                  </>
                )}
              </div>
            )}
          </span>
        )}
        <span className="studio-spacer" />
        {/*
          「优化时照 <技能>」（2026-09-26，徐先：「这边的优化提示词也能用技能」）。

          它紧挨着 ✦ 那颗 —— 它说的就是「点那颗时按谁的写法改」，跟画布 dock 里
          「优化时照」那一行是同一件事、同一个字段（`Skill.optimize`），只是外壳换成一颗胶囊。
          ⚠️ 光写技能标题读不出这一格是干嘛的（会被读成「用哪个技能出图」），所以
             把「优化时照」四个字**放进胶囊里**（`.studio-pill-tag`）、底色挪到外壳上。
          ⚠️ `data-studio-prompt-skill` 钩子给探针用。
        */}
        {optimizeSkills.length ? (
          <span className="studio-pill skill-pill" data-studio-skill-pill="">
            <span className="studio-pill-tag" aria-hidden>优化时照</span>
            <select className="studio-select" data-studio-prompt-skill=""
              value={promptSkill} aria-label="优化时照的技能"
              title="点右边那颗 ✦ 优化提示词时，按这个技能的写法改写；「不指定」只用通用写法"
              onChange={event => { setPromptSkill(event.target.value); setNotice(''); }}>
              <option value="">不指定（通用写法）</option>
              {optimizeSkills.map(item => (
                <option key={item.id} value={item.id}>{item.title}</option>
              ))}
            </select>
            <ChevronDown size={13} strokeWidth={2} aria-hidden />
          </span>
        ) : null}
        {/*
          「优化提示词」—— 图 2 里发送钮左边那个 ✦。挨着出图钮是因为它俩同属
          「对这句提示词做点什么」这一组动作；做成**纯图标**是不去跟左边那排
          描述「用什么出」的胶囊抢读序。
          ⚠️ `data-studio-optimize` 钩子必须留着 —— 探针靠它点。
        */}
        <button type="button" className={`studio-opt${optimizing ? ' on' : ''}`}
          data-studio-optimize="" aria-label="优化提示词"
          disabled={optimizing || busy} onClick={optimize}
          title="优化提示词：用文本模型把这句话改写成一段能直接生成的提示词（设置 · 模型服务里配的那家）">
          {optimizing
            ? <Loader2 className="studio-spin" size={16} aria-hidden />
            : <Sparkles size={17} strokeWidth={1.8} aria-hidden />}
        </button>
        <button type="button" className="studio-go" data-studio-run=""
          disabled={busy || uploading} onClick={generate}
          aria-label="出图" title={paramSummary('image', engine, params)}>
          {busy
            ? <Loader2 className="studio-spin" size={17} aria-hidden />
            : <ArrowUp size={17} strokeWidth={2.2} aria-hidden />}
        </button>
      </div>
      {error && <p className="studio-error">{error}</p>}
      {/* 优化完那句回执（「已按…改写」）—— 只在不忙时占位；忙的时候这一行是进度。 */}
      {!busy && notice && <p className="studio-status" data-studio-notice="">{notice}</p>}
      {busy && <p className="studio-status">{status}</p>}
    </div>
  </div>;
}
