import { ApiError } from '@/lib/api';
import { isTimeoutError } from '@/lib/requestContext';

/**
 * 上传那一步失败时，**别让异常裸奔到 `api()` 那一层**。
 *
 * 那一层会把所有没被认出来的异常糊成一句「服务暂时不可用，请稍后重试。」——
 * 界面上等于什么都没说，而真正的原因（HTTP 413 / 401 / 连接超时）只留在
 * `logs/backend.stderr.log` 里。2026-10-02 徐先点超清就是这么撞上的：
 * 日志里明明写着 `RunningHub 上传失败。`，界面上只有那句兜底，谁也看不出卡在哪儿。
 *
 * `label` 是「哪一份东西没传上去」（`待超清的媒体` / `参考图` / `视频`）——
 * 它和「怎么补救」是同一件事：换一份小一点的素材、还是去看 Key。
 */
export async function uploadOrExplain(label: string, send: () => Promise<string>): Promise<string> {
  try {
    return await send();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    /*
     * 🔴 超时要单独说（2026-10-03，N-113）：下面那句「看一眼 Key 还对不对」对
     * 超时是指错了方向 —— Key 好着呢，是**等太久了**。而「等太久」的补救办法
     * （换小一点的素材、或者等网络好点）和「Key 不对」完全是两件事。
     *
     * 判据用 `isTimeoutError()`（按 `name` 认）—— Node 里 `AbortSignal.timeout()`
     * 抛的是 `DOMException [TimeoutError]`，**没有 stack**，只能按 name 认。
     */
    if (isTimeoutError(error)) {
      throw new ApiError(504, `${label}传到工作流那边等太久了，这一轮已经中断。素材越大要传越久 —— 换一份小一点的，或者等网络好一些再试。`);
    }
    const reason = error instanceof Error && error.message ? error.message : '未知原因';
    throw new ApiError(502, `${label}没能传到工作流那边：${reason}。稍后重试，或到「设置 · 密钥中心」看一眼 Key 还对不对。`);
  }
}
