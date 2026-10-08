/*
 * 创作预设（2026-10-06）—— 纯函数层。
 *
 * 单独成一个文件，跟 `textChain.ts` / `mediaChain.ts` 是同一个路子：
 * 「挑中的几个预设最后拼成什么样的一句话」是纯逻辑，看界面看不出它对不对，
 * 只能拿断言钉住。真会出的错就是这类：**顺序错了** ——
 * 前缀跑到正文后面，模型会把它当成画面描述的一部分；少拼一段，界面上照样显示「已选」。
 *
 * 🔴 所以这个文件**不 import 任何带 `@/` 别名、拖着整条工作流依赖链的模块** ——
 * 它要能单独编译成 CJS 跑单测，不能一编译就把半个子项目拖进来。
 * （`./creativeCatalog` 只导出常量与类型，没有副作用，可以引。）
 */

/*
 * `creativeCatalog.ts` 是**生成物**（285 条从 AIFISHER 抽出来的，不要手改），
 * 所以「档」这个类型在那边只认内置三档；自建档是后来加的（2026-10-08），
 * 宽的那份类型定义在这里 —— 全工程一律从这里拿 `CreativePresetKind` / `CreativePreset`，
 * 别再从 `./creativeCatalog` 直接引类型（那边只有常量 `CREATIVE_PRESETS` 该被外面引）。
 */
import type {
  CreativePreset as CatalogPreset,
  CreativePresetKind as BuiltinPresetKind,
} from './creativeCatalog';

/** 内置的档。 */
export type PresetBuiltinKind = BuiltinPresetKind;

/**
 * 自建的档用 `k-<随机>` 这个 id（与 D站标签那边 `c-` 前缀同一个思路）：
 * 一眼分得开「内置的」和「用户自己建的」，而且 `Record<PresetBuiltinKind, …>`
 * 这种按字面量穷举的写法不会因为多了几个档就类型爆炸。
 */
export type CreativePresetKind = BuiltinPresetKind | `k-${string}`;

export type CreativePreset = Omit<CatalogPreset, 'kind'> & { kind: CreativePresetKind };

export type { CreativePresetKind as PresetKind };

/**
 * 一个节点上选中的预设：**每一档可以选多条**（2026-10-07 徐先：「风格可以添加多个标签」）。
 *
 * 形状为什么是 `CreativePreset | CreativePreset[] | null`：
 * 老画布存下来的 `creativePresets.style` 是**单个对象**（每档一条那阵子写的），
 * 新写的一律是数组。读的时候两者都收（`picksOfKind()` 一处归一），写的时候统一写数组。
 * 这样老工程打开不会「那格空了」，新工程也不会因为多一条就报错。
 *
 * 🔴 哪一档能选几条是不一样的（见 `maxPicksFor`）：风格 / 滤镜是「画面定成什么样」，
 * 叠加是自然的（暖阳赛璐璐 + 胶片颗粒）；运镜说的是**镜头这一段怎么动**，
 * 选两条是「既推又摇」还是「先推后摇」？模型只能猜 —— 所以运镜仍然只留一条。
 */
export type CreativePresetPick = {
  style?: CreativePreset | CreativePreset[] | null;
  filter?: CreativePreset | CreativePreset[] | null;
  motion?: CreativePreset | CreativePreset[] | null;
};

/** 空值一律当「这一档没选」，别在各处自己判。 */
export const CREATIVE_PICK_NONE: CreativePreset[] = [];

/** 内置三档在界面上的显示名（tab、按钮、失败提示共用一份，别各处再写一遍）。 */
export const CREATIVE_KIND_LABEL: Record<BuiltinPresetKind, string> = {
  style: '风格',
  filter: '滤镜',
  motion: '运镜',
};

