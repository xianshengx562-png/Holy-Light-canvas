/**
 * Which side a run belongs to — the rule behind the "engine ↔ workflow" check.
 *
 * Pulled out on 2026-10-04 because that check had just rejected every **local
 * upscale**. The submitter of an upscale never sends `engine` (the run has a single
 * input — the media to process — and no engine dropdown of its own), and the server
 * used to treat a missing engine as "RunningHub". So a node with `engine: 'local'`
 * and a `local-…` upscale workflow was told:
 *
 *     The engine on this node is "RunningHub", but workflow local-mut7m7n56wispiyp is a
 *     local ComfyUI one — not the same pipeline. …or switch the engine back to "local
 *     ComfyUI".
 *
 * i.e. it asked him to switch the engine to the value it already had. Root cause:
 * **"engine missing" was being guessed at instead of read**. The check compares what
 * the user *chose* against where the workflow lives; with no engine there is no choice,
 * so there is nothing to compare — the workflow's own provider already tells us the
 * side (`useLocal` is derived from it).
 *
 * Dependency-free so it can be compiled to CJS and unit-tested on its own
 * (`C:/FRAME/_test-engine-side.py`).
 */

/** Where a run is executed. `null` = no side was chosen — do not reconcile. */
export type RunSide = 'local' | 'runninghub';

/**
 * The side implied by the node's engine dropdown.
 *
 * `null` covers two very different cases that must behave the same way:
 *   - the field is empty (old canvases, MCP-created nodes, every upscale submitter);
 *   - the engine is a gateway (`videoapi` / `custom`) that never goes through a
 *     workflow at all — then "which workflow's side" is not a question that exists.
 */
export function engineSideOf(engine: unknown): RunSide | null {
  const text = String(engine ?? '').trim();
  if (text === 'local') return 'local';
  /* `workflow` is the legacy spelling the canvas still writes for "the default one". */
  if (text === 'runninghub' || text === 'workflow') return 'runninghub';
  return null;
}

/**
 * The side a workflow itself belongs to. Same fallback as `readWorkflowProvider`
 * in `lib/workflows/local.ts`: anything unrecognised is treated as cloud, so a
 * working cloud pipeline can never silently re-route to the local machine.
 */
export function workflowSideOf(provider: unknown): RunSide {
  return provider === 'local' ? 'local' : 'runninghub';
}

/**
 * Does this pair need the "not the same pipeline" error?
 *
 * Returns the two sides only when they genuinely disagree (and never when the
 * engine said nothing — see the module doc).
 */
export function mismatchedSides(
  engine: unknown,
  workflowProvider: unknown,
): { engine: RunSide; workflow: RunSide } | null {
  const wanted = engineSideOf(engine);
  if (!wanted) return null;
  const actual = workflowSideOf(workflowProvider);
  return actual === wanted ? null : { engine: wanted, workflow: actual };
}
