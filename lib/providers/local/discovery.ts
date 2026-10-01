import 'server-only';
import { LOCAL_HISTORY_PATH, LOCAL_SCAN_TIMEOUT_MS, LOCAL_STATS_PATH } from './config';
import {
  classifyProbeError, LOCAL_PROBE_REASON_TEXT, parseLocalStats,
  type LocalCredentials, type LocalProbeReason,
} from './client';
import { parseLocalGraph, type LocalGraph } from './graph';

/**
 * 本机 ComfyUI 的**发现与抓取**。
 *
 * 这一层的存在理由只有一个：「连不上」这三个字对用户没有任何可执行的信息。
 * 真正该回答的是三个问题：
 *   1. 我填的这个地址到底怎么不通（没开 / 占端口 / 被代理截 / 要鉴权）；
 *   2. 那它现在到底在哪（本机常见端口扫一遍，扫到就直接给个「改用这个」）；
 *   3. 连上之后，我要的那份图能不能**不用手抄**就进来（从 `/history` 抓最近一次跑的图）。
 *
 * 三条纪律与 `comfyui-supervisor.ts` 一致：**只探测、只读取，绝不拉起进程、绝不改 ComfyUI 的配置**。
 */

export type LocalProbe = {
  baseUrl: string;
  ok: boolean;
  /** 不通的原因。`ok` 为 true 时是 `null`。 */
  reason: LocalProbeReason | null;
  message: string;
  /** 显卡名。连上了才有。 */
  device?: string;
  /** ComfyUI 版本。连上了才有。 */
  comfyuiVersion?: string;
};

export type LocalScanResult = {
  /** 当前配置的地址探出来什么样 —— 无论通不通都在这里。 */
  current: LocalProbe;
  /** 别的候选地址里**探通的**那些（没通的不占界面篇幅）。按候选顺序排。 */
  candidates: LocalProbe[];
};

/**
 * 扫描时要试的端口。
 *
 * 8188 是 ComfyUI 默认，8189 是「8188 被占了」时 ComfyUI 自己往下顺延的那个；
 * 后面几个是常见的本地 Web 服务端口 —— 有些整合包会把 ComfyUI 挂到 7860（沿用 Gradio 的习惯）。
 * 数量刻意压在 8 个以内：扫的是本机，每个 2.5 秒，再多就超过「点一下就该出结果」的耐心了。
 */
export const LOCAL_SCAN_PORTS = [8188, 8189, 7860, 8080, 8000, 5000, 9000];

