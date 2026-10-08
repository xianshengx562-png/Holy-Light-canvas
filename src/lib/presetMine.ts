/*
 * 自建的创作预设：自己加的**档**、档下自己加的**分类**、以及分类里的条目（2026-10-08）。
 *
 * 徐先：「风格滤镜运镜哪里的也加上吧」—— 要的是和 D站标签面板同一套体验：
 *   - tab 条最右侧那颗「+」→ 建一个自己的**档**（和 风格 / 滤镜 / 运镜 并列，比如「我的镜头」）；
 *   - 分类胶囊排最右侧那颗「+」→ 在当前档下建一个自己的**分类**（和「摄影」「超现实」并列）。
 * 每个自建档 / 分类里的条目三条来源（他三条全要）：手输 / 从文件导入 / 从已有预设里收藏。
 *
 * 🔴 为什么单独一份 `mine.json`，不塞进 `imported.json`：那一份的语义是
 *    「**同名再导 = 覆盖**」（用户把分类名填一样再导一次，意图是刷新那批）。
 *    自建分类里点「导入」的意图是**追加** —— 往「我的常用」里再加一批，
 *    而不是把它清空。两个语义塞进一份文件，总有一次会清掉不该清的。
 *
 * 🔴 档 / 分类**不随画布走**（与 `danbooruCats` 同一条规矩）：节点上存的是
 *    **整条预设快照**（`id/kind/name/prompt/...`），所以档被删之后老画布照样读得出来、
 *    照样能提交 —— 只是那颗 tab 没了。这是「存快照不存 id」那条规矩的另一半。
 */

import type { CreativePreset, CreativePresetKind } from '@/components/canvas/creativePresets';
import { registerExtraKinds } from '@/components/canvas/creativePresets';

/** 自建的档。`single` = 这一档只能选一条（运镜那种）。 */
export type MineKind = {
  /** `k-<随机>`。带前缀是为了跟内置的 style / filter / motion 一眼分得开。 */
  id: string;
  name: string;
  single: boolean;
};

/** 自建的分类：挂在某一个档下面（`kind` 也可能是自建档）。 */
export type MineCategory = {
  id: string;
  kind: string;
  name: string;
};

export type MineFile = {
  version: 1;
  kinds: MineKind[];
  categories: MineCategory[];
  presets: CreativePreset[];
};

/** 一次导入读到的条目。 */
export type PresetImportOutcome = {
  ok: boolean;
  message: string;
  entries: CreativePreset[];
  files: number;
  skipped: string[];
};

/** 是不是自建的档（内置那三档不是）。 */
export function isMineKind(kind: string): boolean {
  return /^k-/i.test(String(kind || ''));
}

export function newMineKindId(): string {
  return `k-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function newMineCategoryId(): string {
  return `cat-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 条目 id 取「名字 + 提示词」的哈希：同一条导两次 / 手输重打一遍不会变成两条。 */
export function presetIdOf(name: string, prompt: string): string {
  const text = `${String(name || '')}\u0000${String(prompt || '')}`;
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return `mine-${hash.toString(36)}`;
}

/** 手输一条：名字可留空（那就拿提示词的前 20 字当名字）。 */
export function presetFromInput(kind: string, category: string, name: string, prompt: string): CreativePreset | null {
  const body = String(prompt || '').trim();
  if (!body) return null;
  const label = String(name || '').trim() || body.slice(0, 20) + (body.length > 20 ? '…' : '');
  return {
    id: presetIdOf(label, body),
    kind: kind as CreativePresetKind,
    category,
    name: label,
    description: '',
    prompt: body,
    preview: '',
  };
}

/** 从磁盘 / IPC 读回来的东西修成合法形状。 */
export function normalizeMine(raw: unknown): MineFile {
  if (!raw || typeof raw !== 'object') return { version: 1, kinds: [], categories: [], presets: [] };
  const src = raw as Partial<MineFile>;
  const kinds: MineKind[] = [];
  for (const item of Array.isArray(src.kinds) ? src.kinds : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    const name = String(item.name || '').trim();
    if (!isMineKind(id) || !name) continue;
    kinds.push({ id, name, single: item.single === true });
  }
  const categories: MineCategory[] = [];
  for (const item of Array.isArray(src.categories) ? src.categories : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    const name = String(item.name || '').trim();
    if (!id || !name) continue;
    categories.push({ id, kind: String(item.kind || '').trim(), name });
  }
  const presets: CreativePreset[] = [];
  for (const item of Array.isArray(src.presets) ? src.presets : []) {
    if (!item || typeof item !== 'object') continue;
    const one = normalizeMinePreset(item);
    if (one && !presets.some(exist => exist.id === one.id)) presets.push(one);
  }
  return { version: 1, kinds, categories, presets };
}

function normalizeMinePreset(raw: Record<string, unknown>): CreativePreset | null {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const prompt = str(raw.prompt);
  const name = str(raw.name) || prompt.slice(0, 20);
  const kind = str(raw.kind);
  if (!prompt || !kind) return null;
  return {
    id: str(raw.id) || presetIdOf(name, prompt),
    kind: kind as CreativePresetKind,
    category: str(raw.category),
    name,
    description: str(raw.description),
    prompt,
    preview: str(raw.preview),
    ...(str(raw.poster) ? { poster: str(raw.poster) } : {}),
    ...(str(raw.prefix) ? { prefix: str(raw.prefix) } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * preload 上那三个方法（只有桌面版有）
 * ------------------------------------------------------------------ */

type MineApi = {
  presetMineLoad?: () => Promise<MineFile>;
  presetMineSave?: (payload: MineFile) => Promise<{ ok: boolean; message: string }>;
  presetMineImport?: (payload: { files: string[] }) => Promise<{
    ok: boolean; message: string; entries: CreativePreset[]; files: number; skipped: string[];
  }>;
};

function mineApi(): MineApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { api?: MineApi }).api ?? null;
}

/* ------------------------------------------------------------------ *
 * 模块级缓存 + 订阅（与 `danbooruCats.ts` 同构）
 * ------------------------------------------------------------------ */

let file: MineFile = { version: 1, kinds: [], categories: [], presets: [] };
let loaded = false;
let inflight: Promise<MineFile> | null = null;
const listeners = new Set<() => void>();

export function mineNow(): MineFile {
  return file;
}

export function subscribeMine(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      /* 某个订阅者炸了不该拖垮其余的。 */
    }
  }
}

