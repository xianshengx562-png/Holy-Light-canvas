import 'server-only';
import {
  LOCAL_OBJECT_INFO_PATH, LOCAL_OBJECT_INFO_TIMEOUT_MS, LOCAL_QUEUE_PATH, LOCAL_STATS_PATH,
} from './config';
import { authHeaders, parseLocalStats, type LocalCredentials } from './client';

/**
 * 本机 ComfyUI 的**家底**：版本、队列、节点类型、**以及它认得哪些模型**。
 *
 * 为什么需要单独一层：探活（`/system_stats`）只回答「在不在」，而用户打开设置页真正想
 * 知道的是「我这个工作流里填的模型名，它到底有没有」。那个答案只在 `/object_info` 里 ——
 * ComfyUI 把每个节点的下拉选项都报出来，`CheckpointLoaderSimple` 的 `ckpt_name` 里
 * 列着的，就是本机**真的能加载**的 checkpoint（含 `extra_model_paths.yaml` 挂进来的）。
 *
 * 比扫 `models/` 目录准得多：目录扫出来的是文件，而这里报出来的是 ComfyUI 认得的模型
 * —— 放在别的盘、靠 yaml 挂进来的那些，扫目录永远扫不到。这一条思路来自 AIFISHER
 * （`F:\本地画布\AIFISHER` 的 `probeComfyServer`），它把 `/system_stats` + `/queue` +
 * `/object_info` 一起并发打，一次拿全。
 *
 * ⚠️ 只读，且不因「读不全」而失败：模型清单读不到就报读到的一半，
 * 队列读不到就是 0 —— 探活已经证明它在了，这一层的价值是补充信息，不是再判一次生死。
 */

/** 一类模型的清单。`names` 只带前几个（界面显示用），`count` 是真实总数。 */
export type LocalModelBucket = {
  count: number;
  names: string[];
};

export type LocalInventoryModels = {
  checkpoints: LocalModelBucket;
  diffusionModels: LocalModelBucket;
  textEncoders: LocalModelBucket;
  vaes: LocalModelBucket;
  loras: LocalModelBucket;
  controlnets: LocalModelBucket;
  upscaleModels: LocalModelBucket;
};

export type LocalInventory = {
  ok: boolean;
  message: string;
  version?: string;
  device?: string;
  /** 正在跑几个 / 排队几个。 */
  queueRunning: number;
  queuePending: number;
  /** ComfyUI 认得的节点类型数（装了多少插件的最直观指标）。 */
  nodeTypeCount: number;
  models: LocalInventoryModels;
  /** 上面所有桶加起来的模型数。 */
  modelCount: number;
};

/**
 * 这些是 ComfyUI 自带的**近似 VAE**（用来预览 latent 的），不是真的模型文件。
 * 报出来会让人以为自己装了一堆 VAE，所以过滤掉 —— 与 AIFISHER 的做法一致。
 */
const BUILTIN_VAE = new Set(['taesd', 'taesdx', 'taesd1', 'taesd2', 'taesd3', 'taef1']);

/** 界面最多显示几个模型名。清单可能有几百个 lora，全塞过去只会把卡片撑爆。 */
const NAME_PREVIEW = 8;

type ObjectInfo = Record<string, {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
}>;

/**
 * 从 `/object_info` 里取出某个节点某个字段的**下拉选项**。
 *
 * ComfyUI 的写法是 `input.required.ckpt_name = [["a.safetensors", "b.safetensors"], {}]`：
 * 数组的第一项是候选列表。也可能不在 required 而在 optional（比如 LoraLoader 的第二个输入），
 * 所以两边都看。
 */
export function comfyChoices(info: ObjectInfo | null | undefined, nodeType: string, field: string): string[] {
  const node = info?.[nodeType];
  const spec = (node?.input?.required?.[field] ?? node?.input?.optional?.[field]) as unknown[] | undefined;
  const list = Array.isArray(spec?.[0]) ? (spec[0] as unknown[]) : [];
  const out = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || BUILTIN_VAE.has(name.toLowerCase())) continue;
    out.add(name);
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function bucket(list: string[]): LocalModelBucket {
  return { count: list.length, names: list.slice(0, NAME_PREVIEW) };
}

