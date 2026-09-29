import 'server-only';

/**
 * 本地模式（本机 ComfyUI）的配置。**只在服务端读**。
 *
 * 与别家最大的差别：**这里没有「非配不可」的东西**。地址有默认值（`127.0.0.1:8188`），
 * 密钥可以留空（本机 ComfyUI 默认不鉴权），所以别家那句 `assertXxxConfigured()` 在这条路上
 * 不存在 —— 拿不到地址就报「地址不对」，而不是「请先配环境变量」，因为对一个只想连自己
 * 机器的人来说，后者等于把「我还没装 ComfyUI」说成了「站长没配好」。
 *
 * 每个值都在**调用时**读，不在模块加载时快照：改 `.env` 重启后不该出现「老值被缓存住」这种怪事。
 */

/** ComfyUI 的默认端口。绝大多数本地部署就是它，填地址时能少打一串。 */
export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:8188';

/** 站点级兜底地址。用户在设置里填了自己的就覆盖它。 */
export function localBaseUrlFallback() {
  return (process.env.LOCAL_BASE_URL?.trim() || '').replace(/\/+$/, '');
}

/** 站点级兜底密钥。本机一般没有鉴权，留空是常态。 */
export function localApiKeyFallback() {
  return process.env.LOCAL_API_KEY?.trim() || '';
}

/**
 * 站点级兜底的 **ComfyUI 安装目录**（只读用）。
 * 自建部署时可以在 `.env` 里就写好它装在哪，用户就不用在设置里再选一次。
 */
export function localComfyuiDirFallback() {
  return (process.env.LOCAL_COMFYUI_DIR?.trim() || '').replace(/[\\/]+$/, '');
}

export const LOCAL_PROMPT_PATH = '/prompt';
/** 查一次任务。后面要拼上 `/<prompt_id>`。 */
export const LOCAL_HISTORY_PATH = '/history';
/** 取输出文件。ComfyUI 的 `/view` 对图片和视频都有效（VHS 的视频也走它）。 */
export const LOCAL_VIEW_PATH = '/view';
/**
 * 上传输入（参考图 / 视频 / 音频）。ComfyUI 只有 `/upload/image` 这一个上传端点，
 * 视频和音频也传这里 —— 它只是把文件放进 `input` 目录，VHS 的 Load Video / Load Audio
 * 读的正是同一个目录。
 */
export const LOCAL_UPLOAD_PATH = '/upload/image';
/** 探活用。比 `/prompt` 轻，也不会真的开始跑一次生成。 */
export const LOCAL_STATS_PATH = '/system_stats';
/**
 * 「扫一遍哪个端口上有 ComfyUI」时单个地址的超时。
 *
 * 比 `LOCAL_PROBE_TIMEOUT_MS`（10 秒）短得多是刻意的：扫描是**并发**的，但 ECONNREFUSED
 * 在 Windows 上要等到底层超时才返回，给 10 秒的话扫 8 个地址最坏要等 80 秒 ——
 * 那已经超过了「点一下就该有结果」的耐心上限。2.5 秒足够本机回话，扫不完就是没有。
 */
export const LOCAL_SCAN_TIMEOUT_MS = 2_500;
/** 实时进度走的是 WebSocket：ComfyUI 只在 `/ws` 上推 `executing` / `progress`。 */
export const LOCAL_WS_PATH = '/ws';
/** 节点信息，用来诊断「图里有没有 ComfyUI 不认得的节点 / 找不到的模型」。 */
export const LOCAL_OBJECT_INFO_PATH = '/object_info';
/** 队列：还剩几个在跑、几个在排。 */
export const LOCAL_QUEUE_PATH = '/queue';
/**
 * 读 `/object_info` 的超时。
 *
 * 比别的请求长得多是刻意的：ComfyUI 第一次被问「你有哪些节点」时要把所有插件的定义
 * 汇总一遍，插件多的整合包实测要十几秒。**不能按「快点超时」设** —— 那样会稳定地
 * 读不到模型清单，而读不到的后果是界面上一直显示「本机没有模型」。
 */
export const LOCAL_OBJECT_INFO_TIMEOUT_MS = 20_000;

/** 提交 / 上传的超时。本地跑没有网络抖动，给足时间即可（大模型第一次加载要等权重）。 */
export const LOCAL_SUBMIT_TIMEOUT_MS = 120_000;
export const LOCAL_QUERY_TIMEOUT_MS = 30_000;
export const LOCAL_UPLOAD_TIMEOUT_MS = 120_000;
export const LOCAL_PROBE_TIMEOUT_MS = 10_000;
