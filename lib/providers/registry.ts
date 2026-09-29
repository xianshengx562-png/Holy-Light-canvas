/**
 * 「有哪些服务商」的唯一事实来源。
 *
 * 之前每加一家就多一处硬编码：`.env` 里一个变量、`lib/providers/<家>/config.ts` 一个取值函数、
 * 设置页一个卡片。三家之后再加第四家，光记「要去几个地方改」就够呛，所以这里一张表定死。
 *
 * 有意把「老套餐」也列进来 —— RunningHub 有自己的历史表（一张 userId 唯一），
 * 不是新池子。`storage` 字段说明白这一点，免得有人以为新池子里没有它们就是漏了。
 *
 * ## 2026-09-21：加了 `kind`，表从「三家上游」扩到「模型服务」
 *
 * 原来这张表里**只有会出图出片的服务商**。提示词优化要接文本模型之后，问题就变成：
 * 「哪些是出图的、哪些只是聊天的」得有个地方说清楚，否则密钥中心会把豆包 / DeepSeek
 * 和视频网关混在一起列，而它们根本不是一类东西（前者不产生媒体、也不参与引擎选择）。
 *
 * 所以每个条目带一个 `kind`：
 * - `media`：能出图 / 出片，会出现在节点的引擎选择里；
 * - `text`：只做文本（提示词优化），密钥照样进池子、照样加密，但不参与引擎选择。
 *
 * 另外 `runninghub-ai`（海外站）是**第二个 RunningHub 站** —— 与国内站是独立账号、
 * 独立 Key，界面上必须分成两段，混成一段的话用户填了海外 Key 却打国内站，报的错
 * 会是「工作流不存在」这种完全指不到根因的话。见 `lib/providers/runninghub/connection.ts`。
 */
export type ProviderId =
  | 'runninghub'
  | 'runninghub-ai'
  | 'videoapi'
  /** 以下六家只做文本（提示词优化），不产生图片 / 视频。 */
  | 'doubao'
  | 'deepseek'
  | 'glm'
  | 'kimi'
  | 'minimax'
  | 'openai';

/** 出图出片的服务商 vs 只做文本的服务商。区别的意义见文件头。 */
export type ProviderKind = 'media' | 'text';

export type KeyStorage =
  /** 新池子：`ProviderKey` 表，一个服务商可以有多把，支持轮询。 */
  | 'pool'
  /** 历史表 `RunningHubConnection`（userId 唯一，单把）。 */
  | 'runninghub-legacy';

