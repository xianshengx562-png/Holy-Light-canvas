import { api, checkOrigin, jsonBody } from '@/lib/api';
import { getLlmSettings, saveLlmSettings, type LlmSettings } from '@/lib/local-llm';

export async function GET() {
  return api(async () => Response.json(getLlmSettings()));
}

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const body = await jsonBody(request, 65536);
    return Response.json(saveLlmSettings(body as Partial<LlmSettings>));
  });
}
