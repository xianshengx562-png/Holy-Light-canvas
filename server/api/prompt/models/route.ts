import { api, apiUser } from '@/lib/api';
import { PROVIDERS } from '@/lib/providers/registry';
import { listKeys } from '@/lib/providers/keys';
import { listCustomModelOptions } from '@/lib/providers/custom';
import { currentTextSource } from '@/lib/promptAssistant';
import { getLlmSettings, listLlmModels, listServerCandidates, pickDefaultModel } from '@/lib/local-llm';
import path from 'node:path';

/**
 * 「优化提示词」可以用哪些模型（2026-09-22）。
 *
 * 给节点上那个下拉用 —— 用户要能在自定义参数里**覆盖**这台全局设置
 * （同一个项目里不同节点想用不同模型优化是很常见的诉求）。
 *
 * 为什么单独开一个接口，而不是让前端去拼：
 * 「配没配」这件事服务端说了算（密钥池 + 环境变量两条路），前端拿不到环境变量。
 * 前端拼的结果是下拉里躺着一堆点下去必失败的厂商，用户分不清是自己的 Key 有问题
 * 还是这个功能坏了 —— 这种分辨成本不该转嫁给用户。
 *
 * ⚠️ 这里**不返回任何 Key**，连掩码都不返回：下拉只需要「有哪些、能不能用」。
 */
export type PromptModelOption = {
  /** 空串 = 自动；`'glm'` 这种 = 官方某家；`'custom:<id>:<modelId>'` = 自定义接口上的某个模型。 */
  value: string;
  label: string;
  /** 没配就是没配，界面上照实写，别让用户点下去才发现。 */
  configured: boolean;
};

export async function GET() {
  return api(async () => {
    const user = await apiUser();
    const [keys, customs, source] = await Promise.all([
      listKeys(user.id),
      listCustomModelOptions(user.id, 'text'),
      currentTextSource(user.id),
    ]);

    const items: PromptModelOption[] = PROVIDERS
      .filter(meta => meta.kind === 'text')
      .map(meta => {
        const configured = keys.some(item => item.provider === meta.id && item.enabled)
          || Boolean(process.env[meta.envKeyName]?.trim());
        const model = meta.text?.defaultModel ?? '';
        return {
          value: meta.id,
          label: model ? `${meta.label} · ${model}` : meta.label,
          configured,
        };
      });

    for (const item of customs) {
      items.push({
        value: `custom:${item.providerId}:${item.modelId}`,
        label: item.label,
        configured: true,
      });
    }

    /*
     * 本地模型（2026-09-27）。
     *
     * **只有显式选它才会走本地**，它不参加上面「自动」那条链：自动挑到本地意味着
     * 每次优化都要先把模型装进显存，而用户对「点一下优化」的预期是立刻出结果。
     *
     * `configured` 的两个条件缺一不可：本机扫得到 .gguf，且找得到一个能跑的
     * llama-server。少任何一个，选了它也只会得到一句报错。
     */
    const localModels = listLlmModels();
    const localSettings = getLlmSettings();
    const localSaved = localModels.find(item => item.path === localSettings.modelPath) ?? null;
    const localPick = localSaved ?? pickDefaultModel(localModels);
    items.push({
      value: 'local',
      label: localPick
        ? `本地 · ${path.basename(localPick.path).replace(/\.gguf$/i, '')}（按需装载）`
        : '本地模型（还没选模型文件）',
      configured: Boolean(localPick) && listServerCandidates().length > 0,
    });

    return Response.json({
      items,
      /** 「自动」那一档现在实际会落到哪家（没有就是 null，界面上要照实说「还没配」）。 */
      resolvedLabel: source?.label ?? null,
      /**
       * 同上，不过是**厂商 id**（2026-09-26）。
       * 界面要靠它判断「这一节点生效的是不是本地模型」—— 只看名字的话，
       * 「本地 · Qwen3-4B」这种 label 得靠字符串匹配去猜，改一次文案就断。
       */
      resolvedProvider: source?.provider ?? null,
    });
  });
}
