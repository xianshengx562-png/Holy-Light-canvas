import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { walletOverview } from '@/lib/wallet';
import { clearApiKey, describeConnection, saveApiKey } from '@/lib/providers/runninghub/connection';
import { verifyConnection } from '@/lib/providers/runninghub/verify';

const schema = z.object({ apiKey: z.string().trim().min(16).max(200) });

/** 连接信息永远和余额一起返回 —— 填没填自己的 key 决定了后续生成扣不扣费，两者是同一件事的两面。 */
async function view(user: { id: string; email: string }) {
  return { ...(await describeConnection(user.id)), wallet: await walletOverview(user) };
}

export async function GET() {
  return api(async () => {
    const user = await apiUser();
    return Response.json(await view(user));
  });
}

export async function PUT(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const parsed = schema.safeParse(await jsonBody(request, 4096));
    if (!parsed.success) throw new ApiError(400, 'API Key 无效，请粘贴完整的密钥（至少 16 位）。');
    await saveApiKey(user.id, parsed.data.apiKey);
    const test = await verifyConnection(user.id);
    return Response.json({ ...(await view(user)), test });
  });
}

export async function DELETE(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    await clearApiKey(user.id);
    return Response.json(await view(user));
  });
}
