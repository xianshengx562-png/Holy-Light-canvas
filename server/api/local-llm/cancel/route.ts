import { api, checkOrigin, jsonBody } from '@/lib/api';
import { cancelLlm } from '@/lib/local-llm';

/** 取消某一次生成（按 requestId）。引擎照旧驻留，只掐那一个请求。 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const body = await jsonBody(request, 8192);
    const requestId = String(body.requestId || '');
    if (!requestId) throw new Error('缺少 requestId');
    return Response.json({ cancelled: cancelLlm(requestId) });
  });
}
