import 'server-only';

/** RunningHub configuration is server-only. The API key is never returned to the browser. */
export const runningHubConfig = {
  baseUrl: process.env.RUNNINGHUB_API_BASE_URL || '',
  workflowId: process.env.RUNNINGHUB_WORKFLOW_ID || '2099453228814528513',
  runPath: process.env.RUNNINGHUB_RUN_PATH || '/run/workflow/2099453228814528513',
  configured: Boolean(process.env.RUNNINGHUB_API_BASE_URL && process.env.RUNNINGHUB_API_KEY),
};

export function assertRunningHubConfigured() {
  if (!runningHubConfig.configured) throw new Error('RunningHub 尚未配置 API 地址和密钥。');
}

/**
 * 站点那把 key 能不能拿给没填自己 key 的账号用（即 `resolveApiKey` 的 env 兜底）。
 *
 * 默认**关**。这不是技术判断，是合同判断：RunningHub 服务协议 2.2 授予的是「个人的、
 * 非商业用途的」许可，2.3 明确「不得将账号以任何方式提供给他人使用（转让、出租、借用、
 * 分享、出售）」。会员购币拿到的 key 就属于这一类 —— 站点拿它给别的账号兜底，在协议上
 * 就是把账号分享出去。
 *
 * 要开，前提是已经跟 RunningHub 谈过商业 / API 授权（对应协议 2.2 的「除非另有约定」）。
 * 开关留着是因为要能被测到：回归脚本得同时验「关了真的不回退」和「开了还能回退」。
 */
export function sharedKeyAllowed() {
  const flag = process.env.RUNNINGHUB_ALLOW_SHARED_KEY?.trim().toLowerCase();
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  return false;
}
