import { api } from '@/lib/api';
import { estimateLlmVram, probeDeviceVramGb } from '@/lib/local-llm';

/**
 * 「这个模型 + 这个上下文」要占多少显存（2026-09-27）。
 *
 * 设置页把「上下文长度」交给用户自己调之后，必须让他**看得见代价** ——
 * 4096 → 32768 的 KV 缓存是八倍，本机 4GB 显存上这就是装得下与装不下的区别。
 * 所以这个接口要能随「换模型 / 改上下文」立刻重算。
 *
 * 参数是**候选值**（还没存进设置的那一份），不是读设置 ——
 * 用户正在输入框里敲 `32768` 的时候，看到的就该是 32768 的代价。
 */
export async function GET(request: Request) {
  return api(async () => {
    const url = new URL(request.url);
    const num = (key: string) => {
      const raw = url.searchParams.get(key);
      if (raw === null || raw.trim() === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const estimate = estimateLlmVram({
      modelPath: url.searchParams.get('modelPath') ?? undefined,
      contextSize: num('contextSize'),
      cacheTypeK: url.searchParams.get('cacheTypeK') ?? undefined,
      cacheTypeV: url.searchParams.get('cacheTypeV') ?? undefined,
      gpuLayers: num('gpuLayers'),
    });
    const deviceGb = await probeDeviceVramGb().catch(() => null);
    return Response.json({ ...estimate, deviceGb });
  });
}
