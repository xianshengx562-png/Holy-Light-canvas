/**
 * 一个 latent 中转节点「供哪几份」的判定（2026-10-03，N-114）。
 *
 * 单独一个文件、**零依赖**：这组是纯函数，要能单独编出来跑单测
 * （`nodeMeta.ts` 的依赖链会一路拉到工作流配置树，编不动）。
 * 和 `textChain` / `mediaChain` 一个路数。
 *
 * 背景：一个中转节点原来只有 `latentPick` **一个**值 —— 一次生成归档两份（粗 / 精），
 * 用户只能二选一。现在能同时供两份，也能只供一份。
 */

/**
 * 工作流里能接 latent 的参数位数量。
 *
 * 默认绑定只有 `latent_1`（节点 210，粗采样）与 `latent_2`（节点 278，精采样），
 * 所以编号就这两个；`configuration.ts` 里 `binding: 'latent_N'` 取的是 `values.latents[N-1]`。
 */
export const LATENT_SLOTS = 2;

/** 这一槽**明确不要**。与空串（= 自动）分开，别合并成一种。 */
export const LATENT_PICK_OFF = '__off__';

export type LatentCandidate = {
  /** 形如 `asset:<id>`，与「已归档的 latent」下拉同一个值形态。 */
  value: string;
  kind: 'coarse' | 'fine';
  /** 同一组的候选（同一次生成归档的两份）—— 自动配对只在组内进行。 */
  group?: string;
};

export type ResolvedLatents = {
  values: string[];
  from: string;
  broken: 'empty' | 'unpicked' | null;
};

/**
 * 自动配对：取**最新那一组**里的粗 / 精两份，粗放槽 1、精放槽 2。
 *
 * 只有一类时放在它该在的槽位（粗 → 槽 1，精 → 槽 2）—— 精采样单独存在是合法的，
 * 那一份本来就是要写进 latent_2 的。
 *
 * 🔴 「只有精采样」返回的是 `['', value]`，**槽 1 必须留空**。顺手写成 `[value]`
 * 的话，这一份会被写进 `latent_1`（粗采样那个参数位）—— 出来的片段和上一段毫无关系，
 * 而界面上全绿。单测第一条就是为它写的。
 */
export function autoPairLatents(candidates: LatentCandidate[]): string[] {
  const first = candidates[0];
  if (!first) return [];
  const group = first.group || '';
  const same = candidates.filter(item => (item.group || '') === group);
  const pool = same.length ? same : candidates;
  const coarse = pool.find(item => item.kind === 'coarse');
  const fine = pool.find(item => item.kind === 'fine');
  if (coarse && fine) return [coarse.value, fine.value];
  if (coarse) return [coarse.value];
  if (fine) return ['', fine.value];
  return [];
}

/**
 * 逐槽取值 —— 规则只有一条：**有显式选择就逐槽照办，一个都没有才自动配对**。
 * 半自动（槽 1 手选、槽 2 自动）有意不做：那样槽 2 该配粗还是配精根本说不清。
 *
 * 🔴 这里**改了一条老规矩**：`resolvePickedLatent` 的注释写着「没选哪一份时不能悄悄挑
 * 第一份」。现在按徐先的要求自动填，但只按**粗 / 精的对应关系**配，不是随手挑第一份 ——
 * 确定性完全不同。配不出来时照样报 `unpicked`，界面上的说法不变。
 */
export function resolvePickedLatents(
  candidates: LatentCandidate[],
  picks: string[],
  from: string,
): ResolvedLatents {
  if (!candidates.length) return { values: [], from, broken: 'empty' };
  const slots = Math.max(LATENT_SLOTS, picks.length);
  const chosen: string[] = [];
  let anyExplicit = false;
  for (let index = 0; index < slots; index += 1) {
    const want = String(picks[index] ?? '').trim();
    /* 「这一槽不用」不算「选过」—— 它是「明确不要」，这一槽留给自动配对去清掉。 */
    if (!want || want === LATENT_PICK_OFF) { chosen[index] = ''; continue; }
    /*
     * 🔴 只要这一槽填了东西（哪怕已经不在候选里）就算**选过**，不再回落自动配对。
     * 上游重跑 / 连线改了之后，旧值会失效 —— 此时悄悄自动配一份新的上去，等于替用户
     * 改了主意（界面还全绿）。正确做法是这一槽留空、由界面报「没选」，让他重选。
     */
    anyExplicit = true;
    const hit = candidates.find(item => item.value === want);
    if (!hit) { chosen[index] = ''; continue; }
    chosen[index] = hit.value;
  }
  /* 末尾的空槽裁掉；中间的空槽**留着**（`latent_N` 按下标取，压实就串位了）。 */
  const trim = (list: string[]) => {
    let last = -1;
    list.forEach((item, index) => { if (item) last = index; });
    return list.slice(0, last + 1);
  };
  if (anyExplicit) return { values: trim(chosen), from, broken: null };
  const auto = autoPairLatents(candidates);
  /* 自动配对的结果里，被 `LATENT_PICK_OFF` 点名的槽位要清掉。 */
  const filtered = auto.map((item, index) => (String(picks[index] ?? '').trim() === LATENT_PICK_OFF ? '' : item));
  const values = trim(filtered);
  return { values, from, broken: values.length ? null : 'unpicked' };
}

/** 中转节点逐槽选的来源，归一成 `latentPicks`（老的单个 `latentPick` 当槽 1）。 */
export function latentPicksOf(data: { latentPicks?: unknown; latentPick?: unknown }): string[] {
  const raw = Array.isArray(data.latentPicks) ? data.latentPicks : [];
  const list = raw.map(item => String(item ?? '').trim());
  if (!list.length && data.latentPick) list.push(String(data.latentPick).trim());
  return list.slice(0, LATENT_SLOTS);
}
