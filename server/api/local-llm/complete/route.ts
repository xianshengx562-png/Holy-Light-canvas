import { api, checkOrigin, jsonBody } from '@/lib/api';
import { completeLlm, type CompleteInput } from '@/lib/local-llm';

/**
 * 一次文本生成。
 *
 * `maxBytes` 给到 1MB：小说原文是按块整段发过来的，默认的 8KB 会让长一点的文章
 * 直接被判成「请求内容过长」—— 而这个限制在报错信息里看不出来，只会看到 400。
 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const body = await jsonBody(request, 1024 * 1024);
    const result = await completeLlm(body as CompleteInput);
    return Response.json(result);
  });
}
