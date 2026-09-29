/**
 * 开始界面（登录后的首页）上那些「创作入口」的**唯一事实来源**。
 *
 * 为什么单独抽一个文件：这类入口天然会长第二个、第三个（画布 → 图片生成 → 音频 → …），
 * 而每加一个就要动一遍首页布局的话，第二次就会有人顺手把卡片写死在 JSX 里，
 * 于是「有哪些入口」这件事再也说不清。
 *
 * 加一个新入口做三件事：
 *   1. 这里加一条记录。`status: 'planned'` 的会渲染成**不可点的占位卡片**，
 *      用来把「已经想好了、还没做」的入口摆在明面上；
 *   2. 目标页面自己实现好后，把 `status` 改成 `'ready'`；
 *   3. **图标名加进 `StartEntryIcon`，再去 `StartEntries.tsx` 的 `ICONS` 里补一条映射** ——
 *      漏了这一步类型会直接报错（这是好事），但别指望它「自动有个默认图标」。
 *
 * ⚠️ `icon` 存的是**名字**不是组件：这个文件会被服务端组件与测试脚本同时读，
 * 引入 React 组件会把「一份纯数据」变成「一个需要 JSX 环境的模块」。
 */
export type StartEntryIcon = 'canvas' | 'image' | 'assets';

export type StartEntry = {
  id: string;
  title: string;
  description: string;
  /**
   * `planned` 的条目这个字段不会被使用（它渲染成不可点的卡片）。
   *
   * ⚠️ 「画布」这条的 `href` 留空是**故意的**：画布不在某个固定地址上，
   * 它是 `/projects/<项目 id>`，而它自己那张卡片就长在首页（`/`）——
   * 写 `'/'` 等于「导航到当前页」：hash 不变、`hashchange` 不触发、组件不重挂，
   * 点了界面纹丝不动（2026-09-19 用户报的「点画布进入不了」就是这个）。
   * 它要去哪儿得**看着当前有什么项目**才能定，见 `lib/start/entryTarget.ts`。
   */
  href: string;
  icon: StartEntryIcon;
  status: 'ready' | 'planned';
  /** 需要按「当前有什么项目」现算落点的条目 —— 渲染方要先 `resolveEntryHref` 再决定能不能点。 */
  dynamic?: boolean;
  /** `planned` 条目上的小字，例如「下一个版本」。 */
  plannedNote?: string;
  /** 是否也放进侧栏导航。 */
  nav?: boolean;
  /*
   * 只在云端版出现的入口。桌面版砍掉了某些整块功能，对应的卡片也该一并消失 ——
   * 留着就是一个点了会跳到「桌面版没有这个界面」的死链接，比没有更糟。
   * （2026-09-21 移除对话后暂时没有条目用它，字段留着：下一个云端专属入口直接加回来即可。）
   */
  webOnly?: boolean;
};

export const START_ENTRIES: StartEntry[] = [
  {
    id: 'canvas',
    title: '画布',
    description: '把提示词、参考图与生成串成一条链路，用节点完成图片与视频的批量创作。',
    /*
     * ⚠️ 空串 = 「落点要现算」，见 `entryTarget.ts`。
     * 这里**绝不能**写 `'/'` —— 那正是 2026-09-19「点画布进入不了」的根因。
     *
     * 现算出来有三种可能：进最近那个项目 / **一个项目都没有时点一下现建一个再进**
     * （`create-canvas`，2026-09-26）/ 定不下来就不许点。渲染方必须按这三种分别渲染成
     * 链接、按钮、不可点卡片 —— 只认 href 的那版实现会把「现建一个」这一支漏掉。
     */
    href: '',
    icon: 'canvas',
    status: 'ready',
    dynamic: true,
  },
  {
    id: 'image',
    title: '图片生成',
    description: '不走画布的独立出图通道，选好比例与分辨率直接出片。',
    /*
     * 2026-09-21 起是真实入口：落点是独立页 `/image`（全页出图界面：历史栏 + 大区 + 底部生成条）。
     * ⚠️ 不写 `'/'`：那是「导航到当前页」，正是 2026-09-19「点画布没反应」的根因形状。
     */
    href: '/image',
    icon: 'image',
    status: 'ready',
  },
  {
    id: 'assets',
    title: '资产库',
    description: '所有落盘的图片、视频与文档，按项目归档，随时下载。',
    href: '/assets',
    icon: 'assets',
    status: 'ready',
  },
];

/** 侧栏要展示的那几条。侧栏顺序跟着这里，别在页面里再排一次。
 *  `dynamic` 的（画布）不进侧栏：它的落点要现算，一条腿挂在列表渲染里只会更难讲清楚。 */
export const NAV_ENTRIES = START_ENTRIES.filter(entry => entry.nav && entry.status === 'ready');

/** 按 id 取一条 —— 别在页面里 `START_ENTRIES.find(...)` 写死 id 字符串。 */
export function startEntry(id: string) {
  return START_ENTRIES.find(entry => entry.id === id);
}