function emptyModels(): LocalInventoryModels {
  return {
    checkpoints: bucket([]),
    diffusionModels: bucket([]),
    textEncoders: bucket([]),
    vaes: bucket([]),
    loras: bucket([]),
    controlnets: bucket([]),
    upscaleModels: bucket([]),
  };
}

function normalize(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

async function getJson(base: string, path: string, credentials: LocalCredentials, timeoutMs: number): Promise<unknown | null> {
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'GET',
      headers: authHeaders(credentials),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  }
}

/**
 * 读一次家底。**并发**打三个端点：它们互不依赖，串起来等于是白等两轮。
 *
 * 只有 `/system_stats` 读不到才算失败（那就是连不上），另外两个读不到只是「信息不全」。
 */
export async function readLocalInventory(credentials: LocalCredentials): Promise<LocalInventory> {
  const base = normalize(String(credentials?.baseUrl || ''));
  if (!base) {
    return { ok: false, message: '还没填本机 ComfyUI 的地址。', queueRunning: 0, queuePending: 0, nodeTypeCount: 0, models: emptyModels(), modelCount: 0 };
  }

  const [statsBody, queueBody, infoBody] = await Promise.all([
    getJson(base, LOCAL_STATS_PATH, credentials, LOCAL_OBJECT_INFO_TIMEOUT_MS),
    getJson(base, LOCAL_QUEUE_PATH, credentials, LOCAL_OBJECT_INFO_TIMEOUT_MS),
    getJson(base, LOCAL_OBJECT_INFO_PATH, credentials, LOCAL_OBJECT_INFO_TIMEOUT_MS),
  ]);

  const stats = parseLocalStats(statsBody);
  const device = stats.devices[0]?.name;
  const version = stats.system?.comfyuiVersion;
  if (!device && !version) {
    return {
      ok: false,
      message: '这个地址上有程序在答话，但它不是 ComfyUI —— 端口被别的软件占了，或者请求被代理截走了。',
      queueRunning: 0, queuePending: 0, nodeTypeCount: 0, models: emptyModels(), modelCount: 0,
    };
  }

  const queue = queueBody as { queue_running?: unknown[]; queue_pending?: unknown[] } | null;
  const queueRunning = Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0;
  const queuePending = Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0;

  const info = (infoBody && typeof infoBody === 'object' && !Array.isArray(infoBody))
    ? infoBody as ObjectInfo
    : null;
  const nodeTypeCount = info ? Object.keys(info).length : 0;

  const models: LocalInventoryModels = {
    checkpoints: bucket(comfyChoices(info, 'CheckpointLoaderSimple', 'ckpt_name')),
    diffusionModels: bucket(comfyChoices(info, 'UNETLoader', 'unet_name')),
    textEncoders: bucket(comfyChoices(info, 'CLIPLoader', 'clip_name')),
    vaes: bucket(comfyChoices(info, 'VAELoader', 'vae_name')),
    loras: bucket(comfyChoices(info, 'LoraLoader', 'lora_name')),
    controlnets: bucket(comfyChoices(info, 'ControlNetLoader', 'control_net_name')),
    upscaleModels: bucket(comfyChoices(info, 'UpscaleModelLoader', 'model_name')),
  };
  const modelCount = Object.values(models).reduce((sum, item) => sum + item.count, 0);

  const queueNote = queueRunning || queuePending ? ` · 队列 ${queueRunning} 在跑 / ${queuePending} 在排` : '';
  const modelNote = modelCount ? ` · ${modelCount} 个模型` : '';
  return {
    ok: true,
    message: `已连上${device ? `（${device}）` : ''}${version ? ` · ComfyUI ${version}` : ''}${modelNote}${queueNote}。`,
    version: version || undefined,
    device: device || undefined,
    queueRunning,
    queuePending,
    nodeTypeCount,
    models,
    modelCount,
  };
}
