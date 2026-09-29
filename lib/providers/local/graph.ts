/**
 * 本地工作流图的解析与套用。**故意不 import 任何东西**（不碰数据库、不碰 `server-only`）：
 * 它是一段纯函数，回归脚本能直接加载它，不用先起服务。
 *
 * 为什么必须有这一层：画布上的字段绑定（`nodeInfoList` = `{ nodeId, fieldName, fieldValue }`）
 * 本来就是照 ComfyUI 节点写的 —— RunningHub 跑的也是 ComfyUI 图。所以本地模式**不需要
 * 另造一套参数体系**：把同一份绑定覆盖进本机那份图的 `inputs`，投给 `/prompt` 就行。
 *
 * 这套绑定会来自两种图：
 *   1. **本地工作流**（`provider = 'local'`）：图与绑定是从同一张图配出来的，编号天然一致，
 *      不需要额外对齐 —— 这就是「本地也能像云端一样自己配」的全部意义；
 *   2. **老用法** —— 选中一条 RunningHub 编号的工作流、却能在本机跑（桌面版 / 开了本地模式开关）：
 *      那时绑定是照那份云端工作流写的，本机这份图必须和它编号一致才写得进去。
 *      只有这条路才有「两张图必须对得上」这回事，处理见 `applyNodeInfoList`。
 */

export type LocalNode = {
  class_type?: string;
  inputs?: Record<string, unknown>;
  [key: string]: unknown;
};

export type LocalGraph = Record<string, LocalNode>;

export type NodeInfoItem = { nodeId?: string; fieldName?: string; fieldValue?: unknown };

/**
 * 校验并归一化一份 ComfyUI **API 格式**的图。
 *
 * 「API 格式」和「UI 格式」的分辨点就在 `inputs`：API 格式里它是**对象**（`{ "text": "..." }`），
 * UI 格式里它是**数组**（连线的描述）。用户在 ComfyUI 里导出时常常顺手点了默认的 UI 格式，
 * 那种图存进来能保存成功、但生成时一个字段都写不进去 —— 所以这里必须当场拦下，并且说清导错了。
 */
export function parseLocalGraph(raw: unknown): LocalGraph {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('本地工作流图得是一个对象 —— 也就是 ComfyUI「导出（API）」出来的那份 JSON。');
  }
  const out: LocalGraph = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`节点 ${key} 不是一个对象 —— 贴进来的多半是 UI 格式的图。`);
    }
    const node = value as Record<string, unknown>;
    if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
      throw new Error(`节点 ${key} 里没有 inputs（或 inputs 是数组）—— UI 格式的图长这样，请在 ComfyUI 里导出「API」格式再贴进来。`);
    }
    out[key] = node as LocalNode;
  }
  const count = Object.keys(out).length;
  if (!count) throw new Error('这张图里一个节点都没有。');
  return out;
}

/**
 * 把画布的字段绑定写进图里。**返回一份深拷贝**，绝不改原图 ——
 * 原图是用户保存的那份，被某次生成改脏了之后，后面每一次生成都会带着上一次的值。
 *
 * ⚠️ 找不到节点时**直接抛错，不跳过**。跳过是最糟的处理：任务照样跑成功、照样出片，
 * 只是提示词 / 参考图一个都没生效 —— 界面上什么都看不出来。
 *
 * 报错文案要同时照顾上面那两种来源：本地工作流对不上通常是「有人改动了图但没重新配」，
 * 而老用法对不上是「本机这份图和云端那份编号不一致」——两种补救动作完全不同，说混了等于没说。
 */
export function applyNodeInfoList(graph: LocalGraph, list: NodeInfoItem[]): LocalGraph {
  const clone: LocalGraph = {};
  for (const [key, node] of Object.entries(graph)) {
    clone[key] = { ...node, inputs: { ...(node.inputs || {}) } };
  }
  const missing: string[] = [];
  for (const item of list) {
    /*
     * `fieldName` **原样使用，绝不 trim** —— 它是图里 `inputs` 的键，必须和插件认的那串字符逐字相同。
     *
     * 第三方插件的键名带空格 / 隐形字符是常态：`AnimaMultiLoraLoader` 里同时有
     * `"   Strength"`（三个前导空格）和 `"   Strength\u200b"`（再加零宽空格），是两个 LoRA 的强度。
     * 早先这里 `.trim()` 过，后果是**静默改不动参数**：
     *   - trim 后写成 `"Strength"`，那是图里**不存在**的新键，插件不认 → 用户改的数值被丢掉；
     *   - 原来那两个带空格的键仍在，还留着**上一次的值** → 生成照旧用旧值，界面上什么都看不出来；
     *   - 两个不同的 LoRA 还会双双 trim 成同一个 `"Strength"`，后写的盖掉先写的。
     * 节点 ID 是纯数字/下划线，trim 一下无妨（用户可能粘贴进空格）。
     */
    const nodeId = String(item?.nodeId ?? '').trim();
    const fieldName = String(item?.fieldName ?? '');
    if (!nodeId || !fieldName) continue;
    const node = clone[nodeId];
    if (!node) {
      if (!missing.includes(nodeId)) missing.push(nodeId);
      continue;
    }
    node.inputs![fieldName] = item.fieldValue;
  }
  if (missing.length) {
    throw new Error(
      `本机这份工作流图里找不到节点 ${missing.join('、')}。`
      + '本次要提交的字段里有它们的编号 —— 多半是在 ComfyUI 里改过这份图却没有重新导入：'
      + '到「设置 · 工作流配置」打开这份工作流，重新粘贴一次「导出（API）」的 JSON（系统会按新图重算字段）。'
      + '（如果这份是 RunningHub 编号的工作流，那本机那张图的节点编号必须和那份一致。）',
    );
  }
  return clone;
}

/** 图里的节点编号（设置页用来提示「这份图有多少节点、编号长什么样」）。 */
export function localGraphNodeIds(graph: LocalGraph): string[] {
  return Object.keys(graph).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}
