import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { api, apiUser, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { db } from '@/lib/db';
import { applyDefaultBindings, configurationSchema, workflowJsonToFields } from '@/lib/workflows/configuration';
import { defaultConfiguration, defaultWorkflowId } from '@/lib/workflows/defaults';
import { getWorkflowJson } from '@/lib/providers/runninghub/client';
import { getWebAppInfo } from '@/lib/providers/runninghub/webapp';
import { resolveRunningHub } from '@/lib/providers/runninghub/connection';
import { isRunningHubAppWorkflowId, webAppFieldsToWorkflowFields, webAppIdOf } from '@/lib/workflows/runninghubApp';
import { parseLocalGraph } from '@/lib/providers/local/graph';
import { normalizeWorkflowName, readWorkflowName } from '@/lib/workflows/label';
import { DEFAULT_GENERATOR_KIND, GENERATOR_KINDS, generatorKindNoun, readGeneratorKind } from '@/lib/workflows/purpose';
import { categoriesFor, DEFAULT_WORKFLOW_CATEGORY, readWorkflowCategory, WORKFLOW_CATEGORIES, workflowCategoryLabel } from '@/lib/workflows/category';
import { DEFAULT_WORKFLOW_OPERATION, readWorkflowOperation, WORKFLOW_OPERATIONS } from '@/lib/workflows/operation';

import {
  graphNodeCount, localGraphToFields, providerFromWorkflowId, readWorkflowProvider, workflowIdError,
} from '@/lib/workflows/local';

type Context = { params: Promise<{ workflowId: string }> };
/*
 * 以前这里只认纯数字（RunningHub 的 ID 就是数字）。现在本地工作流带 `local-` 前缀，
 * 共用同一个 URL 段，判断统一交给 `lib/workflows/local.ts` —— 那一处同时被界面用来
 * 「新建按钮要不要亮」，两边判的是同一件事才不会出现「列表里点得开、保存时 400」。
 */
async function workflowKey(context: Context) {
  const { workflowId } = await context.params;
  const message = workflowIdError(workflowId);
  if (message) throw new ApiError(400, message);
  return workflowId;
}
export async function GET(request: Request, context: Context) {
  return api(async () => {
    const user = await apiUser();
    const workflowId = await workflowKey(context);
    /*
     * 没有草稿时该报哪种用途：配置页会带上它自己当前选的用途（`?kind=`），
     * 这样「从图片节点点进来配一份新的出图工作流」打开的就是图片那一档，
     * 不会先显示成视频、等用户存完才发现标错了。
     */
    const asked = new URL(request.url).searchParams.get('kind');
    const askedCategory = new URL(request.url).searchParams.get('category');
    const askedOperation = new URL(request.url).searchParams.get('operation');
    const draft = await db.workflowDraft.findUnique({ where: { userId_workflowId: { userId: user.id, workflowId } } });
    /** 有草稿以草稿为准，没有草稿才看 URL 上带的用途（从画布某类节点点进来时会带）。 */
    const kind = draft ? readGeneratorKind(draft.kind) : readGeneratorKind(asked ?? DEFAULT_GENERATOR_KIND);
    /*
     * 节点字段的来源（按优先级）：
     * 1. 本地草稿 —— 用户已配好的，永远第一优先；
     * 2. 内置默认工作流 ID —— 字段是静态烘焙的（`runninghub-fields.json`），不额外发请求；
     * 3. 其它 ID 且没有草稿 —— 去 RunningHub 拉「获取工作流Json」，把节点 inputs 摊平成字段。
     *    之前这一支直接返回空 `fields`，于是「输入工作流 ID 节点字段没加载」正是这个 bug。
     *    拉取失败（没配 key / 工作流不存在 / 超时）不抛错，改成返回空字段 + nodeNotice 说明原因，
     *    界面上能看到为什么是空的，而不是又一片静默的空白。
     */
    let configFields: unknown[] = [];
    let nodeNotice = '';
    /** 应用那一支顺带拿回来的名字：新建草稿时它就是默认名，省得用户再去猜这个 ID 是什么。 */
    let appName = '';
    const askedProvider = providerFromWorkflowId(workflowId);
    if (draft) {
      configFields = (applyDefaultBindings(draft.config) as { fields?: unknown[] }).fields ?? [];
      /*
       * 本地工作流的图就存在这一行里，所以「字段列表空了」不等于「这份工作流没东西」——
       * 图还在，只是字段被清过。这时拿图再扫一遍，比给用户一片空白有用得多
       * （新建那一步本来就会扫过，这里是给「手动清干净了」和老数据兜底）。
       */
      if (!configFields.length && draft.graph) {
        configFields = localGraphToFields(draft.graph);
        if (configFields.length) nodeNotice = `已从本地图扫出 ${configFields.length} 个节点字段，请勾选要启用的。`;
      }
    } else if (workflowId === defaultWorkflowId) {
      configFields = defaultConfiguration(workflowId).fields;
    } else if (askedProvider === 'local') {
      /*
       * 本地工作流的一切都从「那份图」开始，而图是在导入的时候写进草稿的。
       * 没有草稿就没有图，**也没有别的地方能把它找回来**（不像云端那样还能去 RunningHub 拉一次），
       * 所以这里只能明确告诉用户该去哪一步。
       */
      configFields = [];
      nodeNotice = '这份本地工作流还没有导入过 ComfyUI 图 —— 先到工作流库里导入「导出（API）」出来的那份 JSON。';
    } else if (isRunningHubAppWorkflowId(workflowId)) {
      /*
       * RunningHub **应用**：字段不在任何一张 ComfyUI 图里，而是应用对外公开的那份
       * `nodeInfoList`（`apiCallDemo`）。所以它必须**每次现拉**（和云端工作流一样），
       * 而拉不到时也不能静默给一片空白 —— 那和「这个应用没有字段」长得一模一样。
       */
      try {
        const resolved = await resolveRunningHub(user.id);
        const info = await getWebAppInfo(String(webAppIdOf(workflowId)), resolved.apiKey || undefined, resolved.baseUrl || undefined);
        appName = info.appName;
        configFields = webAppFieldsToWorkflowFields(info.nodeInfoList).slice(0, 400);
        nodeNotice = configFields.length
          ? `已从 RunningHub 拉取这个应用的 ${configFields.length} 个可调用字段，请勾选要启用的。`
          : '这个应用没有公开可调用的字段 —— 确认它在 RunningHub 上已经发布，且用的是有权限的那个账号。';
      } catch (err) {
        configFields = [];
        nodeNotice = `未能从 RunningHub 拉取应用字段：${err instanceof Error ? err.message : '未知错误'}（确认 API Key 与所在站点，以及这个应用 ID 是否正确）。`;
      }
    } else {
      try {
        /*
         * 🔴 2026-09-28 修复「工作流拉取失败」：这里原本不传 apiKey / baseUrl，
         * getWorkflowJson 就只回退去读 `process.env.RUNNINGHUB_API_KEY` —— 桌面版没有这个
         * 环境变量，用户在「设置 · 模型服务」填的 key（存数据库 RunningHubConnection /
         * runninghub-ai 密钥池）永远用不上，任何非默认工作流 ID 的拉取都报「尚未配置 API Key」。
         * 现在先 resolveRunningHub() 把库里的 key 和站点地址带过来（用户没填时
         * resolved.apiKey 是 null → 仍走函数内部的 env 回退，站长配工作流那档不受影响）。
         * 应用（app-）那一支从进来就带上了 resolve，这一支是漏网之鱼。
         */
        const resolved = await resolveRunningHub(user.id);
        const prompt = await getWorkflowJson(workflowId, resolved.apiKey ?? undefined, resolved.baseUrl ?? undefined);
        const mapped = workflowJsonToFields(prompt);
        if (mapped.length > 400) {
          configFields = mapped.slice(0, 400);
          nodeNotice = `已从 RunningHub 拉取 ${mapped.length} 个节点字段（已截断到 400 项），请勾选要启用的覆盖项。`;
        } else {
          configFields = mapped;
          nodeNotice = mapped.length
            ? `已从 RunningHub 拉取 ${mapped.length} 个节点字段，请勾选要启用的覆盖项。`
            : 'RunningHub 返回的工作流没有可编辑的节点字段。';
        }
      } catch (err) {
        configFields = [];
        nodeNotice = `未能从 RunningHub 拉取节点字段：${err instanceof Error ? err.message : '未知错误'}（可在下方手动添加节点字段，或确认 API Key 与工作流 ID 是否正确）。`;
      }
    }
    return Response.json({
      config: { fields: configFields },
      version: draft?.version ?? -1,
      /* 这份工作流跑在哪：本机 ComfyUI / RunningHub。界面据此显示来源与「换图」入口。 */
      provider: draft ? readWorkflowProvider(draft.provider) : askedProvider,
      /* 只在本地工作流上有意义：这份图里有多少个节点。云端恒为 0。 */
      graphNodes: draft && readWorkflowProvider(draft.provider) === 'local' ? graphNodeCount(draft.graph) : 0,
      kind,
      /*
       * 分类要**跟着用途兜底**：一份标着「视频参考」的草稿若用途是图片，读出来必须是默认值 ——
       * 否则配置页会显示一个这个用途下根本选不到的分类，用户一保存又变成另一个值。
       */
      category: draft
        ? readWorkflowCategory(draft.category, kind)
        : readWorkflowCategory(askedCategory ?? DEFAULT_WORKFLOW_CATEGORY, kind),
      /*
       * 工序与用途正交，不需要跟着用途兜底 —— 认不出来时才回落到默认工序。
       * （分类要跟着用途兜，是因为「图片用途 + 视频参考」这种组合读出来是个选不到的值。）
       */
      operation: draft ? readWorkflowOperation(draft.operation) : readWorkflowOperation(askedOperation),
      /* 没有草稿就没有名字（新建的草稿默认没名字，界面回落显示 ID）—— 应用除外：它有名字。 */
      name: draft ? readWorkflowName(draft.name) : appName,
      /* 拉取成功 / 失败的原因，前端用 setNotice 展示。 */
      nodeNotice,
    });
  });
}
const saveSchema = z.object({
  config: configurationSchema,
  version: z.number().int().min(-1),
  /** 用途。不传就保持原值（老客户端的 PATCH 仍然按原用途存）。 */
  kind: z.enum(GENERATOR_KINDS as unknown as [string, ...string[]]).optional(),
  /** 分类。与用途同样的「不传就保持原值」语义，但**必须适用于当前用途**（见下面那段校验）。 */
  category: z.enum(WORKFLOW_CATEGORIES as unknown as [string, ...string[]]).optional(),
  /**
   * 工序：普通生成 / 超清。与用途、分类正交，所以没有配对的适用性检查 ——
   * 「视频用途的超清工作流」和「图片用途的超清工作流」都成立。
   */
  operation: z.enum(WORKFLOW_OPERATIONS as unknown as [string, ...string[]]).optional(),
  /**
   * 名字。长度与清洗规则在 `lib/workflows/label.ts`（那里报中文错，比 zod 的默认文案有用）。
   * 与 `kind` 同样是「不传就保持原值」；**传空串是有效操作**（= 清掉名字），所以判定要用
   * `!== undefined`，不能用真值判断 —— 否则用户永远清不掉一个起错的名字。
   */
  name: z.string().optional(),
  /**
   * 本地工作流的「图」（ComfyUI「导出（API）」那份 JSON）。
   *
   * 传了 = **换一份图**。这是一次有后果的操作：图一换，节点编号全变，
   * 老字段（`70.value` 这种）很可能在新图里根本不存在，所以服务端会**按新图重算字段列表**
   * —— 能对应上的保留勾选项与绑定，对不上的丢掉，新扫出来的补进来。
   *
   * 云端工作流传这个会 400：它的图在 RunningHub 那边，`graph` 这一列本来就该是空的。
   */
  graph: z.unknown().nullish(),
});

/**
 * 按一份新的 ComfyUI 图重算字段列表。
 *
 * 三条规则，目的只有一个 —— **别让用户配过的东西静默消失**：
 *   1. 新图里没有了的老字段（编号对不上）丢掉，但要把丢了多少告诉用户；
 *   2. 新图里新出现的节点字段补进来（`enabled: false`，不勾就不提交）；
 *   3. 两边都有的，以老的那份为准保留「用户意图」：勾没勾、绑到画布的什么、改过的名和值。
 *      图和的那几列（nodeId / fieldName / classType）以新图为准 —— 它们本来就是从图里读出来的。
 */
function rebuildFieldsFromGraph(config: unknown, graph: unknown) {
  const scanned = localGraphToFields(graph).slice(0, 400);
  const raw = (config || {}) as { fields?: unknown[] };
  const incoming = Array.isArray(raw.fields) ? raw.fields : [];
  const saved = new Map<string, Record<string, unknown>>();
  for (const item of incoming) {
    const field = item as Record<string, unknown>;
    if (typeof field.key === 'string') saved.set(field.key, field);
  }
  const fields = scanned.map(field => {
    const old = saved.get(field.key);
    if (!old) return field;
    /* 只挑「用户改过」的那几列，剩下的用图里的现扫值。 */
    const kept: Record<string, unknown> = {};
    for (const key of ['enabled', 'binding', 'label', 'value', 'kind']) {
      if (old[key] !== undefined) kept[key] = old[key];
    }
    return { ...field, ...kept };
  });
  const keys = new Set(fields.map(field => field.key));
  return {
    fields,
    added: fields.filter(field => !saved.has(field.key)).length,
    dropped: incoming.filter(item => !keys.has(String((item as { key?: unknown }).key ?? ''))).length,
  };
}
export async function PATCH(request: Request, context: Context) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    const workflowId = await workflowKey(context);
    const body = await jsonBody(request, 2 * 1024 * 1024);
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0].message);
    const { version } = parsed.data;
    const kind = parsed.data.kind;
    const category = parsed.data.category;
    const operation = parsed.data.operation;
    /*
     * 分类的适用性依附于用途，所以校验前要知道「保存之后这份草稿是哪个用途」：
     * 本次传了就以传的为准，没传就去看库里现在存的那份（老客户端不带 kind 时也走这条）。
     */
    const current = await db.workflowDraft.findUnique({
      where: { userId_workflowId: { userId: user.id, workflowId } },
      select: { kind: true, category: true, operation: true },
    });
    const effectiveKind = readGeneratorKind(kind ?? current?.kind ?? DEFAULT_GENERATOR_KIND);
    if (category && !categoriesFor(effectiveKind).some(item => item.value === category)) {
      const allowed = categoriesFor(effectiveKind).map(item => item.label).join(' / ');
      throw new ApiError(400, `分类「${workflowCategoryLabel(category)}」不适用于${generatorKindNoun(effectiveKind)}，这个用途只能选：${allowed}。`);
    }
    /*
     * 改了用途时，旧分类若对新用途不成立就顺手退回默认 —— 不这么做，库里会留一个
     * 「读出来永远是 none、但明明白白写着 video-ref」的值，按分类筛选时它会被算进错误的那一格。
     * 用户没显式传分类、也没改用途时，这里是 undefined（保持原值，与 kind 同一语义）。
     */
    const nextCategory = category ?? (kind ? readWorkflowCategory(current?.category, effectiveKind) : undefined);
    /* 名字先清洗校验：超长要**报错**，不能截断后再存（用户会以为名字存下了）。 */
    const nameInput = parsed.data.name;
    let name = '';
    if (nameInput !== undefined) {
      const cleaned = normalizeWorkflowName(nameInput);
      if (!cleaned.ok) throw new ApiError(400, cleaned.message);
      name = cleaned.name;
    }
    /*
     * 换图只在本地工作流上成立。云端那份图从来不存在本地，客户端传了就是拼错 ——
     * 静默忽略会让用户以为「图更新了」而实际一动没动，这种错最难查，所以直接 400 说清。
     */
    const graphInput = parsed.data.graph;
    const askedProvider = providerFromWorkflowId(workflowId);
    if (graphInput !== null && graphInput !== undefined && askedProvider !== 'local') {
      throw new ApiError(400, '云端工作流的图保存在 RunningHub 那边，不支持在本地上传图。');
    }
    let nextGraph: unknown;
    let fieldNotice = '';
    if (graphInput !== null && graphInput !== undefined) {
      try {
        nextGraph = parseLocalGraph(graphInput);
      } catch (error) {
        throw new ApiError(400, error instanceof Error ? error.message : '这份本地工作流图无效。');
      }
    }
    const rebuild = nextGraph ? rebuildFieldsFromGraph(body.config, nextGraph) : null;
    if (rebuild) {
      fieldNotice = `已按新图重算字段：新增 ${rebuild.added} 项`
        + (rebuild.dropped ? `，${rebuild.dropped} 项因为新图里没有对应节点被移除` : '')
        + '。';
    }
    /*
     * Persist the config exactly as it was sent, NOT zod's parsed output.
     * configurationSchema declares `binding: binding.default('manual')`, so parsing a payload that
     * omits `binding` would write an explicit 'manual' into every field. That destroys the signal
     * applyDefaultBindings relies on (`binding === undefined` means "saved before bindings existed,
     * fill in the defaults") and permanently stops the prompt / reference image / latent fields
     * from picking up canvas values — the same silent loss as the generation-side bug, just via a
     * different door. Validation still runs on the parsed value, so bad payloads are still refused.
     */
    const data = (rebuild ? { fields: rebuild.fields } : (body as { config: unknown }).config) as Prisma.InputJsonValue;
    if (version === -1) {
      try {
        const draft = await db.workflowDraft.create({ data: {
          userId: user.id, workflowId, config: data, name,
          /* 本地 ID（`local-` 前缀）在这里第一次落到 `provider` 列：以后「跑在哪」就由它说话。 */
          provider: askedProvider,
          ...(nextGraph ? { graph: nextGraph as Prisma.InputJsonValue } : {}),
          kind: effectiveKind,
          category: readWorkflowCategory(category ?? DEFAULT_WORKFLOW_CATEGORY, effectiveKind),
          operation: readWorkflowOperation(operation ?? DEFAULT_WORKFLOW_OPERATION),
        } });
        return Response.json({
          version: draft.version,
          kind: readGeneratorKind(draft.kind),
          category: readWorkflowCategory(draft.category, readGeneratorKind(draft.kind)),
          operation: readWorkflowOperation(draft.operation),
          name: readWorkflowName(draft.name),
          /* 换图时字段列表被服务端重算过，客户端表单必须换成新的那一套，否则它保存的还是老编号。 */
          ...(rebuild ? { fields: rebuild.fields } : {}),
          fieldNotice,
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
          throw new ApiError(409, '配置已在其他页面保存，请重新加载后再修改。');
        throw error;
      }
    }
    /*
     * 改用途是有后果的动作（会让画布上某类节点的下拉里少一个选项），所以只在**显式传了**才动。
     * 换工作流、重存配置都不该顺手把用途改掉。名字同理，但**空串也算显式传了**（那是「清掉名字」）。
     */
    const result = await db.workflowDraft.updateMany({
      where: { userId: user.id, workflowId, version },
      data: {
        config: data, version: { increment: 1 },
        ...(kind ? { kind } : {}),
        /* `nextCategory` 见上面那段：改用途时会顺手把对不上的旧分类退回默认，没改就不动它。 */
        ...(nextCategory ? { category: nextCategory } : {}),
        ...(operation ? { operation } : {}),
        ...(nameInput !== undefined ? { name } : {}),
        ...(nextGraph ? { graph: nextGraph as Prisma.InputJsonValue } : {}),
      },
    });
    if (!result.count) throw new ApiError(409, '配置已在其他页面修改，请重新加载后再保存。');
    const saved = await db.workflowDraft.findUnique({ where: { userId_workflowId: { userId: user.id, workflowId } }, select: { kind: true, category: true, operation: true, name: true } });
    const savedKind = readGeneratorKind(saved?.kind);
    return Response.json({
      version: version + 1,
      kind: savedKind,
      category: readWorkflowCategory(saved?.category, savedKind),
      operation: readWorkflowOperation(saved?.operation),
      name: readWorkflowName(saved?.name),
      ...(rebuild ? { fields: rebuild.fields } : {}),
      fieldNotice,
    });
  });
}
