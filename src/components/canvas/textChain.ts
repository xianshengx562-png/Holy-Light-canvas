/*
 * 文本链解析（2026-09-29）—— 纯函数层。
 *
 * 单独成一个文件，跟 `lib/providers/site-quota.ts` 是同一个路子：
 * 「文本 → 优化提示词 → 文本」这条链**怎么取值**是纯逻辑，看界面看不出它对不对，
 * 只能拿断言钉住（真出过的错就是这类：优化节点被跳过，下游拿到改写前那句，
 * 而任务照样成功、界面一句话都不说）。
 *
 * 🔴 所以这个文件**不 import 任何带 `@/` 别名、拖着整条工作流依赖链的模块** ——
 * 它要能单独编译成 CJS 跑单测，不能一编译就把半个子项目拖进来。
 */

/**
 * 沿这条链解析出来的值。
 *
 * `broken` 只有一种：这条链上唯一的结构性问题就是**成环**。
 * 「上游没接」在这里不算坏 —— 文本节点自己写的那句就是它的值；
 * latent 那条链（`LatentChain`）没接上游就真的没有值，所以那边要多分好几档。
 */
export type TextChain = {
  value: string;
  from: string;
  broken: 'cycle' | null;
  /**
   * 拼进来的那几段，**按连线先后排好**。
   *
   * 留着它有两个用处：界面上要说清「为什么是这个顺序」，探针要能断言这个顺序。
   * 只留一个拼好的 `value` 的话，「顺序错了」和「少接了一条」在界面上长得一模一样。
   */
  parts: TextChainPart[];
};

/** 拼进来的其中一段（来自哪一个上游、那段字是什么）。 */
export type TextChainPart = { id: string; label: string; value: string };

/** 参与这条链的节点的最小形状（`Node<NodeData>` 天然满足）。 */
export type TextChainNode = {
  id: string;
  /** `bypassed` = 这个节点被绕过了（2026-09-29）：它只当一根管子，不做自己那份活。 */
  data: { kind?: string; text?: string; optimizedText?: string; label?: string; bypassed?: boolean };
};

/** 连线：`source` 在上游、`target` 在下游。 */
export type TextChainEdge = { source: string; target: string };

/**
 * 能交出一段「文本」的节点：文本节点，以及优化节点（它交的是改写出来的那份）。
 *
 * 「哪些节点能进这条链」是取值规则的一部分，所以只在这里写一份 ——
 * `nodeMeta` 与画布其余各处一律从这里引。两处各写一份，迟早出现
 * 「链上认这个节点、别处不认」，而那种差异不报错，只是行为悄悄不同。
 */
export function isTextValueKind(kind: unknown) {
  return kind === 'text' || kind === 'prompt-optimize';
}

/**
 * 把几段上游文本拼成一段（2026-09-29 徐先：「两个输入参数中相隔一行」）。
 *
 * 🔴 中间是 **两个换行**（`\n\n`），也就是两段之间**空一行** —— 一个换行只是换行，
 *   看着还是同一段。提示词里分节靠的就是这个空行，模型也靠它分得清这是两段要求。
 *
 * 空段直接丢掉：中间夹一个没填字的文本节点，不该在结果里留两个空行
 * （那才是「用户看着一段空白，不知道哪来的」）。
 * 每段都 `trim`：上游尾部一个回车 + 空行分隔 = 三个换行，拼出来会散得莫名其妙。
 */
export function joinTextParts(values: string[]): string {
  const chunks = (values || [])
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return dedupeTextValues(chunks).join('\n\n');
}

/**
 * 同一段字只算一次（2026-09-29）。
 *
 * 菱形汇合（两条路从同一个上游带下同一段字）不该把这句话说两遍 ——
 * 拼出来「根\n\n根」，用户只能当 bug 看，而且看不出是哪一步重复了。
 *
 * 保留**最先连的那一条**：位置由连线先后决定，重复的那条后来才连上，
 * 丢后不丢前，于是「我再连一条一样的」不会让前面那段挪位置。
 *
 * 🔴 只在这里写一份：`walk` 与 `optimizeInputOf` 都走它。
 * 两处各写一份，改的时候迟早漏一处，而漏的那处不报错，只是偶尔重复一段字。
 */
