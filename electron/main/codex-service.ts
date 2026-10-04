/**
 * 应用内的 Codex（走官方 `codex app-server` 的 stdio JSON-RPC）。
 *
 * 为什么是这个形态，而不是再写一个「调模型的面板」：
 *   - 用户要的是**能操作画布**的对话。画布的操作能力已经有一整套 MCP 工具
 *     （`tools/frame-mcp`，14 个），Codex 官方客户端天生就是 MCP client ——
 *     让它连上 frame-mcp，画布能力不用重写一行。
 *   - 进程必须**握在主进程手里**：它是长命子进程，挂在渲染层会随页面刷新被丢掉，
 *     挂在后端 utilityProcess 下面会在后端重启时变孤儿（这和 ComfyUI 启动器是同一个道理）。
 *   - 渲染层**只跟主进程说话**（IPC），不直接碰 stdio：stdio 是协议通道，
 *     多一个写它就是多一处把整条流搞坏的机会。
 *
 * 协议事实（本机 codex-cli 0.155.0-alpha，schema 由
 * `codex app-server generate-json-schema` 导出，落在 FRAME\_codex-schema）：
 *   - 握手：`initialize` → 回包之后发一条**通知** `{method:'initialized'}`
 *     （不是请求，没有 id；少了这一条后面所有调用都会超时）。
 *   - 会话：`thread/start` 拿 threadId → `turn/start {threadId, input:[{type:'text',text}]}`。
 *   - 流式输出走**通知**：`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、
 *     `item/started` / `item/completed`（工具调用在这里）、`turn/completed`、`error`。
 *   - 服务端反过来请求我们（审批 / 申请输入）：MCP 工具调用那条**一律放行**
 *     （frame-mcp 是自家服务器，用户开这个面板就是为了让它改画布），其余一律拒绝。
 *   - ⚠️ 审批请求的 `id` 实测是 **0**：判断「这条是不是请求」只能写 `raw.id != null`，
 *     写成 `if (raw.id)` 会把 id=0 的审批当成通知漏掉，工具调用就永远悬在那儿。
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, shell } from 'electron';

export type CodexPhase = 'off' | 'starting' | 'ready' | 'error';

/** frame-mcp 这类 MCP 服务器的就绪情况，直接给界面显示。 */
export type CodexMcpServer = {
  name: string;
  tools: number;
  status: string;
  error: string | null;
};

/**
 * 一次调用挂着的技能（SKILL 社区里选的那个）。
 *
 * 只带**路径**不带正文：技能正文动辄几万字符，还带着一整个 references 目录 ——
 * 全塞进 prompt 会把上下文烧掉一半，而且技能内部本来就写着「哪些参考按需读」，
 * 只有 Codex 自己知道这一轮该翻哪几份。给路径让它自己读，是唯一划算的做法。
 *
 * ⚠️ `dir` 必须是**数据目录里的真实路径**（`<dataDir>/skills/...`）：
 * Codex 是我们 spawn 出去的另一个进程，asar 里的路径它读不到。
 */
export type CodexSkill = {
  id: string;
  title: string;
  dir: string;
  files: string[];
};

export type CodexStatus = {
  phase: CodexPhase;
  /** 界面直接显示的一句话。出错时这里就是诊断线索，别写「发生错误」。 */
  message: string;
  version: string | null;
  account: { type: string; email: string | null; planType: string | null } | null;
  /** codex 说「必须 OpenAI 登录」而账号又是空的 → 界面给登录入口。 */
  requiresAuth: boolean;
  /** **当前这条会话实际在用的**模型。真值来自 `thread/settings/updated`，不是我们猜的。 */
  model: string | null;
  /** 这个账号能选的模型（`model/list` 那一份，已滤掉 hidden）。界面用它画下拉。 */
  models: CodexModel[];
  mcp: CodexMcpServer[];
  busy: boolean;
  threadId: string | null;
  codexPath: string | null;
};

/**
 * 一个可选的模型（2026-10-05 徐先：「可以切换 codex 使用的模型」）。
 *
 * `id` 是**发给 codex 的取用名**（`thread/settings/update` 的 `model` 收的就是它），
 * `label` 是给人看的（`displayName`），`hint` 是它的自述（`description`），当 tooltip。
 * 三个字段都从 `model/list` 原样搬 —— 我们不维护一份自己的模型表：
 * 那个表一变（claude 之类接进来、老的退役），写死的名单就成了「选不了 / 选了个不存在的」。
 */
