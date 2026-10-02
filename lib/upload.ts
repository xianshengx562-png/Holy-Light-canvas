import { ApiError } from '@/lib/api';

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
    const reason = error instanceof Error && error.message ? error.message : '未知原因';
    throw new ApiError(502, `${label}没能传到工作流那边：${reason}。稍后重试，或到「设置 · 密钥中心」看一眼 Key 还对不对。`);
  }
}
