/**
 * 提示词优化（2026-09-21，协议照 AIFISHER 的 `createPromptAssistantRouter`）。
 *
 * 就一件事：**把用户随手写的一句话，扩成一段能直接喂给图片 / 视频模型的中文提示词**。
 * 它不调任何生成模型，只调文本模型 —— 这正是设置页「官方大语言模型」那一栏存在的理由
 * （那一栏不是用来聊天的，是给这个功能供血的）。
 *
 * 两份 system prompt 直接沿用 AIFISHER 的原文（`gWe` / `mWe`）：
 * 措辞是调过的，换一套说法等于换一个功能，没必要「重新发明」。
 *
 * 错误约定也照搬，一个是为了对得上，一个是它确实说得对：
 * - 没填提示词 → `INVALID_PROMPT`（「请输入需要优化的提示词。」）
 * - 一家文本模型都没配 → `AI_CONFIGURATION_REQUIRED`（503）
 */
import 'server-only';
import { readSkill, readSkillBody } from '@/lib/skills';
import { providerLabel } from '@/lib/providers/registry';
import { chatText, isLocalTextProvider, resolveTextCredentials, type TextCredentials } from '@/lib/providers/text';
import { withLocalModel } from '@/lib/local-llm';
import type { PromptImage } from '@/lib/promptMedia';

/** 优化提示词（AIFISHER 的 `gWe`）。 */
export const PROMPT_OPTIMIZE_SYSTEM = [
  '你是专业的 AI 视觉提示词工程师。',
  '保留用户原意，补全主体、动作、环境、构图、镜头、光线、色彩、材质、风格和氛围。',
  '输出一段可直接用于图片或视频生成的中文提示词，不添加解释、标题或引号。',
].join('');

/** 看图写提示词（AIFISHER 的 `mWe`）。 */
export const PROMPT_DESCRIBE_SYSTEM = [
  '你是专业的视觉描述与生成提示词助手。',
  '准确描述主体、动作、环境、构图、镜头、光线、色彩、材质、风格和氛围。',
  '输出可以直接用于图片或视频生成的中文提示词，不添加分析过程或标题。',
].join('');

/** 与 AIFISHER 同一个上限（它那边 `oie(prompt, "提示词", 8000)`）。 */
export const PROMPT_ASSISTANT_MAX = 8000;

export const PROMPT_ASSISTANT_ERROR = {
  code: 'AI_CONFIGURATION_REQUIRED',
  status: 503,
  message: '请先配置大语言模型 API Key（设置 · 模型服务 · 官方大语言模型），或添加一条文本类型的自定义接口。',
};