export type CodexModel = { id: string; label: string; hint: string };

/**
 * 推给渲染层的事件。**只传界面画得出来的东西**：
 * 原始 item 里有几十个字段，全量过 IPC 既慢又会把协议细节漏进 UI 层。
 */
export type CodexEvent =
  | { kind: 'status'; status: CodexStatus }
  /** 助手消息的一段增量，按 itemId 累加。 */
  | { kind: 'message'; itemId: string; text: string }
  | { kind: 'reasoning'; itemId: string; text: string }
  /** 一个条目的开始 / 结束 —— 工具调用主要靠它。 */
  | { kind: 'item'; phase: 'started' | 'completed'; item: CodexItemView }
  | { kind: 'turn'; state: 'started' | 'completed' | 'failed'; error: string | null }
  /** 画布被 frame 工具改过了 —— 渲染层据此把画布拉成最新。 */
  | { kind: 'canvas' }
  | { kind: 'error'; message: string };

export type CodexItemView = {
  id: string;
  type: string;
  /** 仅 mcpToolCall：哪个服务器、哪个工具。 */
  server?: string;
  tool?: string;
  status?: string;
  /** 参数与结果都截断 —— 一次工具调用可能回一大坨画布 JSON。 */
  arguments?: string;
  result?: string;
  error?: string | null;
};

const REQUEST_TIMEOUT_MS = 30_000;
/**
 * 审批策略。**不能**写 `'never'`。
 *
 * 在这个版本里 `'never'` 的语义是「一律拒绝授权」，不是「自动批准」：
 * MCP 工具调用会在最前面就被判死，模型拿到的是
 * `MCP tool call requires approval, but approval policy is never`。
 * （`approvalsReviewer:'auto_review'` 也救不了 —— 它只决定「谁来判」，管不了「不让判」。）
 *
 * 真正走得通的是 granular + `mcp_elicitations: true`：这样 Codex 会把
 * 「让不让 frame 跑这个工具」作为一个**请求**发给我们（`mcpServer/elicitation/request`），
 * 我们在 `onMessage` 里回一个 accept，工具就真的跑了。
 *
 * 其余开关保持关闭：命令规则 / 沙箱逃逸 / 权限申请 / 技能审批这几样画布操作都用不到，
 * 开着只会多出几条没人答的请求，把回合卡住。
 */
const APPROVAL_POLICY = {
  granular: {
    rules: false,
    sandbox_approval: false,
    /** ★ 只有开着它，MCP 工具调用的审批才会发出来 —— 我们才有机会放行。 */
    mcp_elicitations: true,
    request_permissions: false,
    skill_approval: false,
  },
};
/** 工具调用结果最多带这么长给界面看。 */
const RESULT_LIMIT = 1200;

/**
 * 关掉会向客户端要审批 / 要输入的特性。
 *
 * 理由：这一版不做审批 UI。与其让 Codex 弹一个没人答的请求把回合卡死，
 * 不如在启动参数里把这些能力摘掉（画布操作根本用不到它们）。
 * ⚠️ **不要**关 `orchestrator.mcp` —— 我们恰恰要靠它连 frame-mcp。
 */
function configOverrides(nodePath: string | null, mcpEntry: string | null): string[] {
  const off = [
    'features.shell_tool=false',
    'features.multi_agent=false',
    'features.multi_agent_v2=false',
    'features.apps=false',
    'features.code_mode=false',
    'features.goals=false',
    'features.sleep_tool=false',
    'agents.enabled=false',
    'orchestrator.skills.enabled=false',
    'skills.include_instructions=false',
    'tools.experimental_request_user_input.enabled=false',
    'tools.view_image=false',
    'project_doc_max_bytes=0',
    'web_search="disabled"',
  ];
  const args = off.flatMap(item => ['-c', item]);
  /*
   * frame-mcp 用启动参数覆盖，而**不改用户的 ~/.codex/config.toml**。
   * 改全局配置是越界的：用户在别处（Codex 自己的 CLI、别的编辑器）也在用它，
   * 我们写进去的绝对路径一旦失效，坏的是他所有的 Codex。
   */
  if (nodePath && mcpEntry) {
    args.push(
      '-c', 'mcp_servers.frame.type="stdio"',
      '-c', `mcp_servers.frame.command=${JSON.stringify(nodePath)}`,
      '-c', `mcp_servers.frame.args=[${JSON.stringify(mcpEntry)}]`,
      '-c', 'mcp_servers.frame.startup_timeout_sec=60',
      /* 真跑生成要用户显式允许，默认关着 —— 它会花钱、也占着显卡。 */
      '-c', 'mcp_servers.frame.env.HOLYLIGHT_MCP_ALLOW_GENERATE="0"',
    );
  }
  return args;
}

