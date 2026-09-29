/**
 * RunningHub **应用**（WebApp / AI App）的身份约定与字段投影。
 *
 * 它和「工作流」不是同一件事，虽然两者都长在 RunningHub 上、都用一串数字认：
 *
 *   - 工作流：一份 ComfyUI 图，靠 `getJsonApiFormat` 把节点的 `inputs` 摊平成字段；
 *   - 应用：一个打包好的 AI 应用（`runninghub.cn/ai-detail/<id>`），靠 `apiCallDemo`
 *     拿到它**对外公开**的那份 `nodeInfoList`，提交走 `/task/openapi/ai-app/run`。
 *
 * 为什么复用 `WorkflowDraft` 这一张表、只加一个 ID 前缀（`app-`），而不是另开一张：
 *   1. **字段配置只有一套**：`configuration.ts` 的 fieldSchema、画布绑定、`toNodeInfoList`
 *      都是三种来源共用的。另开一张表等于让用户为同一件事学两遍界面。
 *   2. 差别只有两处 —— **字段从哪儿来**（app 是 `apiCallDemo`）与**提交给谁**
 *      （app 是 `ai-app/run`）。这两处看 ID 前缀就够了。
 *
 * 本文件**不 import 数据库、不 import server-only** —— 界面（筛选列表、新建表单）
 * 与服务端（校验、拉取）要判的是同一件事，回归脚本也要能直接加载它。
 */

import {
  MAX_REFERENCE_IMAGES, fieldKey, normalizeFieldLabel, type WorkflowField,
} from './configuration';

/** 应用的工作流 ID 前缀。带上它就不可能和 RunningHub 的纯数字工作流 ID 撞车。 */
export const RUNNINGHUB_APP_PREFIX = 'app-';

/** `app-` + RunningHub 的应用 ID（也是一串数字）。 */
const APP_ID = /^app-\d{1,30}$/;

/** RunningHub 一个应用最多公开多少个可调用字段（与它自己的上限一致）。 */
export const RUNNINGHUB_APP_FIELDS_LIMIT = 256;

/** 这一份是不是「应用」。看前缀就够了，不用查库 —— 路由收到请求的第一时间就得知道。 */
export function isRunningHubAppWorkflowId(value: unknown): boolean {
  return typeof value === 'string' && APP_ID.test(value);
}

/**
 * 从 `app-<id>` 取出 RunningHub 认的那个应用 ID。
 *
 * 不是应用 ID 就返回 `null`（**不抛**）：调用方多半是在「这一份是不是应用」的分支里，
 * 抛一个错等于把一次普通的判断变成一次要 try/catch 的控制流。
 */
export function webAppIdOf(workflowId: unknown): string | null {
  if (!isRunningHubAppWorkflowId(workflowId)) return null;
  return String(workflowId).slice(RUNNINGHUB_APP_PREFIX.length);
}

/** 反过来：一个应用 ID 在 `WorkflowDraft` 里该长什么样。 */
export function appWorkflowIdOf(webAppId: string): string {
  return `${RUNNINGHUB_APP_PREFIX}${webAppId}`;
}

export type ParsedWebAppInput = { ok: true; webAppId: string; workflowId: string } | { ok: false; message: string };

/**
 * 把用户**随手粘进来**的那串东西收拾成一个应用 ID。
 *
 * 认三种写法，因为它们都是「用户在应用页面上顺手复制的」：
 *   - 纯数字（`1939734...`）；
 *   - 应用详情页链接（`https://www.runninghub.cn/ai-detail/123?from=...`）；
 *   - 链接里带 `webappId=123` 的那种分享地址。
 *
 * ⚠️ 判定是**先找 `/ai-detail/<数字>` 再退回纯数字**，不能反过来：一条详情页链接里
 * 到处都是数字（端口号、其它应用的 ID），先按「整串是不是数字」试会在链接上直接失败，
 * 而先按链接试、试不出来再当纯数字，两种写法都对。
 */
