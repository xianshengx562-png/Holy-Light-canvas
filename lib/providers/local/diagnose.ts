import 'server-only';
import { LOCAL_OBJECT_INFO_PATH, LOCAL_QUERY_TIMEOUT_MS, LOCAL_STATS_PATH } from './config';
import { hasModelFile, scanComfyuiDir, type ComfyuiDirScan, type ComfyuiDirView } from './directory';
import type { LocalCredentials } from './client';
import type { LocalGraph } from './graph';

/**
 * 诊断：这份图在本机 ComfyUI 上**跑不跑得起来**。
 *
 * 两件事会被查出来 —— 这正是「本机跑图」最常见的两类失败，而它们的报错都发生在
 * ComfyUI 自己的界面里（我们这边只能看到一个 `node_errors`）：
 *   1. **缺自定义节点**：图里有 `class_type`，但本机的 `/object_info` 里没有这一型；
 *   2. **缺模型 / 资源**：节点要挑一个 `xxx.safetensors`，本机 `models` 目录里没有这个文件。
 *
 * ⚠️ **只诊断，不动手**：用户明确说过「我只连我自己开的 ComfyUI」，所以这里
 * 既不拉起进程、也不下载或安装任何东西。查出问题只负责说清楚「缺什么、在哪个节点」。
 *
 * **两条取数路径**（`source` 会告诉界面这次是走哪条）：
 *  - 服务开着 → 问它的 `/object_info`，那是它自己认得的清单，最准；
 *  - 服务没开但**配了 ComfyUI 目录** → 只读扫目录（`custom_nodes` + `models`），
 *    照样能答「节点装没装、模型在不在」。这时候认不全（有些包运行时才注册），
 *    所以结论里会明说是按目录扫的，不冒充是服务报的。
 */

export type MissingNode = { nodeId: string; classType: string };
export type MissingModel = { nodeId: string; classType: string; field: string; value: string };
/** 这次结论的依据。界面上要照原样说清楚，别把「扫目录」说成「ComfyUI 说的」。 */
export type LocalDiagnoseSource = 'object_info' | 'directory' | 'none';

export type LocalDiagnosis = {
  ok: boolean;
  source: LocalDiagnoseSource;
  missingNodes: MissingNode[];
  /** 节点要的模型 / 资源，本机没有（不在可选列表里 / 目录里没这个文件）。 */
  missingModels: MissingModel[];
  /** 取值不在可选列表里、但看不出是文件的（比如采样器名）—— 只提醒，不算错误。 */
  invalidValues: MissingModel[];
  /** 扫目录那条路才带：目录概览。服务开着走 `/object_info` 时是 null。 */
  dir: ComfyuiDirView | null;
  message: string;
};

/**
 * 哪些输入是「从本机已有的一堆文件里挑一个」。
 *
 * 判据是**字段名**，不是值：ComfyUI 里模型 / LoRA / VAE / ControlNet / 放大模型这些输入
 * 的取名是有规律的；而 `sampler_name` / `scheduler` 这类虽然也是列表，缺了它不是「缺文件」，
 * 报成「缺模型」就是误导 —— 所以它们只进 `invalidValues`。
 */
const RESOURCE_FIELD = /(ckpt|checkpoint|unet|lora|vae|control_?net|embedding|upscale|style_model|clip|diffusion|transformer|text_encoder|gguf|model)/i;
/** 值看着像个文件（`xxx.safetensors`）。命中它就一定是「本机没这个文件」。 */
const LOOKS_LIKE_FILE = /\.[a-z0-9]{2,5}$/i;

/** `/object_info` 整份可能好几 MB，所以按类型单独取并缓存。 */
const objectInfoCache = new Map<string, { at: number; state: ObjectInfoState; info?: Record<string, unknown> }>();
const OBJECT_INFO_TTL_MS = 5 * 60 * 1000;

/**
 * `found` / `missing` 必须分开：**查不到 ≠ 缺这个节点**。
 * `/object_info` 都取不回来时（没启动、地址错了），把图里每个节点都报成「缺节点」
 * 比什么都不报更糟 —— 用户会以为自己装了一整套节点都没装对。
 */
export type ObjectInfoState = 'found' | 'missing' | 'unavailable';
export type ObjectInfoResult = { state: ObjectInfoState; info?: Record<string, unknown> };