export class PromptAssistantError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'INVALID_PROMPT') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * 清理模型吐回来的那段。
 *
 * 模型很爱给结果套一层引号或 ``` 代码围栏（system prompt 里说了不要，但它照犯）。
 * 直接把带引号的结果写回提示词框，用户看到的是「我这句话怎么多了两个引号」，
 * 而真正被送去生成的也是带引号的那一串 —— 所以这一步不是洁癖，是改掉实际内容。
 */
export function cleanOptimizedPrompt(value: string) {
  return String(value ?? '')
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/```$/, '')
    .replace(/^[\s"'“”‘’「」『』《》]+/, '')
    .replace(/[\s"'“”‘’「」『』《》]+$/, '')
    .trim();
}

export type OptimizeResult = { optimizedPrompt: string; provider: string; model: string; latencyMs: number };

/** 技能正文塞进 system 时的上限。够放下正文本身，又不至于把参考资料一起拖进来。 */
export const PROMPT_SKILL_MAX = 12000;

/**
 * 把技能正文拼成一段「本次要照着写」的规矩。
 *
 * 只取 SKILL.md 正文，**不取 references** —— 那是给 Codex 那种会自己翻文件的
 * agent 准备的，优化提示词只是一次短调用，塞进去既费 token 又稀释重点。
 */
export function skillInstruction(skill: { title: string; body: string } | null | undefined): string {
  if (!skill) return '';
  const body = String(skill.body ?? '').trim().slice(0, PROMPT_SKILL_MAX);
  if (!body) return '';
  return [
    '',
    `【本次必须遵循的技能：${skill.title}】`,
    '下面这段是这个技能自己的写法规范。输出必须照它的结构、顺序与用语来写；',
    '它要求的字段一个都不能少，它明令禁止的东西一个都不能写。',
    '用户那句话是要写的内容，不是让你改写技能本身：',
    '',
    body,
  ].join('\n');
}

/**
 * 优化一句提示词。
 *
 * `preferred` 用来在设置页「测一下这家好不好用」时指定厂商；节点上那个按钮不传，
 * 走用户设的那家（没设就自动挑）。
 * `skill` 是 dock 上选中的那个技能（SKILL 社区里标了「用于提示词优化」的那些）。
 */
export async function optimizePrompt(
  userId: string,
  raw: string,
  preferred?: string,
  skill?: { title: string; body: string } | null,
  /**
   * 走本地模型时才用得上：跑完**卸不卸**、什么时候卸（2026-09-26）。
   * 不传 = 跟着设置里的「保活秒数」；`-1` = 一直装载，等用户手动卸载。
   */
  /**
   * 附加在 system 末尾的一段指令（2026-09-29：节点上的「改写强度」与「补充要求」）。
   * 空串 / 不给 = 和加这个功能之前一模一样，一个字都不追加。
   */
  options?: { keepAliveSeconds?: number; instruction?: string },
): Promise<OptimizeResult> {
  const prompt = String(raw ?? '').trim().slice(0, PROMPT_ASSISTANT_MAX);
  if (!prompt) throw new PromptAssistantError('请输入需要优化的提示词。');
  const creds = await resolveTextCredentials(userId, preferred);
  if (!creds) {
    throw new PromptAssistantError(
      missingTextModelMessage(preferred),
      PROMPT_ASSISTANT_ERROR.status,
      PROMPT_ASSISTANT_ERROR.code,
    );
  }
  /* 顺序：本职 → 技能规范 → 节点上那几项参数。技能规范放中间：它是「格式」的规矩，
     用户那两项是「幅度 / 内容」的规矩，先定格式再定幅度，模型不容易顾此失彼。 */
  const system = PROMPT_OPTIMIZE_SYSTEM + skillInstruction(skill) + String(options?.instruction || '');
  const call = () => chatText(creds, { system, user: prompt, temperature: 0.7 });
  /*
   * 本地这一档 = **按需装卸**（2026-09-27，徐先要的「先装载、优化完卸载，减少显存占用」）。
   *
   * 编排在 `lib/local-llm.ts` 的 `withLocalModel()`：它保证同一时刻只有一个
   * llama-server、跑完按「保活秒数」决定立刻卸还是过一会儿卸（默认 0 = 立刻卸）。
   * 节点上还能把它调成「一直装载」（`keepAliveSeconds = -1`，见 `GenerateDock` 那两档）。
   * 这里只负责把「装载失败」翻译成人话 —— 那是一句必须看得懂的话，因为最常见的
   * 失败原因是「还没选模型文件」和「运行时缺运行库」，两件事的下一步完全不同。
   */
  const result = isLocalTextProvider(creds.providerId)
    ? await withLocalModel(call, options?.keepAliveSeconds).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PromptAssistantError(
        `本地模型没能用起来：${detail}（在「设置 · 模型服务 · 文本 · 本地模型」里选模型或换一个运行时试试）`,
        503,
        'LOCAL_MODEL_UNAVAILABLE',
      );
    })
    : await call();
  const optimizedPrompt = cleanOptimizedPrompt(result.text);
  if (!optimizedPrompt) {
    throw new PromptAssistantError(`${creds.label} 返回的提示词是空的，换一家文本模型试试。`);
  }
  return {
    optimizedPrompt,
    provider: creds.providerId,
    model: creds.model,
    latencyMs: result.latencyMs,
  };
}

/**
 * 技能 id → 技能本体。找不到就当没选（不要因为一个技能没了就让优化失败）。
 *
 * 🔴 改写与反推两条路共用这一份：各写一份的话，「反推不认这个技能、改写认」
 * 这种差异不会报错，只是用户选了技能却没生效 —— 最难查的那一类。
 */
export function loadSkillForPrompt(skillId: string | undefined) {
  const slug = String(skillId ?? '').trim();
  if (!slug) return null;
  try {
    const skill = readSkill(slug);
    if (!skill) return null;
    return { title: skill.title, body: readSkillBody(slug) };
  } catch {
    return null;
  }
}

/**
 * 视频反推时加在 system 末尾的那句（2026-10-03）。
 *
 * 🔴 非加不可：模型收到的只是**几张 png**，它不知道这几张是同一段视频的先后帧
 * （还是用户随手丢的几张不相干的图）。不点破的话，常见的输出是「图一：…图二：…」
 * 这种逐张解说 —— 那不是提示词，也没法拿去生成。
 */
const DESCRIBE_VIDEO_HINT = [
  '',
  '【这几张图的来历】它们是**同一段视频**按时间先后均匀抽出来的帧，不是几张不相干的图。',
  '请把它们当成一段连续的画面来描述：主体在这段时间里做了什么、镜头怎么运动、',
  '光线与场景有没有变化，最后合成**一段**提示词，不要逐张分开写。',
].join('\n');

/**
 * 「看图 / 看视频反推提示词」（2026-10-03 徐先：
 * 「左边的接口输入了图片，就自动反推」+「也支持视频，如果接入了视频，那进行视频反推」）。
 *
 * 与 `optimizePrompt` 是同一件事的两个方向：那边把一句话**扩写**成一段提示词，
 * 这边看着一份媒体**写出**那段提示词。所以除了 system（`PROMPT_DESCRIBE_SYSTEM`）
 * 与「多带几张图」之外，走的完全是同一条路 —— 凭据解析、技能规范、本地模型装卸、
 * 结果清理，一处都不另写。
 *
 * `images` 是**数组**而不是单张：视频那一路交的是抽出来的若干帧，
 * 图片那一路只是「这个数组长度为 1」。别为两条路各开一个函数 ——
 * 那样迟早出现「视频那边改了报错文案、图片这边没跟上」。
 *
 * 🔴 用户那句（`note`）在这里是**补充**，不是改写对象：反推的输入是媒体，
 * 把它当成「待优化的话」会让模型两头为难（既看图又顾着原话）。
 */
export async function describePrompt(
  userId: string,
  images: PromptImage[],
  preferred?: string,
  skill?: { title: string; body: string } | null,
  /** `keepAliveSeconds` 与优化那条同一套语义（只有本地模型用得上）。 */
  options?: { keepAliveSeconds?: number; note?: string; video?: boolean },
): Promise<OptimizeResult> {
  const shots = (images || []).filter(item => item && String(item.base64 || '').trim());
  if (!shots.length) throw new PromptAssistantError('没有拿到这份媒体的字节，反推不了。');
  const isVideo = !!options?.video && shots.length > 1;
  const creds = await resolveTextCredentials(userId, preferred);
  if (!creds) {
    throw new PromptAssistantError(
      missingTextModelMessage(preferred),
      PROMPT_ASSISTANT_ERROR.status,
      PROMPT_ASSISTANT_ERROR.code,
    );
  }
  const note = String(options?.note || '').trim();
  const system = PROMPT_DESCRIBE_SYSTEM + (isVideo ? DESCRIBE_VIDEO_HINT : '') + skillInstruction(skill);
  const ask = [isVideo
    ? '就看这几帧（同一段视频按顺序抽出来的），输出一段可以直接用于视频生成的中文提示词。'
    : '就看这张图，输出一段可以直接用于图片或视频生成的中文提示词。']
    .concat(note ? [`补充要求：${note}`] : [])
    .join('\n');
  const call = () => chatText(creds, {
    system,
    user: ask,
    temperature: 0.7,
    images: shots.map(item => ({ mime: item.mime, base64: item.base64 })),
  });
  /*
   * 「这个模型看不了图」必须单独说一句（2026-10-03）。
   *
   * 绝大多数文本模型收到带图的请求会直接 400，报的却是「messages 格式不对」/「不支持 image」
   * 这种只有写接口的人才看得懂的话 —— 而用户此刻的认知是「我连了一张图，它该看图」。
   * 翻译成「换一个支持图片的多模态模型」，他才知道下一步是去改模型，不是去改这张图。
   */
  const guarded = async () => {
    try {
      return await call();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (/image|vision|multimodal|图/i.test(detail)) {
        throw new PromptAssistantError(
          `${creds.label} 好像看不了${isVideo ? '视频（这几帧）' : '图'}（${detail}）—— 换一个支持图片的多模态模型再来反推。`,
          400,
          'MODEL_NOT_VISION',
        );
      }
      throw error;
    }
  };
  const result = isLocalTextProvider(creds.providerId)
    ? await withLocalModel(guarded, options?.keepAliveSeconds).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PromptAssistantError(
        `本地模型没能用起来：${detail}（在「设置 · 模型服务 · 文本 · 本地模型」里选模型或换一个运行时试试）`,
        503,
        'LOCAL_MODEL_UNAVAILABLE',
      );
    })
    : await guarded();
  const described = cleanOptimizedPrompt(result.text);
  if (!described) {
    throw new PromptAssistantError(`${creds.label} 没有为这份${isVideo ? '视频' : '图'}写出提示词，换一家文本模型试试。`);
  }
  return {
    optimizedPrompt: described,
    provider: creds.providerId,
    model: creds.model,
    latencyMs: result.latencyMs,
  };
}