export function dedupeTextValues(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values || []) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * 解析一个节点**此刻**要交给下游的那段文字。
 *
 * 取值规矩：
 *   1. 接了上游文本 / 优化节点 → **上游说了算**（下游那个文本节点展示的正是上游那段）；
 *   2. 优化节点**自己跑出来的那份优先**于它的上游 —— 它存在的理由就是把上游那句改写掉。
 *      一次都没跑过时回落到上游原句，于是下游看到的是「这一刻真会交出去的那句」，不是空白；
 *   3. 都没有才看文本节点自己写的那句。
 *
 * 🔴 `optimizedText`（跑出来的结果，落库）与这条链算出来的值（现算、不写库）
 * **刻意分开**：断开连线之后用户原来写的那句话还得在 —— 把结果写回 `text` 等于删掉他的原稿。
 */
export function resolveTextChain(
  nodes: TextChainNode[],
  edges: TextChainEdge[],
  id: string,
  /** 上游节点的显示名（卡片上那句「来自「X」」要用）。不传就退回 `label || kind`。 */
  labelOf?: (node: TextChainNode) => string,
): TextChain {
  const nameOf = labelOf || ((node: TextChainNode) => String(node.data.label || node.data.kind || ''));
  /** 一次解析里的备忘表：菱形链（两条链汇到同一个上游）不缓存会按路径数重走。 */
  const cache = new Map<string, TextChain>();
  const walk = (current: string, path: Set<string>): TextChain => {
    /*
     * 判环用**当前这条路径**（入口到当前节点的这一串），不是全局 visited。
     * 全局集合会把「两条链汇到同一个上游」的汇合点误报成环，而菱形在这个图里是正常连法。
     */
    if (path.has(current)) return { value: '', from: '', broken: 'cycle', parts: [] };
    const hit = cache.get(current);
    if (hit) return hit;
    const done = (result: TextChain) => { cache.set(current, result); return result; };
    const node = nodes.find(item => item.id === current);
    if (!node) return done({ value: '', from: '', broken: null, parts: [] });
    /*
     * 上游那几段：直接连在左边的文本 / 优化节点，**全都收下**，按连线先后依次拼起来
     * （2026-09-29）。以前是取到第一个有值的就 `break` —— 接第二条线的人会发现
     * 它「连上了但完全不起作用」，那条线在图上是实心的，最容易被当成画错了。
     *
     * 「连线先后」= `edges` 数组里的顺序：新连的一条 push 到末尾，从库里读回来的
     * 也是当初存的顺序。要改顺序就断开重连 —— 这比给每条边挂一个序号好懂，
     * 而且不需要在界面上再塞一个「排序」控件。
     */
    const raw: TextChainPart[] = [];
    let broken: 'cycle' | null = null;
    const next = new Set(path).add(current);
    for (const edge of edges) {
      if (edge.target !== current) continue;
      const from = nodes.find(item => item.id === edge.source);
      if (!from || !isTextValueKind(from.data.kind)) continue;
      const upper = walk(from.id, next);
      /** 成环比「上游是空的」更值得说，所以先记下来，等确认自己也没值再报。 */
      if (upper.broken && !broken) broken = upper.broken;
      if (!upper.value) continue;
      /*
       * `label` 记的是**直接上游**那一颗，不是这段字最初的产地。
       * 「文本1 → 优化（还没跑）→ 文本2」里文本2 该说「来自「优化提示词」」——
       * 说「来自「文本」」虽然也没错（那句话确实是文本1 写的），但用户要断开的是
       * 优化节点这一条线，指到最源头那颗反而让人找不着该动哪条线。
       */
      raw.push({ id: from.id, label: nameOf(from), value: upper.value });
    }
    /*
     * 同一段字只留最先连的那一条（规矩见 `dedupeTextValues`）。
     *
     * 🔴 `parts` 必须跟拼出来的 `value` **段数对得上**：否则界面报「来自 A、B」
     * 而框里只有一段字 —— 那种对不上比重复一段更难看懂。
     * `find` 取的是第一次出现，也就是连线更早的那条。
     */
    const kept = dedupeTextValues(raw.map(part => part.value));
    const parts = kept.map(value => raw.find(part => part.value === value) as TextChainPart);
    const joined = joinTextParts(parts.map(part => part.value));
    /** 多个来源时用「、」连起来给界面显示：`文本1、文本2`。 */
    const from = parts.map(part => part.label).join('、');
    /*
     * 🔴 被绕过 = 这个节点**不做自己那份活**，只把上游交下来的原样传下去（2026-09-29）。
     * 于是：优化节点不改写（下游拿到原句）、文本节点不用自己写的那句。
     * 这正是「绕过」和「删掉这个节点」的差别 —— 绕过是可逆的，而且线还连着，
     * 一眼看得出这条链本来长什么样。
     *
     * 没有上游时它交不出值（一根没接水管的管子）—— 那种情况下照实报 `broken`，
     * 别假装它是空的普通节点：用户得知道是自己绕过了它。
     */
    if (node.data.bypassed) {
      return done(joined
        ? { value: joined, from, broken: null, parts }
        : { value: '', from: '', broken, parts: [] });
    }
    if (node.data.kind === 'prompt-optimize') {
      const own = String(node.data.optimizedText || '').trim();
      /* 跑出来的那份是**整段**的，不是上游那几段拼起来的 —— 所以 `parts` 给空数组，
         别让界面把「改写前的几段」当成这一段的组成部分报出来。 */
      return done(own
        ? { value: own, from: '', broken: null, parts: [] }
        : { value: joined, from, broken, parts });
    }
    if (joined) return done({ value: joined, from, broken: null, parts });
    /** 链成环时才报 `broken`：那种情况下补多少字都取不到值，必须让人看见。 */
    if (broken) return done({ value: '', from: '', broken, parts: [] });
    return done({ value: String(node.data.text || '').trim(), from: '', broken: null, parts: [] });
  };
  return walk(id, new Set());
}

