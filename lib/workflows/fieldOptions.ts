import 'server-only';
import { readLocalCredentials, type LocalCredentials } from '@/lib/providers/local/connection';
import { fieldChoices, localServiceAlive } from '@/lib/providers/local/diagnose';
import { CUSTOM_CLASS_TYPE } from './configuration';

/**
 * 把「看上去是个文本框、其实是个枚举」的字段**补上可选项**（2026-10-10 徐先）。
 *
 * 起因：配置页里 `MiniMaxH3IntegrationGH` 的 `aspect` 显示成一个光秃秃的输入框，
 * 而它在 ComfyUI 里明明是九选一（`adaptive / 16:9 / 9:16 / …`）。原因是**字段列表是从图上扫出来的**
 * （`graphToFields`），而图上只有「当前这个值」——`'16:9'` 是个字符串，光看它我们无从知道
 * 这一项是九选一还是随便填。真正知道答案的是 ComfyUI 自己：问它的 `/object_info/<节点类型>`，
 * 那一项的规格就写着 `['COMBO', { options: [...] }]`（老式节点写成 `[['a','b'], {}]`）。
 *
 * 于是这一层做的事只有一件：**拿着 `classType + fieldName` 去问本机 ComfyUI，把选项挂回字段上**。
 * 挂上之后配置页（以及画布上的「应用参数」面板）就能把它渲染成下拉 —— 那一侧的渲染本来就支持，
 * 之前只是没人给它喂过选项（`options` 只有 RunningHub **应用**那条路会填）。
 *
 * 🔴 三条硬边界，都是为了让这份改动**只会把界面变好，不会把配置弄坏**：
 *   1. **查不到就是查不到，绝不猜**。机器没开 / 没这个节点 / 这一项不是挑选型 → 保持原样（文本框）。
 *      以前是什么样，那时候还是什么样。
 *   2. **只要清单小得像个枚举**。模型 / LoRA 那种清单（几百项、名字老长）一律不挂 ——
 *      用户往 models 目录里丢一个文件，这份冻结在配置里的清单就过期了，下拉里没有新的那个，
 *      比原来的文本框更糟。而且 `fieldSchema.options` 有 60 项 / 每项 80 字的上限，
 *      超限会让整份配置在 `safeParse` 处失败 —— 那种失败表现出来是「保存不了」，最难查。
 *   3. **整段是尽力而为**。读库失败、请求超时、返回了认不出的形状 —— 一律吞掉，
 *      返回原来的字段列表。这是一个「让界面更好用」的动作，不该有把配置页弄挂的能力。
 */

/** 与 `fieldSchema.options` 的上限一致：超了这份配置就存不进去。 */
const MAX_OPTION_COUNT = 60;
const MAX_OPTION_LEN = 80;
/** 一份图里最多查多少个不同的节点类型（多了就是几十次请求，配置页不该等那么久）。 */
const MAX_CLASS_TYPES = 40;
/** 并发数：本机 ComfyUI 一个 `/object_info/<type>` 只要几毫秒，但排队还是比并发慢。 */
const CONCURRENCY = 8;
/** 总预算。超了就用已经查到的那部分 —— 少几个下拉可以，配置页打不开不行。 */
const DEADLINE_MS = 4000;

/**
 * 哪些字段**不补选项**：名字看着像「从本机的一堆文件里挑一个」的那些（与 `diagnose.ts` 同源）。
 *
 * 它们的清单会随用户增删模型而变，冻进配置里必然过期（见上面边界 2）。
 */
const RESOURCE_FIELD = /(ckpt|checkpoint|unet|lora|vae|control_?net|embedding|upscale|style_model|clip|diffusion|transformer|text_encoder|gguf|model)/i;

/** 媒体字段是上传 / 文件路径，不是从清单里挑 —— 哪怕它在 object_info 里是个 COMBO 也不挂。 */
const MEDIA_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'latent']);

type RawField = Record<string, unknown>;

/** 这一条值不值得去问一次 ComfyUI。返回 null = 不用问，保持原样。 */
function lookupTarget(field: RawField): { classType: string; fieldName: string } | null {
  /*
   * 只认「图里带回来的真类名」：`Custom` 是手加的 / 图上没写 class_type 的两种，
   * 问 ComfyUI 也问不出东西（那种节点在它那儿根本不存在）。
   */
  const classType = typeof field.classType === 'string' ? field.classType.trim() : '';
  if (!classType || classType === CUSTOM_CLASS_TYPE) return null;
  const fieldName = typeof field.fieldName === 'string' ? field.fieldName.trim() : '';
  if (!fieldName) return null;
  if (MEDIA_KINDS.has(String(field.kind ?? ''))) return null;
  if (RESOURCE_FIELD.test(fieldName)) return null;
  return { classType, fieldName };
}