/** 读一次（模块级缓存）。读不出来当「还没有」，不抛 —— 这是面板打开时顺带做的查询。 */
/*
 * 🔴 档名注册表必须在**数据层**注册，不能只放在预设面板里（2026-10-08 真机抓到）：
 * 生成节点那一排按钮（「风格 / 滤镜 / 我的镜头」）是 `GenerateDock` 画的，它比预设面板
 * 先出现 —— 只让面板注册的话，面板从没打开过时 `kindLabelOf()` 查不到名字，
 * 按钮上显示的是兜底的「预设」两个字（建了档却看不见档名）。
 * 谁先加载谁注册，名字就总有的查。
 */
function register(): void {
  registerExtraKinds(file.kinds);
}

export function loadMine(): Promise<MineFile> {
  if (loaded) return Promise.resolve(file);
  if (inflight) return inflight;
  const api = mineApi();
  if (!api?.presetMineLoad) {
    loaded = true;
    return Promise.resolve(file);
  }
  inflight = api.presetMineLoad()
    .then(next => {
      file = normalizeMine(next);
      loaded = true;
      register();
      notify();
      return file;
    })
    .catch(() => {
      file = { version: 1, kinds: [], categories: [], presets: [] };
      loaded = true;
      return file;
    })
    .then(result => {
      inflight = null;
      return result;
    });
  return inflight;
}

/** 换一份：先更新缓存再发 IPC（下一帧就要拿它渲染 / 拼提示词，等写盘回来就晚了）。 */
export function replaceMine(next: MineFile): Promise<{ ok: boolean; message: string }> {
  file = next;
  loaded = true;
  register();
  notify();
  const api = mineApi();
  if (!api?.presetMineSave) {
    return Promise.resolve({ ok: false, message: '只有桌面版能把自建预设存到本机。' });
  }
  return api.presetMineSave(next)
    .then(result => ({ ok: Boolean(result?.ok), message: String(result?.message || '') }))
    .catch(error => ({ ok: false, message: error instanceof Error ? error.message : '保存失败。' }));
}

/** 读用户选的那几个文件（只读，收不收由调用方定）。 */
export async function importMinePresets(files: string[]): Promise<PresetImportOutcome> {
  const api = mineApi();
  if (!api?.presetMineImport) {
    return { ok: false, message: '只有桌面版能导入本机的预设清单。', entries: [], files: 0, skipped: [] };
  }
  try {
    const result = await api.presetMineImport({ files });
    const entries: CreativePreset[] = [];
    for (const raw of result?.entries || []) {
      const one = raw ? normalizeMinePreset(raw as unknown as Record<string, unknown>) : null;
      if (one && !entries.some(exist => exist.id === one.id)) entries.push(one);
    }
    return {
      ok: Boolean(result?.ok) && entries.length > 0,
      message: String(result?.message || ''),
      entries,
      files: Number(result?.files || 0),
      skipped: Array.isArray(result?.skipped) ? result.skipped : [],
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '导入失败。', entries: [], files: 0, skipped: [] };
  }
}
