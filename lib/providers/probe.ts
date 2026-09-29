import 'server-only';
import type { ProviderMeta } from './registry';

/**
 * 一次健康检查的结果。`ok: null` = **探测不出来**，和「失败」是两回事。
 *
 * 这个三态很关键：图片 2.0 / 视频网关接的多是各家自己实现的中转站，很多压根没有
 * `/v1/models` 这种轻量端点。如果探测不到就标成「失败」，用户会跑去换一把其实好好的 key ——
 * 明明是探测手段的局限，却让他以为是自己的问题。宁可如实说「探测不出来」。
 */
export type ProbeResult = { ok: boolean | null; message: string };

const NOT_PROBEABLE = '这个服务商不在密钥池里（走的是它自己的历史连接），请在对应的设置区保存后由实际调用来验证。';

export async function probeCredentials(input: {
  meta: ProviderMeta;
  apiKey: string;
  baseUrl: string;
}): Promise<ProbeResult> {
  /** RunningHub 走的是历史连接 + 自己的 verify，池子里的探针不认它。 */
  if (input.meta.storage !== 'pool') return { ok: null, message: NOT_PROBEABLE };
  if (input.meta.probe === 'none') return { ok: null, message: NOT_PROBEABLE };
  const base = input.baseUrl.replace(/\/+$/, '');
  if (!base) return { ok: null, message: '没有接口地址，无从探测。' };

  try {
    const response = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${input.apiKey}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return { ok: true, message: `连接正常（HTTP ${response.status}）。` };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `密钥被拒绝（HTTP ${response.status}）。请确认密钥正确、且没过期。` };
    }
    if (response.status === 404) {
      return { ok: null, message: '这个网关没有 /v1/models 端点，探测不出结果 —— 不代表密钥无效。' };
    }
    return { ok: null, message: `上游返回 HTTP ${response.status}，据此判断不了。` };
  } catch (error) {
    return { ok: false, message: `连不上 ${base}：${error instanceof Error ? error.message : String(error)}` };
  }
}