/**
 * 这份清单配不配变成下拉。
 *
 * 1 项的列表没有意义（下拉只有一个可选项，不如直接显示那个值），超限的会撑爆 schema。
 */
function acceptable(options: string[] | null): string[] | null {
  if (!options || options.length < 2 || options.length > MAX_OPTION_COUNT) return null;
  const cleaned = options.map(item => String(item).trim()).filter(Boolean);
  if (cleaned.length < 2 || cleaned.length > MAX_OPTION_COUNT) return null;
  if (cleaned.some(item => item.length > MAX_OPTION_LEN)) return null;
  return [...new Set(cleaned)];
}

/** 小并发跑一批，返回「类型 → 该类型下 字段名 → 选项」两层表。 */
async function collectChoices(
  credentials: LocalCredentials,
  pairs: { classType: string; fieldName: string }[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const started = Date.now();
  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    /* 每批之前看一眼预算：宁可少几个下拉，也不让配置页一直转圈。 */
    if (Date.now() - started > DEADLINE_MS) break;
    const chunk = pairs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async pair => {
      try {
        return acceptable(await fieldChoices(credentials, pair.classType, pair.fieldName));
      } catch {
        return null;
      }
    }));
    chunk.forEach((pair, index) => {
      const options = results[index];
      /* 没查到就**不写表**：下面按「表里有没有」决定要不要动原字段，写个 null 进去没区别。 */
      if (options) out.set(`${pair.classType}\0${pair.fieldName}`, options);
    });
  }
  return out;
}

/**
 * 给一批字段补选项（原地不动那份原列表，返回新数组）。
 *
 * 🔴 **查得到的才覆盖，查不到的不动**：RunningHub 应用那类字段自己带着 `options`
 * （从应用的 `fieldData` 里解析出来的），它的类名是 `RunningHubWebAppField`，
 * 本机 ComfyUI 那台机器上没有这个类型 → 查不到 → 原来那份选项原样留着。
 * 反过来，两边都能查到时以本机的为准 —— 那是这台机器上真正能填的值。
 */
export async function enrichFieldOptions(
  fields: unknown[],
  userId: string,
): Promise<{ fields: unknown[]; enriched: number }> {
  const wanted = new Map<string, { classType: string; fieldName: string }>();
  for (const item of fields) {
    if (!item || typeof item !== 'object') continue;
    const field = item as RawField;
    const target = lookupTarget(field);
    if (!target) continue;
    /*
     * 按「节点类型 + 字段名」去重：同一份配置里同一个组合只问一遍 ComfyUI。
     * 已经带着选项的那些**也要查**（本机那份更准，见上面的「查得到才覆盖」）。
     */
    const key = `${target.classType}\0${target.fieldName}`;
    if (!wanted.has(key)) wanted.set(key, target);
  }
  if (!wanted.size) return { fields, enriched: 0 };
  const pairs = [...wanted.values()].slice(0, MAX_CLASS_TYPES);
  try {
    const credentials = await readLocalCredentials(userId);
    /*
     * 先探一次活：**服务没开就不要去问几十次**。每一问都会等它连接失败，
     * 那种「配置页转半天才出来一片文本框」正是这一层最该避免的。
     */
    if (!await localServiceAlive(credentials)) return { fields, enriched: 0 };
    const choices = await collectChoices(credentials, pairs);
    if (!choices.size) return { fields, enriched: 0 };
    let enriched = 0;
    const next = fields.map(item => {
      if (!item || typeof item !== 'object') return item;
      const field = item as RawField;
      const target = lookupTarget(field);
      if (!target) return item;
      const options = choices.get(`${target.classType}\0${target.fieldName}`);
      if (!options) return item;
      enriched += 1;
      return { ...field, options };
    });
    return { fields: next, enriched };
  } catch {
    /* 尽力而为：这一层唯一不该做的事就是让配置页打不开（理由见文件头边界 3）。 */
    return { fields, enriched: 0 };
  }
}