/** 找一个能跑 frame-mcp 的 node。**不能**用 `process.execPath`（打包后那是 Holy Light画布.exe）。 */
function findNode(): string | null {
  const candidates = [
    /*
     * 只要 node.exe。⚠️ `configCommandCandidates()` 是给 findCodex 写的，
     * 它把 codex.exe 也算进来，而且 `CODEX_CLI_PATH` 是 unshift 在最前面的 ——
     * 不过滤的话这里挑到的就是 codex.exe，于是变成「拿 codex.exe 去跑 frame-mcp.js」，
     * 进程静默失败，模型只会说「当前环境没有这个工具」。
     */
    ...configCommandCandidates().filter(item => /node\.exe$/i.test(item)),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', 'node.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'fnm_multishells', 'node.exe') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* 继续找下一个 */ }
  }
  const found = scanPath('node.exe');
  return found;
}

/** 从用户已有的 codex 配置里把「上次装 frame-mcp 时用的 node」读出来。 */
function configCommandCandidates(): string[] {
  try {
    const file = path.join(os.homedir(), '.codex', 'config.toml');
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const out: string[] = [];
    const command = /^\s*command\s*=\s*['"]([^'"]+)['"]/gm;
    let match = command.exec(text);
    while (match) { out.push(match[1]); match = command.exec(text); }
    const cli = /CODEX_CLI_PATH\s*=\s*['"]([^'"]+)['"]/.exec(text);
    if (cli) out.unshift(cli[1]);
    return out.filter(item => /node\.exe$/i.test(item) || /codex\.exe$/i.test(item));
  } catch {
    return [];
  }
}

function scanPath(name: string): string | null {
  const raw = process.env.PATH || process.env.Path || '';
  for (const dir of raw.split(path.delimiter).filter(Boolean)) {
    const target = path.join(dir, name);
    try { if (fs.existsSync(target)) return target; } catch { /* 忽略不可读的目录 */ }
  }
  return null;
}

/**
 * 找 codex 可执行文件。顺序按「本机实测最可能命中的」排：
 * 官方桌面版把它放在 `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`（版本目录会变，
 * 所以扫目录而不是写死），配置里的 `CODEX_CLI_PATH` 次之（那是 Codex 自己写下的）。
 */
function findCodex(): string | null {
  const fromConfig = configCommandCandidates().filter(item => /codex\.exe$/i.test(item));
  for (const item of fromConfig) {
    try { if (fs.existsSync(item)) return item; } catch { /* 继续 */ }
  }
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const binDir = path.join(local, 'OpenAI', 'Codex', 'bin');
    try {
      const versions = fs.readdirSync(binDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(binDir, entry.name, 'codex.exe'))
        .filter(file => fs.existsSync(file))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (versions.length) return versions[0];
    } catch { /* 目录不存在则往下走 */ }
  }
  return scanPath('codex.exe');
}

/** frame-mcp 的入口。装过安装包就落在 LOCALAPPDATA，开发时直接用仓库里那份。 */
function findFrameMcp(): string | null {
  const local = process.env.LOCALAPPDATA;
  const candidates = [
    local ? path.join(local, 'frame-mcp', 'frame-mcp.js') : '',
    path.join(process.cwd(), 'tools', 'frame-mcp', 'dist', 'frame-mcp.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* 继续 */ }
  }
  return null;
}

/**
 * 子进程环境只留必要的那几个。
 * 全量继承会把 Electron 的一堆变量（包括 `ELECTRON_RUN_AS_NODE`）带进去，
 * 那玩意儿足以让被它拉起的 node 表现异常。
 */
function spawnEnv(): NodeJS.ProcessEnv {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOME|HOMEDRIVE|HOMEPATH|COMSPEC|LANG|LC_ALL|HTTPS?_PROXY|NO_PROXY)$/i;
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (keep.test(key) && typeof value === 'string') out[key] = value;
  }
  return out;
}

