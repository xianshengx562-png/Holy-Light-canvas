import { api } from '@/lib/api';
import {
  bundledServerPath, detectModelDirs, getLlmSettings, listLlmModels, listLlmProjectors,
  listServerCandidates, pickDefaultModel, pickProjectorFor,
} from '@/lib/local-llm';

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
    const projectors = listLlmProjectors();
    return Response.json({
      models,
      /**
       * 视觉投影（mmproj）单独一份（2026-10-03 徐先）。
       *
       * 主模型下拉里**没有**它们 —— 投影不是主模型，选了它 llama-server 起不来。
       * `paired` 是给当前主模型猜的那一份（同目录、名字最像的那个）：
       * 界面上换了主模型就自动填进去，省得他再从一份几百 MB 的清单里自己找。
       */
      projectors,
      paired: pickProjectorFor(settings.modelPath || pickDefaultModel(models)?.path || ''),
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
