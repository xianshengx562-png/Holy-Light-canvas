'use client';

/**
 * 内联脚本的渲染壳。**它必须是客户端组件** —— 这是整个修复的关键，见下。
 *
 * 问题：在 App Router 的 `layout.tsx` 里直接写
 *   `<script dangerouslySetInnerHTML={{ __html: ... }} />`
 * 开发模式下 React 会报一条 Console Error：
 *   「Encountered a script tag while rendering React component. Scripts inside React components
 *     are never executed when rendering on the client.」
 *
 * 为什么会报（不是玄学，React 内部就这一个判据）：React DOM 在 `completeWork` 里对
 * `<script>` 调 `isScriptDataBlock(props)`，**只看 `type`**：
 *   - 没有 `type`、或 `type` 是 `text/javascript` 这一类「浏览器会执行」的 MIME → 返回 false → 报警并 `console.error`；
 *   - `type` 是 `text/plain` / `application/json` 这类「不执行」的类型 → 返回 true → 当作数据块，不报警。
 * RSC 的客户端渲染器会**在浏览器里重新渲染一遍服务端组件的产物**，所以哪怕 `layout.tsx` 只在
 * 服务端跑，那个 `<script>` 元素照样会在客户端被挂载一次 —— 于是报错栈里看到的是 `RootLayout`。
 *
 * 修法（Next.js 官方指南「How to prevent flash before hydration」的写法）：
 * 把它包成一个**客户端组件**，两边各取所需 ——
 *   - 服务端渲染（`window` 不存在）：`type="text/javascript"`，浏览器解析 HTML 时**同步执行**，防闪才成立；
 *   - 客户端渲染：`type="text/plain"`，React 视作数据块不再报警 —— 而且客户端渲染出来的内联脚本
 *     **本来就不会执行**，标成不可执行等于是说实话，不是遮掩。
 * 两边 `type` 不同会触发水合属性不一致，用 `suppressHydrationWarning` 消化掉。
 *
 * 别图省事写成固定 `type="text/plain"`：那样服务端产物也不再执行，防闪脚本就白写了
 * （症状是刷新时先闪一帧深色再跳成日间）。
 */
export default function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
