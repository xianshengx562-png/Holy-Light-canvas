/**
 * 任务结果里「这一条是视频 / 图片 / 音频」的判定。
 *
 * 为什么单独一个文件：**两个地方必须判成一样** ——
 *   - `lib/runs.ts`（生成历史 / 生成结果侧栏，数据在 `Task.result` 里，服务端读）；
 *   - `src/components/canvas/CanvasEditor.tsx`（轮询到成功那一刻，往节点上落结果）。
 * 两边各写一份正则的下场是：同一个结果在历史面板里是音频、回到节点上却画成了图片。
 * 所以这里只放三个正则 + 一个函数，**不引 `server-only`、不碰数据库**，两边都能 import。
 */

export type ResultKind = 'video' | 'image' | 'audio';

/** 视频。与加音频之前那两份逐字相同，别顺手改宽 —— 改了会认错老数据。 */
export const VIDEO_RESULT_RE = /mp4|webm|mov/i;
export const IMAGE_RESULT_RE = /png|jpe?g|webp|gif|avif/i;

/**
 * 音频（2026-10-02）。
 *
 * 两处刻意的收紧，都是为了防止「URL 里恰好有这个词」被当成音频：
 *   - `audio` **前面不能是字母数字或斜杠**（`(?<![\w/])`）—— 也就是说只认 `outputType`
 *     那一段本身（`audio /audio/mpeg` 这类）。URL 路径里的 `/audio/cover.png` 是**图片**，
 *     没有这个限制就会被判成音频。
 *   - `mp3` 这些扩展名**后面不能再跟字母数字**（`(?![\w])`）—— 否则
 *     `https://cdn/wave.mp4` 里的 `wav` 会把一段视频认成音频。
 */
export const AUDIO_RESULT_RE = /(?<![\w/])audio|\b(mp3|wav|m4a|aac|ogg|flac)(?![\w])/i;

/** 从 `outputType + ' ' + url` 的那串拼串里认出它是哪一类；认不出返回 null。 */
export function resultKindOf(text: string): ResultKind | null {
  if (AUDIO_RESULT_RE.test(text)) return 'audio';
  if (VIDEO_RESULT_RE.test(text)) return 'video';
  if (IMAGE_RESULT_RE.test(text)) return 'image';
  return null;
}
