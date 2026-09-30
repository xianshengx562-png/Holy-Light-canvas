/**
 * 「还有没保存的东西吗」——**一处登记、多处询问**（2026-09-30）。
 *
 * 起因：徐先说「用户如果在工作流配置界面不小心点击项目或者退出了，会提醒用户工作流未保存，
 * 是否退出」。查下来缺的不是「有没有脏」—— `WorkflowConfigurator` 里早就有 `dirty`，
 * 而且挂了 `beforeunload`。缺的是**离开的方式不止一种，而只有一种被兜住了**：
 *
 * | 离开方式 | 兜住了吗 |
 * | --- | --- |
 * | 刷新 / 关整个页面 | ✅ `beforeunload` |
 * | 配置页里加载另一个 ID | ✅ 组件内的 `window.confirm` |
 * | 画布浮层 ✕ / Esc / 点灰 | ✅ `onDirtyChange` 报给壳，壳自己问 |
 * | **点「返回项目」「工作流列表」这些站内链接** | ❌ **没有** |
 * | **桌面版点右上角关闭** | ❌ 有确认框，但只问「最小化还是退出」 |
 *
 * 后两条漏掉的原因都一样：**站内跳转和关应用都不是「卸载页面」**。
 * 这个应用的路由是 hash 驱动的（`src/shims/router.ts`），点 `<Link>` 只改 hash，
 * `beforeunload` 根本不会被触发；而关应用是主进程先拦下、再推 IPC 给渲染层弹自己的框
 * （见 `CloseConfirmDialog`）。所以「有没有未保存」这件事**不能靠浏览器的卸载钩子**，
 * 得有个人主动问。
 *
 * 于是做成一个小小的登记处：正在编辑的组件把自己登记进来（报一个「我脏不脏」的函数），
 * 要离开的地方（`<Link>` 点击前、退出确认框里）统一来这里问一句。
 *
 * 为什么不把判定写在问的地方：那样问的地方就得认识每一个编辑页 ——
 * 加一个编辑页就要改两处，而漏改的那处**不会报错**，只是悄悄不提醒。
 * 反过来写（登记）的话，编辑页自己带着「我是不是脏」的知情权，
 * 多一个编辑页只要多登记一次，问的地方一个字都不用改。
 */

type Entry = {
  /** 问的时候怎么说这件事（例如「工作流「出图-2.5」」）。 */
  label: string;
  /** 现在脏不脏。传函数而不是布尔值：`dirty` 是会变的 state，登记一次就行。 */
  isDirty: () => boolean;
};

const entries = new Set<Entry>();

/**
 * 登记一处「可能有未保存改动」的编辑区。
 *
 * @returns 注销函数。**必须**在组件卸载时调用（放进 `useEffect` 的返回值），
 *          否则组件都销毁了它还在被问，「我改过」会一直拦着用户。
 */
export function registerUnsaved(label: string, isDirty: () => boolean): () => void {
  const entry: Entry = { label, isDirty };
  entries.add(entry);
  return () => {
    entries.delete(entry);
  };
}

/** 现在所有「脏着」的地方，按登记顺序。没登记就是空数组 —— 什么都不问。 */
export function unsavedLabels(): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    /*
     * 逐个 try：某个登记方正在卸载、它的 state 已经读不出来的时候，
     * 不该因为这一处把「要不要提醒」整件事带崩 —— 问不出就是没脏。
     */
    try {
      if (entry.isDirty()) out.push(entry.label);
    } catch {
      /* 读不出来 = 那一处已经不算了 */
    }
  }
  return out;
}

/**
 * 问一句「有未保存的改动，确定离开吗」。
 *
 * 用 `window.confirm` 而不是自绘对话框，是为了跟配置页里那句
 * 「放弃未保存的修改并加载配置？」**说同一种话、长得一样**（同一个入口两种弹法更怪）。
 *
 * @returns 可以继续走（`true`）还是该停下（`false`）
 */
export function confirmLeave(): boolean {
  const labels = unsavedLabels();
  if (!labels.length) return true;
  const what = labels.length === 1 ? labels[0] : labels.join('、');
  /* `what` 以中文引号收尾（「工作流「出图」」），后面**不能再跟空格** —— 中文里那个空格很碍眼。 */
  return window.confirm(`${what}有未保存的改动。\n\n现在离开，这些改动就没了。确定离开吗？`);
}