/**
 * 优化节点这次要改写的**输入**。
 *
 * 🔴 刻意**不看它自己上一次的 `optimizedText`**：拿上一次的结果再去改写一遍，
 * 等于把同一句话反复「优化」，第二次起只会越来越浮夸 —— 而界面上看着全是成功。
 */
export function optimizeInputOf(
  nodes: TextChainNode[],
  edges: TextChainEdge[],
  id: string,
  labelOf?: (node: TextChainNode) => string,
): string {
  /* 与下游那条规矩一致：接了多个上游就**全拼上**（2026-09-29）。
     只取第一个的话，第二条线在优化节点这儿同样是「连上了没用」。 */
  const parts: string[] = [];
  for (const edge of edges) {
    if (edge.target !== id) continue;
    const from = nodes.find(item => item.id === edge.source);
    if (!from || !isTextValueKind(from.data.kind)) continue;
    const value = resolveTextChain(nodes, edges, from.id, labelOf).value;
    if (value) parts.push(value);
  }
  return joinTextParts(parts);
}

/**
 * 这一轮真正要提交的那句提示词（从一堆上游里挑）。
 *
 * 优化节点**优先**于文本节点：它交的是改写后那份，而只按「第一个上游文本节点」取的话
 * 拿到的是改写前那句 —— 任务照样成功、画面却是照原话生成的，全程不报错。
 */
export function promptTextOf(
  nodes: TextChainNode[],
  edges: TextChainEdge[],
  upstream: TextChainNode[],
  labelOf?: (node: TextChainNode) => string,
): string {
  const resolved = upstream
    .filter(item => isTextValueKind(item.data.kind))
    .map(item => ({ item, chain: resolveTextChain(nodes, edges, item.id, labelOf) }));
  const optimized = resolved.find(entry => entry.item.data.kind === 'prompt-optimize' && entry.chain.value);
  if (optimized) return optimized.chain.value;
  const first = resolved.find(entry => entry.chain.value);
  return first ? first.chain.value : '';
}
