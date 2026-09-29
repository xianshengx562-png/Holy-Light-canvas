import { api } from '@/lib/api';
import { bundledServerPath, detectModelDirs, getLlmSettings, listLlmModels, listServerCandidates, pickDefaultModel } from '@/lib/local-llm';

/**
 * 本机上能用的模型与运行时。
 *
 * 一次给全（模型列表 / 扫描到的目录 / 候选可执行文件 / 推荐的那一个）——
 * 界面上「选模型」下拉要这些，分开成三个接口的话得等三次往返，而扫描本身要读盘。
 */
export async function GET() {
  return api(async () => {
    const settings = getLlmSettings();
    const models = listLlmModels();
    return Response.json({
      models,
      modelDirs: detectModelDirs(),
      savedDirs: settings.modelDirs,
      servers: listServerCandidates(),
      /** 随包自带的那套；界面上要把它标成「内置」，也要能单独选它。 */
      bundled: bundledServerPath(),
      recommended: pickDefaultModel(models),
      settings,
    });
  });
}