function authHeaders(credentials: LocalCredentials): Record<string, string> {
  const key = String(credentials?.apiKey || '').trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

function normalize(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

/** 探一个地址。失败也**不抛** —— 扫描要的是「每个地址各是什么结果」，不是「第一个不通就停」。 */
export async function probeLocalBaseUrl(baseUrl: string, credentials: LocalCredentials): Promise<LocalProbe> {
  const base = normalize(baseUrl);
  if (!base) {
    return { baseUrl: base, ok: false, reason: 'unknown', message: '还没填地址。' };
  }
  try {
    const response = await fetch(`${base}${LOCAL_STATS_PATH}`, {
      method: 'GET',
      headers: authHeaders(credentials),
      signal: AbortSignal.timeout(LOCAL_SCAN_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { baseUrl: base, ok: false, reason: 'unauthorized', message: LOCAL_PROBE_REASON_TEXT.unauthorized };
    }
    if (!response.ok) {
      return { baseUrl: base, ok: false, reason: 'http', message: `HTTP ${response.status}。${LOCAL_PROBE_REASON_TEXT.http}` };
    }
    const body = await response.json().catch(() => null);
    const stats = parseLocalStats(body);
    const device = stats.devices[0]?.name;
    const version = stats.system?.comfyuiVersion;
    /*
     * 答了 200 但两个字段都没有 —— 那不是 ComfyUI。
     * 这种情况在开着代理的机器上很常见：代理把请求收下、回了一个自己的页面，
     * 于是「连上了但什么都读不到」看起来就像 ComfyUI 坏了。必须单独说出来。
     */
    if (!device && !version) {
      return { baseUrl: base, ok: false, reason: 'not-comfyui', message: LOCAL_PROBE_REASON_TEXT['not-comfyui'] };
    }
    return {
      baseUrl: base,
      ok: true,
      reason: null,
      message: device ? `已连上（${device}${version ? ` · ComfyUI ${version}` : ''}）。` : `已连上${version ? ` · ComfyUI ${version}` : ''}。`,
      device: device || undefined,
      comfyuiVersion: version || undefined,
    };
  } catch (error) {
    const reason = classifyProbeError(error);
    /* 与 client.ts 同理：不把原始错误甩给用户，`detail` 变量一起删。 */
    return { baseUrl: base, ok: false, reason, message: LOCAL_PROBE_REASON_TEXT[reason] };
  }
}

/**
 * 由当前地址推导要扫的候选。**当前地址永远排第一**，界面上它要单独显示。
 *
 * 换 host 只换 127.0.0.1 ↔ localhost 这一对：这两个在部分机器上并不等价
 * （IPv6 优先时 localhost 会解析到 ::1，而 ComfyUI 默认只听 127.0.0.1），
 * 这是「明明开着却连不上」里最容易漏的一类。其余主机名（比如局域网 IP）不去猜。
 */
export function localScanCandidates(baseUrl: string): string[] {
  const base = normalize(baseUrl);
  const out: string[] = [];
  const push = (value: string) => { if (value && !out.includes(value)) out.push(value); };
  push(base);

  let protocol = 'http:';
  let host = '127.0.0.1';
  let port = '';
  try {
    const parsed = new URL(base);
    protocol = parsed.protocol;
    host = parsed.hostname;
    port = parsed.port;
  } catch {
    return out;
  }

  const twin = host === 'localhost' ? '127.0.0.1' : host === '127.0.0.1' ? 'localhost' : '';
  if (twin) push(`${protocol}//${twin}${port ? `:${port}` : ''}`);
  for (const candidate of LOCAL_SCAN_PORTS) {
    push(`${protocol}//${host}:${candidate}`);
  }
  return out;
}

/**
 * 扫一遍。**并发**，但当前地址先用长超时单独探一次 ——
 * 它是用户填的那个，值得等；其余候选用扫描超时快速过一遍。
 */
export async function scanLocalCandidates(credentials: LocalCredentials): Promise<LocalScanResult> {
  const list = localScanCandidates(String(credentials?.baseUrl || ''));
  if (!list.length) {
    return { current: { baseUrl: '', ok: false, reason: 'unknown', message: '还没填地址。' }, candidates: [] };
  }
  const probes = await Promise.all(list.map(item => probeLocalBaseUrl(item, credentials)));
  const current = probes[0];
  const candidates = probes.slice(1).filter(item => item.ok);
  return { current, candidates };
}

/** `/history` 里一条记录里我们认得的部分。字段全可选：这是别人家的接口。 */
type HistoryEntry = {
  prompt?: unknown;
  status?: { status_str?: string };
};

/**
 * 从一条 history 记录里取出 **API 格式的图**。
 *
 * ComfyUI 把每次提交存成 `[queue_index, prompt_id, graph, extra_data, outputs_to_execute]`，
 * 图在下标 2。老一些的版本直接存对象，所以两条路都留着 ——
 * 认不出来的返回 null，让调用方说「没抓到」，而不是拿一份残缺的图去导入。
 */
function graphFromHistoryEntry(entry: HistoryEntry | null | undefined): LocalGraph | null {
  const prompt = entry?.prompt;
  const raw = Array.isArray(prompt) ? prompt[2] : prompt;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    return parseLocalGraph(raw);
  } catch {
    return null;
  }
}

export type LocalPullResult = {
  graph: LocalGraph;
  promptId: string;
  /** 这次跑是成功还是失败 —— 失败的图也能导进来改，所以这里只是提示，不拦。 */
  status: string;
  nodeCount: number;
};

/**
 * 从**正在运行的** ComfyUI 抓最近一次跑过的工作流。
 *
 * 为什么必须有这一条：原本要接本地工作流，得先在 ComfyUI 里手动「导出（API）」、
 * 再把那一大坨 JSON 贴回 Holy Light画布 —— 只要改一次图就要重来一遍，于是「接本地」这件事
 * 实际只做一次，之后就再也不想动了。而它开着的时候，最近跑过的图就躺在 `/history` 里，
 * 直接拿即可，节点编号天然和 ComfyUI 界面上（装了编号插件时）看到的那一个个 `#12` 对得上。
 *
 * `max_items=5`：取最近几条里**第一条能解析出图的**，因为最近一次可能是个失败的空提交。
 */
export async function pullLatestLocalGraph(credentials: LocalCredentials): Promise<LocalPullResult> {
  const base = normalize(String(credentials?.baseUrl || ''));
  if (!base) throw new Error('还没填本机 ComfyUI 的地址。');
  let body: unknown;
  try {
    const response = await fetch(`${base}${LOCAL_HISTORY_PATH}?max_items=5`, {
      method: 'GET',
      headers: authHeaders(credentials),
      signal: AbortSignal.timeout(LOCAL_SCAN_TIMEOUT_MS * 4),
    });
    if (!response.ok) {
      throw new Error(`本机 ComfyUI 不给看历史（HTTP ${response.status}）。`);
    }
    body = await response.json().catch(() => null);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('本机 ComfyUI')) throw error;
    throw new Error(`读不到本机 ComfyUI 的历史：${error instanceof Error ? error.message : '请求失败'}。`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('本机 ComfyUI 的历史是空的 —— 先在 ComfyUI 里跑一次这个工作流，再来抓。');
  }
  const entries = Object.entries(body as Record<string, HistoryEntry>);
  if (!entries.length) {
    throw new Error('本机 ComfyUI 的历史是空的 —— 先在 ComfyUI 里跑一次这个工作流，再来抓。');
  }
  for (const [promptId, entry] of entries) {
    const graph = graphFromHistoryEntry(entry);
    if (!graph) continue;
    return {
      graph,
      promptId,
      status: String(entry?.status?.status_str || ''),
      nodeCount: Object.keys(graph).length,
    };
  }
  throw new Error('最近几条历史里都取不出工作流图 —— 确认 ComfyUI 已经跑过一次生成。');
}
