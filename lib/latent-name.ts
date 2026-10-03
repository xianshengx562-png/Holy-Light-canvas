/**
 * File names for latents, both when we store them and when we hand them upstream.
 *
 * The suffix **must be `.safetensors`** — that is the upstream node's *criterion*,
 * not a stylistic choice of ours. The RunningHub node `Yuan_H3MotionContextLoadLatent`
 * detects the type from the file name suffix; we used to send `<seq>-<kind>.latent`
 * and every task failed at the very end with:
 *
 *     h3_motion_context: 手动上传仅支持 .safetensors 文件
 *
 * The *contents* were always correct: what we store is exactly the byte stream the
 * upstream produced (see `lib/latents.ts`), and unpacking one shows the safetensors
 * 8-byte length header followed by `{"__metadata__":{"format":"h3_motion_con…`.
 * Only the name was wrong.
 *
 * Since 2026-10-03 the archived copy uses the same suffix and is **not gzipped**
 * (徐先's call): gzip only saved ~9% (12.3 MB vs 13.5 MB) while turning the file
 * into a format only we understand — a local ComfyUI had to gunzip and rename it
 * before it could be used. What lands on disk is now a plain safetensors file that
 * can be picked directly.
 *
 * This module is **dependency-free** so it can be compiled to CJS and unit-tested on
 * its own (`C:/FRAME/_test-latent-name.py`). Worth locking down: getting the suffix
 * wrong again costs a task that runs for several minutes and then 500s.
 */

/** The one and only latent suffix — used for both storage and upload. */
export const LATENT_UPLOAD_EXT = 'safetensors';

/**
 * `<seq>-<coarse|fine>.safetensors` (the name used when uploading).
 *
 * Unknown sequence falls back to `L000`, unknown kind to `coarse` — the same
 * fallbacks `lib/latents.ts` applies when reading an archive back
 * (`meta.sequence || 'L000'` / `kind === 'fine' ? 'fine' : 'coarse'`).
 */
export function latentBaseName(sequence: unknown, kind: unknown) {
  const seq = String(sequence ?? '').trim() || 'L000';
  return `${seq}-${kind === 'fine' ? 'fine' : 'coarse'}.${LATENT_UPLOAD_EXT}`;
}

/** Upload name (kept under the old name; it shares the suffix with the stored copy). */
export const latentUploadName = latentBaseName;

/**
 * Name on disk: `<task or asset id>-<seq>-<coarse|fine>.safetensors`.
 *
 * With no prefix it degrades to the bare upload-style name (a latent the user picked
 * from their own disk has no taskId; we use the asset id as the prefix instead).
 */
export function latentStoreName(prefix: unknown, sequence: unknown, kind: unknown) {
  const head = String(prefix ?? '').trim();
  return head ? `${head}-${latentBaseName(sequence, kind)}` : latentBaseName(sequence, kind);
}
