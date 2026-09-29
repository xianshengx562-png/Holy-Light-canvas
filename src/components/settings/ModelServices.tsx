'use client';

/*
 * 「设置 · 模型服务」（2026-09-21；**2026-09-23 按用途重排成「文本 / 图片 / 视频」三段**）。
 *
 * ## 为什么按用途分，而不是按服务商分
 *
 * 旧版按服务商分（RunningHub / 官方大语言模型 / 自定义接口）。来这一页的人脑子里想的
 * 是「我要出图」「我要出片」「我要优化提示词」，不是「我要配 RunningHub」——
 * 于是同一次配置要跨几个区块：配完内置服务，还得去另一段加兼容接口，
 * 而它们其实是「出图」这件事的两个选项。三段重排之后，一段里就能把这件事配完。
 *
 * ## 每段里的两层
 *
 * 1. **内置服务** —— 这家自己做的链路（工作流 / 直连网关 / 官方文本模型）；
 * 2. **兼容接口** —— 用户自己找的 OpenAI 兼容网关，按用途归档到这一段。
 *
 * ⚠️ 兼容接口**按用途归段**，不是按接口：一条中转站上往往同时有出图、出视频、文本三种模型，
 * 它会在三段里各出现一次（每段只列那一段用得上的模型与个数）。
 *
 * ⚠️ **RunningHub 是图片段与视频段共用的**：同一把 Key、同一个站点切换。
 *    完整区块放在图片段，视频段给一张精简卡指过去 —— 放两个填 Key 的框，用户会以为要配两次，
 *    改了一处另一处不动，那是纯粹自找的麻烦。
 *
 * ## 数据
 *
 * 一次拿全（`/api/settings/model-services`），改完就地 `reload()` ——
 * 不做「本地乐观更新」：这一页上的每个操作都会改变**别处**的行为（节点上多一个引擎选项），
 * 界面自说自话地更新，而实际配置没写上，是这类页面最容易出的错。
 */
import { useEffect, useState } from 'react';
import { pickFilePath, pickFolderPath } from '@/lib/desktop-fs';
import RunningHubKeyForm from './RunningHubKeyForm';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/client';
import type { ConnectionView } from '@/lib/providers/runninghub/connection';
import {
  applySiteAccount, fetchSiteAccount, formatYuan, useSiteAccount, type SiteAccountView,
} from '@/lib/site-account';

/** 用途三段。与 `CustomModelKind` 同值 —— 节点引擎只看 image / video。 */
type Kind = 'text' | 'image' | 'video';

export type SiteView = {
  id: 'cn' | 'ai';
  label: string;
  host: string;
  baseUrl: string;
  hasKey: boolean;
  source: string;
  masked: string | null;
  status: string;
  lastCheckedAt: string | null;
  supportsMultiple: boolean;
  keys: { id: string; label: string; masked: string; baseUrl: string; enabled: boolean; status: string }[];
};

export type TextView = {
  id: string;
  label: string;
  summary: string;
  envKeyName: string;
  defaultBaseUrl: string;
  defaultModel: string;
  configured: boolean;
  keys: { id: string; label: string; masked: string; baseUrl: string; model: string; enabled: boolean; status: string }[];
};

/** 直连网关（Image 2.0 / 视频网关）—— 与文本厂商同一套字段，只是**没有模型名**。 */
export type GatewayView = {
  id: string;
  label: string;
  summary: string;
  group: 'image' | 'video';
  envKeyName: string;
  /** `.env` 里那个兜底地址（用户级 Key 没填地址时回落的就是它）。 */
  defaultBaseUrl: string;
  configured: boolean;
  keys: { id: string; label: string; masked: string; baseUrl: string; enabled: boolean; status: string }[];
};

