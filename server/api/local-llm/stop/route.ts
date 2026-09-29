import { api, checkOrigin } from '@/lib/api';
import { stopLlm } from '@/lib/local-llm';

/** 停掉引擎、释放显存。切换模型前也走这里（不然两个进程会抢同一块显存）。 */
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    return Response.json(await stopLlm());
  });
}
