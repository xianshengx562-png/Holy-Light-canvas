import { ApiError, api, apiUser, checkOrigin } from '@/lib/api';
import { markKeyChecked, readKey, readPlainCredentials } from '@/lib/providers/keys';
import { probeCredentials } from '@/lib/providers/probe';
import { providerMeta } from '@/lib/providers/registry';

/**
 * 拿一把 key 做一次健康检查。
 *
 * 结果有三态（见 `probeCredentials`）：正常 / 无效 / **探测不出来**。界面必须区分第三种 ——
 * 把它显示成红色等于告诉用户「你的 key 坏了」，而实际上只是我们这边没有合适的探测手段。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const { id } = await params;
    const creds = await readPlainCredentials(user.id, id);
    if (!creds) throw new ApiError(404, '找不到这把密钥，或者它已经解不开了。');
    const meta = providerMeta(creds.provider);
    if (!meta) throw new ApiError(400, '未知的服务商。');

    const probe = await probeCredentials({
      meta,
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
    });
    /** ok 为 null 时**不动状态**：没查出东西就改人家的状态，属于添乱。 */
    if (probe.ok !== null) await markKeyChecked(creds.id, probe.ok, probe.message);
    return Response.json({ ...probe, key: await readKey(user.id, id) });
  });
}