export function parseWebAppInput(raw: string): ParsedWebAppInput {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, message: '请填 RunningHub 应用的 ID，或把它的详情页链接粘进来。' };
  const fromPath = /\/ai-detail\/(\d{1,30})/.exec(text);
  if (fromPath) return done(fromPath[1]);
  const fromQuery = /[?&]webappId=(\d{1,30})/.exec(text);
  if (fromQuery) return done(fromQuery[1]);
  if (/^\d{1,30}$/.test(text)) return done(text);
  return { ok: false, message: '这不是一个 RunningHub 应用 ID —— 它是一串数字，也可以直接把应用详情页（/ai-detail/…）的链接粘进来。' };

  function done(webAppId: string): ParsedWebAppInput {
    return { ok: true, webAppId, workflowId: appWorkflowIdOf(webAppId) };
  }
}

/** RunningHub `nodeInfoList` 里一条的样子（只取我们真的会读的那几列）。 */
export type WebAppFieldInput = {
  nodeId?: unknown;
  fieldName?: unknown;
  fieldType?: unknown;
  label?: unknown;
  name?: unknown;
  description?: unknown;
  required?: unknown;
  defaultValue?: unknown;
  fieldValue?: unknown;
  value?: unknown;
  options?: unknown;
  /**
   * 字段的**元信息**，一个 JSON 字符串 —— 应用的选项 / 范围都在这里，不在平铺的 `options` 里。
   * 形状见 `metaOf`。
   */
  fieldData?: unknown;
};

/** 一个应用字段自己公开的元信息（从 `fieldData` 里解出来）。 */
type WebAppFieldMeta = { options: string[] };

/**
 * 解 `fieldData`。
 *
 * 应用把字段的元信息塞在**一个 JSON 字符串**里（不是 `options` / `min` / `max` 这些平铺键），
 * 实测四种形状：
 *   `["FLOAT", {"max": 16, "min": 0.1, "step": 0.1, "default": 1}]`
 *   `["LIST",  {"default": "1:1 (Square)", "options": ["1:1 (Square)", ...]}]`
 *   `["STRING", {"default": "prompt", "multiline": true}]`
 *   `[["example.png", "None", ...], {"image_upload": true}]`
 * 还有一种**没有外层类型名**的（`easy anythingIndexSwitch` 的 `index`，`fieldType` 是 `SWITCH`）：
 *   `[{"name":"value1","index":1,"description":"武戏"}, {"name":"value0","index":0,"description":"文戏"}]`
 *
 * 最后那种最关键：不解它，界面上就只有一个「模式选择」，而 `0` 是文戏、`1` 是武戏这件事
 * 只存在于应用的网页里 —— 用户在节点上根本没法选。
 *
 * 解出来的选项一律写成「文字=值」（SWITCH）或「值」（COMBO）：界面据此渲染下拉，
 * 提交的仍然是 `=` 后面那一段。没有 `=` 的（比例档那种）整串就是值。
 */
function metaOf(input: WebAppFieldInput): WebAppFieldMeta {
  const out: WebAppFieldMeta = { options: [] };
  let node: unknown = input.fieldData;
  if (typeof node === 'string') {
    try { node = JSON.parse(node); } catch { return out; }
  }
  if (!Array.isArray(node)) return out;
  const head = node[0];
  const params = node[1];
  if (typeof head === 'string' && params && typeof params === 'object' && !Array.isArray(params)) {
    const row = params as { options?: unknown };
    if (Array.isArray(row.options)) {
      out.options = row.options.map(item => String(item ?? '').trim()).filter(Boolean).slice(0, 60);
    }
    return out;
  }
  /* SWITCH：每一项是一个「名字 + 下标」，**下标才是要填的值**（fieldValue 也是下标）。 */
  for (const item of node) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as { description?: unknown; name?: unknown; index?: unknown };
    const text = String(row.description ?? row.name ?? '').trim();
    if (!text) continue;
    out.options.push(row.index === undefined || row.index === null ? text : `${text}=${String(row.index)}`);
  }
  return out;
}

/**
 * RunningHub 的字段类型 → 我们自己的字段类型。
 *
 * 两边不是同一套词：它那边有 `int` / `float` / `combo` / `select`，我们这边只有
 * `text` / `number` / `boolean` / `image` / `video` / `audio` / `latent`。
 *
 * ⚠️ `select`（下拉）**落成 `text` 而不是 `number`**：下拉里的选项常常是字符串
 * （模型名、比例档位），落成 number 会在保存时撞上「需要有效数字」那条校验。
 * 选项的值本身仍由用户按应用页面上看到的原样填 —— 界面上把选项写进 label 里提示。
 */