/*
 * ---------------------------------------------------------------------------
 * 自建的档（2026-10-08）
 * ---------------------------------------------------------------------------
 *
 * 档的**名字**和「能选几条」是**用户数据**（存在 `<dataDir>/creative-presets/mine.json`），
 * 而这一层是纯函数、要能单独编译跑单测 —— 所以这里放一份**注册表**，由外面
 * （`src/lib/presetMine.ts` 读完盘之后）灌进来。跟 `danbooruCats` 那份缓存一个路子。
 *
 * 🔴 为什么要注册表而不是「把名字塞进每条预设里」：一个档的名字改一次，
 *    所有条目都得跟着改；而条目在节点上还存着**快照**（改名前的那一份），
 *    那就变成同一个档有两个名字。注册表里改一处就够了。
 */
type KindDef = { name: string; single: boolean };

let extraKinds: Record<string, KindDef> = {};

/** 灌入当前有哪些自建档（每次从磁盘读回来都调一次）。 */
export function registerExtraKinds(list: { id: string; name: string; single: boolean }[]): void {
  const next: Record<string, KindDef> = {};
  for (const item of list || []) {
    const id = String(item?.id || '').trim();
    if (!id) continue;
    next[id] = { name: String(item.name || '').trim() || '预设', single: item.single === true };
  }
  extraKinds = next;
}

/** 是不是自建的档（内置三档不是）。 */
export function isCustomKind(kind: unknown): boolean {
  return typeof kind === 'string' && /^k-/i.test(kind);
}

/** 档的显示名：内置查表，自建查注册表，都没有就落一个「预设」—— 别返回空串。 */
export function kindLabelOf(kind: unknown): string {
  const key = String(kind || '');
  if (key === 'style' || key === 'filter' || key === 'motion') return CREATIVE_KIND_LABEL[key];
  return extraKinds[key]?.name || '预设';
}

/**
 * 这一档最多能选几条。
 *
 * 运镜 = 1：镜头怎么动只能有一个说法（见 `CreativePresetPick` 上那段注释）。
 * 风格 / 滤镜不限：它们是叠加的定语。
 * **自建档由建档时定的 `single` 决定**（他选的「可叠加 / 只一条」）。
 */
export function maxPicksFor(kind: CreativePresetKind): number {
  if (kind === 'motion') return 1;
  if (isCustomKind(kind)) return extraKinds[String(kind)]?.single ? 1 : Number.POSITIVE_INFINITY;
  return Number.POSITIVE_INFINITY;
}

/**
 * 当前一共有哪些档：**内置三档 + 自建档 + 数据里出现过但已经没定义的自建档**。
 *
 * 最后那一半不是多余的：节点上存的是快照，用户把某个自建档删掉之后，
 * 老画布里那档选的预设还在 —— 顺序里没有它，`picksOf` 就会把它漏掉，
 * 表现为「打开老工程，那一档的已选标签没了，但提示词里还有」。
 */
export function orderedKinds(pick?: CreativePresetPick | null): CreativePresetKind[] {
  const out: CreativePresetKind[] = [...CREATIVE_KIND_ORDER];
  for (const id of Object.keys(extraKinds)) {
    if (!out.includes(id as CreativePresetKind)) out.push(id as CreativePresetKind);
  }
  if (pick && typeof pick === 'object') {
    for (const key of Object.keys(pick as Record<string, unknown>)) {
      if (isCustomKind(key) && !out.includes(key as CreativePresetKind)) out.push(key as CreativePresetKind);
    }
  }
  return out;
}

/**
 * 拼装顺序：**前缀们 → 正文 → 后缀们**。
 *
 * 🔴 与 AIFISHER 的 `Hae()` 逐字一致：
 *   `[style, filter, motion].map(prefix)` → 正文 → `[style, filter, motion].map(prompt)`
 *
 * 为什么前缀必须全在前面：那几段是「怎么画」的指令（风格定语、处理要求），
 * 正文是「画什么」。指令夹在画面描述中间，模型容易把指令本身也当成画面内容画出来。
 *
 * 为什么运镜排在 filter 之后：运镜说的是**时间维度的镜头运动**，风格与滤镜说的是
 * 单帧长什么样 —— 由静到动排，读起来才顺，改的人也一眼看得出该往哪加档。
 */
