import { api, apiUser, ApiError } from '@/lib/api';
import { db } from '@/lib/db';
import { applyDefaultBindings, fieldSchema, type WorkflowField } from '@/lib/workflows/configuration';
import { defaultConfiguration, defaultWorkflowId } from '@/lib/workflows/defaults';
import { localGraphToFields, providerFromWorkflowId, readWorkflowProvider, workflowIdError } from '@/lib/workflows/local';
import { isRunningHubAppWorkflowId, webAppFieldsToWorkflowFields, webAppIdOf } from '@/lib/workflows/runninghubApp';
import { getWebAppInfo } from '@/lib/providers/runninghub/webapp';
import { resolveRunningHub } from '@/lib/providers/runninghub/connection';
import { enrichFieldOptions } from '@/lib/workflows/fieldOptions';

/*
 * 这份工作流里**有哪些字段可以挑** —— 画布参数块的「添加参数」下拉、以及配置页的
 * 「补全候选字段」都从这里取。
 *
 * 为什么不直接复用 `GET .../config`：那边返回的是「用户勾了哪些」（要连同数值一起回显，
 * 几百行带着 40KB 上限的 value 一起过来），而这里要的是「这份图里都有什么」（只有名字，
 * 没有值）。混用会导致下拉里塞着上一次的旧值 —— 那种「看着像选上了、其实没写进去」的 bug。
 *
 * - 本地工作流（`local-` 前缀 + 自己带图）：以图为源头扫一遍，再让草稿里存过的那条覆盖回来，
 *   这样「勾了 / 绑了画布哪个值」仍然看得见，而**图里新增的节点也会出现在候选里**。
 * - 云端工作流：以草稿里保存过的那份为准。它的图在 RunningHub 那边，
 *   每次拉 `getJsonApiFormat` 要一次真实网络请求，下拉不值得这么贵。
 */

type Context = { params: Promise<{ workflowId: string }> };

export type WorkflowFieldOption = Pick<WorkflowField, 'key' | 'nodeId' | 'fieldName' | 'label' | 'kind' | 'classType'> & {
  enabled: boolean;
  binding: WorkflowField['binding'];
  /**
   * 这一条能填哪些值（本机 ComfyUI 的 `/object_info` 说的；RunningHub 应用则来自它自己的元信息）。
   *
   * 带出去是为了让「挑这个字段」的那一侧（画布参数块 / 配置页）也能直接渲染成下拉 ——
   * 以前只有 RunningHub 应用有这份清单，从图上扫出来的永远是个文本框。
   */
  options?: string[];
};

/** 一次最多返回多少项：下拉里几千条是没有意义的，人也不会拉到底。 */
const MAX_FIELDS = 400;

/** 一条挑不出来就跳过：库里可能躺着别的版本写进去的形状，别让整个下拉因为一条脏数据空掉。 */
function toOption(field: Record<string, unknown>): WorkflowFieldOption | null {
  const parsed = fieldSchema.safeParse(field);
  if (!parsed.success) return null;
  const f = parsed.data;
  return {
    key: f.key, nodeId: f.nodeId, fieldName: f.fieldName, label: f.label,
    kind: f.kind, classType: f.classType, enabled: f.enabled, binding: f.binding,
    /* 存过的选项原样带出去；没存过的由下面那一步去本机 ComfyUI 问。 */
    ...(f.options?.length ? { options: f.options } : {}),
  };
}

export async function GET(_request: Request, context: Context) {
  return api(async () => {
    const user = await apiUser();
    const { workflowId } = await context.params;
    const message = workflowIdError(workflowId);
    if (message) throw new ApiError(400, message);

    const draft = await db.workflowDraft.findUnique({
      where: { userId_workflowId: { userId: user.id, workflowId } },
      select: { provider: true, graph: true, config: true },
    });

    const provider = draft ? readWorkflowProvider(draft.provider) : providerFromWorkflowId(workflowId);
    const saved = draft
      ? (applyDefaultBindings(draft.config) as { fields?: Array<Record<string, unknown>> }).fields ?? []
      : [];
    const savedByKey = new Map(saved.map(field => [String(field.key ?? ''), field]));

    let options: Array<WorkflowFieldOption | null>;
    let source: 'graph' | 'config' | 'builtin' | 'app';
    if (!draft && workflowId === defaultWorkflowId) {
      /*
       * 内置那份出厂配置既不用连网、也不用先存过 —— 刚装好的机器上直接就有得挑。
       * 少了这一支，「默认工作流」会挂在生成节点上却一个字段都挑不出来，而配置页明明列得出来；
       * 两边读的不是同一处来源时，用户只会得出「画布这边坏了」的结论。
       */
      source = 'builtin';
      options = defaultConfiguration(workflowId).fields
        .slice(0, MAX_FIELDS)
        .map(field => toOption(field as unknown as Record<string, unknown>));
    } else if (provider === 'local' && draft?.graph) {
      source = 'graph';
      options = localGraphToFields(draft.graph)
        .slice(0, MAX_FIELDS)
        .map(field => {
          /* 同键命中就用存过的那条：它带着 enabled / binding，图里扫出来的一律是没勾的。 */
          const old = savedByKey.get(field.key);
          return old ? toOption(old) : toOption(field as unknown as Record<string, unknown>);
        });
    } else if (isRunningHubAppWorkflowId(workflowId) && !saved.length) {
      /*
       * 应用：还没存过配置时（刚填完 ID 进来），得去 RunningHub 现拉一次它的公开字段。
       * 存过之后就按云端那条规矩走 —— 以存过的为准，下拉不值得每次都打一次网络请求。
       */
      source = 'app';
      try {
        const resolved = await resolveRunningHub(user.id);
        const info = await getWebAppInfo(String(webAppIdOf(workflowId)), resolved.apiKey || undefined, resolved.baseUrl || undefined);
        options = webAppFieldsToWorkflowFields(info.nodeInfoList)
          .slice(0, MAX_FIELDS)
          .map(field => toOption(field as unknown as Record<string, unknown>));
      } catch {
        /* 拉不到就给个空列表：这里只是「候选下拉」，失败不该把整个配置页弄挂。 */
        options = [];
      }
    } else {
      source = 'config';
      options = saved.slice(0, MAX_FIELDS).map(toOption);
    }

    /*
     * 与配置页那条同源：能查到的枚举字段把选项挂上（详见 `lib/workflows/fieldOptions.ts`）。
     * 挂上之后，画布上「添加参数」拿到的候选就带着可选项，不用人去 ComfyUI 那边抄。
     */
    const enriched = await enrichFieldOptions(options as unknown[], user.id);
    /* `.filter(Boolean)` 在 TS 里不带类型收窄，这里显式判一次（顺便让「跳过了几条」能进计数）。 */
    const fields = (enriched.fields as Array<WorkflowFieldOption | null>)
      .filter((item): item is WorkflowFieldOption => item !== null);
    return Response.json({ workflowId, provider, source, fields });
  });
}