export type ProviderMeta = {
  id: ProviderId;
  label: string;
  /** 一句话说清这条链路是干什么的 —— 界面上直接显示，不用用户自己猜。 */
  summary: string;
  kind: ProviderKind;
  storage: KeyStorage;
  /** 界面上要不要让用户填接口地址。填了就覆盖 `.env` 里的全局值。 */
  needsBaseUrl: boolean;
  /** 要不要让用户填模型名。文本厂商每家都得填（各家模型名不通用）。 */
  needsModel: boolean;
  /** 兜底用的环境变量名。界面上要提示「当前回落的是哪把」。 */
  envKeyName: string;
  /**
   * 直连网关的**接口地址**环境变量名（现在只有 videoapi 有 —— Image 2.0 那条 2026-09-23 删了）。
   *
   * 用户级 key 没填地址时会回落到它（见 `lib/providers/resolve.ts`），
   * 所以界面上必须能把那个地址显示出来 —— 写死在页面里迟早和 .env 分岔。
   */
  baseUrlEnvName?: string;
  /**
   * 文本厂商的预填值：接口地址与默认模型。
   *
   * 放在这里而不是写死在页面里，是因为**服务端调它时也要用同一个默认值**
   * （用户没填就按这里来），两处各写一份必然出现「界面显示 A、实际调 B」。
   */
  text?: { defaultBaseUrl: string; defaultModel: string };
  /**
   * 能不能真的探活。
   *
   * 说实话这里是各家最不齐的一处：只有 RunningHub 有正经的查询类接口可以拿来试 key，
   * 其余三家要么没有轻量端点，要么各家端点长得不一样。**`false` 不代表不支持健康检查，
   * 而是「检查不出来就等于正常」** —— 具体做法见 `lib/providers/keys.ts` 的 probeKey()。
   */
  probe: 'endpoint' | 'models' | 'none';
};

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'runninghub',
    label: 'RunningHub 工作流',
    summary: '画布上的视频 / 超清工作流，走 ComfyUI 节点图（国内站）',
    kind: 'media',
    storage: 'runninghub-legacy',
    needsBaseUrl: false,
    needsModel: false,
    envKeyName: 'RUNNINGHUB_API_KEY',
    probe: 'endpoint',
  },
  {
    id: 'runninghub-ai',
    label: 'RunningHub 海外站',
    summary: '同一个工作流 API 的海外站（runninghub.ai），与国内站是独立账号和 Key',
    kind: 'media',
    storage: 'pool',
    needsBaseUrl: true,
    needsModel: false,
    envKeyName: 'RUNNINGHUB_AI_API_KEY',
    probe: 'endpoint',
  },
  {
    id: 'videoapi',
    label: '视频网关',
    summary: '视频节点的第二个引擎，提交 + 轮询的异步视频 API',
    kind: 'media',
    storage: 'pool',
    needsBaseUrl: true,
    needsModel: false,
    envKeyName: 'VIDEO_API_KEY',
    baseUrlEnvName: 'VIDEO_API_BASE_URL',
    probe: 'models',
  },
  {
    id: 'doubao',
    label: '豆包（火山方舟）',
    summary: '字节跳动的文本模型，用于提示词优化',
    kind: 'text',
    storage: 'pool',
    needsBaseUrl: true,
    needsModel: true,
    envKeyName: 'ARK_API_KEY',
    text: { defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-seed-1-6-250615' },
    probe: 'models',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    summary: '深度求索的文本模型，用于提示词优化',
    kind: 'text',
    storage: 'pool',
    needsBaseUrl: true,
    needsModel: true,
    envKeyName: 'DEEPSEEK_API_KEY',
    text: { defaultBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
    probe: 'models',
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    summary: '智谱的文本模型，用于提示词优化（AIFISHER 的提示词助手用的就是它）',
    kind: 'text',
    storage: 'pool',
    needsBaseUrl: true,
    needsModel: true,
    envKeyName: 'ZHIPU_API_KEY',
    text: { defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4.6' },
    probe: 'models',
  },
  {
    id: 'kimi',
    label: 'Kimi（月之暗面）',
    summary: '月之暗面的文本模型，用于提示词优化',
    kind: 'text',
    storage: 'pool',
    needsBaseUrl: true,
    needsModel: true,
    envKeyName: 'MOONSHOT_API_KEY',
    text: { defaultBaseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-32k' },
    probe: 'models',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    summary: 'MiniMax 的文本模型，用于提示词优化',
    kind: 'text',
    storage: 'pool',
    needsBaseUrl: true,
    needsModel: true,
    envKeyName: 'MINIMAX_API_KEY',
    text: { defaultBaseUrl: 'https://api.minimax.chat/v1', defaultModel: 'MiniMax-Text-01' },
    probe: 'models',
  },
  {
    id: 'openai',
    label: 'OpenAI 兼容接口',
    summary: '任意 OpenAI 兼容的文本接口，用于提示词优化（填自己的地址与模型名）',
    kind: 'text',
    storage: 'pool',
    needsBaseUrl: true,
    needsModel: true,
    envKeyName: 'OPENAI_API_KEY',
    text: { defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
    probe: 'models',
  },
];

/**
 * 媒体网关归到设置页的哪一段（2026-09-23：那一页按「文本 / 图片 / 视频」三段重排）。
 *
 * 只列**直连网关**那几家（2026-09-23 起只剩视频网关，Image 2.0 那条整条删了）。
 * `runninghub` / `runninghub-ai` 不在里面，是因为它们是
 * **工作流类**：图片节点与视频节点用的是同一把 Key、同一个站点切换，归到任何一段
 * 都会让人以为「另一段得再配一次」。界面上它们单独摆，并写明两段共用。
 */
export const MEDIA_GROUP: Partial<Record<ProviderId, 'image' | 'video'>> = {
  videoapi: 'video',
};

/**
 * 命令行形态的两家（即梦 CLI / LibTV CLI）—— **只显示，不能配**。
 *
 * 它们在 AIFISHER 里是「本机装了某个 CLI 工具才能用」的类型，界面上要如实写「未安装」，
 * 而不是给一个填 Key 的框：给框等于骗用户「填了就能用」，而实际上填什么都跑不通。
 * 不进 `PROVIDERS` 就是为了让它们没法被塞进密钥池。
 */
export const CLI_PROVIDERS: { id: string; label: string; summary: string }[] = [
  { id: 'dreamina-cli', label: '即梦 CLI', summary: '本机安装即梦命令行工具后可用，当前未安装' },
  { id: 'libtv-cli', label: 'LibTV CLI', summary: '本机安装 LibTV 命令行工具后可用，当前未安装' },
];

/** 文本服务商（提示词优化的候选来源），顺序 = 「自动」时的挑选顺序。 */
export const TEXT_PROVIDER_IDS = PROVIDERS.filter(item => item.kind === 'text').map(item => item.id);

export function isTextProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && TEXT_PROVIDER_IDS.includes(value as ProviderId);
}

const BY_ID = new Map(PROVIDERS.map(item => [item.id, item]));

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && BY_ID.has(value as ProviderId);
}

/** 读不到就返回 null —— 调用方自己决定是报错还是跳过，别在这里代它猜。 */
export function providerMeta(id: string): ProviderMeta | null {
  return BY_ID.get(id as ProviderId) ?? null;
}

export function providerLabel(id: string): string {
  return providerMeta(id)?.label ?? id;
}

/**
 * 连续失败到这个数就自动停用那把 key。
 *
 * 不设成 1 是因为上游偶发超时太常见了 —— 一次抖动就把 key 判死，等于自己给自己找麻烦。
 * 设成 3 的含义是「连着三次都不行，那大概是 key 本身的问题」。
 */
export const FAILURE_LIMIT = 3;

/** 即将到期的提醒阈值（天）。 */
export const EXPIRY_WARNING_DAYS = 7;