function authHeaders(credentials: LocalCredentials): Record<string, string> {
  const headers: Record<string, string> = {};
  const apiKey = String(credentials?.apiKey || '').trim();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

export async function readObjectInfo(credentials: LocalCredentials, classType: string): Promise<ObjectInfoResult> {
  const base = String(credentials?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return { state: 'unavailable' };
  const key = `${base}|${classType}`;
  const cached = objectInfoCache.get(key);
  if (cached && Date.now() - cached.at < OBJECT_INFO_TTL_MS) {
    return cached.info ? { state: cached.state, info: cached.info } : { state: cached.state };
  }
  const headers = authHeaders(credentials);
  try {
    /* 先按类型单独取。老版本 ComfyUI 不支持这个子路径 —— 那种情况退回整份。 */
    const single = await fetch(`${base}${LOCAL_OBJECT_INFO_PATH}/${encodeURIComponent(classType)}`, {
      headers, signal: AbortSignal.timeout(LOCAL_QUERY_TIMEOUT_MS),
    });
    if (single.ok) {
      const body = await single.json().catch(() => null) as Record<string, Record<string, unknown>> | null;
      const info = body?.[classType];
      if (info && typeof info === 'object') {
        objectInfoCache.set(key, { at: Date.now(), state: 'found', info });
        return { state: 'found', info };
      }
      /* 拿到了一份 JSON 但里面没有这个类型 —— 也可能是老版本的空对象，继续试整份。 */
      if (body && Object.keys(body).length) {
        objectInfoCache.set(key, { at: Date.now(), state: 'missing' });
        return { state: 'missing' };
      }
    }
    const all = await fetch(`${base}${LOCAL_OBJECT_INFO_PATH}`, {
      headers, signal: AbortSignal.timeout(LOCAL_QUERY_TIMEOUT_MS),
    });
    if (!all.ok) return { state: 'unavailable' };
    const allBody = await all.json().catch(() => null) as Record<string, Record<string, unknown>> | null;
    if (!allBody) return { state: 'unavailable' };
    for (const [type, info] of Object.entries(allBody)) {
      objectInfoCache.set(`${base}|${type}`, { at: Date.now(), state: 'found', info: info as Record<string, unknown> });
    }
    const mine = allBody[classType];
    if (mine && typeof mine === 'object') return { state: 'found', info: mine };
    objectInfoCache.set(key, { at: Date.now(), state: 'missing' });
    return { state: 'missing' };
  } catch {
    return { state: 'unavailable' };
  }
}

/**
 * 「服务开着吗」。只为了决定走哪条取数路径，所以用最轻的 `/system_stats`
 * （`/prompt` 会真的开始跑一次生成，绝对不能拿它探活）。
 *
 * ⚠️ **不缓存**：一次诊断只探一次，本来就没必要存；而缓存的代价很实在 ——
 * 用户刚把 ComfyUI 关掉，接下来一分钟内我们仍当它开着，于是走 `/object_info`
 * 全部取不回来、又退回「查不到」，白白浪费一次机会。这个判断必须**每次都现问**。
 */
const ALIVE_TIMEOUT_MS = 4000;

async function serviceAlive(credentials: LocalCredentials): Promise<boolean> {
  const base = String(credentials?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return false;
  try {
    const response = await fetch(`${base}${LOCAL_STATS_PATH}`, {
      headers: authHeaders(credentials), signal: AbortSignal.timeout(ALIVE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 一个输入的规格写成 `[ ['a.safetensors', 'b.safetensors'], {...} ]` 时，才是「从列表里挑」。 */
function choiceList(spec: unknown): string[] | null {
  if (!Array.isArray(spec)) return null;
  const head = spec[0];
  if (!Array.isArray(head)) return null;
  return head.map(item => String(item));
}

function nodeEntries(graph: LocalGraph): { nodeId: string; classType: string; inputs: Record<string, unknown> }[] {
  const out: { nodeId: string; classType: string; inputs: Record<string, unknown> }[] = [];
  for (const [nodeId, node] of Object.entries(graph || {})) {
    const classType = String(node?.class_type || '').trim();
    if (!classType) continue;
    out.push({ nodeId, classType, inputs: (node?.inputs || {}) as Record<string, unknown> });
  }
  return out;
}

function describeMissing(missingNodes: MissingNode[], missingModels: MissingModel[], invalidValues: MissingModel[]): string {
  const parts: string[] = [];
  if (missingNodes.length) {
    const types = [...new Set(missingNodes.map(item => item.classType))];
    parts.push(`缺 ${missingNodes.length} 处节点（${types.join('、')}）`);
  }
  if (missingModels.length) {
    parts.push(`缺 ${missingModels.length} 个模型/资源：${missingModels.slice(0, 5).map(item => item.value).join('、')}${missingModels.length > 5 ? ' 等' : ''}`);
  }
  if (invalidValues.length) {
    parts.push(`${invalidValues.length} 个取值不在可选列表里（${invalidValues.slice(0, 3).map(item => `${item.field}=${item.value}`).join('、')}${invalidValues.length > 3 ? ' 等' : ''}）`);
  }
  return parts.length ? parts.join('；') + '。' : '';
}

/** 服务开着：问 `/object_info`。 */
async function diagnoseWithObjectInfo(graph: LocalGraph, credentials: LocalCredentials): Promise<LocalDiagnosis> {
  const missingNodes: MissingNode[] = [];
  const missingModels: MissingModel[] = [];
  const invalidValues: MissingModel[] = [];
  let checked = 0;
  let unavailable = 0;

  for (const { nodeId, classType, inputs } of nodeEntries(graph)) {
    const result = await readObjectInfo(credentials, classType);
    if (result.state === 'unavailable') { unavailable++; continue; }
    if (result.state === 'missing') { missingNodes.push({ nodeId, classType }); continue; }
    checked++;
    const spec = result.info?.input as { required?: Record<string, unknown>; optional?: Record<string, unknown> } | undefined;
    const fields = { ...(spec?.required || {}), ...(spec?.optional || {}) };
    for (const [field, value] of Object.entries(inputs)) {
      /* 连线（`['3', 0]`）不是取值，跳过。 */
      if (Array.isArray(value) || typeof value !== 'string' || !value) continue;
      const choices = choiceList(fields[field]);
      if (!choices || choices.includes(value)) continue;
      const entry: MissingModel = { nodeId, classType, field, value };
      if (LOOKS_LIKE_FILE.test(value) || RESOURCE_FIELD.test(field)) missingModels.push(entry);
      else invalidValues.push(entry);
    }
  }

  const ok = !missingNodes.length && !missingModels.length;
  return {
    ok, source: 'object_info', missingNodes, missingModels, invalidValues, dir: null,
    /* 一个节点都没查到时不要说「都齐了」—— 那多半是压根没连上。 */
    message: checked
      ? (describeMissing(missingNodes, missingModels, invalidValues)
        || `这份图里的 ${checked} 个节点、要用的模型本机都有。`)
      : (unavailable
        ? '没能从本机 ComfyUI 取到节点信息 —— 确认它已经启动、地址没填错，再检查一次。'
        : '这份图里没有可查的节点。'),
  };
}

/** 服务没开但配了目录：只读扫目录。 */
function diagnoseWithDirectory(graph: LocalGraph, scan: ComfyuiDirScan): LocalDiagnosis {
  const missingNodes: MissingNode[] = [];
  const missingModels: MissingModel[] = [];
  let checked = 0;

  for (const { nodeId, classType, inputs } of nodeEntries(graph)) {
    if (!scan.nodeTypes.has(classType)) { missingNodes.push({ nodeId, classType }); continue; }
    checked++;
    for (const [field, value] of Object.entries(inputs)) {
      if (Array.isArray(value) || typeof value !== 'string' || !value) continue;
      /* 目录这条路上只能查「文件在不在」，采样器名之类的取值无从比对，所以一律不报。 */
      if (!LOOKS_LIKE_FILE.test(value) && !RESOURCE_FIELD.test(field)) continue;
      if (hasModelFile(scan, value)) continue;
      missingModels.push({ nodeId, classType, field, value });
    }
  }

  const ok = !missingNodes.length && !missingModels.length;
  const lead = `服务没开，这是按目录扫出来的（${scan.view.dir}）：`;
  const detail = describeMissing(missingNodes, missingModels, []);
  const suffix = missingNodes.length ? '—— 目录里没找到注册它的节点包' : '';
  const message = detail
    ? `${lead}${detail.replace(/。$/, '')}${suffix}。`
    : `${lead}这份图里的 ${checked} 个节点、要用的模型在目录里都在。`;
  return { ok, source: 'directory', missingNodes, missingModels, invalidValues: [], dir: scan.view, message };
}

export async function diagnoseLocalGraph(graph: LocalGraph, credentials: LocalCredentials): Promise<LocalDiagnosis> {
  if (await serviceAlive(credentials)) {
    return diagnoseWithObjectInfo(graph, credentials);
  }
  const dir = String(credentials?.comfyuiDir || '').trim();
  const scan = dir ? await scanComfyuiDir(dir) : null;
  /*
   * 扫出 0 个节点类型时不许拿它下结论 —— 那只会是「没扫到」（目录填错了、扫超时了、
   * 或者这个包的注册方式我们认不出），照它比对的后果是**每个节点都被报成缺**，
   * 用户会以为自己的 ComfyUI 是空的。这种情况按「查不到」处理，并提示去核对目录。
   */
  if (scan && scan.nodeTypes.size > 0) {
    return diagnoseWithDirectory(graph, scan);
  }
  const hint = dir
    ? '目录里一个节点类型都没认出来 —— 确认填的是 ComfyUI 根目录（里面带 custom_nodes 的那一层）。'
    : '到「设置 · ComfyUI 服务」填上 ComfyUI 的安装目录，服务没开也能查出缺什么。';
  return {
    /** `ok: false` 是刻意的：这里不是「检查通过」，而是**根本没查成**，界面上不该显示成绿色。 */
    ok: false, source: 'none', missingNodes: [], missingModels: [], invalidValues: [],
    dir: scan?.view ?? null,
    message: `没能从本机 ComfyUI 取到节点信息 —— 确认它已经启动、地址没填错，再检查一次。${hint}`,
  };
}
