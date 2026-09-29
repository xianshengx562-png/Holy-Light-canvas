import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { db } from '@/lib/db';
import { listKeys } from '@/lib/providers/keys';
import { CLI_PROVIDERS, MEDIA_GROUP, PROVIDERS } from '@/lib/providers/registry';
import {
  describeConnection, describeRunningHubSites, isRunningHubSite, setRunningHubSite, RUNNINGHUB_SITES,
} from '@/lib/providers/runninghub/connection';
import { listCustomModelOptions, listCustomProviders } from '@/lib/providers/custom';
import { currentTextSource } from '@/lib/promptAssistant';

/**
 * 「设置 · 模型服务」的一次性取数（2026-09-21；2026-09-23 重排成「文本 / 图片 / 视频」三段）。
 *
 * 这一页三段：**文本（提示词优化）· 图片（出图引擎）· 视频（出片引擎）**，
 * 每段里都可能有内置服务与「兼容接口」。数据来源各不相同
 * （历史连接表、密钥池、环境变量、自定义接口表）。
 * 让页面自己发四个请求去拼，会出现「两段已就绪、两段还在转圈」的半张脸界面，
 * 所以照 `/api/settings/providers/bootstrap` 的规矩：**一个接口一次拿全**。
 *
 * 顺带把**节点要用的那份**也一起给（`customModels`）：图片 / 视频节点凭它决定
 * 引擎里要不要多出「自定义接口」那一项，省得每个节点再各问一次。
 */
/** 直连网关那一栏（现在只有视频网关）在界面上要的字段。 */
type GatewayView = {
  id: string;
  label: string;
  summary: string;
  group: 'image' | 'video';
  envKeyName: string;
  /** `.env` 里那个兜底地址。用户级 key 没填地址时回落的就是它。 */
  defaultBaseUrl: string;
  configured: boolean;
  keys: { id: string; label: string; masked: string; baseUrl: string; enabled: boolean; status: string }[];
};

export async function GET() {
  return api(async () => {
    const user = await apiUser();
    const [keys, runninghub, custom, source] = await Promise.all([
      listKeys(user.id),
      describeRunningHubSites(user.id),
      listCustomProviders(user.id),
      currentTextSource(user.id),
    ]);
    const row = await db.user.findUnique({ where: { id: user.id }, select: { promptProvider: true } });

    const text = PROVIDERS.filter(meta => meta.kind === 'text').map(meta => {
      const rows = keys.filter(item => item.provider === meta.id);
      const envSet = Boolean(process.env[meta.envKeyName]?.trim());
      return {
        id: meta.id,
        label: meta.label,
        summary: meta.summary,
        envKeyName: meta.envKeyName,
        defaultBaseUrl: meta.text?.defaultBaseUrl ?? '',
        defaultModel: meta.text?.defaultModel ?? '',
        /** 配没配：池子里有启用的 key，或者环境变量里有。页面据此显示「已配置 / 未配置」。 */
        configured: rows.some(item => item.enabled) || envSet,
        keys: rows.map(item => ({
          id: item.id,
          label: item.label,
          masked: item.masked,
          baseUrl: item.baseUrl || meta.text?.defaultBaseUrl || '',
          model: item.model || meta.text?.defaultModel || '',
          enabled: item.enabled,
          status: item.status,
        })),
      };
    });

    /*
     * 直连网关（视频网关 → 视频段；图片段的 Image 2.0 已于 2026-09-23 整条删掉）。
     *
     * 与文本厂商同一套算法，只是**没有模型名**：网关的模型名留空时由它自己决定默认模型，
     * 我们猜的名字大概率它不认（见 `lib/providers/videoapi/config.ts`）。
     */
    const media: { image: GatewayView[]; video: GatewayView[] } = { image: [], video: [] };
    for (const meta of PROVIDERS) {
      const group = MEDIA_GROUP[meta.id];
      if (!group) continue;
      const rows = keys.filter(item => item.provider === meta.id);
      const envBaseUrl = (meta.baseUrlEnvName ? process.env[meta.baseUrlEnvName]?.trim() : '') || '';
      media[group].push({
        id: meta.id,
        label: meta.label,
        summary: meta.summary,
        group,
        envKeyName: meta.envKeyName,
        defaultBaseUrl: envBaseUrl,
        /** 配没配：池子里有启用的 key，或者环境变量里有（与文本厂商同一口径）。 */
        configured: rows.some(item => item.enabled) || Boolean(process.env[meta.envKeyName]?.trim()),
        keys: rows.map(item => ({
          id: item.id,
          label: item.label,
          masked: item.masked,
          baseUrl: item.baseUrl || envBaseUrl,
          enabled: item.enabled,
          status: item.status,
        })),
      });
    }

    return Response.json({
      runninghub,
      /**
       * 国内站那一条连接（历史表，每个账号一把）。
       *
       * 「设置 · 服务连接」整页并进这一页之后，填 Key / 清除密钥 / 看密钥来源都要它。
       * 从 `runninghub.cn` 里拿不到 `updatedAt`，也拿不到「环境变量兜底后」那层语义 ——
       * 那是**连接**的状态，不是**站点**的状态，两回事。
       */
      connection: await describeConnection(user.id),
      text,
      /** 图片段 / 视频段的直连网关。分类来自 `MEDIA_GROUP`（注册表是唯一事实来源）。 */
      media,
      /** 命令行形态的两家：只显示「未安装」，不给填 Key 的框（理由见 `registry.ts`）。 */
      cli: CLI_PROVIDERS,
      custom,
      customModels: {
        image: await listCustomModelOptions(user.id, 'image'),
        video: await listCustomModelOptions(user.id, 'video'),
        text: await listCustomModelOptions(user.id, 'text'),
      },
      promptProvider: String(row?.promptProvider ?? '').trim(),
      promptSource: source,
      sites: Object.values(RUNNINGHUB_SITES).map(item => ({ id: item.id, label: item.label, host: item.host })),
    });
  });
}

const patchSchema = z.object({
  /** 空串 = 自动（按 `TEXT_PROVIDER_IDS` 顺序挑第一家配了的）。 */
  promptProvider: z.string().trim().max(120).optional(),
  runninghubSite: z.string().trim().max(8).optional(),
});

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const parsed = patchSchema.safeParse(await jsonBody(request, 4096));
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    }
    const input = parsed.data;
    if (input.runninghubSite !== undefined && !isRunningHubSite(input.runninghubSite)) {
      throw new ApiError(400, `未知的 RunningHub 站点：${input.runninghubSite}`);
    }
    if (input.promptProvider !== undefined) {
      const value = input.promptProvider.trim();
      /*
       * 只认三种写法：官方那六家的 id、`custom:<id>`、以及本地模型的 `local`。
       * 手改请求体塞个乱值进来，存下之后每次优化都找不到来源 —— 那种错只在点按钮时才暴露。
       */
      const ok = value === '' || value === 'local' || value.startsWith('custom:')
        || PROVIDERS.some(item => item.kind === 'text' && item.id === value);
      if (!ok) throw new ApiError(400, `未知的文本模型来源：${value}`);
      await db.user.update({ where: { id: user.id }, data: { promptProvider: value } });
    }
    if (input.runninghubSite !== undefined) {
      await setRunningHubSite(user.id, input.runninghubSite);
    }
    return Response.json({ ok: true, promptSource: await currentTextSource(user.id) });
  });
}
