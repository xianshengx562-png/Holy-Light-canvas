/**
 * 进站公告 —— **唯一事实来源**。
 *
 * 为什么内容单独抽一个文件：公告文案会反复改，
 * 而「改一句文案」应该是**改数据**，不是改 JSX。同 `lib/start/author.ts` 的路子。
 *
 * ⚠️ 给徐先的一件事：
 *   1. `VERSION` 是**已读记录的钥匙**。改了任何文案就把版本号往后推一格（比如 `'2026-09-17.3'`），
 *      老用户本地那条「已读」就此失效，公告会再弹一次 —— 否则改了文案没人看得到，等于白改。
 *
 * 纯数据、无 React：弹窗（客户端）直接消费这一份。
 */

/** 改文案就 bump 这个；它是 localStorage 里那条「已读」的比对值。 */
export const ANNOUNCEMENT_VERSION = '2026-09-17.2';

/** 已读记录存在哪个 key 下。和外观偏好一样只落在浏览器里，不进库。 */
export const ANNOUNCEMENT_KEY = 'frame.announcement.read';

export const ANNOUNCEMENT_META = {
  kicker: '公告',
  title: '关于 Holy Light画布',
  /** 内容最后更新的日期：改文案时顺手改它 —— 弹窗底部那一行读的就是它。 */
  updatedAt: '2026-09-17',
};

/** 一、做这个项目的初衷。一段一条，按徐先自己的口气写。 */
export const ANNOUNCEMENT_ORIGIN: string[] = [
  '做这个站点没什么宏大计划，纯粹是脑子一热 —— 最近又学了点新东西，手痒，就想把它做成一个真的能跑起来的网站。',
  '它不是产品，也不是商业服务，是我个人的学习作品和练习场：画布交互、工作流编排、接入第三方生成服务，基本都是一边查一边写出来的。',
  '所以现在它还挺粗糙的：功能在补、界面在改、偶尔会抽风。你要是碰到报错、变慢、或者哪里反直觉 —— 那基本是我还没做完，不是你用错了。',
  '我会继续慢慢优化。谢谢你愿意点进来看一眼。',
];

export type AnnouncementFeature = {
  title: string;
  desc: string;
  /** 云端版独有的功能：桌面版里没有这一层，列出来只会骗人（比如「余额与账单」）。 */
  webOnly?: boolean;
  /**
   * 桌面版独有的功能。
   *
   * 注意它**不能**和 `webOnly` 一起用（两个都为真时，两边都看不到这条）——
   * 过滤那一步按同一份清单同时摘 `webOnly`（桌面版侧）与 `desktopOnly`（web 版侧）。
   */
  desktopOnly?: boolean;
  /** 桌面版下替换 `desc` 的说法。同一件事换了个做法，就该换一句人话来描述。 */
  desktopDesc?: string;
};

/** 二、站点能干什么。条数随功能增减，页面会照着渲染。 */
export const ANNOUNCEMENT_FEATURES: AnnouncementFeature[] = [
  {
    title: '无限画布编排',
    desc: '提示词、参考图、视频、音频、续接 latent、自定义参数块都是节点，拖进来连成一条流水线，改一处就顺着往下传。',
    desktopDesc: '提示词、参考图、视频、音频、自定义参数块都是节点，拖进来连成一条流水线，改一处就顺着往下传。',
  },
  {
    title: '视频生成',
    desc: '两种引擎：接自己的 RunningHub 工作流，或直连通用视频网关；支持首帧图起手、续接上一段，出完还能再跑一道超清。',
    desktopDesc: '视频跑在你自己机器的 ComfyUI 上：把工作流图贴进来，画布上的节点直接喂参数；出完还能再跑一道超清。',
  },
  {
    title: '图片生成',
    desc: '三档引擎出图：RunningHub 工作流、本机 ComfyUI 工作流，或你自己加的兼容接口；比例、分辨率、步数、CFG、种子、采样器都能调。',
    desktopDesc: '出图跑在你自己机器的 ComfyUI 上：比例、分辨率、步数、CFG、种子、采样器这些照样能在节点上调。',
  },
  {
    title: '工作流参数映射',
    desc: '把工作流里任意节点的字段绑到画布上的值（提示词、参考图、视频 / 音频、时长、latent……），改画布就等于改参数，不用回去改工作流。',
    desktopDesc: '把 ComfyUI 工作流里任意节点的字段绑到画布上的值（提示词、参考图、视频 / 音频、时长……），改画布就等于改参数，不用回去改工作流。',
  },
  {
    title: '素材直接拖进来',
    desc: '图片 / 视频 / 音频拖进画布即可；视频会在上传时抽一帧首图，好直接拿去当参考图或首帧。',
  },
  {
    title: '资产库',
    desc: '生成结果自动归档，能预览、能下载，也能挑一份出来继续加工。',
    desktopDesc: '生成结果自动归档，能预览、能下载，也能挑一份出来继续加工；产出存在哪个文件夹由你自己选，找文件、备份都方便。',
  },
  {
    title: '余额与账单',
    desc: '用站点公共额度按次计费，填上自己的 API Key 就不再扣费 —— 充值和流水都在设置里看得见。',
    webOnly: true,
  },
  {
    title: '自带密钥 · 不经过任何服务器',
    desc: '密钥中心里四家都能填自己的 key，填了直连那一家，花的是你自己的额度；一家都不填就只用本机 ComfyUI，一个字节都不往外发。',
    desktopOnly: true,
  },
  {
    title: '产出目录自己挑',
    desc: '生成出来的图、视频、latent 落在哪个文件夹由你定，选完当场验证能不能写；换了目录也不会动已有的资产。',
    desktopOnly: true,
  },
  {
    title: '外观',
    desc: '日间 / 夜间 / 跟随系统，画布底色也能自己挑，网格点和连线会跟着底色自动换深浅。',
  },
];

/**
 * 按版本取功能清单。**过滤与改写在数据这一层做**，组件只管渲染 ——
 * 否则「哪些条目该隐藏」会变成一串散在 JSX 里的三元表达式，改文案时最容易漏。
 */
export function announcementFeatures(desktop: boolean): AnnouncementFeature[] {
  const list = ANNOUNCEMENT_FEATURES.filter(feature => (desktop ? !feature.webOnly : !feature.desktopOnly));
  if (!desktop) return list;
  return list.map(feature => ({ ...feature, desc: feature.desktopDesc || feature.desc }));
}
