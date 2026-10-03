/**
 * 传给上游的 latent 文件名（2026-10-03，徐先报的那次 500）。
 *
 * 🔴 后缀**必须是 `.safetensors`**，这是上游节点的**判据**，不是我们的口味：
 * RunningHub 那个 `Yuan_H3MotionContextLoadLatent` 节点的「手动上传」按**文件名后缀**
 * 认类型，原来的名字是 `<编号>-<粗/精>.latent`，于是任务直接失败：
 *
 *     h3_motion_context: 手动上传仅支持 .safetensors 文件
 *
 * 内容其实一直是对的 —— 落盘的就是上游给的那份字节（gzip 存、读的时候原样解回来），
 * 我们自己的核验也印证了：解压后前 8 字节是 safetensors 的头部长度、后面跟着
 * `{"__metadata__":{"format":"h3_motion_con…`。**错的只是名字**。
 *
 * 本地那份存档仍叫 `<taskId>-<编号>-<粗/精>.latent.gz`（`lib/latents.ts` 的 `store()`）：
 * 那是我们自己的归档格式，改它等于让老档案找不到自己。
 *
 * 这个文件**零依赖**，好单独编成 CJS 跑单测（`C:/FRAME/_test-latent-name.py`）——
 * 这条判据值得锁住：写回 `.latent` 的代价是一次跑满几分钟、最后 500 的任务。
 */

/** 交给上游时必须用的后缀。改它之前先确认上游那个节点换了判据。 */
export const LATENT_UPLOAD_EXT = 'safetensors';

/**
 * `<编号>-<粗/精>.safetensors`。
 *
 * 认不出编号时回落 `L000`、认不出粗精时按 `coarse` —— 与 `lib/latents.ts` 里
 * 读档案时的那两个兜底**同一口径**（那边也是 `meta.sequence || 'L000'` /
 * `kind === 'fine' ? 'fine' : 'coarse'`）。
 */
export function latentUploadName(sequence: unknown, kind: unknown) {
  const seq = String(sequence ?? '').trim() || 'L000';
  return `${seq}-${kind === 'fine' ? 'fine' : 'coarse'}.${LATENT_UPLOAD_EXT}`;
}
