/**
 * `import 'server-only'` 在 Next 里是个「只能在服务端引入」的编译期护栏。
 *
 * 桌面版没有 Next：lib/ 的代码**全部**跑在主进程里，本来就是服务端。
 * 但 `server-only` 这个包在 node 侧的入口是一句 `throw`，真 import 进来直接崩。
 * 所以两边（主进程、渲染进程）都把它 alias 成这个空模块。
 */
export {};