function trim(value: unknown): string {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}…` : text;
}

export function createCodexService() {
  let child: ChildProcessWithoutNullStreams | null = null;
  let buffer = '';
  let nextId = 1;
  /** 会话代次：每次重启 +1，用来把「上一次的待答请求」作废掉。 */
  let generation = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  /*
   * 各 MCP 服务器的**启动**状态，来自 `mcpServer/startupStatus/updated`。
   * 为什么要单独记一份：`mcpServerStatus/list` 里的 `runtimeStatus` 实测是 null
   * （schema 说它是枚举，但线程刚起来、还没真正连过 MCP 时它就是 null）；
   * 光靠它，界面上的状态永远是「未启动」。
   */
  const mcpStartup = new Map<string, string>();
  let threadId: string | null = null;
  let turnId: string | null = null;
  let busy = false;
  /**
   * 徐先在这一栏里选的模型（换会话、断开重连都留着）。
   *
   * 为什么要在主进程记一份，而不是每次问渲染层：线程的生命周期在这里 ——
   * 「新会话」「断线重连」都会重新 `thread/start`，那一次必须把用户选的那个带上，
   * 否则他切过的模型会**悄悄回到默认**（界面上的下拉还显示着他选的那个，更难看）。
   */
  let preferredModel = '';
  /** 当前回合里 frame 工具被调用过几次 —— 用来决定要不要通知画布刷新。 */
  let frameCalls = 0;
  let status: CodexStatus = {
    phase: 'off', message: '还没连接 Codex。', version: null, account: null,
    requiresAuth: false, model: null, models: [], mcp: [], busy: false, threadId: null, codexPath: null,
  };

  const listeners = new Set<(event: CodexEvent) => void>();

  function publish(event: CodexEvent) {
    for (const listener of listeners) {
      try { listener(event); } catch { /* 一个订阅者出错不该连累其它人 */ }
    }
  }

  function publishStatus() {
    publish({ kind: 'status', status: { ...status } });
  }

  function patch(next: Partial<CodexStatus>) {
    status = { ...status, ...next };
    publishStatus();
  }

  function write(message: Record<string, unknown>) {
    if (!child || !child.stdin.writable) throw new Error('Codex 进程不在。');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Codex 响应超时。'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error('写不进 Codex。'));
      }
    });
  }

  function toItemView(raw: Record<string, unknown>): CodexItemView {
    const item: CodexItemView = { id: String(raw.id ?? ''), type: String(raw.type ?? '') };
    if (item.type === 'mcpToolCall') {
      item.server = typeof raw.server === 'string' ? raw.server : undefined;
      item.tool = typeof raw.tool === 'string' ? raw.tool : undefined;
      item.status = typeof raw.status === 'string' ? raw.status : undefined;
      item.arguments = trim(raw.arguments);
      item.result = raw.result == null ? undefined : trim(raw.result);
      item.error = raw.error == null ? null : trim(raw.error);
    }
    return item;
  }

  function onMessage(raw: Record<string, unknown>) {
    const method = typeof raw.method === 'string' ? raw.method : '';
    const params = (raw.params ?? {}) as Record<string, unknown>;

    if (method && raw.id != null) {
      /*
       * 服务端发来的请求。⚠️ id 可能是 0 —— 只能用 `!= null` 判，写真值会漏。
       */
      if (method === 'mcpServer/elicitation/request') {
        /*
         * 「让不让 frame 这个 MCP 服务器跑这个工具？」—— 放行。
         *
         * 无条件放行的理由：
         *   - frame-mcp 是我们自己装、自己管的服务器，只会操作本应用的画布；
         *   - 用户点开这个面板的目的就是让它改画布 —— 每调一次都问一次，等于每次都要点确认；
         *   - 真正花钱又占显卡的那一档（frame_run_generation）在启动参数里就是关着的
         *     （`HOLYLIGHT_MCP_ALLOW_GENERATE=0`），根本走不到这里。
         * 而且这次调用本身会作为一个「工具调用」条目显示在对话里，用户看得见它干了什么。
         */
        write({ id: raw.id, result: { action: 'accept', content: {} } });
        return;
      }
      /*
       * 其它一律拒绝：这一版不做审批 UI，启动参数也已经把会触发它们的特性关了。
       * 真收到了说明还有没关干净的，宁可让它失败，也不要把回合卡在等一个不存在的答案上。
       */
      write({ id: raw.id, error: { code: -32601, message: 'Holy Light画布不处理这个请求。' } });
      return;
    }

    if (method) {
      switch (method) {
        case 'item/agentMessage/delta': {
          const itemId = String(params.itemId ?? params.id ?? '');
          const delta = typeof params.delta === 'string' ? params.delta : '';
          if (itemId && delta) publish({ kind: 'message', itemId, text: delta });
          break;
        }
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta': {
          const itemId = String(params.itemId ?? params.id ?? '');
          const delta = typeof params.delta === 'string' ? params.delta : '';
          if (itemId && delta) publish({ kind: 'reasoning', itemId, text: delta });
          break;
        }
        case 'item/started':
        case 'item/completed': {
          const rawItem = (params.item ?? {}) as Record<string, unknown>;
          const view = toItemView(rawItem);
          publish({ kind: 'item', phase: method === 'item/started' ? 'started' : 'completed', item: view });
          /* 只有真正改画布的那几个工具才算「画布变了」—— 读类型的工具不需要刷新。 */
          if (view.type === 'mcpToolCall' && view.server === 'frame'
            && method === 'item/completed' && !/_(get|list|describe|status)/.test(view.tool ?? '')) {
            frameCalls += 1;
            publish({ kind: 'canvas' });
          }
          break;
        }
        case 'mcpServer/startupStatus/updated': {
          const name = typeof params.name === 'string' ? params.name : '';
          const state = typeof params.status === 'string' ? params.status : '';
          if (name && state) {
            mcpStartup.set(name, state);
            void refreshMcp();
          }
          break;
        }
        case 'turn/started':
          busy = true;
          turnId = String((params.turn as Record<string, unknown> | undefined)?.id ?? turnId ?? '');
          patch({ busy: true });
          publish({ kind: 'turn', state: 'started', error: null });
          break;
        case 'turn/completed': {
          busy = false;
          const turn = (params.turn ?? {}) as Record<string, unknown>;
          const failed = typeof turn.error === 'object' && turn.error !== null;
          patch({ busy: false });
          publish({ kind: 'turn', state: failed ? 'failed' : 'completed', error: failed ? trim(turn.error) : null });
          if (frameCalls > 0) { frameCalls = 0; publish({ kind: 'canvas' }); }
          break;
        }
        case 'error':
          publish({ kind: 'error', message: trim(params.message ?? params.error ?? 'Codex 报错了。') });
          break;
        case 'account/login/completed':
          void refreshAccount();
          break;
        /*
         * 会话设置变了（2026-10-05，切模型走这条）。
         *
         * ⚠️ **别把这条当唯一真值**：实测它不总是及时到（`setModel` 里另有一手 `thread/read`
         * 兜底）。但它是**最权威**的一条 —— codex 自己说「现在的设置是这个」，
         * 比我们乐观写进去的值可信。
         */
        case 'thread/settings/updated': {
          const id = String(params.threadId ?? '');
          const settings = (params.threadSettings ?? {}) as Record<string, unknown>;
          const next = String(settings.model ?? '').trim();
          /*
           * 只认**当前这条会话**：换会话时旧线程的设置通知会晚到一步，
           * 照着它改会把下拉写成上一条会话的模型 —— 而用户此刻看到的是新会话。
           */
          if (id && id === threadId && next) patch({ model: next });
          break;
        }
        default:
          break;
      }
      return;
    }

    /* 有 id 没 method = 响应。 */
    const id = typeof raw.id === 'number' ? raw.id : NaN;
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    if (raw.error) entry.reject(new Error(trim((raw.error as Record<string, unknown>).message ?? 'Codex 拒绝了这次调用。')));
    else entry.resolve((raw.result ?? {}) as Record<string, unknown>);
  }

  function failAll(message: string) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  }

  async function refreshAccount() {
    try {
      const account = await request('account/read', {}) as { account?: Record<string, unknown> | null; requiresOpenaiAuth?: boolean };
      const raw = account.account ?? null;
      patch({
        account: raw
          ? {
            type: String(raw.type ?? ''),
            email: typeof raw.email === 'string' ? raw.email : null,
            planType: typeof raw.planType === 'string' ? raw.planType : null,
          }
          : null,
        requiresAuth: Boolean(account.requiresOpenaiAuth) && !raw,
      });
    } catch {
      /* 读不到账号不该把整个连接判死 —— 模型没配好时这一条常常就是失败的。 */
    }
  }

  /**
   * 界面上要显示的状态。
   *
   * 三个来源，按可信度排序：启动状态（codex 自己广播的）> 运行时状态（常为 null）> 猜。
   * 「猜」这一档是必要的：有工具就说明它其实连上了，不能显示成「未启动」。
   */
  function displayStatus(startup: string | undefined, runtime: unknown, tools: number): string {
    if (startup === 'ready') return 'connected';
    if (startup === 'failed') return 'failed';
    if (startup === 'starting') return 'starting';
    if (typeof runtime === 'string' && runtime) return runtime;
    return tools > 0 ? 'connected' : 'notStarted';
  }

  /** 拉一次 MCP 列表。返回 frame 是不是已经有工具了（== 真的能操作画布）。 */
  async function refreshMcp(): Promise<boolean> {
    try {
      const result = await request('mcpServerStatus/list', {}) as { data?: Record<string, unknown>[] };
      const list = Array.isArray(result.data) ? result.data : [];
      patch({
        mcp: list.map(item => {
          const name = String(item.name ?? '');
          const tools = item.tools && typeof item.tools === 'object' ? Object.keys(item.tools as object).length : 0;
          return {
            name,
            tools,
            status: displayStatus(mcpStartup.get(name), item.runtimeStatus, tools),
            error: typeof item.toolsError === 'string' ? item.toolsError : null,
          };
        }),
      });
      const frame = list.find(item => String(item.name ?? '') === 'frame');
      return Boolean(frame && frame.tools && Object.keys(frame.tools as object).length > 0);
    } catch {
      /* 同上：连不上 MCP 列表时保持上一次的结果，让界面照旧显示。 */
      return false;
    }
  }

  /**
   * 等 frame-mcp 就绪再收工。
   *
   * 为什么必须等：codex 起来的时候 frame-mcp 还只是 `starting`，这时候查列表
   * 拿到的 tools 是空的 —— 界面上「画布工具 0 个」，用户会以为没挂上。
   * 实测 frame-mcp 一秒内就 ready，这里给它 20 秒，超时就认命（界面照旧显示，不至于卡住连接）。
   */
  async function waitForFrameMcp(mine: number) {
    for (let i = 0; i < 20; i++) {
      if (mine !== generation) return;
      const ready = await refreshMcp();
      if (ready) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * 开一条会话的参数（新会话与首次连接共用）。
   *
   * `model` **只在用户明确选过的时候才带** —— 不带就是 codex 自己的默认，
   * 那才是「我什么都没选」该有的样子；随便填一个默认名等于把他按在某个特定模型上，
   * 而那个名字哪天退役了就变成「连上了但什么都跑不了」。
   */
  function threadStartParams() {
    return {
      cwd: os.homedir(),
      approvalPolicy: APPROVAL_POLICY,
      ...(preferredModel ? { model: preferredModel } : {}),
    };
  }

  async function start() {
    if (status.phase === 'starting' || status.phase === 'ready') return status;
    const codexPath = findCodex();
    if (!codexPath) {
      patch({ phase: 'error', message: '没找到 codex。先装 Codex CLI（或在设置里告诉我它在哪）再点连接。' });
      return status;
    }
    patch({ phase: 'starting', message: '正在启动 Codex…', codexPath });

    const nodePath = findNode();
    const mcpEntry = findFrameMcp();
    const mine = ++generation;
    try {
      const childProcess = spawn(codexPath, ['app-server', '--listen', 'stdio://', ...configOverrides(nodePath, mcpEntry)], {
        cwd: os.homedir(),
        env: spawnEnv(),
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child = childProcess;
      buffer = '';
      child.stderr.resume();
      child.stdin.on('error', () => { if (child === childProcess) stop('写 Codex 失败。'); });
      child.once('error', () => { if (child === childProcess) stop('Codex 启动失败。'); });
      child.once('exit', () => { if (child === childProcess) stop('Codex 已经退出了。'); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (child !== childProcess) return;
        buffer += chunk;
        let cut = buffer.indexOf('\n');
        while (cut >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          cut = buffer.indexOf('\n');
          if (!line.trim()) continue;
          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          try { onMessage(parsed); } catch { /* 一条消息解析错不该连累整条流 */ }
        }
      });

      await request('initialize', {
        clientInfo: { name: 'frame-canvas', title: 'Holy Light画布', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      /* 握手最后一步是**通知**，不是请求：少了它，后面的 turn/start 会一直挂着。 */
      write({ method: 'initialized', params: {} });

      const thread = await request('thread/start', threadStartParams()) as { thread?: Record<string, unknown> };
      threadId = String(thread.thread?.id ?? '') || null;

      /*
       * 能选哪些模型（2026-10-05）。`model/list` 返回的每一条都带 `displayName` 与
       * `description`，直接搬给界面当选项与 tooltip。
       *
       * `hidden: true` 的那几档是 codex 自己藏起来不给选的（内部 / 实验），滤掉 ——
       * 列出来只会让人踩坑。当前用哪个**不猜**：等 `thread/settings/updated` 那条通知来写。
       */
      const models = await request('model/list', {}) as { data?: Record<string, unknown>[] };
      const catalog: CodexModel[] = (Array.isArray(models.data) ? models.data : [])
        .filter(item => item?.hidden !== true)
        .map(item => ({
          id: String(item.id ?? item.model ?? '').trim(),
          label: String(item.displayName ?? item.model ?? item.id ?? '').trim(),
          hint: String(item.description ?? '').trim(),
        }))
        .filter(item => item.id);
      const current = catalog.find(item => item.id === preferredModel)
        ?? catalog.find(item => item.id === status.model)
        ?? catalog[0];
      patch({
        phase: 'ready',
        /*
         * 缺 node 或缺 frame-mcp 的时候，会连上一个「一切正常、只是没有画布工具」的 Codex：
         * 界面不报错，模型只会说「当前环境未提供 frame_* 工具」，极难查。
         * 所以这里把实话写进状态条。
         */
        message: nodePath && mcpEntry
          ? '已连接 Codex。'
          : '已连接 Codex，但没挂上画布工具（找不到可用的 node 或 frame-mcp）。',
        /*
         * 先用目录里那个默认垫上（列表为空时保持原来的 null）：真正的值会由
         * `thread/settings/updated` 覆盖 —— 那时才算数。
         */
        model: status.model || current?.id || null,
        models: catalog,
        threadId,
      });
      void refreshAccount();
      void waitForFrameMcp(mine);
      if (mine === generation) return status;
    } catch (error) {
      if (mine === generation) {
        stop(error instanceof Error ? error.message : 'Codex 连接失败。');
      }
    }
    return status;
  }

  function stop(message?: string) {
    generation += 1;
    const target = child;
    child = null;
    threadId = null;
    turnId = null;
    busy = false;
    failAll(message ?? 'Codex 连接已断开。');
    if (target && Number.isInteger(target.pid) && (target.pid ?? 0) > 0 && process.platform === 'win32') {
      /*
       * Windows 上必须 taskkill /T：codex 会拉起自己的子进程，
       * 只 kill 父进程会把它们留在管道上，端口和句柄都收不干净。
       */
      execFile('taskkill.exe', ['/PID', String(target.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else if (target) {
      target.kill();
    }
    patch({ phase: 'off', message: message ?? 'Codex 已断开。', busy: false, threadId: null });
  }

  /**
   * 选了技能时拼进这次输入的那一段。
   *
   * 没选就返回空串 —— 「没选技能」这件事不该在 prompt 里占一行，
   * 说了反而让模型去找一个不存在的技能。
   */
  function skillBlock(skill: CodexSkill | null | undefined): string {
    if (!skill?.dir) return '';
    const list = (skill.files ?? []).slice(0, 24).join('、');
    return [
      `[Holy Light画布技能] 本次任务要用「${skill.title}」这个技能。`,
      `技能目录：${skill.dir}`,
      `先完整读取 ${skill.dir}/SKILL.md —— 那是它的正文，读完再动手。`,
      '正文里点名要读的参考文件（references/…）按它的指引读全；没点名的不要顺手全读。',
      '严格按这个技能的流程、结构与用语交付：它要求的字段一个都不能少，它列的禁止项一律不写。',
      list ? `这个技能目录里现有的文件：${list}` : '',
      '下面是用户这次的具体要求（照上面的技能做，不要把技能内容复述一遍）：',
      '',
    ].filter(Boolean).join('\n');
  }

  /**
   * 发一句话。
   *
   * 上下文（当前项目 id）**拼进这次输入**，而不是改系统提示词：
   * 项目 id 每次进画布都不一样，而 thread 是长期复用的 —— 塞进 system 里，
   * 换一个项目再说话时模型拿到的还是上一个项目的 id。
   */
  async function send(text: string, context: { projectId: string; projectName: string; skill?: CodexSkill | null }) {
    if (status.phase !== 'ready') await start();
    if (status.phase !== 'ready') throw new Error(status.message);
    if (!threadId) throw new Error('会话还没建好，再等一下。');
    const prompt = [
      `[Holy Light画布画布上下文] 当前项目 id = ${context.projectId}，项目名 = ${context.projectName}。`,
      '请用 frame_* 工具操作这个项目的画布；先看现状用 frame_describe_canvas。',
      '改动尽量小：只动用户要求的地方，不要重排其它节点。',
      skillBlock(context.skill),
      text,
    ].join('\n');
    busy = true;
    patch({ busy: true });
    try {
      const result = await request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd: os.homedir(),
        approvalPolicy: APPROVAL_POLICY,
      }) as { turn?: Record<string, unknown> };
      turnId = String(result.turn?.id ?? '') || null;
    } catch (error) {
      busy = false;
      patch({ busy: false });
      throw error;
    }
  }

  async function interrupt() {
    if (!threadId || !turnId) return;
    try {
      await request('turn/interrupt', { threadId, turnId });
    } catch { /* 中断失败也要把界面上的 busy 解掉 */ }
    busy = false;
    patch({ busy: false });
  }

  /** 重新开一个会话（换项目、或者上一轮说歪了想从头来）。 */
  async function newThread() {
    if (status.phase !== 'ready') await start();
    const thread = await request('thread/start', threadStartParams()) as { thread?: Record<string, unknown> };
    threadId = String(thread.thread?.id ?? '') || null;
    patch({ threadId });
    return threadId;
  }

  /**
   * 换一个模型（2026-10-05 徐先：「可以切换 codex 使用的模型」）。
   *
   * 走 `thread/settings/update`：它的语义是「**这条会话接下来的回合**用这个」——
   * 聊天记录留着，只是后面的话换个模型答。这比「为了换模型重开一条会话」对得多：
   * 用户常常是聊到一半发现这件事该交给更强的那个模型。
   *
   * 还没连上（或还没有会话）时**只记下来**：下次 `thread/start` 会带上它。
   * 也就是说在没连上的时候选，选了也不会白选。
   */
  async function setModel(modelId: string) {
    const id = String(modelId || '').trim();
    if (!id) throw new Error('没给要换的模型。');
    const before = status.model;
    preferredModel = id;
    if (status.phase !== 'ready' || !threadId) {
      patch({ model: id });
      return id;
    }
    /*
     * 先乐观写一次（下拉立刻跟手），失败再退回去。
     *
     * 🔴 **切换成不成，只认 `thread/read` 读回来的那个 `model`**（2026-10-05 实测）：
     *   - `thread/settings/update` 的返回**永远是空对象 `{}`**，而且它**不校验** ——
     *     拿一个根本不存在的模型名去试，它照收不误（会话上就记着那个名字）；
     *   - `thread/settings/updated` 那条通知**实测没有及时到**（第一刀等了 6 秒一条都没有，
     *     换一个不存在的名字那刀才来了一条）。
     * 所以「更新成功」这个信号谁都给不了，能给的只有读回来对一次。
     */
    patch({ model: id });
    try {
      await request('thread/settings/update', { threadId, model: id });
    } catch (error) {
      patch({ model: before });
      preferredModel = before || '';
      throw error;
    }
    try {
      const read = await request('thread/read', { threadId }) as { thread?: Record<string, unknown> };
      const confirmed = String((read.thread ?? {}).model ?? '').trim();
      if (confirmed) patch({ model: confirmed });
    } catch {
      /* 读不回来就用上面那个乐观值 —— 更新本身已经发出去了，没必要因此报错。 */
    }
    return id;
  }

  /** 登录：拿 OAuth 地址交给系统浏览器，Codex 那边完成后会推 `account/login/completed`。 */
  async function login() {
    if (status.phase !== 'ready') await start();
    const result = await request('account/login/start', { type: 'chatgpt' }) as { authUrl?: string };
    const url = typeof result.authUrl === 'string' ? result.authUrl : '';
    if (!url) throw new Error('Codex 没给登录地址。');
    await shell.openExternal(url);
    return true;
  }

  return {
    status: () => ({ ...status }),
    start,
    stop,
    send,
    interrupt,
    newThread,
    login,
    setModel,
    /** 订阅事件，返回取消函数。 */
    onEvent(listener: (event: CodexEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** 把事件推到所有窗口。渲染层只认 IPC，不碰子进程。 */
    attach() {
      return this.onEvent(event => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('codex:event', event);
        }
      });
    },
    dispose() {
      stop('应用正在退出。');
      listeners.clear();
    },
  };
}

export type CodexService = ReturnType<typeof createCodexService>;