export const CREATIVE_KIND_ORDER: CreativePresetKind[] = ['style', 'filter', 'motion'];

/**
 * 取某一档选中的**那几条**（2026-10-07 起可以多条）。
 *
 * 🔴 单条对象与数组**都得认**：老画布存的是单条、新写的是数组。
 * 只认数组的话，所有老工程一打开那格就空了 —— 而用户看到的只是「我挑的风格没了」。
 *
 * 顺手做两件事：丢掉形状不对的（坏数据不该让整档消失）、**按 id 去重**
 * （同一条被存两遍的话，提示词里会出现两句一模一样的风格描述）。
 */
export function picksOfKind(
  pick: CreativePresetPick | null | undefined,
  kind: CreativePresetKind,
): CreativePreset[] {
  if (!pick || typeof pick !== 'object') return [];
  const raw = (pick as Record<string, unknown>)[kind];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: CreativePreset[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const item = normalizePreset(entry);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * 一个节点选中的三档，按固定顺序摊平成数组（**跳过没选的**）。
 *
 * 界面显示「已选：风格A、滤镜B」、拼提示词、探针断言顺序，三处都走它 ——
 * 三处各写一遍 `[pick.style, pick.filter, pick.motion].filter(Boolean)` 的话，
 * 迟早有一处忘了 `filter(Boolean)`，然后 `undefined.prompt` 在运行时炸。
 *
 * 风格 / 滤镜各可能多条，摊平之后就是「风格1、风格2、滤镜1、运镜1」这个顺序。
 */
export function picksOf(
  pick: CreativePresetPick | null | undefined,
  kinds?: CreativePresetKind[],
): CreativePreset[] {
  if (!pick || typeof pick !== 'object') return [];
  const out: CreativePreset[] = [];
  for (const kind of kinds || orderedKinds(pick)) out.push(...picksOfKind(pick, kind));
  return out;
}

/**
 * 取某一档选中的**第一条**（没选 / 存下来的东西已失效 → `null`）。
 *
 * 用它的地方都是「一颗按钮上写点什么」这类**只放得下一条**的场合
 * （「风格 · 暖阳赛璐璐CG +2」）—— 多条时拿第一条当代表，别在这里做截断拼接。
 */
export function pickOf(pick: CreativePresetPick | null | undefined, kind: CreativePresetKind): CreativePreset | null {
  return picksOfKind(pick, kind)[0] || null;
}

/**
 * 往这一档里**加一条**（或在已选时**去掉**它），返回这一档的结果。
 *
 * 放在纯函数层是因为「点第二张卡片是替换还是叠加」这个决定看不见摸不着，
 * 界面上点一下就过去了 —— 只能拿断言钉住（见 `_test-creative-presets.py` 第 11 节）。
 */
export function togglePickIn(
  pick: CreativePresetPick | null | undefined,
  kind: CreativePresetKind,
  preset: CreativePreset,
): CreativePreset[] {
  const current = picksOfKind(pick, kind);
  if (current.some(item => item.id === preset.id)) {
    return current.filter(item => item.id !== preset.id);
  }
  const limit = maxPicksFor(kind);
  /* 单条那几档（运镜）：新的顶掉旧的，不追加。 */
  if (current.length >= limit) return [preset];
  return [...current, preset];
}

/**
 * 一条预设的最小合法形状。
 *
 * 🔴 这里做的是**形状校验、不是内容校验**，跟 AIFISHER 的 `nS()` 一个尺度：
 * 从画布 JSON 读回来的可能是老版本存的、手改过的、甚至压根不是预设的东西。
 * 校验不过就当没选 —— 悄悄跳过，而不是抛异常。理由：一个坏掉的预设不该让
 * 整张画布打不开，用户要的是「那格空了，我再挑一次」，不是一屏报错。
 *
 * ⚠️ **不校验 `preview` 指向的文件在不在**：那是运行期的事（打包漏了图 / 用户手删），
 * 卡片上显示占位符就够了，不构成「这条预设不可用」。
 */
export function normalizePreset(value: unknown): CreativePreset | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const kind = raw.kind;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
  if (!id || !name) return null;
  /* 自建档（`k-xxx`）也算合法 —— 形状的规矩是「有前缀」，不是「背得出那几个 id」。 */
  if (kind !== 'style' && kind !== 'filter' && kind !== 'motion' && !isCustomKind(kind)) return null;
  return {
    id,
    kind: kind as CreativePresetKind,
    category: typeof raw.category === 'string' ? raw.category : '',
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    prompt,
    preview: typeof raw.preview === 'string' ? raw.preview : '',
    ...(typeof raw.poster === 'string' && raw.poster ? { poster: raw.poster } : {}),
    ...(typeof raw.prefix === 'string' && raw.prefix ? { prefix: raw.prefix } : {}),
  };
}

/** 从节点数据里读出选中的预设（形状不对时返回空对象，**不抛**）。 */
export function creativePicksFrom(data: unknown): CreativePresetPick {
  if (!data || typeof data !== 'object') return {};
  const raw = (data as Record<string, unknown>).creativePresets;
  if (!raw || typeof raw !== 'object') return {};
  const out: CreativePresetPick = {};
  for (const kind of orderedKinds(raw as CreativePresetPick)) {
    const list = picksOfKind(raw as CreativePresetPick, kind);
    if (list.length) (out as Record<string, CreativePreset[]>)[kind] = list;
  }
  return out;
}

/** 这个节点上选了东西没有（决定那排按钮要不要显示已选标签、要不要拼进提示词）。 */
export function hasCreativePicks(value: unknown): boolean {
  return picksOf(creativePicksFrom(value)).length > 0;
}

/**
 * 🔴 ComfyUI-Easy-Use 那批预设的正文里带一个 `Subject:{prompt}` 占位符（2026-10-07）。
 *
 * 它说的是「**用户写的主体该插在这里**」，不是字面的四个字符。原样拼出去的话，
 * 模型会收到一句带着 `{prompt}` 的提示词 —— 最坏情况下它真的去画一个叫 prompt 的东西。
 *
 * 为什么**不在导入时**就把占位符替换掉 / 删掉：正文是**每次提交都可能变**的，
 * 换一句主体就得重新导入一次，那批 88 MB 的图也要跟着重搬。替换只能是提交时的事。
 */
const PLACEHOLDER = /\{\s*prompt\s*\}/i;
const PLACEHOLDER_ALL = /\{\s*prompt\s*\}/gi;

/** 这条预设的正文是不是自带「主体插在这」的占位符。 */
export function hasPromptPlaceholder(prompt: string): boolean {
  return PLACEHOLDER.test(String(prompt || ''));
}

/** 收掉多余空白与空洞的标点（替换完占位符之后总会有一些）。 */
function tidyPrompt(text: string): string {
  return String(text || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,，.。])/g, '$1')
    .replace(/([,，])(?:\s*[,，])+/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * 把占位符换成真正的主体。
 *
 * `subject` 为空（用户没写正文，只想拿预设跑一张图）时，占位符**连同它前面那个
 * 引导词一起删掉** —— 否则提示词末尾留一个孤零零的 `Subject:`，
 * 模型会把它当成要画的东西。`Subject:` / `主体：` 两种写法都认（中英两批预设都有）。
 */
export function fillPromptPlaceholder(prompt: string, subject: string): string {
  const raw = String(prompt || '');
  if (!hasPromptPlaceholder(raw)) return tidyPrompt(raw);
  const body = String(subject || '').trim();
  if (body) return tidyPrompt(raw.replace(PLACEHOLDER_ALL, body));
  return tidyPrompt(
    raw
      .replace(PLACEHOLDER_ALL, '')
      .replace(/(?:subject|主体)\s*[:：]\s*$/i, '')
      .replace(/[,，]\s*$/, ''),
  );
}

/**
 * 把选中的预设拼进提示词 —— **先前缀、再正文、最后后缀**。
 *
 * 入参 `text` 是这一轮本来要提交的那句（上游文本链 + 导演台已经拼好的结果）。
 * 出来的是最终要送出去的那一段。
 *
 * 空值处理：
 *   - 没选任何预设 → **原样返回 `text`**（一个字都不动，老画布行为完全不变）；
 *   - 预设段自己为空 → 跳过那一段，不留下多余空行（与 `joinTextParts` 同一套规矩）；
 *   - `text` 为空也行 —— 用户可能只想用预设的描述跑一张图（与「提示词不是闸」一致）。
 *
 * 🔴 带 `Subject:{prompt}` 的那批（ComfyUI-Easy-Use）：正文**填进占位符里**，
 * 不再单独出现在最后 —— 它本来就该在预设说的那个位置上。
 * 多条都带占位符时**只有第一条吃正文**：同一句主体在提示词里出现两次，
 * 模型只会更困惑（而且每档只能选一条，这种情况本来就罕见）。
 *
 * 分隔用 `\n`：与 `generate()` 里拼导演台那句用的是同一个（那边也是 `join('\n')`），
 * 换成 `\n\n`（文本链用的那个）会让「预设 + 正文」看起来像两个独立段落，
 * 而它们本来就是在说同一张图。
 */
export function composeCreativePrompt(text: string, pick: CreativePresetPick | null | undefined): string {
  const items = picksOf(pick);
  if (!items.length) return text;

  const body = String(text || '').trim();
  const prefixes: string[] = [];
  const bodies: string[] = [];
  /** 正文已经被某条预设的占位符吃掉了吗 —— 吃了就别再往最后补一遍。 */
  let consumed = false;

  for (const item of items) {
    const prefix = String(item.prefix || '').trim();
    if (prefix) prefixes.push(prefix);
    const raw = String(item.prompt || '').trim();
    if (!raw) continue;
    if (hasPromptPlaceholder(raw)) {
      const subject = consumed || !body ? '' : body;
      if (subject) consumed = true;
      const piece = fillPromptPlaceholder(raw, subject);
      if (piece) bodies.push(piece);
    } else {
      bodies.push(raw);
    }
  }

  return [...prefixes, ...(consumed ? [] : [body]), ...bodies].filter(Boolean).join('\n');
}

/**
 * 这个节点上「能选哪几档」。
 *
 * 🔴 运镜**只对视频生成节点开放**：图片生成是一张静帧，没有时间维度，
 * 给它一个「镜头怎么运动」的选项，用户挑了半天、结果什么都没发生 ——
 * 而界面上那个标签还挂着「已选：固定机位」，看着像生效了。
 *
 * 判据用 kind 而不是「输出类型」：`image-generate` 永远出图，
 * `video-generate` 出片（也可能出图/音频，但那不影响它能选运镜）。
 */
export function creativeKindsFor(kind: unknown, extra: string[] = []): CreativePresetKind[] {
  const customs = extra.filter(item => isCustomKind(item)) as CreativePresetKind[];
  if (kind === 'video-generate') return ['style', 'filter', 'motion', ...customs];
  if (kind === 'image-generate') return ['style', 'filter', ...customs];
  return [];
}

/** 这一类节点能不能挂预设（生成节点才挂，别的节点一律不显示那排按钮）。 */
export function supportsCreativePresets(kind: unknown): boolean {
  return creativeKindsFor(kind).length > 0;
}
