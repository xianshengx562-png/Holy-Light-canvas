import 'server-only';

/**
 * 通用视频网关的配置。**只在服务端读**，key 永远不回传浏览器。
 *
 * 这一层是「适配层」而不是「某一家的 SDK」：目标是**换一家网关只改 `.env` 就能跑**，
 * 所以地址、密钥、模型名、提交/查询路径全部可配，代码里不留任何一家的专属常量。
 *
 * 与 RunningHub 那套的区别：这里**没有用户级 key**，所有用户共用站长配的那一个，
 * 所以每次生成都按积分计费。将来要支持用户自带 key，就照 `runninghub/connection.ts` 加一张表，
 * 下面的读取点不用动（调用方只在 `videoApiKey()` 里取 key）。
 *
 * 每个值都**在调用时读**，不在模块加载时快照，理由有两条：
 *   1. 测试要能在同一个进程里改 `process.env` 验证「没配就报错」这条分支；
 *   2. 常驻 dev server 上改 `.env` 重启后不会出现「老值被缓存住」这种查半天的怪事。
 */

/** 提交任务（文生视频 / 图生视频）的端点，默认按最常见的 `/v1/videos/generations` 写。 */
export const DEFAULT_VIDEO_API_SUBMIT_PATH = '/v1/videos/generations';

/**
 * 查询任务状态的端点。路径里的 `{id}` 是占位符，调用时会替换成提交时拿到的外部任务号。
 *
 * 有的网关把状态挂在 `/v1/videos/generations/{id}`（REST 风格），有的单独开 `/v1/tasks/{id}`，
 * 所以这一条也做成可配的 —— 对不上时在 `.env` 里写一句就行，不用改代码。
 */
export const DEFAULT_VIDEO_API_QUERY_PATH = '/v1/videos/generations/{id}';

export function videoApiBaseUrl() {
  return (process.env.VIDEO_API_BASE_URL?.trim() || '').replace(/\/+$/, '');
}

export function videoApiKey() {
  return process.env.VIDEO_API_KEY?.trim() || '';
}

/**
 * 模型名。**留空时不发 `model` 字段** —— 与图片链路同一条规矩：
 * 各家网关的模型命名五花八门，我们猜的那个名字大概率它不认，反而会直接 400；
 * 不发的话大多数网关会用它自己的默认模型，至少能跑通。
 */
export function videoApiModel() {
  return process.env.VIDEO_API_MODEL?.trim() || '';
}

function withLeadingSlash(raw: string) {
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function videoApiSubmitPath() {
  return withLeadingSlash(process.env.VIDEO_API_SUBMIT_PATH?.trim() || DEFAULT_VIDEO_API_SUBMIT_PATH);
}

export function videoApiQueryPath() {
  return withLeadingSlash(process.env.VIDEO_API_QUERY_PATH?.trim() || DEFAULT_VIDEO_API_QUERY_PATH);
}

export function videoApiConfigured() {
  return Boolean(videoApiBaseUrl() && videoApiKey());
}

/**
 * 没配齐就抛错 —— **绝不静默回退到 RunningHub**。
 *
 * 回退的后果是「用户选了视频网关，跑出来的却是工作流那一套」：任务成功、有视频、
 * 界面上什么都看不出来，只是参数全变了。宁可明确报错让他去填 `.env`。
 */
export function assertVideoApiConfigured() {
  if (!videoApiBaseUrl()) {
    throw new Error('尚未配置视频网关接口地址，请在 .env 里填 VIDEO_API_BASE_URL 后重启服务。');
  }
  if (!videoApiKey()) {
    throw new Error('尚未配置视频网关 API Key，请在 .env 里填 VIDEO_API_KEY 后重启服务。');
  }
}