/**
 * 「用不了」的时候要说清是**哪一个**用不了。
 *
 * 节点上可以单独指定模型（2026-09-22），用户是刚刚点着选出来的 ——
 * 这时候回一句泛泛的「请先配置大语言模型」，等于让他自己回想刚才点的是哪家。
 * 指定过就该点到名字：是这家没 Key，还是那条自定义接口已经没了，两句话的事。
 */
export function missingTextModelMessage(preferred?: string) {
  const wanted = String(preferred ?? '').trim();
  if (!wanted) return PROMPT_ASSISTANT_ERROR.message;
  if (isLocalTextProvider(wanted)) {
    return '本地模型现在用不了：可能还没选模型文件（.gguf），或者本机没有能跑的 llama-server。到「设置 · 模型服务 · 文本 · 本地模型」看一眼状态。';
  }
  if (wanted.startsWith('custom:')) {
    const providerId = wanted.split(':')[1] || '';
    return `这条自定义接口现在用不了${providerId ? `（${providerId}）` : ''}：可能被删了，或者 Key 解不开。到「设置 · 模型服务」重加一条，或者把这个节点的「优化提示词用」改回「自动」。`;
  }
  return `${providerLabel(wanted)} 还没配置 Key —— 到「设置 · 模型服务 · 官方大语言模型」补上，或者把这个节点的「优化提示词用」改回「自动」。`;
}

/** 现在会用哪家（界面上一句话说明，免得用户以为「优化」是本机算的）。 */
export async function currentTextSource(userId: string): Promise<{ provider: string; label: string } | null> {
  const creds: TextCredentials | null = await resolveTextCredentials(userId);
  if (!creds) return null;
  return { provider: creds.providerId, label: creds.label };
}
