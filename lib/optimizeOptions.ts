/*
 * 「优化提示词」节点上那几项参数的取值规矩（2026-09-29）。
 *
 * 单独成一个文件，跟 `lib/providers/site-quota.ts` 是同一个路子：
 * 「强度 / 补充要求 → 送进模型的是哪句话」是纯逻辑，而它**看界面看不出来** ——
 * 用户改了「重度」，界面上只会多转一圈，改没改对只能靠断言钉住。
 *
 * 🔴 放在**工程根 `lib/`**，不放 `src/lib/`：
 * `@/lib/*` 在两边解析不一样 —— 主进程 / 预加载的 `'@'` 指向工程根，
 * 渲染进程才是「先 `src/`、再工程根」（`electron.vite.config.ts` 的 `resolveAt()`）。
 * 而 `server/api/...` 那批路由是**打进主进程**的（`electron/main/routes.generated.ts` 里 import 它们），
 * 放 `src/lib/` 的话前端和后端会各自解析到**不同的文件**，改一处等于改一半。
 *
 * 🔴 这个文件**不 import 任何东西**：它要能单独编译成 CJS 跑单测。
 */

/** 强度档位。存的是 `value`，不是中文标签 —— 显示文案改了不该让老画布失忆。 */
export type OptimizeStrength = 'light' | 'standard' | 'heavy';

export type OptimizeStrengthOption = {
  value: OptimizeStrength;
  label: string;
  /** 下拉里那一项的副标题 / 悬浮说明：用户是靠这句话决定选哪一档的。 */
  hint: string;
};

/**
 * 三档强度（顺序 = 界面上的顺序）。
 *
 * 🔴 三档的说法必须是**「写多写少」**，不能是「写得好不好」：
 * 「轻度」听起来像「质量差一档」，用户就永远不敢选它。实际它只是**少补一些**，
 * 适合「我这句话已经写好了，只是想让它通顺」—— 那是真实存在的一种用法。
 */
export const OPTIMIZE_STRENGTHS: OptimizeStrengthOption[] = [
  {
    value: 'light',
    label: '轻度润色',
    hint: '只通顺化、修正用词，尽量保留原句的结构和长度，不凭空补内容',
  },
  {
    value: 'standard',
    label: '标准补全',
    hint: '补全主体、动作、环境、构图、镜头、光线、色彩、材质、风格与氛围',
  },
  {
    value: 'heavy',
    label: '重度扩写',
    hint: '在标准补全之外，再加镜头运动、光影层次、材质细节、色彩分级与氛围，可以写得长一些',
  },
];

/**
 * 认得出是哪一档；认不出返回 `null`（= **没选过**）。
 *
 * 🔴 「没选过」和「选了标准」必须能分开：老画布上没有这个字段，
 * 而 system 里本来就在要求「补全主体、动作、环境…」（`PROMPT_OPTIMIZE_SYSTEM`），
 * 替没选过的节点再塞一句「标准补全」等于**悄悄改了所有老节点的行为** ——
 * 那次改动没有任何界面会告诉他。
 */
export function parseStrength(value: unknown): OptimizeStrength | null {
  const raw = String(value ?? '').trim();
  if (raw === 'light' || raw === 'standard' || raw === 'heavy') return raw;
  return null;
}

/** 下拉框要显示成哪一档（没选过的按标准显示，但**不写库** —— 存不存是 `onField` 的事）。 */
export function resolveStrength(value: unknown): OptimizeStrength {
  return parseStrength(value) ?? 'standard';
}

/**
 * 补充要求：只 trim。
 *
 * 🔴 **不限字数**（2026-09-29 徐先：「补充要求不限字数」）—— 原来切到 500 字，现在原样带出去。
 * 名字也从 `clipOptimizeNote` 改成现在这个：留着 clip 会让人以为它还在切。
 */
export function normalizeOptimizeNote(value: unknown): string {
  return String(value ?? '').trim();
}

/** 某一档强度对应的那句指令。 */
export function strengthInstruction(strength: OptimizeStrength): string {
  /*
   * 🔴 只给 `hint` 是不够的：`hint` 是**说给用户听**的（「可以写得长一些」），
   * 模型看到「可以写得长一些」不会真的去写长。所以指令里必须换成**命令句**。
   * 两份文案长得像、但不能合成一份 —— 合成的结果一定是有一边变得不好懂。
   */
  if (strength === 'light') {
    return '【改写幅度：轻度润色】只做通顺化与用词修正，尽量保持原句的结构、信息量与长度，**不要**凭空补充原句里没有的内容。';
  }
  if (strength === 'heavy') {
    return '【改写幅度：重度扩写】在补全主体、动作、环境、构图、镜头、光线、色彩、材质、风格与氛围之外，还要补上镜头运动、光影层次、材质细节、色彩分级与画面氛围；写充分一些，长一点没关系。';
  }
  return '【改写幅度：标准补全】把主体、动作、环境、构图、镜头、光线、色彩、材质、风格与氛围补全成一段完整的画面描述。';
}

/**
 * 把「强度 + 补充要求」拼成一段要追加进 system 的指令。
 *
 * 🔴 **一项都没动过就返回空串** —— 那种情况下 system 一个字都不该变：
 * 加这个功能之前老节点跑出来是什么样，之后还得是什么样。
 * 只在用户真的选过 / 填过时才加，改动范围才收得住。
 *
 * 🔴 补充要求放在**强度之后**，并明说「冲突时以它为准」：
 * 用户填「不要写镜头语言」而强度选了「重度」（重度那句里就有「要补镜头运动」），
 * 这两句是**直接矛盾**的。不给仲裁规则的话模型会自己挑一条照做，
 * 而它挑中的那条多半不是用户此刻更想要的（他刚打完字才点下的改写）。
 */
export function buildOptimizeInstruction(input?: {
  strength?: unknown;
  note?: unknown;
}): string {
  const strength = parseStrength(input?.strength);
  const note = normalizeOptimizeNote(input?.note);
  if (!strength && !note) return '';
  const lines: string[] = [''];
  if (strength) lines.push(strengthInstruction(strength));
  if (note) {
    lines.push('', '【用户补充的要求】', note);
    /* 没有强度那句就不存在「冲突」，这句会变成没头没尾的一句废话。 */
    if (strength) lines.push('上面这条与改写幅度冲突时，以用户补充的要求为准。');
  }
  return lines.join('\n');
}
