import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import {
  clearLocalConnection, describeLocalConnection, markLocalStatus, readLocalCredentials, saveLocalConnection,
} from '@/lib/providers/local/connection';
import { testLocalConnection } from '@/lib/providers/local/client';

/**
 * 本地模式的连接读写。
 *
 * 与 `/api/providers/runninghub/connection` 同构，差别只有一处：**保存后要不要顺手探一次活**。
 * 那边必测，因为 key 错了后面每次生成都失败；这边只在**开关是开的**时候测 ——
 * 用户可能只是想把图和地址先存下来、等装好 ComfyUI 再开，那时候逼他连一次是纯粹的噪音。
 *
 * ⚠️ 请求体可能很大（一份 ComfyUI 图几十 KB 很正常），所以这里的 `jsonBody` 上限给到 2 MB，
 * 别照抄别处那个 4 KB。
 */
const schema = z.object({
  baseUrl: z.string().trim().max(500).optional(),
  apiKey: z.string().trim().max(500).optional(),
  /** `null` = 清空这份图。不传 = 不动它。 */
  graph: z.unknown().nullish(),
  /**
   * ComfyUI 的安装目录（**只读**用：扫 `custom_nodes` 和 `models`）。
   * 传空串 = 不配，于是服务没开的时候查不了缺什么。
   */
  comfyuiDir: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
});

function assertUrl(value: string | undefined) {
  if (value !== undefined && value && !/^https?:\/\//i.test(value)) {
    throw new ApiError(400, '本机地址要以 http:// 或 https:// 开头 —— 本机一般是 http://127.0.0.1:8188。');
  }
}

export async function GET() {
  return api(async () => {
    const user = await apiUser();
    return Response.json(await describeLocalConnection(user.id));
  });
}

export async function PUT(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const parsed = schema.safeParse(await jsonBody(request, 2 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, '本地模式配置无效。');
    assertUrl(parsed.data.baseUrl);
    try {
      await saveLocalConnection(user.id, parsed.data);
    } catch (error) {
      /** 存图 / 开开关那几处会被动的校验抛的是普通 Error，在这里统一翻成 400 —— 它们都是「用户该去改」的事。 */
      throw new ApiError(400, error instanceof Error ? error.message : '本地模式配置无效。');
    }
    const view = await describeLocalConnection(user.id);
    let test: { ok: boolean; message: string } | null = null;
    if (view.enabled) {
      const creds = await readLocalCredentials(user.id);
      test = await testLocalConnection(creds);
      await markLocalStatus(user.id, test.ok ? 'verified' : 'failed');
    }
    return Response.json({ ...(await describeLocalConnection(user.id)), test });
  });
}

export async function DELETE(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    await clearLocalConnection(user.id);
    return Response.json(await describeLocalConnection(user.id));
  });
}
