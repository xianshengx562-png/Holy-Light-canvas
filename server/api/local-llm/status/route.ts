import { api } from '@/lib/api';
import { getLlmStatus } from '@/lib/local-llm';

/**
 * 本地引擎的状态。
 *
 * 启动期间渲染进程靠**轮询**这个接口看日志（见 `ScriptTool`），
 * 所以这里要把 `log` 一起带回去 —— 模型加载失败的现场只在引擎的 stdout 里，
 * 不给出来的话界面上就只有一句「启动失败」，没法排查。
 */
export async function GET() {
  return api(async () => Response.json(getLlmStatus()));
}
