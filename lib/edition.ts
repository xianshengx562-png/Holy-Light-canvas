/**
 * 版本开关。**构建期内联，运行时不读环境变量** —— 这是它和别处 env 最大的区别。
 *
 * 同一个代码库要出两个**互相独立的产品**：
 *
 * - `web`（默认）：云端完整版。画布 + RunningHub + 计费 + 支付 + 订阅 + 对话，外加本地模式作为可选项。
 * - `desktop`：本地桌面版。Electron 壳里跑，自带数据库，**只保留画布与本机 ComfyUI**，
 *   没有云端、没有计费、也没有登录这一步（见 `lib/auth/session.ts` 里的本机用户）。
 *
 * 为什么要做成「一个代码库 + 一个开关」而不是复制一份出来：两边共享画布、工作流绑定、
 * 资产、本地模式这整套代码，复制一份就等于同一个 bug 要修两遍，而且修完很快会分叉。
 * 用开关的话，差异集中在「哪些页面存在、哪些接口放行、生成走哪条路」这三处，
 * 其余部分两边跑的是同一份代码。
 *
 * ⚠️ 变量名必须是 `NEXT_PUBLIC_` 前缀：导航和设置页是客户端组件，
 * 客户端拿不到没有这个前缀的环境变量（构建时不会被内联进去，运行时变成 `undefined`）。
 * 代价是这个值**在构建那一刻就定死**了 —— 桌面版必须在构建时带上
 * `NEXT_PUBLIC_HOLYLIGHT_EDITION=desktop`，运行时再设没有意义。
 */
export type Edition = 'web' | 'desktop';

const raw = (process.env.NEXT_PUBLIC_HOLYLIGHT_EDITION || '').trim().toLowerCase();

export const EDITION: Edition = raw === 'desktop' ? 'desktop' : 'web';

export const isDesktop = EDITION === 'desktop';

/** 写 `isWeb` 而不是到处写 `!isDesktop`：读的时候不用在脑子里做一次取反。 */
export const isWeb = !isDesktop;