export type CustomView = {
  id: string;
  name: string;
  baseUrl: string;
  masked: string;
  hasKey: boolean;
  /** 用途是**多选**：一个模型可能同时是出图 + 出视频 + 文本。 */
  models: { id: string; name: string; kinds: Kind[] }[];
  enabled: boolean;
  status: string;
  errorMessage: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ModelOption = { value: string; label: string; providerId: string; modelId: string; kinds: Kind[] };

/** 本地模型那一层的数据（`GET /api/local-llm/models`）。 */
export type LocalLlmView = {
  models: { name: string; path: string; size: number }[];
  modelDirs: string[];
  savedDirs: string[];
  servers: string[];
  /** 随包自带的 llama-server 路径（没有就是空串）。 */
  bundled: string;
  recommended: { name: string; path: string; size: number } | null;
  settings: {
    serverPath: string;
    modelPath: string;
    port: number;
    keepAliveSeconds: number;
    /** 上下文长度（`contextSize`）—— 界面上要能改它，也要拿它算显存。 */
    contextSize: number;
    /** -1 = 全部层上显卡；0 = 纯 CPU。 */
    gpuLayers: number;
    cacheTypeK: string;
    cacheTypeV: string;
  };
};

/**
 * 显存估算（`GET /api/local-llm/estimate`）。
 *
 * 三个分量分开给：用户要判断的是「我能把哪一项调小」，
 * 只给一个总数等于让他自己猜 KV 缓存占了多少 —— 而那正是上下文长度决定的那一项。
 */
export type VramView = {
  ok: boolean;
  note: string;
  contextSize: number;
  weightsGb: number;
  kvGb: number;
  overheadGb: number;
  totalGb: number;
  cpuOnly: boolean;
  /** 本机显卡显存总量（GB）；探不到就是 null（没 N 卡 / 没驱动）。 */
  deviceGb: number | null;
};

/** 引擎状态（`GET /api/local-llm/status`）—— `log` 是排查启动失败的唯一线索。 */
export type LocalLlmStatus = {
  state: 'stopped' | 'starting' | 'ready' | 'error';
  message: string;
  log: string;
  running: boolean;
  port: number;
  modelPath: string;
  resolvedServerPath: string;
};

/**
 * 引擎状态在界面上的说法。
 *
 * `error` 不直接摊给用户看：他要知道的是「现在能不能用」，「Engine exited with code 3221225781」
 * 那种话留给下面那个可展开的日志块。
 */
const LOCAL_STATE_TEXT: Record<LocalLlmStatus['state'], string> = {
  stopped: '未装载', starting: '正在装载…', ready: '已装载', error: '装载失败',
};

/**
 * 运行时在下拉里的名字（2026-09-26）。
 *
 * ⚠️ 不能只显示文件名：本机扫到的 5 套都叫 `llama-server.exe`，
 *    五个一模一样的选项等于没得选。真正区分它们的是**所在目录名**
 *    （`vulkan-avx2-2.28.2` / `nvidia-cuda12-avx2-2.29.1` …）—— 后端报错也是这么说的。
 */
function serverLabel(value: string, bundled: string) {
  const raw = String(value || '');
  if (!raw) return '';
  if (bundled && raw.toLowerCase() === bundled.toLowerCase()) return '内置（Holy Light画布自带）';
  const parts = raw.split(/[\\/]/);
  const dir = parts.length > 1 ? parts[parts.length - 2] : '';
  /* `llama.cpp-win-x86_64-vulkan-avx2-2.28.2` → `vulkan-avx2-2.28.2`：前半截每套都一样，留着没用。 */
  const short = dir.replace(/^llama\.cpp-win-x86_64-/, '').replace(/^llama\.cpp-/, '');
  return short || parts[parts.length - 1];
}

/** 本机路径太长，卡片上只显示文件名。 */
function shortName(value: string) {
  const parts = String(value || '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/** 体积给人看：0.52 GB / 214 MB。 */
/**
 * 上下文长度的推荐档位（2026-09-27）。
 *
 * **光给数字没用** —— 用户不知道 8192 够干什么。所以每档都带一句实测出来的话：
 * 不挂技能的一次优化只要 80 token，而技能正文最多 12000 字（实测 7874 token），
 * 默认的 4096 直接撑爆（llama-server 回 400 exceed_context_size_error）。
 */
const CTX_PRESETS = [
  { value: 4096, label: '4096', hint: '默认。够普通优化（不挂技能，实测 80 token）；挂技能会撑爆' },
  { value: 8192, label: '8192', hint: '够挂一段中等长度的技能（两三千字那种）' },
  { value: 16384, label: '16384', hint: '够挂满字数的技能（12000 字，实测 7874 token）' },
  { value: 32768, label: '32768', hint: '长技能 + 长提示词；KV 缓存是 4096 的 8 倍，显存吃得多' },
];

function formatSize(bytes: number) {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * 「刚探到 N 个模型」那一行最多列几个 id。
 *
 * 中转站一次能报几百个，全拼成一行就是一堵看不完的墙 —— 而那一行的作用只是
 * 让人确认「拉到的是不是这个站的模型」，列十来个够认了，剩下的用个数说话。
 */
const PROBED_PREVIEW = 12;

/** 模型清单超过这么多条就给筛选框（几百个模型靠眼睛扫是不现实的）。 */
const MODEL_FILTER_AT = 20;

export type ModelServicesPayload = {
  runninghub: { active: 'cn' | 'ai'; cn: SiteView; ai: SiteView };
  /**
   * 国内站那一条连接（历史表，每个账号一把）。
   *
   * 「服务连接」页并进来之后，填 Key / 清除密钥 / 看密钥来源都靠它。
   * 海外站不在这一项里 —— 它走密钥池，看 `runninghub.ai.keys`。
   */
  connection: ConnectionView;
  text: TextView[];
  /** 直连网关，按段分好（分类来自注册表的 `MEDIA_GROUP`）。 */
  media: { image: GatewayView[]; video: GatewayView[] };
  cli: { id: string; label: string; summary: string }[];
  custom: CustomView[];
  customModels: { image: ModelOption[]; video: ModelOption[]; text: ModelOption[] };
  promptProvider: string;
  promptSource: { provider: string; label: string } | null;
  sites: { id: string; label: string; host: string }[];
};

type CustomModel = { id: string; name: string; kinds: Kind[] };
type Notice = { tone: 'ok' | 'off'; text: string } | null;
type CustomDraft = { name: string; baseUrl: string; apiKey: string };
type SiteDraft = { baseUrl: string; username: string; password: string };
/** 徐先自己的中转站。只是给「站点地址」一个默认值，手填照样能用别的站。 */
const DEFAULT_SITE = 'https://www.myvigna.top';

const KIND_LABEL: Record<Kind, string> = { image: '出图', video: '出视频', text: '文本' };

/** 用途勾选框的顺序。出图放最前 —— 它是最常用的那个。 */
const KIND_ORDER: Kind[] = ['image', 'video', 'text'];

/** 三段的标题与说明。顺序就是页面顺序：先文本，再图片，再视频。 */
const SECTIONS: { id: Kind; title: string; hint: string }[] = [
  {
    id: 'text',
    title: '文本',
    hint: '只给节点上的「优化提示词」供血 —— 这一段的官方模型与兼容接口文本模型，会出现在节点「优化提示词用」的下拉里。',
  },
  {
    id: 'image',
    title: '图片',
    hint: '图片生成节点的三个来源：RunningHub 工作流、本地 ComfyUI，以及这一段里加的兼容接口。',
  },
  {
    id: 'video',
    title: '视频',
    hint: '视频生成节点的四个来源：RunningHub 工作流（与图片段共用同一把 Key）、本地 ComfyUI、视频网关，以及这一段里加的兼容接口。',
  },
];

function statusTone(status: string, hasKey: boolean) {
  if (!hasKey) return 'off';
  return status === 'verified' ? 'ok' : '';
}

function siteStatusText(status: string, hasKey: boolean) {
  if (!hasKey) return '未配置';
  return status === 'verified' ? '连接正常' : status === 'failed' ? '连接失败' : '未验证';
}

export default function ModelServices({ initial, reload }: { initial: ModelServicesPayload; reload: () => void }) {
  const [busy, setBusy] = useState<string>('');
  const [notice, setNotice] = useState<Notice>(null);
  /** 正在填写的那家（官方文本厂商 / 直连网关 / 海外站 Key）—— 点「填 Key」才展开。 */
  const [keyForm, setKeyForm] = useState<string>('');
  const [keyDraft, setKeyDraft] = useState({ baseUrl: '', model: '', apiKey: '' });
  /*
   * 新增兼容接口的表单，**三段各一份**。
   *
   * 共用一份的话，在「图片」段打字，「视频」段那张表单会跟着变 —— 界面上看着像
   * 「我已经在视频段填好了」，而实际提交的是另一个用途。
   */
  const [draft, setDraft] = useState<Record<Kind, CustomDraft>>({
    text: { name: '', baseUrl: '', apiKey: '' },
    image: { name: '', baseUrl: '', apiKey: '' },
    video: { name: '', baseUrl: '', apiKey: '' },
  });
  /*
   * 「先测一下」探到的模型清单（还没保存的那条），同样**三段各一份**。
   *
   * 保存时**一起带上**：用户刚刚才测过一次，结果就在眼前，再让他点一次「拉取模型」
   * 等于把同一个请求打两遍 —— 而他那时的直觉是「我明明已经配好了」。
   */
  const [probed, setProbed] = useState<Record<Kind, CustomModel[]>>({ text: [], image: [], video: [] });
  /** 展开的那条接口，写成 `<kind>#<id>`：同一条接口在三段里都能展开，各自独立。 */
  const [openCustom, setOpenCustom] = useState<string>('');
  /*
   * 站点账号（中转站的网站账号）—— 一个用户只有一个，不属于任何一段。
   * 读的是 `lib/site-account.ts` 那个**共享 store**：侧栏那张卡、用户页、页头余额
   * 用的是同一份，全站只往站点打一趟（那边有 20 次 / 20 分钟的 IP 限流）。
   */
  const { site } = useSiteAccount();
  /** 登录表单。**没登录**时才用得上；「换账号」时拿它重填。 */
  const [siteForm, setSiteForm] = useState<SiteDraft>({
    baseUrl: DEFAULT_SITE, username: '', password: '',
  });
  /*
   * 站点那一块**就地**的回执（与页面顶部那条 `notice` 内容相同）。
   * 为什么要两份：顶部那条在整页最上面，而按钮在中段 —— 点完屏幕里什么都看不到，
   * 看起来就像「没反应」（2026-09-25 徐先就是这么以为的）。
   */
  const [siteNote, setSiteNote] = useState<Notice>(null);
  /** 展开那条接口的模型筛选关键字。 */
  const [modelQuery, setModelQuery] = useState('');
  /*
   * 本地模型（2026-09-27 徐先：「添加本地模型卡片，用于优化提示词，先装载、优化完卸载」）。
   *
   * 它跟上面那些厂商**不是一类东西**：那些填一把 Key 就能用，而这个要在本机 spawn
   * 一个 llama-server、用完还得卸掉（显存是硬约束）。所以它有自己的状态要轮询、
   * 自己的设置要存 —— 卡片就干这三件事：选、装/卸、测一下。
   *
   * `keepAliveSeconds` 初始给空串（不是 '0'）：要等第一次读到服务端设置才能填，
   * 否则会用界面上的默认值把用户存过的保活秒数悄悄覆盖掉。
   */
  const [localView, setLocalView] = useState<LocalLlmView | null>(null);
  const [localStatus, setLocalStatus] = useState<LocalLlmStatus | null>(null);
  const [localDraft, setLocalDraft] = useState({
    modelPath: '', serverPath: '', keepAliveSeconds: '', port: '',
    /*
     * 跟上面那些一样先给空串：要等第一次读到服务端设置才填，
     * 否则界面上的默认值会把用户存过的数悄悄覆盖掉。
     */
    contextSize: '',
  });
  const [localBusy, setLocalBusy] = useState('');
  const [localNote, setLocalNote] = useState<Notice>(null);
  /** 显存估算（换模型 / 改上下文时重算）。 */
  const [vram, setVram] = useState<VramView | null>(null);
  /** 深度扫描：盘符清单（GET /api/local-llm/scan）+ 正在扫的标志。 */
  const [localDrives, setLocalDrives] = useState<string[]>([]);
  const [localScanDrive, setLocalScanDrive] = useState('');
  const [localScanning, setLocalScanning] = useState(false);

  /**
   * 三段的收纳状态（2026-09-26 徐先：「这个界面的内容有点多，加一个收纳效果」）。
   *
   * 进来时三段都是收起的 —— 这一页原来要滚五六屏，想找「图片」那张卡得先路过整段「文本」。
   * **各自独立**（不是手风琴）：可以同时开着 —— 「图片」和「视频」常常要对着看，
   * RunningHub 在两段里本来就是共用的一把 Key。
   *
   * 不做持久化：哪一段开着是「这一趟在看什么」，不是配置。下次进来重新选，
   * 否则上次随手点开的一段会一直替用户做决定。
   */
  const [openSections, setOpenSections] = useState<Record<Kind, boolean>>({
    text: false, image: false, video: false,
  });
  const hashAt = openCustom.indexOf('#');
  const openKind = (hashAt > 0 ? openCustom.slice(0, hashAt) : '') as Kind;
  const openRow = hashAt > 0 ? initial.custom.find(item => item.id === openCustom.slice(hashAt + 1)) || null : null;
  /*
   * 筛选**只对「模型多到需要筛」的站生效**。
   *
   * 关键字是整页共享的一个 state：在大站筛了「seedream」再展开小站，小站会被筛成空清单，
   * 而它不足 MODEL_FILTER_AT 条、连筛选框都没有 —— 用户看着就是「模型全没了」，还没处清。
   * 所以阈值以下的站永远整列，另外切换展开项时会把关键字清掉（见展开按钮）。
   */
  const openQuery = modelQuery.trim().toLowerCase();
  const shownModels = openRow
    ? (openRow.models.length > MODEL_FILTER_AT && openQuery
      ? openRow.models.filter(item => item.id.toLowerCase().includes(openQuery))
      : openRow.models)
    : [];

  async function run(tag: string, task: () => Promise<{ ok: boolean; text: string }>) {
    setBusy(tag);
    setNotice(null);
    try {
      const result = await task();
      setNotice({ tone: result.ok ? 'ok' : 'off', text: result.text });
      reload();
    } catch (error) {
      setNotice({ tone: 'off', text: error instanceof Error ? error.message : '操作失败。' });
    } finally {
      setBusy('');
    }
  }


  /* ── 本地模型 ─────────────────────────────────────────────── */

  /** 拉一次「有什么模型 / 有什么运行时 / 现在什么状态」。 */
  async function refreshLocal() {
    try {
      const view = await apiGet<LocalLlmView>('/api/local-llm/models');
      setLocalView(view);
      setLocalDraft(prev => ({
        modelPath: prev.modelPath || view.settings.modelPath || view.recommended?.path || '',
        serverPath: prev.serverPath || view.settings.serverPath || '',
        keepAliveSeconds: prev.keepAliveSeconds === '' ? String(view.settings.keepAliveSeconds) : prev.keepAliveSeconds,
        port: prev.port || String(view.settings.port),
        contextSize: prev.contextSize === '' ? String(view.settings.contextSize ?? 4096) : prev.contextSize,
      }));
      setLocalStatus(await apiGet<LocalLlmStatus>('/api/local-llm/status'));
      const drives = await apiGet<{ drives: string[] }>('/api/local-llm/scan').catch(() => null);
      if (drives?.drives?.length) setLocalDrives(drives.drives);
    } catch (error) {
      setLocalNote({ tone: 'off', text: error instanceof Error ? error.message : '读不到本地模型的信息。' });
    }
  }

  /*
   * 显存占用随「模型 + 上下文」变，这两个值一变就重算一次。
   *
   * 算的是**界面上正在填的那份**（draft），不是存过的那份 ——
   * 用户正在敲 32768 的时候，他要看见的就是 32768 的代价，而不是「存了才告诉你」。
   */
  useEffect(() => {
    const view = localView;
    if (!view) return;
    const modelPath = localDraft.modelPath || view.settings.modelPath || view.recommended?.path || '';
    const contextSize = Number(localDraft.contextSize) || view.settings.contextSize || 4096;
    if (!modelPath) {
      setVram(null);
      return;
    }
    let cancelled = false;
    const qs = new URLSearchParams({ modelPath, contextSize: String(contextSize) });
    apiGet<VramView>(`/api/local-llm/estimate?${qs.toString()}`)
      .then(value => { if (!cancelled) setVram(value); })
      .catch(() => { if (!cancelled) setVram(null); });
    return () => { cancelled = true; };
  }, [localView, localDraft.modelPath, localDraft.contextSize]);

  useEffect(() => {
    void refreshLocal();
    /* 只在进这一页时拉一次：本地模型的状态变化都由卡片自己的操作触发，不需要常驻轮询。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 装载期间轮询状态。
   *
   * 4B 模型要几十秒才进显存，中途不给反馈就是「点了没反应」——
   * 所以点完装载一定要把它盯到 `ready` 或 `error` 为止（最长 3 分钟，与后端超时一致）。
   */
  async function watchLocal(limit = 180, settled?: (s: LocalLlmStatus) => boolean) {
    for (let i = 0; i < limit; i += 1) {
      const status = await apiGet<LocalLlmStatus>('/api/local-llm/status').catch(() => null);
      if (!status) return;
      setLocalStatus(status);
      /* 默认「不再是 starting 就算完事」；优化那条路要的是「等它真的卸掉」。 */
      if (settled ? settled(status) : status.state !== 'starting') return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /** 存设置。改模型 / 运行时 / 保活 / 端口都走它 —— 后端每次优化都现读这份设置。 */
  async function saveLocal(patch: Record<string, unknown>) {
    try {
      await apiPost('/api/local-llm/settings', patch);
    } catch (error) {
      setLocalNote({ tone: 'off', text: error instanceof Error ? error.message : '设置没存上。' });
      throw error;
    }
  }

  /**
   * 上下文长度的预设档位：点了就填进输入框**并立刻存**。
   *
   * 立刻存是必须的 —— 这个数只在引擎启动时才会被读进去，
   * 只改界面上的 draft 而不落库，用户会以为「我选了 16384」结果下一次装载还是旧的。
   */
  async function applyContextPreset(value: number) {
    setLocalDraft(prev => ({ ...prev, contextSize: String(value) }));
    try {
      await saveLocal({ contextSize: value });
    } catch {
      /* saveLocal 已经把错误摆到卡片上了，这里不重复提示。 */
    }
  }

  /**
   * 加一个模型文件夹（2026-09-26，徐先：「选择模型文件夹」）。
   *
   * 走主进程的系统选目录框 —— 那种又长又容易打错的路径不能让用户手敲。
   * 加完立刻重扫：他要的是「我选完就能在下拉里看见」，不是「存起来了」。
   */
  async function addModelDir() {
    const dir = await pickFolderPath({ title: '选一个装着 .gguf 模型的文件夹' });
    if (!dir) return;
    setLocalNote(null);
    const current = localView?.savedDirs ?? [];
    if (current.includes(dir)) {
      setLocalNote({ tone: 'ok', text: `这个目录已经在列表里了：${dir}` });
      return;
    }
    try {
      await apiPost('/api/local-llm/settings', { modelDirs: [...current, dir] });
      await refreshLocal();
      setLocalNote({ tone: 'ok', text: `已加入并重新扫描：${dir}` });
    } catch (error) {
      setLocalNote({ tone: 'off', text: error instanceof Error ? error.message : '这个目录没加进去。' });
    }
  }

  /** 直接挑一个 .gguf 文件 —— 模型散着放（不成目录体系）时比选目录快。 */
  async function pickModelFile() {
    const file = await pickFilePath({
      title: '选一个 GGUF 模型',
      filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }],
    });
    if (!file) return;
    setLocalNote(null);
    setLocalDraft(prev => ({ ...prev, modelPath: file }));
    try {
      await saveLocal({ modelPath: file });
      await refreshLocal();
      setLocalNote({ tone: 'ok', text: `已选模型：${file}` });
    } catch {
      /* saveLocal 自己会写 note */
    }
  }

  /**
   * 深度扫描：真·递归扫盘找 .gguf（2026-09-26，徐先：「直接扫一遍电脑」）。
   *
   * ⚠️ 后端是同步扫的，几十秒都可能 —— 期间整个后端进程是占着的，
   *    所以按钮要立刻变「扫着…」并锁住（以界面自己的状态为准，不能等响应）。
   */
  async function deepScan() {
    setLocalScanning(true);
    setLocalNote(null);
    try {
      const result = await apiPost<{ models: unknown[]; dirs: number; files: number; elapsedMs: number; truncated: boolean }>(
        '/api/local-llm/scan',
        localScanDrive ? { roots: [localScanDrive] } : {},
      );
      await refreshLocal();
      setLocalNote({
        tone: 'ok',
        text: `扫了 ${result.dirs} 个目录 / ${result.files} 个文件，找到 ${result.models.length} 个模型，`
          + `用时 ${(result.elapsedMs / 1000).toFixed(1)} 秒${result.truncated ? '（撞到上限提前停了，没扫完）' : ''}。`,
      });
    } catch (error) {
      setLocalNote({ tone: 'off', text: error instanceof Error ? error.message : '扫描没跑完。' });
    } finally {
      setLocalScanning(false);
    }
  }

  /** 不再扫某个目录（列表里那个小 ×）。 */
  async function removeModelDir(dir: string) {
    const next = (localView?.savedDirs ?? []).filter(item => item !== dir);
    try {
      await apiPost('/api/local-llm/settings', { modelDirs: next });
      await refreshLocal();
    } catch (error) {
      setLocalNote({ tone: 'off', text: error instanceof Error ? error.message : '没能去掉这个目录。' });
    }
  }

  async function startLocal() {
    setLocalBusy('local:start');
    setLocalNote(null);
    try {
      /* 先把卡片上选的模具交过去：用户点「装载」时看到的是这一份，装的就该是这一份。 */
      await apiPost('/api/local-llm/start', {
        modelPath: localDraft.modelPath,
        serverPath: localDraft.serverPath,
        port: Number(localDraft.port) || undefined,
      });
      setLocalNote({ tone: 'ok', text: '装载完成。' });
    } catch (error) {
      setLocalNote({ tone: 'off', text: error instanceof Error ? error.message : '装载失败。' });
    } finally {
      setLocalBusy('');
      await watchLocal();
      await refreshLocal();
    }
  }

  async function stopLocal() {
    setLocalBusy('local:stop');
    try {
      const status = await apiPost<LocalLlmStatus>('/api/local-llm/stop');
      setLocalStatus(status);
      setLocalNote({ tone: 'ok', text: '已卸载，显存还回去了。' });
    } catch (error) {
      setLocalNote({ tone: 'off', text: error instanceof Error ? error.message : '卸载失败。' });
    } finally {
      setLocalBusy('');
    }
  }

  /**
   * 「测一下」走的是**真正那条路**（`/api/prompt/optimize` + `provider: 'local'`），
   * 不是单独调一次引擎 —— 只有这样才能证明「装载 → 优化 → 卸载」整条链是通的。
   * 跑完再看一眼状态：保活是 0 的话，这时应该已经回到「未装载」。
   */
  async function testLocal() {
    setLocalBusy('local:test');
    setLocalNote(null);
    try {
      const result = await apiPost<{ optimizedPrompt: string; latencyMs: number }>(
        '/api/prompt/optimize',
        { prompt: '一只橘猫趴在窗台上晒太阳', provider: 'local' },
      );
      setLocalNote({ tone: 'ok', text: `本地模型跑通了（${result.latencyMs} ms）：${result.optimizedPrompt}` });
    } catch (error) {
      setLocalNote({ tone: 'off', text: error instanceof Error ? error.message : '本地模型没跑通。' });
    } finally {
      setLocalBusy('');
      /* 卸载是立刻触发的（stopLlm 不 await），给它几秒；保活 >0 时等不到也无所谓。 */
      await watchLocal(8, s => s.state === 'stopped' || s.state === 'error');
    }
  }

  /**
   * 本地模型卡。
   *
   * 为什么单独占一张卡而不是塞进上面那个厂商列表：它的操作面完全不一样 ——
   * 上面那些是「填 Key / 用它优化」两颗按钮，这里是「选模型 + 选运行时 + 保活秒数 + 装/卸」。
   * 混在一起会被当成「又一家要填 Key 的」。
   */
  function localLlmCard() {
    const view = localView;
    const status = localStatus;
    /*
     * 「点完装载」到「后端真的开始拉模型」之间隔着一个要等几十秒才返回的请求，
     * 这段时间服务端状态还是 stopped —— 照实显示就是「点了没反应」。
     * 所以「正在装载」这件事以**界面自己的 busy** 为准，先显示出来。
     */
    const state: LocalLlmStatus['state'] =
      localBusy === 'local:start' ? 'starting' : (status?.state ?? 'stopped');
    const active = initial.promptProvider === 'local';
    const models = view?.models ?? [];
    const servers = view?.servers ?? [];
    const savedDirs = view?.savedDirs ?? [];
    const bundled = view?.bundled ?? '';
    const keepAlive = Number(localDraft.keepAliveSeconds) || 0;
    return <div
      className={`ms-site ms-local${active ? ' active' : ''}`}
      data-ms-local-llm={state}
      id="ms-section-local"
    >
      <div className="ms-site-head">
        <div className="ms-vendor-main">
          <strong>本地模型（llama.cpp）</strong>
          <p>
            用本机显卡跑一个小模型来优化提示词 —— 不联网、不花额度。
            用的时候装载，跑完按下面的「保活秒数」卸载（<strong>0 = 立刻卸</strong>，显存一秒都不多占）。
          </p>
        </div>
        <div className="ms-vendor-side">
          <span className="badge" data-ms-local-state={state}>{LOCAL_STATE_TEXT[state]}</span>
          <button className="button secondary" disabled={busy !== '' || localBusy !== ''} data-ms-local-pick=""
            onClick={() => pickPromptProvider('local')}>
            用它优化
          </button>
        </div>
      </div>

      {!models.length && (
        <p className="muted" data-ms-local-empty>
          本机没扫到 .gguf 模型。把它放进 <code>E:\llm\model</code> 这类常见目录（或 <code>~/.lmstudio/models</code>），
          再点「重新扫描」。
        </p>
      )}

      <div className="ms-local-find" data-ms-local-find="">
        <button className="button secondary" data-ms-local-add-dir=""
          disabled={localBusy !== '' || localScanning}
          onClick={() => void addModelDir()}>
          加模型文件夹
        </button>
        <button className="button secondary" data-ms-local-pick-file=""
          disabled={localBusy !== '' || localScanning}
          onClick={() => void pickModelFile()}>
          选 .gguf 文件
        </button>
        <span className="ms-local-scan">
          <select data-ms-local-drive="" value={localScanDrive}
            aria-label="深度扫描哪个盘"
            onChange={event => setLocalScanDrive(event.target.value)}>
            <option value="">（所有盘）</option>
            {localDrives.map(drive => <option key={drive} value={drive}>{drive}</option>)}
          </select>
          <button className="button secondary" data-ms-local-deep=""
            disabled={localBusy !== '' || localScanning}
            onClick={() => void deepScan()}>
            {localScanning ? '扫着…' : '深度扫描'}
          </button>
        </span>
      </div>

      {savedDirs.length ? (
        <div className="ms-local-dirs" data-ms-local-dirs="">
          <span className="ms-local-dirs-tag">记着的目录</span>
          {savedDirs.map(dir => (
            <span key={dir} className="ms-local-dir" title={dir}>
              {dir}
              <button type="button" data-ms-local-dir-drop={dir} aria-label="不再扫这个目录"
                onClick={() => void removeModelDir(dir)}>×</button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="ms-row">
        <label className="field" style={{ flex: '2 1 260px' }}>
          <span>模型（.gguf）</span>
          <select data-ms-local-model value={localDraft.modelPath}
            onChange={event => {
              const modelPath = event.target.value;
              setLocalDraft({ ...localDraft, modelPath });
              void saveLocal({ modelPath });
            }}>
            <option value="">（自动挑一个能跑的）</option>
            {models.map(item => <option key={item.path} value={item.path}>
              {item.name}（{formatSize(item.size)}）
            </option>)}
          </select>
        </label>
        <label className="field" style={{ flex: '2 1 260px' }}>
          <span>运行时（llama-server.exe）</span>
          <select data-ms-local-server value={localDraft.serverPath}
            onChange={event => {
              const serverPath = event.target.value;
              setLocalDraft({ ...localDraft, serverPath });
              void saveLocal({ serverPath });
            }}>
            <option value="">（自动挑：先试能上显卡的，起不来换下一个）</option>
            {servers.map(item => <option key={item} value={item}>{serverLabel(item, bundled)}</option>)}
          </select>
        </label>
        <label className="field" style={{ flex: '0 1 130px' }}>
          <span>保活秒数</span>
          <input type="number" min={0} max={3600} step={30} data-ms-local-keepalive
            value={localDraft.keepAliveSeconds}
            onChange={event => setLocalDraft({ ...localDraft, keepAliveSeconds: event.target.value })}
            onBlur={event => void saveLocal({ keepAliveSeconds: Number(event.target.value) || 0 })} />
        </label>
        <label className="field" style={{ flex: '0 1 110px' }}>
          <span>端口</span>
          <input type="number" min={1024} max={65535} data-ms-local-port
            value={localDraft.port}
            onChange={event => setLocalDraft({ ...localDraft, port: event.target.value })}
            onBlur={event => void saveLocal({ port: Number(event.target.value) || 0 })} />
        </label>
        <label className="field" style={{ flex: '0 1 150px' }}>
          <span>上下文长度</span>
          <input type="number" min={512} max={65536} step={512} data-ms-local-context
            title="一次能塞进去多少 token。调大能挂更长的技能，代价是 KV 缓存线性变胖（显存）"
            value={localDraft.contextSize}
            onChange={event => setLocalDraft({ ...localDraft, contextSize: event.target.value })}
            onBlur={event => void saveLocal({
              contextSize: Number(event.target.value) || view?.settings.contextSize || 4096,
            })} />
        </label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {CTX_PRESETS.map(item => (
            <button key={item.value} type="button" className="button secondary"
              data-ms-local-ctx-preset={String(item.value)}
              aria-pressed={Number(localDraft.contextSize) === item.value}
              title={item.hint}
              onClick={() => void applyContextPreset(item.value)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/*
        显存占用：把三个分量摊开写，因为用户要判断的是「我能把哪一项调小」。
        只给一个总数等于让他自己猜 KV 缓存占了多少 —— 而那正是上下文长度决定的那一项。
      */}
      {vram ? (
        <p className="muted" data-ms-local-vram={vram.totalGb > 0 ? 'on' : 'off'}>
          {vram.cpuOnly
            ? '现在是 0 层上显卡（纯 CPU 推理），不吃显存 —— 但会慢很多'
            : `预计显存占用 ~${vram.totalGb.toFixed(2)} GB`
              + `（模型 ${vram.weightsGb.toFixed(2)} + KV 缓存 ${vram.kvGb.toFixed(2)} + 运行开销 ${vram.overheadGb.toFixed(2)}）`}
          {vram.deviceGb ? ` · 本机显卡 ${vram.deviceGb.toFixed(1)} GB` : ''}
          {vram.deviceGb && vram.totalGb > vram.deviceGb
            ? ' —— 装不下，把上下文调小或换个更小的模型'
            : ''}
          {vram.ok && vram.note ? ` · ${vram.note}` : ''}
        </p>
      ) : null}

      {/*
        装着的引擎不会跟着改 —— 这一句是必须的，否则用户会以为「我改成 16384 了」
        而实际跑的还是装载时那个 4096 的进程（参数签名只在启动那一步比对）。
      */}
      {state !== 'stopped' && state !== 'error' ? (
        <p className="muted" data-ms-local-ctx-reload="">
          上下文 / 模型这类参数只在**装载时**读进去 —— 改完要点「卸载」再「装载」才生效。
        </p>
      ) : null}

      <div className="key-actions">
        <button className="button" data-ms-local-load="" disabled={localBusy !== ''}
          onClick={() => void startLocal()}>
          {localBusy === 'local:start' ? '装载中…' : '装载'}
        </button>
        <button className="button secondary" data-ms-local-unload="" disabled={localBusy !== '' || state === 'stopped'}
          onClick={() => void stopLocal()}>
          卸载
        </button>
        <button className="button secondary" data-ms-local-test="" disabled={localBusy !== ''}
          onClick={() => void testLocal()}>
          {localBusy === 'local:test' ? '跑着…' : '测一下'}
        </button>
        <button className="button secondary" data-ms-local-rescan="" disabled={localBusy !== ''}
          onClick={() => void refreshLocal()}>
          重新扫描
        </button>
      </div>

      <p className="muted" data-ms-local-summary>
        状态：{status?.message || '还没读过引擎状态'}
        {status?.resolvedServerPath ? ` · 运行时 ${serverLabel(status.resolvedServerPath, bundled)}` : ''}
        {status?.modelPath ? ` · 模型 ${shortName(status.modelPath)}` : ''}
        {status ? ` · 端口 ${status.port}` : ''}
        {keepAlive > 0 ? ` · 跑完保活 ${keepAlive} 秒` : ' · 跑完立刻卸载'}
      </p>

      {localNote && <p className={localNote.tone === 'ok' ? 'ms-site-note ok' : 'ms-site-note off'}
        role="status" data-ms-local-note="">{localNote.text}</p>}

      {Boolean(status?.log) && <details className="ms-site-trace ms-local-log" data-ms-local-log="">
        <summary>引擎日志（装载失败时看这里）</summary>
        <pre>{status?.log}</pre>
      </details>}
    </div>;
  }

  const rh = initial.runninghub;
  const activeSite = rh.active === 'ai' ? rh.ai : rh.cn;

  /** 展开 / 收起某一段。 */
  function toggleSection(kind: Kind) {
    setOpenSections(prev => ({ ...prev, [kind]: !prev[kind] }));
  }

  /**
   * 段落之间跳转（共用凭证 / 别段入口用）。页面与画布浮层里都靠 `id` 定位。
   *
   * 🔴 跳之前**必须先把那一段展开**：收起状态下 `#ms-section-image` 只剩一条标题栏，
   * 视频段那颗「去「图片」段管密钥」点下去会落在一个空壳上，看着像没反应。
   * 展开要等 React 重渲染，所以滚动放进 `requestAnimationFrame`。
   */
  function jumpTo(kind: Kind) {
    setOpenSections(prev => (prev[kind] ? prev : { ...prev, [kind]: true }));
    requestAnimationFrame(() => {
      const node = document.getElementById('ms-section-' + kind);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function useSite(site: 'cn' | 'ai') {
    await run('site:' + site, async () => {
      await apiPost('/api/settings/model-services', { runninghubSite: site });
      return { ok: true, text: `已把 RunningHub 切到${site === 'ai' ? '海外站' : '国内站'}。` };
    });
  }

  async function testSite(site: 'cn' | 'ai') {
    await run('test:' + site, async () => {
      const result = await apiPost<{ ok: boolean; message: string }>('/api/providers/runninghub/test', { site });
      return { ok: result.ok, text: result.message };
    });
  }

  async function saveKey(id: string) {
    await run('key:' + id, async () => {
      await apiPost('/api/provider-keys', {
        provider: id,
        apiKey: keyDraft.apiKey,
        baseUrl: keyDraft.baseUrl,
        model: keyDraft.model,
        label: '',
      });
      setKeyForm('');
      setKeyDraft({ baseUrl: '', model: '', apiKey: '' });
      return { ok: true, text: '已保存。' };
    });
  }

  async function pickPromptProvider(id: string) {
    await run('pick:' + id, async () => {
      await apiPost('/api/settings/model-services', { promptProvider: id });
      return { ok: true, text: id ? '已指定提示词优化用的模型。' : '已改回「自动挑一家配了的」。' };
    });
  }

  async function addCustom(kind: Kind) {
    await run('custom:add:' + kind, async () => {
      await apiPost('/api/providers/custom', { ...draft[kind], models: probed[kind], defaultKind: kind });
      setDraft({ ...draft, [kind]: { name: '', baseUrl: '', apiKey: '' } });
      setProbed({ ...probed, [kind]: [] });
      return {
        ok: true,
        text: probed[kind].length
          ? `已添加，带上刚探到的 ${probed[kind].length} 个模型（用途归到${KIND_LABEL[kind]}）。`
          : `已添加。点「拉取模型」从接口拉一次清单 —— 拉不到模型的接口在节点上选不到模型。`,
      };
    });
  }

  /** 探活 / 拉取模型。`kind` 决定拉到的模型默认归到哪一段。 */
  async function testCustom(kind: Kind, id?: string) {
    await run('custom:test:' + kind + ':' + (id ?? 'new'), async () => {
      const result = await apiPost<{ ok: boolean; message: string; models: CustomModel[] }>(
        '/api/providers/custom/test',
        id ? { id, kind } : { baseUrl: draft[kind].baseUrl, apiKey: draft[kind].apiKey, kind },
      );
      /** 没保存的那条：探到的模型留下来，保存时一起带上（理由见 `probed` 那句注释）。 */
      if (!id) setProbed({ ...probed, [kind]: result.ok ? (result.models || []) : [] });
      return { ok: result.ok, text: result.message };
    });
  }

  /* ── 站点账号（中转站的网站账号）─────────────────────────── */

  /**
   * 强制重读一次站点账号。
   *
   * 只在「刷新密钥」那颗按钮上用：用户很可能刚去站点「令牌」页建了一把新的。
   * 平时读的是缓存 —— 每进一次这一页都去打一趟站点，只会更快撞上那边的限流。
   */
  function reloadSite() {
    void fetchSiteAccount(true);
  }

  /**
   * 登录并记住（密码加密落盘，JWT 快过期时用库里那份自动续）。
   *
   * 与早先那一版最大的区别：**不建令牌**。登录完只是把站点上已有的密钥列出来，
   * 徐先挑一把再点「添加」—— 建令牌那件事交回站点自己的网页，那儿看得见额度与过期时间，
   * 也撤得掉（2026-09-25 徐先：「也不用自动创建了，直接拉取登录账号密匙」）。
   */
  async function loginSite() {
    await run('site:login', async () => {
      try {
        const result = await apiPost<{ site: SiteAccountView }>('/api/site-account', {
          baseUrl: siteForm.baseUrl.trim(),
          username: siteForm.username.trim(),
          password: siteForm.password,
        });
        /* 拿到的这份直接写进共享 store —— 页头余额 / 侧栏那张卡跟着就变了，谁都不用再拉一趟。 */
        applySiteAccount(result.site);
        /* 登录成功就不再把密码留在内存里 —— 它已经加密落盘，续期用库里那份。 */
        setSiteForm({ ...siteForm, password: '' });
        const who = result.site.username || result.site.loginName;
        const text = result.site.tokens.length
          ? `已登录${who ? `（${who}）` : ''} —— 下面列出 ${result.site.tokens.length} 把密钥，挑一把添加。`
          : `已登录${who ? `（${who}）` : ''}，但这个账号在站点上一把密钥都没有 —— 去站点「令牌」页建一把再点「刷新」。`;
        setSiteNote({ tone: 'ok', text });
        return { ok: true, text };
      } catch (error) {
        /* 失败原因也要出现在**手边**，不能只丢在页面顶上。 */
        const said = error instanceof Error ? error.message : '登录站点失败。';
        setSiteNote({ tone: 'off', text: said });
        throw error;
      }
    });
  }

  /** 换账号：整行删掉（连密码一起），回到登录表单。 */
  async function switchSite() {
    await run('site:switch', async () => {
      await apiDelete('/api/site-account');
      setSiteForm({ baseUrl: site?.baseUrl || DEFAULT_SITE, username: site?.loginName || '', password: '' });
      applySiteAccount(null);
      setSiteNote(null);
      return { ok: true, text: '已退出站点账号 —— 换一个账号登录。' };
    });
  }

  /**
   * 把站点上**已有**的某一把密钥加成兼容接口。
   *
   * 传的是令牌 **id** 而不是 key：清单里那把是打码的（`sk-AB**********xyzw`），
   * 真拿去调 `/v1/*` 一律 401 —— 比留空更难查。完整密钥由后端再打一次
   * `POST /api/token/<id>/key` 换回来（见 `lib/providers/site.ts`）。
   */
  async function useSiteToken(tokenId: number, kind: Kind) {
    await run('site:use:' + tokenId + ':' + kind, async () => {
      try {
        const result = await apiPost<{ ok: boolean; provider: { name: string; baseUrl: string; models: number } }>(
          '/api/site-account/use-token',
          { tokenId, kind },
        );
        const text = `已加成${KIND_LABEL[kind]}接口「${result.provider.name}」` +
          (result.provider.models
            ? `，带上刚探到的 ${result.provider.models} 个模型。`
            : '。想让它出现在节点里，去对应那一段点「拉取模型」。');
        setSiteNote({ tone: 'ok', text });
        return { ok: true, text };
      } catch (error) {
        /* 失败原因同样要出现在**手边**：站点那一块离页顶那条回执有一屏远。 */
        const said = error instanceof Error ? error.message : '添加这把令牌失败。';
        setSiteNote({ tone: 'off', text: said });
        throw error;
      }
    });
  }

  async function removeCustom(id: string) {
    await run('custom:del:' + id, async () => {
      await apiDelete(`/api/providers/custom/${id}`);
      return { ok: true, text: '已删除这条接口。' };
    });
  }

  async function toggleCustom(row: CustomView) {
    await run('custom:toggle:' + row.id, async () => {
      await apiPatch(`/api/providers/custom/${row.id}`, { enabled: !row.enabled });
      return { ok: true, text: row.enabled ? '已停用。' : '已启用。' };
    });
  }

  /** 勾 / 取消一个用途。用途是**多选**的：一个模型可以同时出图 + 出视频 + 当文本用。 */
  async function toggleKind(row: CustomView, modelId: string, kind: Kind, on: boolean) {
    const current = row.models.find(item => item.id === modelId);
    const next = on
      ? (current?.kinds || []).filter(item => item !== kind)
      : [...(current?.kinds || []), kind];
    if (!next.length) return;
    await run('custom:kind:' + modelId, async () => {
      await apiPatch(`/api/providers/custom/${row.id}`, { modelKinds: { modelId, kinds: next } });
      return {
        ok: true,
        text: on
          ? `已去掉「${modelId}」的${KIND_LABEL[kind]}用途。`
          : `已给「${modelId}」加上${KIND_LABEL[kind]}用途 —— 它现在也能${kind === 'text' ? '用来优化提示词' : `用来${KIND_LABEL[kind]}`}了。`,
      };
    });
  }

  /* ── 共用零件 ────────────────────────────────────────────── */

  /** 官方文本厂商 / 直连网关 / 海外站共用的那张「填 Key」表单。 */
  function keyFields(id: string) {
    const vendor = initial.text.find(item => item.id === id) || null;
    const gateway = [...initial.media.image, ...initial.media.video].find(item => item.id === id) || null;
    return <div className="ms-form" style={{ width: '100%' }} data-ms-key-fields={id}>
      <label className="field"><span>接口地址{gateway && !gateway.defaultBaseUrl ? '（留空则用 .env 里那个）' : ''}</span>
        <input
          value={keyDraft.baseUrl}
          data-ms-key-baseurl
          onChange={event => setKeyDraft({ ...keyDraft, baseUrl: event.target.value })}
          placeholder={gateway ? gateway.defaultBaseUrl || 'https://…' : vendor?.defaultBaseUrl || 'https://…'}
        />
      </label>
      {vendor && <label className="field"><span>模型名</span>
        <input value={keyDraft.model} data-ms-key-model onChange={event => setKeyDraft({ ...keyDraft, model: event.target.value })} />
      </label>}
      <label className="field"><span>API Key</span>
        <input
          type="password"
          value={keyDraft.apiKey}
          data-ms-key-apikey
          onChange={event => setKeyDraft({ ...keyDraft, apiKey: event.target.value })}
          placeholder="sk-..."
        />
      </label>
      <div className="key-actions">
        <button className="button" disabled={busy !== '' || !keyDraft.apiKey} data-ms-key-save onClick={() => saveKey(id)}>保存</button>
        <button className="button secondary" onClick={() => setKeyForm('')}>取消</button>
      </div>
    </div>;
  }

  /** 一段里的「兼容接口」：列表 + 新增表单。三段共用同一份实现。 */
  function customBlock(kind: Kind) {
    /*
     * 一条接口在**每一段都出现**（2026-09-23 改的）。
     *
     * 原来按「这段有没有该用途的模型」过滤，结果一条只报了出图模型的接口在文本段、
     * 视频段根本不出现 —— 想把它改成「也能当文本用」都找不到地方勾，
     * 而「拉取模型（归到文本）」那个按钮也跟着一起消失。
     * 能不能在某段用，由模型上那几个用途勾选项决定；**行必须先看得见**。
     */
    const rows = initial.custom;
    const form = draft[kind];
    return <>
      <div className="ms-sub" data-ms-sub={kind}>
        <strong>兼容接口（OpenAI 兼容）</strong>
        <span className="muted">
          在「{SECTIONS.find(item => item.id === kind)?.title}」这一段添加或拉取的模型，按名字认用途，
          认不出来的归到{KIND_LABEL[kind]}；想让一个模型同时干几件事，展开后在清单里勾（用途是多选的）；
          随后出现在{kind === 'text' ? '节点上「优化提示词用」的下拉' : `${KIND_LABEL[kind]}节点的「自定义接口」引擎里`}。
        </span>
      </div>
      {rows.length === 0 && (
        <p className="muted" data-ms-custom-empty={kind}>
          这一段还没有兼容接口 —— 在下面填一条；已经加过的接口会**在每一段都出现**，
          把模型勾上「{KIND_LABEL[kind]}」，这一段就能用它。
        </p>
      )}
      <div className="ms-custom">
        {rows.map(row => {
          const inKind = row.models.filter(item => item.kinds.includes(kind)).length;
          const open = openKind === kind && openRow?.id === row.id;
          return <div key={row.id} className="ms-custom-row" data-ms-custom={row.id} data-ms-custom-in={kind}>
            <div className="ms-custom-head">
              <div>
                <strong>{row.name}</strong>
                <div className="ms-host">{row.baseUrl}</div>
                {/* 上次拉取的失败原因**就摆在行里**：状态徽章只有「连不上」三个字，说不清是 Key 错还是地址错。 */}
                {row.errorMessage && <div className="ms-error" data-ms-custom-error={row.id}>{row.errorMessage}</div>}
              </div>
              <div className="ms-vendor-side">
                <span className="badge">{row.masked}</span>
                <span className="badge" data-ms-custom-status={row.status}>
                  {row.status === 'verified' ? '已连通' : row.status === 'failed' ? '连不上' : '未验证'}
                </span>
                <span className="badge" data-ms-custom-count={row.id}>{KIND_LABEL[kind]} {inKind}</span>
                <button className="button secondary" data-ms-custom-open={row.id}
                  onClick={() => { setOpenCustom(open ? '' : kind + '#' + row.id); setModelQuery(''); }}>
                  {open ? '收起模型' : `看模型（共 ${row.models.length}）`}
                </button>
                <button className="button secondary" disabled={busy !== ''} data-ms-custom-fetch={row.id}
                  onClick={() => testCustom(kind, row.id)}>
                  {busy === 'custom:test:' + kind + ':' + row.id ? '拉取中…' : `拉取模型（归到${KIND_LABEL[kind]}）`}
                </button>
                <button className="button secondary" disabled={busy !== ''} data-ms-custom-toggle={row.id}
                  onClick={() => toggleCustom(row)}>{row.enabled ? '停用' : '启用'}</button>
                <button className="button secondary" disabled={busy !== ''} data-ms-custom-del={row.id}
                  onClick={() => removeCustom(row.id)}>删除</button>
              </div>
            </div>
            {open && <div className="ms-custom-body" data-ms-custom-models={row.id}>
              {row.models.length === 0
                ? <p className="muted">
                  还没有模型清单 —— 点上面「拉取模型」，从 <code>{row.baseUrl}</code> 的
                  {' '}<code>/v1/models</code>（拿不到再试 <code>/models</code>）拉一次。
                </p>
                : <>
                  {/*
                    中转站常常报几十上百个模型，全列出来等于没有清单。
                    给一个筛选框 + 分类计数：用途猜错了要改，靠的是能**找到**那一条。
                  */}
                  {row.models.length > MODEL_FILTER_AT && (
                    <div className="ms-model-filter">
                      <input
                        value={modelQuery}
                        data-ms-model-filter=""
                        aria-label="按模型名筛选"
                        placeholder="按模型名筛选（这个站报了几百个）"
                        onChange={event => setModelQuery(event.target.value)}
                      />
                      <span className="muted" data-ms-model-count={row.models.length}>
                        共 {row.models.length} 个 · 出图 {row.models.filter(item => item.kinds.includes('image')).length}
                        {' / '}视频 {row.models.filter(item => item.kinds.includes('video')).length}
                        {' / '}文本 {row.models.filter(item => item.kinds.includes('text')).length}
                        {shownModels.length !== row.models.length ? ` · 筛出 ${shownModels.length} 个` : ''}
                      </span>
                    </div>
                  )}
                  {/*
                    这条接口在**别的段**也有模型时说一句：否则用户会以为「这条只报了出图模型，
                    我的视频模型丢了」，而它们只是列在「视频」那一段里。
                  */}
                  {row.models.length > inKind && (
                    <p className="muted" data-ms-custom-other={row.id}>
                      另有 {row.models.length - inKind} 个模型没勾「{KIND_LABEL[kind]}」—— 这一段用不上它们。
                      用途是**多选**的：一个模型可以同时是出图 + 出视频 + 文本，在下面清单里勾就行。
                    </p>
                  )}
                  <div className="ms-models">
                    {shownModels.map(model => <div key={model.id} className="ms-model" data-ms-model={model.id}>
                      <code>{model.id}</code>
                      <div className="ms-model-kinds">
                        {KIND_ORDER.map(item => {
                          const on = model.kinds.includes(item);
                          /* 最后一个勾选项不许取消：一个用途都没有的模型在三段里都不会出现，那就没地方改回来了。 */
                          const last = on && model.kinds.length === 1;
                          return <label key={item} className="ms-kind" data-ms-model-kind={item}
                            title={last ? '至少要留一个用途' : `勾上后这个模型会出现在「${KIND_LABEL[item]}」那一段`}>
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={busy !== '' || last}
                              data-ms-model-kind-input={item}
                              onChange={() => toggleKind(row, model.id, item, on)}
                            />
                            <span>{KIND_LABEL[item]}</span>
                          </label>;
                        })}
                      </div>
                    </div>)}
                  </div>
                </>}
            </div>}
          </div>;
        })}
      </div>

      <div className="ms-form" data-ms-custom-new={kind}>
        <div className="ms-row">
          <label className="field" style={{ flex: '1 1 180px' }}><span>名称</span>
            <input value={form.name} data-ms-custom-name={kind}
              onChange={event => setDraft({ ...draft, [kind]: { ...form, name: event.target.value } })}
              placeholder="例如：我的中转" />
          </label>
          <label className="field" style={{ flex: '2 1 320px' }}><span>接口地址</span>
            <input value={form.baseUrl} data-ms-custom-url={kind}
              onChange={event => setDraft({ ...draft, [kind]: { ...form, baseUrl: event.target.value } })}
              placeholder="https://api.example.com/v1" />
          </label>
          <label className="field" style={{ flex: '2 1 260px' }}><span>API Key</span>
            <input type="password" value={form.apiKey} data-ms-custom-key={kind}
              onChange={event => setDraft({ ...draft, [kind]: { ...form, apiKey: event.target.value } })}
              placeholder="sk-..." />
          </label>
        </div>
        <div className="key-actions">
          <button className="button secondary" disabled={busy !== ''} data-ms-custom-test={kind}
            onClick={() => testCustom(kind)}>
            {busy === 'custom:test:' + kind + ':new' ? '拉取中…' : '先测一下'}
          </button>
          <button className="button" disabled={busy !== '' || !form.name || !form.baseUrl || !form.apiKey}
            data-ms-custom-save={kind} onClick={() => addCustom(kind)}>
            {probed[kind].length ? `添加接口（带上 ${probed[kind].length} 个模型）` : '添加接口'}
          </button>
        </div>
        {probed[kind].length > 0 && (
          <p className="muted" data-ms-probed={probed[kind].length}>
            刚探到 {probed[kind].length} 个模型，保存时会一起带上（认不出来的归到{KIND_LABEL[kind]}）：
            {' '}{probed[kind].slice(0, PROBED_PREVIEW).map(item => item.id).join('、')}
            {probed[kind].length > PROBED_PREVIEW ? ` …等 ${probed[kind].length} 个` : ''}
          </p>
        )}
      </div>
    </>;
  }

  /** 本地 ComfyUI：图片段与视频段各一张，只指路 —— 它不需要填 Key。 */
  function localCard(kind: Kind) {
    return <div key={'local-' + kind} className="ms-vendor" data-ms-local={kind}>
      <div className="ms-vendor-main">
        <strong>本地 ComfyUI</strong>
        <p>用你自己的 ComfyUI 跑本机工作流 —— 图与算力都在本机，不扣点。服务启停与状态在「ComfyUI 服务」页。</p>
      </div>
      <div className="ms-vendor-side">
        <span className="badge">用本机</span>
        <button className="button secondary" data-ms-goto-comfyui={kind}
          onClick={() => { window.location.hash = '#/settings/comfyui'; }}>去 ComfyUI 服务</button>
      </div>
    </div>;
  }

  /**
   * 直连网关那一栏（2026-09-23 起只有视频段的视频网关 —— 图片段的 Image 2.0 整条删了）。
   * 还是写成按段取，是因为「哪一段有直连网关」由注册表（`MEDIA_GROUP`）说了算，
   * 将来图片段再加一家，这里不用改。
   */
  function gatewayCards(kind: 'image' | 'video') {
    return initial.media[kind].map(item => <div key={item.id} className="ms-vendor" data-ms-gateway={item.id}>
      <div className="ms-vendor-main">
        <strong>{item.label}</strong>
        <p>{item.summary}</p>
        <p className="muted">
          {item.configured
            ? `已配置：${item.keys.length ? `${item.keys.length} 把 Key` : `环境变量 ${item.envKeyName}`}${item.defaultBaseUrl ? ` · ${item.defaultBaseUrl}` : ''}`
            : `还没配：填一把自己的 Key，或者让站长在 .env 里配 ${item.envKeyName}。`}
        </p>
      </div>
      <div className="ms-vendor-side">
        <span className="badge" data-ms-gateway-state={item.configured ? 'configured' : 'missing'}>
          {item.configured ? '已配置' : '未配置'}
        </span>
        <button className="button secondary" data-ms-gateway-form={item.id}
          onClick={() => {
            setKeyForm(keyForm === item.id ? '' : item.id);
            setKeyDraft({ baseUrl: item.defaultBaseUrl, model: '', apiKey: '' });
          }}>
          {item.configured ? '换一把 Key' : '填 Key'}
        </button>
      </div>
      {keyForm === item.id && keyFields(item.id)}
    </div>);
  }

  /* ── 三段 ────────────────────────────────────────────────── */

  /**
   * 段标题 —— **整条就是收纳开关**。收起时只留标题、说明和「里面装了多少」的徽章，
   * 点它展开；展开后再点收起。三段的开关各自独立。
   *
   * 为什么做成真的 `<button>` 而不是给 div 挂 onClick：键盘 Tab 能到、回车能开，
   * 不用自己补 role / tabIndex / onKeyDown 那一套（漏一个就是个只有鼠标能用的控件）；
   * `aria-expanded` 顺带把开关状态报给读屏。
   * 长得像个按钮是 CSS 的事 —— 全部覆盖在 `.ms-fold` 那一段里。
   */
  function sectionHead(kind: Kind) {
    const meta = SECTIONS.find(item => item.id === kind)!;
    const open = openSections[kind];
    return <button
      type="button"
      className={`provider-head ms-fold${open ? ' open' : ''}`}
      data-ms-section-toggle={kind}
      aria-expanded={open}
      onClick={() => toggleSection(kind)}
    >
      <span className="ms-fold-title">
        <h2>{meta.title}</h2>
        <p className="muted">{meta.hint}</p>
      </span>
      <span className="ms-fold-side">
        <span className="badge" data-ms-section-count={kind}>
          兼容接口 {initial.customModels[kind].length} 个{KIND_LABEL[kind]}模型
        </span>
        <span className="ms-fold-chev" aria-hidden="true" />
      </span>
    </button>;
  }

  return <div data-ms>
    {notice && <div className={notice.tone === 'ok' ? 'ms-result ok' : 'ms-result off'} data-ms-notice>{notice.text}</div>}

    {/* ── 站点账号 ─────────────────────────────────────────── */}
    <section className="provider" id="ms-section-site" data-ms-section="site">
      <div className="provider-head">
        <div>
          <h2>站点账号</h2>
          <p className="muted">
            用中转站的**网站账号**登录 —— 登录后列出这个账号在站点上**已有**的密钥（带分组），
            挑一把加成兼容接口。密码加密存在本机，下次打开自动续期；
            Holy Light画布不会在你的站上建任何令牌 —— 要新的令牌请去站点自己的「令牌」页。
          </p>
        </div>
        {site?.loggedIn && <span className="badge" data-ms-site-state="on">已登录</span>}
      </div>

      {!site?.loggedIn && (
        <div className="ms-site-form" data-ms-site-login-block>
          <label className="field" style={{ flex: '2 1 300px' }}><span>站点地址</span>
            <input value={siteForm.baseUrl} data-ms-site-url
              onChange={event => setSiteForm({ ...siteForm, baseUrl: event.target.value })}
              placeholder={DEFAULT_SITE} />
          </label>
          <label className="field" style={{ flex: '1 1 160px' }}><span>用户名</span>
            <input value={siteForm.username} data-ms-site-user
              onChange={event => setSiteForm({ ...siteForm, username: event.target.value })}
              placeholder="中转站的登录名" />
          </label>
          <label className="field" style={{ flex: '1 1 160px' }}><span>密码</span>
            <input type="password" value={siteForm.password} data-ms-site-pass
              onChange={event => setSiteForm({ ...siteForm, password: event.target.value })} />
          </label>
          <button
            className="button"
            type="button"
            data-ms-site-login
            disabled={busy !== '' || !siteForm.username || !siteForm.password}
            onClick={() => loginSite()}
          >
            {busy === 'site:login' ? '登录中…' : '登录并拉取密钥'}
          </button>
          <span className="muted">账号密码只用来换令牌，加密存在本机 —— 不存的话第二天 JWT 过期就得重登。</span>
        </div>
      )}

      {site?.loggedIn && <>
        <p className="muted" data-ms-site-account>
          当前账号：{site.username || site.loginName}
          {site.loginName && site.username !== site.loginName ? `（登录名 ${site.loginName}）` : ''}
          {' · '}<code>{site.baseUrl}</code>
          {site.group ? ` · 分组 ${site.group}` : ''}
          {' · '}余额 <strong data-ms-site-balance>{formatYuan(site.remainingYuan)}</strong>
        </p>
        <div className="key-actions">
          <button className="button secondary" disabled={busy !== ''} data-ms-site-switch
            onClick={() => switchSite()}>
            {busy === 'site:switch' ? '退出中…' : '换账号'}
          </button>
          <button className="button secondary" disabled={busy !== ''} data-ms-site-refresh
            onClick={reloadSite}>
            刷新密钥
          </button>
        </div>
        {site.error && <p className="ms-site-note off" data-ms-site-error>{site.error}</p>}
        {site.tokens.length === 0
          ? <p className="muted" data-ms-site-empty>
            这个账号在站点上一把密钥都没有 —— 去站点「令牌」页建一把，再回来点「刷新密钥」。
          </p>
          : <div className="ms-tokens" data-ms-site-tokens={site.tokens.length}>
            {site.tokens.map(token => <div key={token.id} className="ms-token" data-ms-token={token.id}>
              <div className="ms-token-main">
                <strong>{token.name || '（未命名）'}</strong>
                <span className="badge" data-ms-token-group={token.group || ''}>分组 {token.group || '（没写）'}</span>
                <code data-ms-token-key={token.id}>{token.masked}</code>
                {token.status !== null && token.status !== 1 && <span className="badge" data-ms-token-off={token.id}>已停用</span>}
              </div>
              <div className="ms-token-side">
                {/*
                  三颗按钮 = 三种用途。不做一个「用途」下拉：加完这条接口归到哪一段，
                  是这一页最需要一眼看清的事，藏在下拉里只会让人加错段。
                */}
                {KIND_ORDER.map(kind => <button key={kind} className="button secondary"
                  data-ms-token-use={token.id + ':' + kind}
                  disabled={busy !== ''}
                  onClick={() => useSiteToken(token.id, kind)}>
                  {busy === 'site:use:' + token.id + ':' + kind ? '添加中…' : `添加为${KIND_LABEL[kind]}`}
                </button>)}
              </div>
            </div>)}
          </div>}
      </>}

      {siteNote && (
        <p className={siteNote.tone === 'ok' ? 'ms-site-note ok' : 'ms-site-note off'}
          role="status" data-ms-site-note="site">
          {siteNote.text}
        </p>
      )}
      {!!site?.trace?.length && (
        <details className="ms-site-trace" data-ms-site-trace="site">
          <summary>这一路是怎么走的（排查用）</summary>
          <ol>{site.trace.map((line, index) => <li key={index}>{line}</li>)}</ol>
        </details>
      )}
    </section>

    {/* ── 文本 ─────────────────────────────────────────────── */}
    <section
      className={`provider ms-fold-sec${openSections.text ? ' open' : ''}`}
      id="ms-section-text"
      data-ms-section="text"
      data-ms-section-open={openSections.text ? 'yes' : 'no'}
    >
      {sectionHead('text')}
      {openSections.text && <div className="ms-fold-body" data-ms-section-body="text">
      <p className="muted" data-ms-prompt-current>
        当前：{initial.promptSource ? initial.promptSource.label : '一家都没配（自动挑选也没得挑）'}。
        这一栏不是用来聊天的 —— 它只给节点上的「优化提示词」供血。
      </p>

      <div className="key-actions" style={{ marginTop: 12 }}>
        <button className="button secondary" disabled={busy !== ''} data-ms-prompt-pick=""
          onClick={() => pickPromptProvider('')}>自动（按顺序挑一家配了的）</button>
      </div>

      <div className="ms-sub" data-ms-sub="builtin">
        <strong>官方大语言模型</strong>
        <span className="muted">至少配一家，节点上的「优化提示词」才点得动。</span>
      </div>
      <div className="ms-vendors">
        {initial.text.map(vendor => <div key={vendor.id}
          className={`ms-vendor${initial.promptProvider === vendor.id ? ' active' : ''}`}
          data-ms-text={vendor.id} data-ms-text-state={vendor.configured ? 'configured' : 'missing'}
        >
          <div className="ms-vendor-main">
            <strong>{vendor.label}</strong>
            <p>{vendor.summary}</p>
            {!vendor.configured && <p className="muted">没配时也可以用站长在 .env 里配的 {vendor.envKeyName}。</p>}
          </div>
          <div className="ms-vendor-side">
            <span className="badge">{vendor.configured ? '已配置' : '未配置'}</span>
            <button className="button secondary" disabled={busy !== ''} data-ms-prompt-pick={vendor.id}
              onClick={() => pickPromptProvider(vendor.id)}>
              用它优化
            </button>
            <button className="button secondary" data-ms-text-form={vendor.id}
              onClick={() => {
                setKeyForm(keyForm === vendor.id ? '' : vendor.id);
                setKeyDraft({ baseUrl: vendor.defaultBaseUrl, model: vendor.defaultModel, apiKey: '' });
              }}>
              {vendor.configured ? '换一把 Key' : '填 Key'}
            </button>
          </div>
          {keyForm === vendor.id && keyFields(vendor.id)}
        </div>)}

        {/* 命令行形态的两家：只显示，不提供填 Key 的入口。 */}
        {initial.cli.map(item => <div key={item.id} className="ms-vendor cli" data-ms-cli={item.id}>
          <div className="ms-vendor-main">
            <strong>{item.label}</strong>
            <p>{item.summary}</p>
          </div>
          <div className="ms-vendor-side"><span className="badge">未安装</span></div>
        </div>)}
      </div>

      {localLlmCard()}

      {customBlock('text')}
      </div>}
    </section>

    {/* ── 图片 ─────────────────────────────────────────────── */}
    <section
      className={`provider ms-fold-sec${openSections.image ? ' open' : ''}`}
      id="ms-section-image"
      data-ms-section="image"
      data-ms-section-open={openSections.image ? 'yes' : 'no'}
    >
      {sectionHead('image')}
      {openSections.image && <div className="ms-fold-body" data-ms-section-body="image">

      <div className="ms-sub" data-ms-sub="builtin">
        <strong>内置出图服务</strong>
        <span className="muted">RunningHub 工作流的密钥在下面这一段里管 —— 视频节点用的是同一把 Key。</span>
      </div>

      {/* RunningHub 两个站 —— 完整区块放在图片段（视频段给一张指路卡）。 */}
      <div className="ms-sites">
        {[rh.cn, rh.ai].map(site => <div
          key={site.id}
          className={`ms-site${site.id === rh.active ? ' active' : ''}`}
          data-ms-site={site.id}
        >
          <div className="ms-site-head">
            <strong>{site.label}</strong>
            <span className="badge">{site.hasKey ? '已配置' : '未配置'}</span>
          </div>
          <div className="ms-site-host">{site.host}</div>
          <div className="ms-site-meta">
            <div><span>接口地址</span> <code>{site.baseUrl}</code></div>
            <div><span>密钥</span> <span className={site.hasKey ? 'ok' : 'off'}>{site.masked ?? '未填写'}</span></div>
            <div><span>状态</span> <span className={statusTone(site.status, site.hasKey) === 'ok' ? 'ok' : ''}>
              {site.status === 'verified' ? '连接正常' : site.status === 'failed' ? '连接失败' : '未验证'}
            </span></div>
          </div>
          <div className="key-actions">
            <button className="button secondary" disabled={busy !== '' || site.id === rh.active}
              data-ms-use-site={site.id} onClick={() => useSite(site.id)}>
              {site.id === rh.active ? '当前使用中' : `切到${site.id === 'ai' ? '海外站' : '国内站'}`}
            </button>
            <button className="button secondary" disabled={busy !== '' || !site.hasKey}
              data-ms-test-site={site.id} onClick={() => testSite(site.id)}>
              {busy === 'test:' + site.id ? '测试中…' : '测试连接'}
            </button>
            {site.id === 'ai' && site.supportsMultiple && (
              <button className="button secondary" data-ms-add-site-key
                onClick={() => { setKeyForm('runninghub-ai'); setKeyDraft({ baseUrl: rh.ai.baseUrl, model: '', apiKey: '' }); }}>
                添加海外站 Key
              </button>
            )}
          </div>
          {site.keys.length > 0 && <div className="ms-site-meta">
            {site.keys.map(key => <div key={key.id} data-ms-site-key={key.id}>
              <span>{key.label || '（未命名）'}</span> <code>{key.masked}</code> <span>{key.enabled ? '启用' : '停用'}</span>
            </div>)}
          </div>}
        </div>)}
      </div>
      {
        /*
         * 直接填「国内站」密钥 —— 这一块原来整页叫「设置 · 服务连接」（2026-09-22 并进来）。
         *
         * **常驻，不跟着「当前用哪个站」走**：国内站走历史连接表（每个账号一把），
         * 海外站走密钥池（可以多把，在上面那张卡里加）。填国内站的 key 与现在用哪个站是两件事 ——
         * 不能因为当前正用海外站就把这个入口藏起来（原来那一页随时能填，藏了就是把能力收回去）。
         * 第一版就是按「只在当前站是国内站时才出现」写的，探针当场抓到：用户的当前站是海外站，
         * 于是这一块整个不存在。
         */
        <div className="ms-key-box" data-ms-key-box="cn">
          <div className="ms-key-box-head">
            <strong>国内站密钥</strong>
            <span className="muted">国内站与海外站是两个独立账号：这一把只作用于国内站；海外站的 Key 在上面那张卡里单独添加。</span>
          </div>
          {/* 桌面版没有钱包，`credits` 传 null（余额与扣费两行整行不渲染，见那个组件）。 */}
          <RunningHubKeyForm initial={initial.connection} credits={null} compact onChanged={reload} />
        </div>
      }
      {
        /*
         * 填 Key 的表单复用在「海外站 Key」上：两处要填的东西一模一样（地址 / Key），
         * 只是 provider 不同。单独写一份表单等于把「填 Key 留空=不改」这类规矩抄第二遍。
         */
        keyForm === 'runninghub-ai' && keyFields('runninghub-ai')
      }

      {localCard('image')}

      {customBlock('image')}
      </div>}
    </section>

    {/* ── 视频 ─────────────────────────────────────────────── */}
    <section
      className={`provider ms-fold-sec${openSections.video ? ' open' : ''}`}
      id="ms-section-video"
      data-ms-section="video"
      data-ms-section-open={openSections.video ? 'yes' : 'no'}
    >
      {sectionHead('video')}
      {openSections.video && <div className="ms-fold-body" data-ms-section-body="video">

      <div className="ms-sub" data-ms-sub="builtin">
        <strong>内置出片服务</strong>
        <span className="muted">RunningHub 与本地 ComfyUI 在两段里是同一套 —— 这里只放指路与切换。</span>
      </div>

      {/*
        RunningHub 的**精简卡**：完整区块（含填 Key）在「图片」段。
        这里只给「现在用哪个站 / 状态 / 切换 / 测试」+ 一条跳转 —— 两段各放一个填 Key 的框，
        用户会以为要配两次，而改了一处另一处不动。
      */}
      <div className="ms-vendor" data-ms-rh-shared="video">
        <div className="ms-vendor-main">
          <strong>RunningHub 工作流（与「图片」段共用同一把 Key）</strong>
          <p>
            当前站：{rh.active === 'ai' ? '海外站' : '国内站'}（{activeSite.host}） ·
            状态：{siteStatusText(activeSite.status, activeSite.hasKey)}。
            视频节点与图片节点走的是同一个 RunningHub 账号，密钥只在「图片」段那一块里填。
          </p>
        </div>
        <div className="ms-vendor-side">
          <span className="badge" data-ms-site-active={rh.active}>
            当前：{rh.active === 'ai' ? '海外站' : '国内站'}
          </span>
          <button className="button secondary" disabled={busy !== ''}
            data-ms-use-site={rh.active === 'ai' ? 'cn' : 'ai'}
            onClick={() => useSite(rh.active === 'ai' ? 'cn' : 'ai')}>
            切到{rh.active === 'ai' ? '国内站' : '海外站'}
          </button>
          <button className="button secondary" disabled={busy !== '' || !activeSite.hasKey}
            data-ms-test-site={rh.active} onClick={() => testSite(rh.active)}>
            {busy === 'test:' + rh.active ? '测试中…' : '测试连接'}
          </button>
          <button className="button secondary" data-ms-goto="image" onClick={() => jumpTo('image')}>
            去「图片」段管密钥
          </button>
        </div>
      </div>

      {gatewayCards('video')}
      {localCard('video')}

      {customBlock('video')}
      </div>}
    </section>
  </div>;
}
