import { z } from 'zod';
import { ApiError, api, checkOrigin, jsonBody } from '@/lib/api';
import { deepScanGgufs, dirsOfModels, getLlmSettings, listDrives, saveLlmSettings } from '@/lib/local-llm';

/**
 * 深度扫盘找模型（2026-09-26，徐先：「直接扫一遍电脑」）。
 *
 * GET 只是给界面上「扫哪个盘」那个下拉用的盘符清单；真正干活的是 POST。
 *
 * ⚠️ 默认只把**真有模型的目录**记进 `modelDirs` —— 用户选了 `E:\` 就整盘记下来，
 *    下次常规扫描会去递归整个盘，那才是真的把界面拖死。
 */
const schema = z.object({
  /** 要扫的根目录。不传 = 所有还在的盘符。 */
  roots: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  /** 要不要把扫到的目录记住（默认记）。 */
  remember: z.boolean().optional(),
});

export async function GET() {
  return api(async () => Response.json({ drives: listDrives() }));
}

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const parsed = schema.safeParse(await jsonBody(request));
    if (!parsed.success) throw new ApiError(400, '请求体格式不对。');
    const roots = parsed.data.roots?.length ? parsed.data.roots : listDrives();
    if (!roots.length) throw new ApiError(400, '这台机器上没有可扫的盘。');

    const result = await deepScanGgufs(roots);
    let modelDirs = getLlmSettings().modelDirs;
    if (parsed.data.remember !== false && result.models.length) {
      const found = dirsOfModels(result.models);
      modelDirs = [...new Set([...modelDirs, ...found])];
      saveLlmSettings({ modelDirs });
    }
    return Response.json({ ...result, roots, modelDirs });
  });
}
