import { api, checkOrigin, jsonBody } from '@/lib/api';
import { startLlm, type LlmSettings } from '@/lib/local-llm';

/** 启动本地引擎。请求体是设置补丁（可以只传 `modelPath`）。 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const body = await jsonBody(request, 65536);
    const status = await startLlm(body as Partial<LlmSettings>);
    return Response.json(status);
  });
}
