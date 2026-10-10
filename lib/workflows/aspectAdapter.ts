/**
 * 「画布 · 画面比例」→ 节点认的比例串（2026-10-10 徐先）。
 *
 * 画布上那一档比例（`lib/workflows/imageParams.ts` 的 `ASPECT_RATIOS`）**八项全带括号备注**
 * —— `'16:9 (Widescreen)'`。那是 RunningHub 应用字段的历史写法，绑到大多数工作流上一直没事。
 *
 * 但 MiniMax H3 那条线（仓库 `Goohai-MiniMax-H3_Integration`，节点类名
 * `MiniMaxH3IntegrationGH`）的 `aspect` 是**九选一的短串**：
 *
 *     adaptive / 16:9 / 9:16 / 3:2 / 2:3 / 4:3 / 3:4 / 1:1 / 21:9
 *
 * 带括号那串不在清单里 —— 于是「配置页把 `aspect` 绑到画布比例」这件事一做，
 * 任务必然是 `MiniMaxH3IntegrationGH：Value not in list`（2026-10-10 那条就是这么挂的）。
 *
 * 这个文件只干一件事：**认出这条线的节点，把画布值折成它认的写法**。
 *
 * 🔴 三条边界，都是为了让这份改动**只会把这条路修通，不会碰别的东西**：
 *   1. **只挑比例**。别的绑定（提示词 / 时长 / 种子…）一个字不碰。
 *   2. **只挑认这个口径的节点**（见 `COMPACT_ASPECT_NODE`）：别的节点继续拿带括号的值 ——
 *      它们的字段本来就是那么写的，替它们「顺手改短」反而会把好好的工作流弄坏。
 *   3. **折不出来就原样发**，不替用户挑一个。宁可让他看见 `Value not in list`，
 *      也不要静默换成一个他没选过的比例 —— 那属于最难查的那种失败（任务成功、形状不对）。
 */

/**
 * 认这个口径的节点。
 *
 * 两种写法都收：`MiniMaxH3IntegrationGH` 是 ComfyUI 里的**类名**（配置里 `classType` 存的就是它），
 * `Goohai-MiniMax-H3_Integration` 是那个仓库 / 包的**名字** —— 人常常只记得后者，
 * 而配置里的类名万一是从别处抄来的，也得认。
 */
const COMPACT_ASPECT_NODE = /minimax[\s_-]*h3/i;

/** MiniMax H3 的 `aspect` 只认这九个（节点包 `nodes.py` 里的 `ASPECTS`）。 */
export const COMPACT_ASPECTS: readonly string[] = ['adaptive', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '1:1', '21:9'];

/** 这个类名的节点要不要走「短串」口径。空类名 / `Custom` 一律不认 —— 不知道是谁就别猜。 */
export function usesCompactAspect(classType: string | undefined | null): boolean {
  const name = String(classType ?? '').trim();
  return Boolean(name) && COMPACT_ASPECT_NODE.test(name);
}

/**
 * 把画布的比例值折成节点认的短串；折不出来**原样返回**。
 *
 * 归一三步：全角标点换半角 → 去掉括号备注 → 去空白。
 * `'16:9 (Widescreen)'` → `'16:9'`、`'21:9 (Ultrawide)'` → `'21:9'`、`'16：9'` → `'16:9'`。
 *
 * 为什么连全角冒号也换：手打这个字段时输入法常给出全角冒号（`16：9`），
 * 那一串同样不在清单里、报的错一模一样。这里顺手抹平，用户不用去分辨半角全角。
 */
export function compactAspect(value: string | undefined | null): string {
  const raw = String(value ?? '').trim();
  if (!raw) return raw;
  const normalized = raw.replace(/：/g, ':').replace(/（/g, '(').replace(/）/g, ')');
  if (COMPACT_ASPECTS.includes(normalized)) return normalized;
  const head = normalized.split('(')[0].trim();
  return COMPACT_ASPECTS.includes(head) ? head : raw;
}

/**
 * 提交前那一步：字段绑的是画布比例、宿主节点又走这条线 → 换成短串。
 *
 * 其余情况一律返回原值（含 `undefined` —— 那表示「这次没有这个值」，`toNodeInfoList` 会跳过）。
 */
export function adaptedAspectRatio(classType: string | undefined | null, value: string | undefined): string | undefined {
  if (value === undefined || value === '') return value;
  return usesCompactAspect(classType) ? compactAspect(value) : value;
}