function inferKind(fieldType: unknown, options: string[]): WorkflowField['kind'] {
  const type = String(fieldType || '').toLowerCase();
  if (/image|picture|photo|mask|图片|图像/.test(type)) return 'image';
  if (/video|movie|视频/.test(type)) return 'video';
  if (/audio|sound|voice|music|音频|声音/.test(type)) return 'audio';
  /*
   * ⚠️ `SWITCH` **不落 `boolean`**（2026-09-26 实测）。
   *
   * RunningHub 上 `easy anythingIndexSwitch` 的 `index` 就是 `SWITCH` 类型，但它不是一个开关 ——
   * 它是「走第几路」：`fieldData` 里写着 文戏=0 / 武戏=1，默认值 `"0"`。
   * 落成 `boolean` 之后 `defaultValueOf` 会把 `"0"` 收成 `"false"` 发出去：应用收到一个布尔量，
   * 要么直接报错要么走错分支，而界面上一个字都不会说 —— 这正是「节点参数不对」的硬伤。
   * 也不能落 `number`：值有可能是 `value0` 这种名字，落 number 会撞「需要有效数字」那条校验。
   */
  if (/switch/.test(type)) return 'text';
  if (/boolean|bool|toggle/.test(type)) return 'boolean';
  if (/int|integer|float|double|number|数字|整数/.test(type)) return 'number';
  if (options.length) return 'text';
  return 'text';
}

/**
 * 应用字段该绑到画布的哪一档（2026-09-26）。
 *
 * 应用**自己已经把参数填好了**（prompt 有内容、时长/像素/强度都有默认值），
 * 所以只有两样东西真的要画布来给：**提示词**和**图**。其余一律 `manual`、
 * 用应用填好的那个值 —— 那才是「应用把参数填好了」的意思。
 *
 * 🔴 刻意**不**绑 `duration` / `aspect_ratio` / `megapixels`：
 *   应用那三项是「30」「16:9 (Widescreen)」「0.4」，而画布这三档的口径是
 *   「6 秒」「16:9」「1MP」—— 绑上去等于用画布的口径**覆盖掉应用填好的值**
 *   （一个 30 秒的应用被压成 6 秒，界面上还什么都不说）。要让画布能改这几项，
 *   得先把档位翻译成应用认的那份字符串，那是另一件事。
 */
function appBindingFor(
  kind: WorkflowField['kind'],
  fieldName: string,
  label: string,
  imageSlot: number,
  promptTaken: boolean,
): WorkflowField['binding'] {
  /* 图：按出现顺序占参考图槽位，超出上限的退回手填（越界的槽位名不在枚举里）。 */
  if (kind === 'image') {
    if (imageSlot >= 1 && imageSlot <= MAX_REFERENCE_IMAGES) {
      return `reference_image_${imageSlot}` as WorkflowField['binding'];
    }
    return 'manual';
  }
  if (promptTaken) return 'manual';
  const name = fieldName.toLowerCase();
  if (name === 'prompt' || name === 'text' || name === 'positive' || name.endsWith('_prompt')) return 'prompt';
  if (/prompt|text/i.test(label)) return 'prompt';
  return 'manual';
}

/** 默认值一律收成字符串 —— `fieldSchema.value` 就是字符串，`toNodeInfoList` 也只发字符串。 */
function defaultValueOf(input: WebAppFieldInput, kind: WorkflowField['kind']): string {
  const raw = input.fieldValue ?? input.defaultValue ?? input.value;
  if (raw === undefined || raw === null || Array.isArray(raw) || typeof raw === 'object') {
    return kind === 'boolean' ? 'false' : '';
  }
  const text = String(raw);
  /*
   * RunningHub 没填默认值时会给 Python 的 `None`（stringify 出来就是这三个字母）。
   * 当成一个真值提交出去，image 字段会收到素材名 "None" —— 应用那边认不出来，
   * 而界面上一句提示都没有。空串是对的：`toNodeInfoList` 会跳过空值。
   */
  if (text === 'None' || text === 'null' || text === 'undefined') {
    return kind === 'boolean' ? 'false' : '';
  }
  if (kind === 'boolean') return text === 'true' ? 'true' : 'false';
  return text.slice(0, 40000);
}

/** 选项收成「最多几个」的字符串数组 —— 只用来拼进 label 给人看，不参与提交。 */
function optionsOf(input: WebAppFieldInput): string[] {
  const raw = input.options;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 12).map(item => {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return String(item);
    if (item && typeof item === 'object') {
      const row = item as { value?: unknown; label?: unknown; name?: unknown };
      return String(row.value ?? row.label ?? row.name ?? '').trim();
    }
    return '';
  }).filter(Boolean);
}

/**
 * 应用公开的字段 → 配置页能勾的 `WorkflowField[]`。
 *
 * 与「工作流那份 `graphToFields`」是同一个位置：**把远端给的字段摊平成可勾选的一行行**。
 * 差别只在入口（那边是一张 ComfyUI 图，这边是一个 `nodeInfoList`）。
 *
 * 三条与那边一致的规矩：
 *   - `enabled` 默认 **true**（2026-09-26 改）：应用已经把值填好了，勾一遍是体力活，
 *     而漏勾 = 这条字段根本不提交（任务照跑、参数全丢，界面一句话都没有）；
 *   - `recommended` 默认 true：配置页左侧默认筛「常用字段」，不标推荐就是一片空白；
 *   - `label` 走 `normalizeFieldLabel`（去隐形字符），而 `fieldName` **原样** —— 那是应用认的键。
 */
export function webAppFieldsToWorkflowFields(list: unknown[]): WorkflowField[] {
  const fields: WorkflowField[] = [];
  const seen = new Set<string>();
  /* 图槽按出现顺序编号（image1 → reference_image_1）；同一份配置只把**第一个**
     提示词类字段绑到画布提示词，其余的留手填（应用常常还有第二个文本输入）。 */
  let imageSlot = 0;
  let promptTaken = false;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const input = item as WebAppFieldInput;
    const nodeId = String(input.nodeId ?? '').trim();
    const fieldName = String(input.fieldName ?? '');
    /*
     * `nodeId` 得过 `fieldSchema` 那条 `/^[\w:-]+$/`：应用里偶尔会给出带点的层级编号，
     * 那种编号提交上去服务端不认，留着只会让配置页存不下整份配置。
     */
    if (!/^[\w:-]{1,100}$/.test(nodeId)) continue;
    if (!fieldName || fieldName.length > 100) continue;
    const key = fieldKey(nodeId, fieldName);
    if (seen.has(key)) continue;
    seen.add(key);
    if (fields.length >= RUNNINGHUB_APP_FIELDS_LIMIT) break;
    /* 选项优先取 `fieldData` —— 实测平铺的 `options` 键从来没出现过，选项全在那个 JSON 串里。 */
    const meta = metaOf(input);
    const options = meta.options.length ? meta.options : optionsOf(input);
    const kind = inferKind(input.fieldType, options);
    const rawLabel = String(input.label ?? input.name ?? input.description ?? '').trim() || fieldName;
    const label = normalizeFieldLabel(rawLabel);
    if (kind === 'image') imageSlot += 1;
    const binding = appBindingFor(kind, fieldName, rawLabel, imageSlot, promptTaken);
    if (binding === 'prompt') promptTaken = true;
    fields.push({
      key,
      nodeId,
      fieldName,
      /* 有选项时把它并进显示名：下拉里能选什么，界面上得看得见，否则用户只能去应用页面抄。 */
      label: options.length ? `${label}（可选：${options.join(' / ')}）`.slice(0, 160) : label.slice(0, 160),
      kind,
      value: defaultValueOf(input, kind),
      /*
       * 默认**启用**：应用已经把值填好了，让人再勾一遍是纯体力活，
       * 而漏勾的后果是这条字段压根不进 `toNodeInfoList` —— 任务照跑、参数全丢，
       * 界面上一句提示都没有（2026-09-26「应用节点参数不对」就是这么来的）。
       */
      enabled: true,
      binding,
      recommended: true,
      classType: 'RunningHubWebAppField',
      /* 选项一起存下来：画布节点上要把它渲染成下拉，只写在 label 里选不了。 */
      ...(options.length ? { options } : {}),
    });
  }
  return fields;
}
