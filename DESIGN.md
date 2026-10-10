# DESIGN.md — Holy Light 画布 设计锚

> 2026-10-07 由 qiaomu-design Phase 2 四方向预览选出 **方向 D · 玻璃工坊**，
> 用户补充：「Figma 弥散渐变效果，高级灰渐变色」。拨盘：VARIANCE 4 / MOTION 3 / DENSITY 7。
> 本文件是唯一设计锚。改视觉前先读这里；改了这里就要同步 `globals.css` 与 `canvas.css`。

## 0. 产品与受众

桌面端（Electron）AI 生成编排工作台。受众是**每天要批量出图的专业创作者**，
单次会话常常 1–8 小时。所以：**耐看 > 惊艳，可读 > 个性，可预测 > 惊喜**。

## 1. 功能契约（风格不许吃掉它）

2026-10-07 布局修订：顶栏显示品牌、项目与画布数量，保存为图标动作，运行保持唯一主按钮。
左侧 64px 固定工具轨，中间为无遮挡画布，右侧 360px 常驻节点参数栏。
生成服务、参考素材、提示词与输出规格分区；常用规格直接显示，不藏在摘要弹层中。
所有编辑继续使用原节点回调。参数栏可收起，收起后恢复节点下方原面板。
1100px 以下参数栏缩到 320px；760px 以下作为可关闭的右侧覆盖层。

用户 3 秒内必须获得：
1. 我在哪个项目
2. 画布上有什么节点、跑到哪一步了
3. 怎么加节点、怎么启动

必须能完成的链路：加节点 → 连边 → 调参 → 启动 → 看结果 → 存/导出。

## 2. 一句话气质

> 一间有天窗的工作室：中调灰的台面，台面上挖下去一块深色的工作区，
> 天光（弥散渐变）落在工作区里，工具各有各的颜色。

## 3. 色彩

### 3.1 表面（深色档默认）

| 角色 | 值 | 说明 |
|---|---|---|
| 界面底 `--bg` | `#25272e` | 顶栏 / 页面 chrome |
| 画布地板 `--bg-canvas` | `#131417` | **比界面底更深**——画布是台面上挖下去的那块，深色才能让生成的图不发灰 |
| 一级面板 `--surface` | `#2a2c34` | 面板 / 底栏 |
| 二级 `--surface-2` | `#31333c` | hover / 卡片 |
| 三级 `--surface-3` | `#3a3c45` | 激活 |
| 输入框 `--field` | `#1e2026` | 比面板深 → 陷进去 |

🔴 **为什么画布最深**：这是出图工具。把画布底提到中调灰会让用户误判生成结果的对比度与黑位。
「中调灰」落在**界面 chrome**，不落在**内容舞台**。

### 3.2 文字（中文界面按 7:1 设防）

| 角色 | 值 | 对 `#2a2c34` 对比度 |
|---|---|---|
| 主文 `--text` | `#f2f3f6` | ≈ 15.6:1 |
| 次文 `--text-dim` | `#bcbfc8` | ≈ 7.6:1 |
| 弱文 `--text-mute` | `#a6abb6` | ≈ 5.2:1（**只给非关键**） |

🔴 弱文这一档是**真机量出来的**，不是拍的。它必须同时过四种底：
地板 8.1 / 面板 6.0 / 浮层 5.2 / 次级面（账户卡那种 #3a3c45）4.75。
前一版 #8f939e 在顶栏上只有 3.57:1、#9ea2ad 在账户卡上只有 4.3:1 —— 都过不了线。
改档前先跑真机对比度探针，不许出现 < 4.5:1 的正文。

### 3.3 节点类型色（「高级灰」= 低饱和带灰，不是鲜艳色）

| 类型 | 值 |
|---|---|
| 文本 | `#8fa3c4` 雾蓝 |
| 图片 | `#c78ea6` 灰粉 |
| 视频 | `#8fbca4` 雾绿 |
| 音频 | `#cbb083` 砂黄 |
| 超清 | `#a893c6` 灰紫 |
| 其它 | `#9aa0aa` |

规则：**彩色只出现在内容层**（节点卡、画布地板渐变）。面板 / 顶栏 / 按钮一律中性灰——
这条直接来自 Figma：界面 chrome 无色，彩色属于产品内容。

### 3.4 弥散渐变（Figma 那一笔）

只画在**画布地板**上，四个大半径径向渐变叠加，单点不透明度 ≤ 10%：

```
radial-gradient(760px 520px at 18% 22%, rgba(143,163,196,.10), transparent 68%)
radial-gradient(680px 480px at 82% 30%, rgba(199,142,166,.08), transparent 68%)
radial-gradient(820px 560px at 62% 84%, rgba(143,188,164,.07), transparent 70%)
radial-gradient(560px 420px at 30% 78%, rgba(203,176,131,.06), transparent 70%)
```

🔴 它是**氛围不是装饰**：不进面板、不进卡片、不做按钮底、不做文字渐变。

## 4. 排版

- 中文一律系统栈（零下载）：`-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC"`
- 参数 / 尺寸 / seed / 计数走 `--font-mono` + `font-variant-numeric: tabular-nums`
- 字重只用 **400 / 500 / 600**，不用 `bold`（中文字体伪合成会发虚）
- 行高正文 ≥ 1.6
- **禁负字距**（中文挤压会糊）——Figma 那条负字距不抄
- 五档字号台阶（都乘 `--ui`）：

| 档 | 值 | 用在哪 |
|---|---|---|
| `--fs-1` | 10.5px | 徽标 / 角标 / 计数 |
| `--fs-2` | 11.5px | 次要说明 / 单位 |
| `--fs-3` | 12.5px | 控件正文 / 面板正文 |
| `--fs-4` | 13.5px | 节点名 / 小标题 |
| `--fs-5` | 15px | 区块标题 |

🔴 新增样式**不许再写裸 `font-size: calc(11.7px * var(--ui))`**，只许用台阶变量。

## 5. 形状

三档圆角（D 方向比上一代大一档，配合软阴影）：

`--r-xs 6 / --r-sm 10 / --r-md 14 / --r-lg 18 / --r-xl 24 / --r-full 999`
画布侧：`--cv-radius-sm 10 / --cv-radius 14 / --cv-radius-lg 20`

图标钮用圆或胶囊（`--r-full`），标签用胶囊。

## 6. 深度

三级真阴影（上一代全是 `none`，浮层只能靠 1px 描边分层，在深底上等于看不见）：

```
--sh-1: 0 1px 2px rgba(0,0,0,.28), 0 4px 12px -4px rgba(0,0,0,.32)   卡片
--sh-2: 0 2px 6px rgba(0,0,0,.30), 0 12px 28px -8px rgba(0,0,0,.40)  面板 / 左轨 / 底栏
--sh-3: 0 4px 10px rgba(0,0,0,.34), 0 24px 56px -12px rgba(0,0,0,.52) 弹层
```

### 玻璃的使用边界（🔴 硬约束）

- 浮层允许 `backdrop-filter: blur(16px)`，但**底色不透明度 ≥ 0.88**。
- 原因：Electron 里「半透明/裁剪的祖先 + 大量被缩放的图」会被合成器画成**横纹**
  （2026-10-06 已在 CreativePresetPicker 上踩过一次）。
- 遮罩（`.cv-scrim` 一类）底色必须**完全不透明**。

## 7. 焦点

画布内控件 `:focus-visible` 用 **2px 虚线 + offset 2px**——呼应画布自己的选择手柄，
这条 DNA 来自 Figma。全站其它页面保持实线描边，不强行统一。

## 8. 动效（MOTION 3）

- 时长：`--t-fast 0.14s` / `--t 0.22s`，缓动 `cubic-bezier(.4,0,.2,1)`
- 禁 `transition: all`、禁 UI `ease-in`、禁 `scale(0)` 入场
- 只做**状态反馈**：hover 底色、active 下沉 1px、focus 显形、running 呼吸
- 必须提供 `prefers-reduced-motion`

## 9. Do / Don't

**Do**
- 层级靠「底色差 + 阴影 + 圆角」三重表达
- 彩色只给内容和状态，界面 chrome 保持中性
- 数字纵向对齐（等宽 + tabular-nums）
- 状态要完整：hover / active / focus-visible / disabled / loading / empty / error / success

**Don't**
- 不做全员玻璃拟态（只有浮层）
- 不堆 AI 紫蓝光晕、不做渐变文字
- 不用左侧竖线做选中态（用整块底色 + 全边框）
- 不引入任何新字体文件、新图片资产
- 不加无语义的装饰卡片

## 10. 响应式与缩放

- 界面尺寸只有一个乘数 `--ui`（80–130），所有控件尺寸都要乘
- **画布节点卡片例外**：它是内容不是控件，`.cv-node` 上钉 `--ui: 1`

## 11. 验收清单（每次改视觉都要过）

- [ ] 主界面正文对比度 ≥ 4.5:1，次文 ≥ 7:1（真机探针量）
- [ ] 同一排控件高度统一（顶栏实测）
- [ ] 字号只出现台阶里的值
- [ ] 圆角只出现三档
- [ ] 浮层底色不透明度 ≥ 0.88
- [ ] 节点类型色在卡片上可辨
- [ ] `npm run typecheck` rc=0
- [ ] 现有单测 / 真机探针不回归

---

# 附：2026-10-07 晚 · 打磨轮（简约风精修，两套主题）

范围由徐先当面定：**深色 + 亮色两套都做**，**延续当前简约风精修**（不回到方向 D 的玻璃工坊 /
弥散渐变；那两样被 `8481ae5`「简约主题重构」主动关掉了，本轮不动）。

## DNA 供体（工艺环要求逐条可溯源）

- **Linear** → 圆角刻度 `6 / 8 / 12 / 22px`（+ 50% / 999px 几何档）；卡片用 `0 0 0 1px` 阴影环
  参与描边；icon button 走 `50%` + `1px rgba(255,255,255,.08)`。
- **Cursor** → 三层阴影结构（远扩散 + 中扩散 + 1px ring）；8px 间距 + 亚增量；
  语义色带暖度（success 用 muted teal 而非纯绿）。

## 本轮改了什么

1. **圆角收敛**（真机实测 7 种 → 3 档真刻度 + 2 存档几何 + 1 档细线）：
   `--cv-radius* ` 与 `--cv-r-*` 两套名字**值统一**为 `sm 6 / md 8 / lg 12 / xl 22`；
   54 处裸值（3/4/5/6/7/8/10px）批量收敛到令牌。
2. **对比度**：亮色 `--cv-mute #888888 → #6E7276`（3.54 → **4.85:1**）；
   暗色 `#888C90 → #9BA0A6`（4.9 → **6.9:1**，按祖先链实测复核）。
3. **阴影**：亮色改 Cursor 三层结构（强度收敛到原值约 1/3）；暗色改 Linear 式
   多层 + `inset 0 1px 0 rgba(255,255,255,.04)` 上沿高光 —— 暗底纯黑投影没有体积感。
4. **🔴 修复：右侧属性面板宽度塌成 61px**。`.cv-body` 是 flex 容器，而 `.cv-inspector`
   （以及 `-head` / `-empty` / `-selection` / `-content` / `-facts` / `-section` / `-label` / `-engine`）
   **整套类从来没写过 CSS** —— 组件渲染了但它们零命中，于是作为 flex item 被内容压成 61px，
   「节点参数 / × / 未选中节点」挤成三行竖排贴屏幕右缘。补齐整套样式后实测 **270px**。
5. **minimap 节点描边**降强度：`#60A5FA` → `rgba(96,165,250,.5)`（暗色下它曾是整屏最跳的元素）。
6. **`tabular-nums`**：节点数 / 连线数 / 缩放百分比是活数字，比例字宽会让顶栏整行抖。

## 复核过、但不成立的怀疑（记下来免得下一棒重查）

- 「焦点环是纯黑」→ 误判。`globals.css:709` 早就是 `2px solid var(--accent)` + offset 2px；
  程序化 `focus()` **不触发** `:focus-visible`，探针读到的是默认值。要验就派真键盘事件。
- 「深色下缩放百分比只有 2.63:1」→ 探针在切主题瞬间抓到了旧底色，误报。
  按祖先链实测是 `#9BA0A6` on `rgb(15,20,25)` = **6.9:1**。

## 追加修复（同日 22:20）· 参数块从右侧面板脱出到画布左上角

徐先报：「右边的参数没了，不知道为什么跑到了左上角，而且不是全部」。

**根因**：`GenerateDock` 在 inspector 模式下**仍然带着 `.cv-dock`**
（`GenerateDock.tsx:1510` 的 className 是 `cv-dock cv-dock-inspector` 两个类叠着），
而 `panels.css:1578` 那条 `.flow-shell .cv-dock` 是给**浮在画布上**写的：
`position: absolute; left: 14px; top: 14px; z-index: 20`。
修饰类 `.cv-dock-inspector` **原先一行 CSS 都没有**，撤不掉那个定位 ——
于是整块参数从面板里脱出、正好飘到画布左上角那个兜底位。

**修法**：给 `.cv-dock.cv-dock-inspector` 加一条**定位与浮层外观的整体撤除**
（`position: static; left/top: auto; z-index: auto; flex: 1 1 auto; min-height: 0;
background: transparent; border: 0; border-radius: 0; box-shadow: none`）。
面板自己已经有底、有边、有阴影，参数块不该再叠一层卡片；
滚动沿用组件里原有的 `.cv-dock-scroll`（它本来就是 `flex:1 + overflow-y:auto`）。

**真机验证**：`dockPosition: static`、`left: auto`、`x=1171`（面板 x=1170）、
`inside: true`、参数内容渲染完整。「修复后」截图存
`design-previews/2026-10-07-打磨-简约精修/参数面板-修复后.png`。

> 📌 **这是同一类病的第三次**：`cv-workspace-brand`（顶栏品牌）、`cv-inspector*`（整块面板）、
> `cv-dock-inspector`（模式修饰类）—— 都是 **JSX 里有类名、CSS 里零命中**。
> 判据很好用：`grep -rn "<类名>" --include=*.css src` 得到 0 命中，
> 而 `--include=*.tsx` 里有 —— 就是它。
> 以后新增带模式的组件（`xxx` + `xxx-<mode>`），**两个类都要落样式**。

> ⚠️ 验证这类交互时必须真的把节点**选中**（应用监听的是 React 的 `onClick`，
> `CanvasEditor.tsx:5088`）。CDP 的真鼠标序列会被 React Flow 的 d3-drag 吃掉 ——
> 表现为「节点视觉上选中了（蓝框），但面板仍显示未选中节点」，**这不是 bug，是探针不可靠**。
> 用 `el.click()` 派发真 click 才进得去。

## 追加（同日 22:25）· 徐先三条：圆钮配色 / 参数栏可拖宽 / 初始宽度加大

原话：「白色的图标不符合主题，右侧的节点参数可以调整宽度，初始的宽度可以多一点」。

### ① 右上角那排圆钮（`.cv-ap-open`）白色不合主题

**根因不是硬编码，是令牌静默继承**：`.cv-ap-open` 写的是 `var(--cv-float-strong)`，
但**深色块里没有定义这个令牌**。`tokens.css` 的主题块是**覆盖式**的 ——
深色块没写的令牌**不会报错、不会回落到基值，而是静默继承亮色块那个值**，
于是深色下那 5 个圆钮拿的是亮色的 `rgba(255,255,255,.98)`，在白字图标的衬托下就是 5 个白圆盘。

逐块对比后发现：**深色块共缺 39 个令牌**。本轮补齐其中 **12 个「直接写死颜色值」的**：

| 令牌 | 深色补齐值 |
|---|---|
| `--cv-float-strong` | `rgba(26,31,38,.98)` ← 这条就是圆钮 |
| `--cv-media-solid` | `#1A1F26` |
| `--cv-switch-off` / `--cv-switch-knob` | `rgba(255,255,255,.14)` / `#E8EAED` |
| `--cv-select-bg` | `rgba(96,165,250,.10)` |
| `--cv-icon-dim` | `#9AA0A6` |
| `--cv-node-opposite` | `#0F1419` |
| `--cv-accent-ring` / `--cv-accent-veil` | `rgba(96,165,250,.18)` / `rgba(96,165,250,.05)` |
| `--cv-danger` / `-soft` / `-line` | `#F87171` / `rgba(248,113,113,.12)` / `rgba(248,113,113,.30)` |
| `--cv-warn` / `-line` | `#FBBF24` / `rgba(251,191,36,.30)` |
| `--cv-success` | `#34D399` |

> 📌 **规矩**：令牌块是覆盖式的 —— 凡是**直接写死颜色值**的令牌，**两个块都要写**；
> 写成 `var(...)` 间接引用的不用（延迟解析，用到时才查当前层，天然跟随主题）。
> 剩 27 个未补的多是 `var(...)` 引用型或尺寸型，随用随补。

**真机实测**：深色 `bg = rgba(26,31,38,.98)` ✅ / 亮色 `rgba(255,255,255,.98)` ✅（亮色本来就对）。

### ② + ③ 参数栏可拖宽、初始宽度 300 → 380

`NodeInspector.tsx` 整体重写：

- 面板左缘加一条 **6px 热区** `.cv-inspector-resize`（`role="separator"` +
  `aria-orientation="vertical"`），`cursor: col-resize`；
  平时全透明，**hover 才显强调色、按住变实心**（hover 态包在
  `@media (hover: hover) and (pointer: fine)` 里，触屏不吃这条）。
- 拖拽走 **`setPointerCapture`**（不是 window 监听）—— 快速拖出窗口也不掉。
  实时改宽度用 React state；**松手才写 localStorage**（`frame.inspector-width`）。
- 拖动时设 `body.userSelect = 'none'` + `cursor: col-resize`，松手恢复；
  **松手路径写在 `onPointerUp` 和 `onPointerCancel` 两处**（右键 / Esc 中断时也要恢复）。
- 宽度：`DEFAULT_WIDTH = 380`（原 300）/ `MIN 280` / `MAX 760`，`clampWidth()` 收口。
- 🔴 **存逻辑值，用时乘 `--ui`**：`style={{ width: 'calc(${width}px * var(--ui))' }}`，
  localStorage 里存的是裸数字。这样他改「界面大小」时参数栏跟着缩放，而不是被钉死。
- 首帧用常量、`useEffect` 里才读盘 —— 防 SSR 注水不一致（同 `ThemeProvider` 那套理由）。

**真机实测（真鼠标拖，`Input.dispatchMouseEvent`）**：

| 步骤 | 逻辑宽度 | localStorage | 说明 |
|---|---|---|---|
| 全新（清过 key） | **380** | `null` | 尺寸 342px = 380 × `--ui` 0.9 ✅ |
| 往左拖 140px | **520** | `"520"` | 拖左变宽，方向正确、落盘逻辑值 ✅ |
| 再往右猛拖 900px | **280** | `"280"` | clamp 在 MIN ✅ |
| 拖到 470 | **470** | `"470"` | 全程 `inspectorInsideViewport: true` ✅ |

拖动中 `handleColor = rgb(96,165,250)`（= `--cv-accent`），松手回 `transparent`，
hover 才显色 —— 符合预期。

截图：`画布-深色-圆钮已融主题+参数栏380.png` / `画布-亮色-参数栏380.png` /
`参数栏-拖到470.png`（都在 `design-previews/2026-10-07-打磨-简约精修/`）。

> ⚠️ 探针跑完会在**他的真实数据目录**里留下拖拽后的宽度。收尾那跑特意
> `localStorage.removeItem('frame.inspector-width')` 清掉了，让他第一眼看到的是初始 380。

---

## 追加（同日 23:00）· 风格/滤镜/运镜栏：先修空白崩溃，再改成三栏并排

徐先报：「风格和滤镜以及运镜选项也有问题，这个做成以侧边栏的形式显示在节点旁边吧，
不用跳转一个新界面选择了」——截图是**一整片空白**（只剩下系统标题栏那三个按钮）。

### 先说那个空白：那是**崩溃**，不是「新界面」

真机复现抓到的异常，一字不差：

```
EXC TypeError: importedAll.filter is not a function
    at CreativePresetPicker (index-CBo6Nf53.js:49921:34)
    at Object.useMemo (…)
```

`useImportedPresets()` 返回的是 `{ groups, presets, loading }` —— **不是数组**，
而 `CreativePresetPicker` 里写的是 `importedAll.filter(...)`。
组件在**第一次 render** 就抛，React 直接把整棵树卸掉：
`bodyTextLen` 从 255 掉到 **0**、`.cv-topbar` / `.react-flow` / `.cv-inspector` 全查不到。
所以「点一下风格 → 界面跳到一个空白新页」= 这个异常。截图存
`design-previews/2026-10-07-预设栏三栏并排/崩溃复现-点风格后整屏空白.png`。

同一片区还有三处一起修掉了（`npm run typecheck` 由 **rc=2 → rc=0**，四处全清）：

| 位置 | 病 | 修 |
|---|---|---|
| `CreativePresetPicker.tsx:119` | `importedAll.filter` —— 上面那条，整屏空白 | `importedAll.presets.filter` |
| `CreativePresetPicker.tsx:163` | 给 `PresetImportPanel` 传 `onClose`，人家要 `onBack` → 「返回」那颗按钮 `onClick` 是 `undefined`，**永远点不动**（不报错、不崩，最难发现的那种） | 改 `onBack`，并补上 `onPicked`（导入完直接跳到那一组） |
| `CreativePresetPicker.tsx:240` | 自定义预设对象缺 `preview`（类型必填） | 补 `preview: ''` |
| `GenerateDock.tsx:1836` | 传 `favorites={string[]}`，prop 声明是 `Set<string>` | prop 改成 `readonly string[]` —— **以真值源为准**（`readPresetFavorites()` 就是数组），不是在调用处包一层 Set 去迁就声明 |

> 📌 这三条是同一个毛病的三种长相：**「运行时不炸但功能是死的」**。
> 类型检查能抓到全部三条，而 `npm run build`（vite 只转译）一条都抓不到 ——
> 所以 `typecheck` 红了不能当没看见，也别用「build 是绿的」糊过去。

### 形态：画布 │ 预设栏 │ 节点参数（徐先选的那条）

上一版写的是 `position: fixed; right: 0; width: 420px; z-index: 70` —— 那是**浮层**，
会整个盖住右侧参数栏。徐先要的是「显示在节点旁边、不用跳转新界面」，所以改成真并排：

- `CanvasEditor` 在 `.cv-stage` 与 `<NodeInspector>` **中间**摆一块
  `<div className="cv-preset-slot" />`，CSS 就一条 `display: contents` ——
  这一层自己不生成盒子，portal 进来的那一栏于是**直接成为 `.cv-body` 的 flex 子项**，
  顺位由 DOM 顺序决定，不用 `order` 去绕。
- `CreativePresetPicker` 的 portal 宿主从 `.flow-shell` 换成 `.cv-preset-slot`。
  ⚠️ 别再挂回 `.flow-shell`（那是浮层时代的宿主，会盖住参数栏），
  也别挂 `body`（取不到 `cv-*` 变量，会变成一块没配色的白板）。
- 宽度 `calc(360px * var(--ui))`，跟 `.cv-inspector` 一个规矩。

**真机实测（1440×900、`--ui` 0.9）**：

| 状态 | `.cv-stage` | `.cv-cpk-sidebar` | `.cv-inspector` |
|---|---|---|---|
| 没开预设 | `0 → 1098` | — | `1098 → 1440` |
| 开着预设 | `0 → 774` | `774 → 1098`（324px = 360 × 0.9） | `1098 → 1440` |

三块**严丝合缝、零重叠**（`stage.right === sidebar.left`、`sidebar.right === inspector.left`），
`position: static`。画布让出 324px，参数栏一动不动。

### 顺手修的几处（都在这一栏里）

1. **分类胶囊从横向滚动改成换行**。`overflow-x: auto` 在 360px 里等于
   「最后一颗永远被切一半」+「藏在滚动里的分类等于不存在」。现在是 `flex-wrap: wrap`
   （实测 6 个分类排成 2 行 74px，`scrollWidth === clientWidth`，不裁）。
2. **底栏装了「已选 N 条」会断在数字中间** —— 给计数那句 `white-space: nowrap` +
   底栏 `flex-wrap: wrap`，装不下就让按钮**整块**换到第二行贴右。
3. **卡片去掉 `overflow: hidden`**。圆角改用 `.cv-cpk-thumb` 自己那条 `border-radius`
   （`border-radius` 本来就会裁自己的背景，不需要裁子孙）。理由见 MEMORY：
   Electron 里「会裁剪的祖先 + 几十上百张被缩放的 webp」会被合成器画成一片横纹，
   这一栏一屏就是 60 张卡。
4. **收藏星标去掉 `backdrop-filter: blur(4px)`** —— 每张卡一颗，一屏 60 个模糊图层；
   改成 `rgba(0,0,0,.55)` 的实底。顺带把 `.5` 提到 `.55`。
5. **自定义预设的缩略图**：原来是 45° 斜纹占位（每张自定义卡长得一模一样），
   改成把用户写的那句提示词铺上去。（实测注：自定义预设目前只作为标签挂到节点上、
   不进卡片网格，所以这一支是兜底路径 —— 但导入的条目缺图时走的就是它。）
6. **补上 Esc 关闭**。上一版把模态框拆掉时把 Esc 一起丢了，注释里还写着
   「想关有右上角 ×、Esc、点遮罩三条路」—— 实际一条都不在。
   现在挂 `window` **捕获阶段**（跟 `CanvasDrawer` / `CanvasContextMenu` 同一套写法），
   两级语义：导入子面板开着时先回列表、再按一次才关整栏。
   ⚠️ **不学 `CanvasDrawer` 那条「焦点在输入框里就放行」的例外**：抽屉里那是因为输入框自己
   认 Esc（取消改名），这儿的搜索框不认 —— 放行的话「搜了一半想退出来」按 Esc 毫无反应。

### 真机验过的行为（都是真事件，不是读元素属性）

- **Esc**：`Input`/`KeyboardEvent` 派真 keydown → `sidebar: null`、`.cv-stage` 弹回 1098 ✅
- **星标不冒泡**：点星标 → 卡的 `on` 仍是 `false`、星标 `on: true`；取消后
  `localStorage['frame.preset-favorites']` 回 `null` ✅
- **点卡片 → 再点一次撤销**：标签从 `[]` → `[{style, style-643}]` → `[]` ✅
- **导入子面板的「返回」**：`hasImportPanel` true → 点一下 → false，回得到列表 ✅
- **运镜 tab**：51 条，卡片用的是 `poster` 静帧（不是拿 `.mp4` 当 `<img>`）✅
- **自定义加一条**：`已选 1 条` + 底部出现「清除运镜」✅

> ⚠️ **探针污染**：这一轮探针往他项目里那颗「视频/音频生成」节点上写了一条自定义预设。
> 收尾跑已经清干净了（`收尾脏标签 []`），下一棒跑交互类探针要记得**留一步回滚**。

> ⚠️ **探针坑（第二类）**：`Runtime.evaluate` 求值 Promise 必须带 `awaitPromise: true`。
> 少这一条时 `fetch('/api/projects')` 那个表达式返回的是 Promise 对象、`value` 是
> `undefined` → `location.hash = '#/projects/undefined'` → 页面没工程 → 后续全是
> `no-entry` / `SELECT null`，看着像「功能没做出来」，其实只是探针自己拿错了 id。

截图（`design-previews/2026-10-07-预设栏三栏并排/`）：
崩溃复现、深色-风格、深色-运镜、深色-已选一条、亮色-风格、导入子面板。

---

## 追加（同日 23:20）· 徐先两条：深色主题改深灰 / 三入口加低饱和色

原话：「**深色主题改为深灰色**」「这里的三个选项**添加不同的低饱和度颜色**」。

### ① 深色改成真正的中性灰

**病根不是「不够亮」，是「偏蓝」。** 原来那一族深色（`#0F1419` / `#1A1F26` / `#222832` …）
蓝通道**恒比红通道高 10** —— 15/20/25、26/31/38、34/40/50，是一条等差的蓝偏，
所以整块画布看着发蓝、像夜景而不是中性工作台。改法就是把三通道压到 **差 ≤ 5**。

画布（`tokens.css`，深色块 —— 含挂 `<html>` 的 `[data-canvas-theme="minimal"][data-theme="dark"]` 那份，两处同改免得打架）：

| 令牌 | 改前 | 改后 | 实测（真机 computed） |
|---|---|---|---|
| `--cv-bg` | `#0F1419` | `#1B1C1F` | — |
| `--cv-floor` | `#0F1419` | `#1B1C1F` | `rgb(27,28,31)`，**通道差 4**（原来是 10） |
| `--cv-panel` / `--cv-card` | `#1A1F26` | `#2A2B2F` | `rgb(42,43,47)` |
| `--cv-elev` | `#222832` | `#33343A` | — |
| `--cv-panel-2` / `--cv-field` | `#151B22` | `#212225` | — |
| `--cv-float` / `--cv-float-strong`（顶栏、右上圆钮） | `rgba(26,31,38,.98)` | `rgba(42,43,47,.98)` | `rgba(42,43,47,.98)` ✅ |
| `--cv-accent-ink` / `--cv-node-opposite` / `--cv-media-bg` / `--cv-media-solid` | `#0F1419`/`#1A1F26` | `#1B1C1F`/`#2A2B2F` | — |
| `--cv-dim` | `#B4B8BC` | `#B9BBBF` | — |
| `--cv-placeholder` | `#646668` | `#6E7075` | — |
| `--cv-handle-bg` / `--cv-handle-line` | `#222832`/`#4A4F55` | `#33343A`/`#55575C` | — |
| `--xy-minimap-mask-background-color` | `rgba(15,20,25,.85)` | `rgba(27,28,31,.85)` | — |
| `--xy-minimap-node-background-color` | `#1A1F26` | `#2A2B2F` | — |

全局（`globals.css`，同一条道理 —— 原来是 `#25272e`/`#2a2c34`/`#31333c`/`#3a3c45`，蓝比红高 7~11）：

```css
--bg: #26272A;            --bg-canvas: #16171A;
--surface: #2D2E32;       --surface-2: #35363A;    --surface-3: #3E3F43;
--surface-glass: rgba(45, 46, 50, 0.92);
--field: #222327;         --well: #1E1F22;
```

- **未动**：`--cv-line*`（分隔线，测量良好）、`--xy-minimap-node-stroke-color`、`--cv-shadow-*`。
- **亮档零影响**（实测）：`--cv-bg #FAFBFC` / `--cv-panel #FFFFFF` / 地板 `rgb(250,251,252)` /
  顶栏 `rgba(255,255,255,.98)` —— 与改前一致，深色那次替换没越界。

### ② 三个创作入口各一支低饱和色

**方案：一个中间变量。** `[data-entry]` 只负责把 `--entry` / `--entry-soft` / `--entry-line`
指到对应那支色上；`.entry-icon` 与 `.entry-cta` **只写一次**、统一读这三个变量 ——
以后再加第四个入口，加一条 `[data-entry='x']` 就够了，不用去动图标规则。

| 入口 | `data-entry` | 深色档 | 亮色档 |
|---|---|---|---|
| 画布 | `canvas` | `#8FA3C4` 雾蓝 | `#4E6484` |
| 图片生成 | `image` | `#C78EA6` 灰玫 | `#96566F` |
| 资产库 | `assets` | `#CBB083` 沙金 | `#836628` |

> ✅ **这三支不是新造的色，跟既有的「节点类型色」是同一组 hex** ——
> `nodes.css` 的 `--cv-node-kind`：`#8fa3c4`（文本节点）、`#c78ea6`（图片节点）、
> `#cbb083`（音频输入节点）。所以首页与画布是**同一套色感**，不是两套并行的体系。
> 以后要调这三支，先看一眼 `nodes.css` 那 17 条 —— 改一边不改另一边就会散。

- soft（图标洗底）= 同色 `rgba(...,.12)`（深）/ `.08`（亮）；line（图标描边）= `.30` / `.26`。
- **亮色档要压深到正文级**，否则浅底上那三支色发飘、对比度不够。
- 悬停：`background: var(--entry-soft)`（一层同色系极淡洗底），**不是**换成中性面 —— 换中性面
  等于把「这张卡属于哪一支色」这个信息在交互时抹掉了。

> ⚠️ **`workspace-home.css` 那一层必须读同一组变量、不许写死 `var(--surface)`。**
> 它的选择器 `.home .entry-icon` 是（0,2,0），**压得住** `start.css` 的 `.entry-icon`（0,1,0）——
> 写死一次那三支色就全被吃掉了，而且**没有任何报错**，只是看着「颜色没生效」。
> 这正是「JSX 有类名、CSS 零命中」那类病的近亲：**规则在，但被更近的一条盖住。**

### ③ 验收

- 对比度：`_contrast.py` 算了 **19 对，不合格 0**。最紧的一对是
  **全局弱文 `#a6abb6` 压 `--surface-3 #3E3F43` = 4.57:1**（线上通过、但没余量）。
  🔴 **以后再把 `--surface-3` 提亮，`--text-mute` 必须跟着提** —— 这条已写进 `globals.css` 注释。
  三支入口色 5.07 ~ 6.51 全过。
- 真机宽：`documentElement.clientWidth = scrollWidth = bodyScrollWidth = 1430`，
  `.home *` 里越界元素 **0 个**（深、亮两档都查了）。
  主页那条滚动条是**主内容区的纵向滚动条**，不是横向溢出。
- **全站巡检（`_gray-pages.js`，读侧栏真实 href 逐个点进去）**：资产库 / 设置-ComfyUI / 图片分割
  三页深色档实测 `body rgb(38,39,42)`、`.sidebar rgb(45,46,50)`、`input rgb(34,35,39)`、
  `button rgb(53,54,58)` —— 与令牌一一对应；**「仍然是发蓝的近黑」的元素 0 个**
  （判据：`B − R ≥ 8` 且亮度 < 90 的不透明底）。亮档同页 `rgb(255,255,255)` 未受影响。
- 截图：`design-previews/2026-10-07-深灰主题+三入口色/`（画布-深/亮、主页-深/亮、
  资产库-深/亮、设置-ComfyUI-深、图片分割-深）。

---

---

## 追加（同日 23:55）· 徐先三条：logo 变大变亮 / 收纳钮挪到页头最右 / 加载的界面全部优化

来源是他两张截图原话：「这里有一个图标，位置变一下，这里的 logo 图标变大变亮一点；
加载的界面优化一下」。三条方向都由他选：**收纳钮 → 页头最右端**、**加载界面 → 所有三处**、
**启动画面 → 保持居中标，把它做厚**。

### ① logo：真因不是「不够亮」，是素材换过而 CSS 没跟着走

`src/assets/logo.png` 在 10-07 17:18 换过：旧的图形是**深色**的，新的（三角 + 三节点）是
**浅色**的（不透明像素亮度实测 160~224）。而 CSS 里还留着给旧图写的 `filter: invert(1)`，
把新图反相成亮度 **85** 的深灰 —— 压在侧栏底 `#2D2E32`（45）上只有 **1.6:1**。

| 档位 | 改前 | 改后 | 实测对比度 |
|---|---|---|---|
| 深色 | `invert(1)` / 18px | **`filter: none`** / **24px** | 1.6 → **4.73:1** |
| 亮色 | `invert(1)` / 18px | **`brightness(0.6)`** / 24px | 2.56 → **4.29:1** |

亮色档**不能用 invert**（会把那三支低饱和节点色翻成互补色），只能用 brightness 压暗。
logo 按**图形元素**判 3:1，实测两档都过且有余量。

修 logo 时发现的第二半 bug（同一个病的两副面孔）：

- `globals.css` 的 `--logo` 内联的是 **63KB 旧 logo 的 base64**；
- `workspace-home.css` 里另有一条 `!important` 覆盖，指向**新文件**；
- 结果就是「**首页显示新 logo、其它页显示旧 logo**」—— 同一个软件两个标。

→ `--logo` 改回 `url('../assets/logo.png')`（走打包器发哈希资源，换 logo 只换一张图），
删掉那条 `!important`。注意相对路径是**相对 CSS 文件**算的：`src/app/globals.css` +
`../assets/` = `src/assets/`。

### ② 收纳钮：挪之前先发现 `.workspace-title` 这个 class 在整份 CSS 里零命中

按钮原来写在 `<div className="workspace-title">` 里，和 `<h1>` 一起 —— 而这个 class
**全库 grep 得 0**（JSX 有类名、CSS 零命中，是「同类病」的又一变体）。`<button>` 与 `<h1>`
都是块级、上下堆叠 → 按钮跑到标题**上方**、并探出页头顶边（实测 `y = -5`）。

按他选的方向挪成页头**最后一个孩子**，并照画布顶栏 `.cv-balance-slot` 那套显式摆一个
`[data-balance-slot]` 卡槽 —— 因为余额是 portal **追加**到页头末尾的，不摆卡槽的话它会
排在收纳钮**后面**，收纳钮永远到不了最右端。

**踩到的新坑：`display: contents` 的元素自己不生成盒子，写在它上面的 `margin-left: auto`
等于没写。** 首页第二个孩子正是那个 `display: contents` 的余额卡槽，于是 globals 那条
`> :nth-child(2) { margin-left: auto }` 静默失效。改成「**第一个孩子吃右侧剩余空间**」
（`.workspace-title { margin-right: auto }`）。

实测通过 —— 首页页头三兄弟与资产页**逐项一致**：

```
首页  kids = [1] workspace-title(x=277,y=12) | [2] home-balance-slot(display:contents,x=0,w=0) | [3] nav-toggle(x=1243, right=1277)
资产页 nav-toggle = x=1243 / right=1277   ← 完全一致
```

顺手修了旁边一个会让用户误会的：`{user && <span>{list.length} 个项目</span>}` 少判了
`projects !== null`（那是「还在读」的信号），读盘过程中会在「正在读取项目…」旁边显示
**「0 个项目」** —— 用户读到的不是「稍等」，而是「我的项目全没了」。

### ③ 加载的界面（他选「所有」）—— 三处，各自的原因不同

| 位置 | 改前 | 改后 |
|---|---|---|
| `index.html` 启动画面 | 「正在启动…」、88px 标、168×2 进度条 | 「**正在准备你的工作台…**」、112px 标、220×3 条带 mask 拖尾 |
| `home.css` 首页骨架屏 | `background: var(--bg)` | 新令牌 `--skeleton` + 扫光 + 三张卡错相位 |
| `projects/[id]/page.tsx` 画布载入 | 居中 ✦ +「正在打开画布…」 | 与真画布**同构**的空壳（顶栏 / 左侧工具条 / 三个节点位） |

首页骨架屏原来用 `var(--bg)`：**深档 1.07:1 且方向是反的**（比周围更暗，看着像挖了三个洞），
亮档更糟 —— `--bg` 和 `--surface` 都是 `#ffffff`，对比度**为零**，等于没画。

**新坑：`--skeleton` 用 `color-mix(in srgb, var(--text) 12%, transparent)` 会被
electron-vite 的 CSS 压缩器配一份错的 `@supports` 兜底** —— 产物里实测到
`--skeleton: var(--text);`（比例整个丢了，渲染出来是一颗实心文字色的药丸）。
→ **改用写死 alpha 值**（深 `rgba(255,255,255,.10)` / 亮 `rgba(0,0,0,.11)`）。

画布载入那一处刻意**不画右侧参数栏**（真画布刚打开没选中节点，参数栏本来就不出现，
画上去等于自己造一次布局跳动），也不画地板点阵（实测量出对比度太低，加了会在切换瞬间露馅）。
外壳挂在 `.flow-shell` 上而不是自己写底色，这样自动跟着主题与画布配色走。

### ④ 启动画面：埋点暴露出一个真 bug（不修的话「做厚」白做）

这块牌子撤得太快，两次连拍都落在它已撤之后，「到底亮没亮过」没法证 —— 于是加了
`window.__bootTrace` 计时埋点。数据出来发现：

```
本机热启动：script@43ms → reveal@224ms → done@373ms
```

**牌子亮出来 150ms 就被撤掉了** —— 那是「闪一下」，比压根不出现还难看。原来
`REVEAL_MS = 180` 把「快启动」门槛划在了 180ms，而热启动实际要 ~370ms 才完事。

→ `REVEAL_MS 180 → 400`（这么久还没好才亮出来）+ 新增 `MIN_VISIBLE_MS = 450`
（一旦亮出来至少待这么久）。fast path 从此**完全不出现**，慢的时候才稳稳亮一小会儿。

验收手法值得记一笔：**用 CDP 的 Fetch 拦截把 `/api/auth/me` 按住**，人为把启动变慢，
牌子才会真的亮出来给你量。

```
BOOT_SLOW_LATE  opacity=1, mark 113×113, name 15px/600/ls 5px, bar 220×3 带 mask, tip「正在准备你的工作台…」
BOOT_AFTER_RELEASE gone:true（trace 有 done@2280ms）
BOOT_FAST          reveal(skipped)  ← 热启动完全不出现 ✅
BOOT_SLOW_LIGHT    opacity=1        ← 亮色档同样验过
```

### 本轮改动文件（7 个）

`globals.css`（logo 尺寸/滤镜/`--logo` 图源/新增 `--skeleton` 两对令牌）·
`workspace-home.css`（删 `!important` 覆盖 + 首页页头靠右规则）·
`home.css`（首页骨架屏）· `index.html`（启动画面 + `__bootTrace` 埋点 + 时间常数）·
`page.tsx`（收纳钮移位 + 余额卡槽 + 修「0 个项目」）·
`projects/[id]/page.tsx`（画布载入骨架）· `canvas/layout.css`（`.cv-boot-*` 整段 + 修一条过期注释）

`typecheck rc=0` / `build rc=0` / `pack rc=0`；产物 `app.asar` 里确认新符号全进包
（`cv-boot-node` 7 / `home-balance-slot` 2 / `正在准备你的工作台` 1 / `__bootTrace` 2 / `skeleton-sheen` 5）。
截图：`design-previews/2026-10-07-logo与加载界面/`（11 张）。

---

---

## 追加（2026-10-08 01:00）· 徐先两条：侧栏「形态切换」/ 首页入口卡显眼一点

他给了两张截图：一张是**别的软件**的窄图标侧栏（红圈圈的是整条侧栏的形状），
一张是自己首页「创作」那三张入口卡。原话：「侧边栏形态切换」「卡片选项比周围颜色稍微显眼一点」。

三条方向都由他选：**收起 = 窄图标条（同参照图）** · 窄条里**只留图标 + 悬停出提示** ·
入口卡走**底色 + 描边**。

### ① 侧栏：收起从「整条滑出屏幕」改成「窄图标条 56px」

改之前 `html[data-nav='collapsed']` 是 `--nav-w: 0px` + `transform: translateX(-100%)`
—— 收起来什么都不剩，导航还在不在、该往哪点全靠记。

**顺手修掉一个既有 bug**：那条规则写的是 `.shell:not(.home-shell)`，
**把首页 / 项目列表排除在外**了 —— 这两页点收纳钮**根本没有任何反应**
（侧栏一动不动，只有按钮上的图标翻了面）。现在统一成 `.shell`，首页跟着生效。

窄条的形态规则（都在 `globals.css` 同一段里）：

| 元素 | 展开 | 收起（窄条） |
|---|---|---|
| `--nav-w` | 248px | **56px**（`--nav-rail-w`，只此一处） |
| `.sidebar` 内距 | `22px 16px` | `22px 10px`（内容区 36px） |
| `.sidebar .brand` | logo + 名字 | **只留 logo**，居中 |
| `nav a` | 图标 + 标签，左对齐 | **只有图标**，居中，高 33px |
| `nav a.active` | 2px 竖条 + 文字变亮 | **整块 `--accent-soft` 底**（没文字可亮，竖条太弱） |
| `.nav-group` | 「实用工具 STUDIO TOOLS」+ 横线 | **一条 20px 居中的短横线** |
| `.side-user` | 头像 + 昵称 + 账号，215×52 | **只有头像**，36×36 圆形按钮 |

实测（1440×900，`--ui = 0.9`）：

```
展开：sidebar 248 / nav a 215 / 9 项 title 全 null / workspace.x 248
窄条：sidebar  56 / nav a  35 / 9 项 title 齐全 / workspace.x  56 / 溢出 1px
```

**手法是 `font-size: 0`，不是给文字包 `<span>`**：`SideNav.tsx` 的标签是裸文本节点，
`.brand` 那半截也是（而且散在十几个页面里）。`font-size: 0` 让它们缩成 0×0，
而图标是 `<svg width/height>` 固定尺寸、`.brand-mark` 写死 24px —— **都不受影响**。

🔴 **但这个手法有一个必须先想清楚的边界：显式声明过的 `font-size` 不会继承父级的 0。**
第一版就栽在这里：`.nav-group em`（拉丁副标「Studio tools」）自己有一条 `font-size: 9px`，
父级写 `font-size: 0` 它照样有 9px 宽 —— 实测那串「STUDIO TOOLS」（含 0.16em 字距）约 **82px**，
于是这条 grid 的列被撑到 **97px**：整条侧栏横向溢出 **52px**，
导航图标被推到 56px 的侧栏**外面**（`iconCenterDelta` 还是 0，因为它只证明"图标相对导航项居中"，
**导航项自己溢出了它不知道**）。
→ 那一处必须 `display: none`。**验收时量的是 `scrollWidth − clientWidth`，不是图标是否居中。**

另两个同批次的必要零件：

- `.sidebar` 要显式 `overflow-x: hidden`：它顶上那条 `overflow-y: auto` 按规范会把另一个方向
  也变成 `auto` —— 收窄过程中文字横着溢出去，侧栏底下会长出一条横向滚动条。
- 小屏（≤720px）侧栏本来就是**横向换行的带子**，窄条那种竖排形态在那里没意义 ——
  那一档要把上面整套形态规则**逐条还原**（选择器与上面逐字相同，靠位置靠后赢）。

悬停提示走**原生 `title`**（`SideNav.tsx` 里读 `appearance.navCollapsed` 决定加不加）。
🔴 **展开态故意不给**：名字就在图标旁边，再叠一个一模一样的系统气泡是噪音，
而且它晚 1 秒才弹、正好盖住你要点的东西。
🔴 没做自定义浮层的原因：`.sidebar` 的 `overflow-x: hidden`（见上）会把往右弹的浮层裁掉，
要绕开就得把提示用 `position: fixed` + JS 定位重做一遍 —— 不值。

### ② 首页三张入口卡：`transparent` → 底色 + 描边

`workspace-home.css` 那条原来是 `background: transparent; border: 0; border-right: 1px solid var(--line)`
—— 三格连成一整块、只靠竖线分格。而首页页面底就是 `--bg`，**卡片和周围完全同色**，
看不出「这是一个可以点的选项」，只像几行字排在那儿。
（`start.css` 给的基础 `.entry-card` 本来就有色面 + 描边 + 圆角，是首页这条覆盖把它抹平的。）

现在恢复基础卡形，**但仍然只改外壳** —— 三支入口色照旧只铺图标块与那行 CTA。
配套把 `.entry-grid` 的 `border-block` 与 `gap: 0` 一起撤掉（那是「连成一整块」那套的零件，
只改卡片不改网格会剩下「三张独立的卡共用上下两条长横线」这种半吊子状态）。

| 档位 | 页面底 | 卡片底 | 差 | 描边 |
|---|---|---|---|---|
| 深色 | `--bg` #26272A (38) | `--surface-2` #35363A (53) | **+15** | `--line` (白 9%) |
| 亮色 | `--bg` #ffffff (255) | `--surface-3` #ededed (237) | **−18** | `--line` (黑 10%) |

🔴 **两档用的不是同一个令牌，这是有意的**：亮档 `--surface-2` 是 #f7f7f7，
压在白底上只差 **8 级**（几乎看不见）；而深档的 `--surface-3` 是 #3E3F43，
压在 #26272A 上差 **24 级**、比侧栏面板还亮，三张卡会像贴上去的膏药。
两档各取「跨过同色系一档」，视觉强度才是接近的 —— **只写一个共用令牌做不到这件事**。

悬停保持原样（各自入口色的极淡洗底），只多补一条 `border-color: var(--entry-line)` ——
卡片有了描边之后，只洗干净底色会留下「卡里是彩色、卡框还是灰的」的中间态。

### 本轮改动文件（4 个）

`globals.css`（`--nav-rail-w` 令牌 + 收纳段整段重写 + 小屏还原）·
`workspace-home.css`（入口卡 + 网格 + 悬停）· `SideNav.tsx`（引入 `useAppearance`，窄条态加 `title`）·
（`start.css` / `entries` 组件**未动** —— 入口色那套变量原样保留）

`typecheck rc=0` / `build rc=0` / `pack rc=0`。
截图：`design-previews/2026-10-08-侧栏窄条+入口卡/`（6 张：展开-首页-深、窄条-首页-深/亮、
窄条-资产页-深、窄条-设置页-深、入口卡-首页-亮）。
探针：`_nav-probe.js` + `_run-nav-probe.py`（测量）· `_nav-shot.js` + `_run-nav-any.py`（截图），都在 `C:/Windows/Temp/`。

全站 `.shell` + `SideNav` 的页面（首页 / 项目 / 资产 / 设置 / 工具 / 用户）都走同一套外壳，
窄条形态一处生效、一处覆盖。**画布是独立布局，没有侧栏，不受影响。**

---

## 追加（2026-10-08 01:20）· 同一个病第二次：项目卡也看不见

徐先：「下面的卡片颜色明显一点」（两张截图都是亮档，红圈圈的是「最近项目」那一片）。
指的不是入口卡 —— 入口卡上一轮已经改好了，**是项目卡还是白的**。

`components/start/project-grid.css` 里那条基础规则：

```css
.home-project { background: var(--surface); border: 1px solid var(--line); }
.home-project-thumb { background: var(--bg); }   /* 封面位 */
```

**和入口卡一模一样的病**：亮档下 `--bg` 与 `--surface` 都是 #ffffff ——
卡片压在页面底上完全同色，边界只剩一圈 10% 黑的描边。

### 修法：两处收拢到一个令牌 `--card-face`

```css
.home { --card-face: var(--surface-2); }
:root[data-theme='light'] .home { --card-face: var(--surface-3); }
```

| 档位 | 页面底 | `--card-face` | 差 |
|---|---|---|---|
| 深色 | `--bg` #26272A (38) | `--surface-2` #35363A (53) | **+15** |
| 亮色 | `--bg` #ffffff (255) | `--surface-3` #ededed (237) | **−18** |

🔴 **入口卡与项目卡必须读同一个令牌**：它们是同一屏里上下相邻的两排卡，
分开写两份迟早会改一边漏一边，然后同一屏出现两种深浅的「卡片」。
（入口卡那边原来写死的两档规则已经删掉，一起改读 `--card-face`。）

同批次顺手修的两个零件：

- `.home .home-project-thumb { background: inherit; }` ——
  `project-grid.css` 里它写的是 `background: var(--bg)`（= 页面底）。
  卡片一旦有了自己的色面，**没缩略图的项目就会出现「上半白、下半灰」的拼色横带**。
- 删掉 `.home .home-project:hover` 里那句 `background: var(--surface)` ——
  它会在鼠标移上去的瞬间把卡片**变回纯白**（比静息的灰更亮），是个反向反馈。
  底色交给静息规则给，悬停只管抬升与描边。

实测（1440×900）：

```
深：pageBg 38,39,42 · projBg 53,54,58 · thumbBg 53,54,58 · entryBg 53,54,58
亮：pageBg 255,255,255 · projBg 237,237,237 · thumbBg 237,237,237 · entryBg 237,237,237
亮-悬停：projBg 仍是 237（没被变回白）
```

像素抽样（亮档项目卡区域）也确认边界清楚：页底最亮、卡片整块低一档、
中间那点是没缩略图时的文件夹图标。

截图：`design-previews/2026-10-08-侧栏窄条+入口卡/项目卡-首页-{亮,深}色.png`。
探针：`_card-probe.js`（配 `_run-nav-any.py`），在 `C:/Windows/Temp/`。

---

## 追加（2026-10-08 01:40）· 原生下拉展开面板：白底压白字

> ⚠️⚠️ **本段的「修法」和「修完实测」是错的，已被下一段（02:00）推翻，保留只为记下误判过程。**
> 一句话：`option` 的 `background` 在 Windows 上**根本不参与绘制**，这里所谓"修完实测 ≈14:1"
> 是拿**注入的假控件**量到的假阳性（量的其实是控件自己的底色）。**以 02:00 那段为准。**

徐先：「深色主题，选项，文字太淡了」+ 一张「优化提示词」的截图。
截图里打开的是「文本模型」那个下拉，展开的一列几乎读不出字。

### 真因不是「颜色选淡了」，是**底没给**

- `<option>` 的 `color` 继承 `select` 的 —— 深色档是近白的 `--text` / `--cv-text`；
- 而展开面板的**底色由浏览器画**。Chromium 在 Electron 里照的是**系统浅色主题**，
  **不认应用自己的 `<html data-theme>`，也不认 `color-scheme: dark`**
  （两档都写了 `color-scheme`，实测在原生下拉上不生效）；
- 而全站**此前一条 `option` 规则都没有**，所以这个坑对每一个原生下拉都成立。

从原截图取样（`_rowmax.py`）：

```
底 (255,255,255) ／ 字 (242,243,246)   →  对比度 1.05:1   ← 白底白字
```

### 修法：把底也写出来

```css
/* globals.css */
select option { color: inherit; background: var(--field); }
/* canvas/controls.css */
.cv-select option { color: inherit; background: var(--cv-field); }
```

用 `--field` / `--cv-field` 而不是另挑一个浮层色：**`--field` + `--text` 这一对
是输入框本来就在用的组合**，对比度早验过，深浅两档都不会翻车；
下拉面板自带边框与投影，不会因为底跟输入框一致就「陷进去」。

修完实测（真·原生面板，见下面的验证手法）：

```
普通项  底 (34,35,39) = --field ／ 字 (242,243,246) = --text   →  ≈14:1
选中项  底 (45,46,50)（Chromium 自己的高亮）／ 字 (153,200,255)  →  够用，先不干预
```

### 🔴 验证手法：`Page.captureScreenshot` **能抓到原生下拉面板**

一开始以为抓不到（Windows 上 select popup 传统上是独立窗口），实测**能抓到** ——
这个 Electron 版本（44.4.2）里它落在可截取的合成层内。办法：

1. 往页面里注入一个 `<select>`，固定摆在一个好算坐标的位置；
2. `Input.dispatchMouseEvent` 发一对 **真实的** `mousePressed` / `mouseReleased` 把它点开；
   （用 `sel.matches(':open')` 确认真的开了 —— 顺带说明这个 Chromium 认得 `:open`，
   也就认得 `appearance: base-select`，以后要彻底接管下拉有这条路）
3. `Page.captureScreenshot` 存下来，再用 `_rowmax.py` 逐行取「最亮像素（文字笔画）」与
   「最暗像素（底）」，两边一减就是对比度。

不用去抓整个屏幕，也不用写自定义下拉。

---

## 追加（2026-10-08 02:00）· 原生下拉：上一轮是假阳性，这一轮才真修对

徐先：「这里还没什么变化」+ 同一处截图（还是白底白字）。
先核查过：**他跑的就是带上一轮修复的包**（进程 00:59:57 起、asar 00:56:14 打，
那两条规则在 asar 里各命中 1 次），所以是**真没生效**，不是没重启、没打包。

### 我上一轮错在哪（这条比结论更值得记）

上一轮"实测通过"的数据，是用 **CDP 往页面里注入的一个裸 `<select>`** 量出来的。
那个控件挂在 `document.body` 下 —— 而 `--cv-field` 只在 `.canvas-studio` 作用域里有值，
**body 下是空的**，于是 `option { background: var(--cv-field) }` 整条落到 `unset`，
量到的 `(34,35,39)` 其实是 **UA / `--field` 自己的底色**，不是"我的规则生效了"。
`_rowmax.py` 逐行取最亮/最暗也确实取到了颜色 —— 只是取错了对象的颜色。

**教训：验收对象必须是用户真机上那一个**（真面板、真宿主、真数据目录）。
拿自己造的同名控件自证，特异性或继承链一变，结论就全是假的。

### 真因（两层，少一层都解释不通）

① **Windows 上展开面板是「操作系统菜单」画的。** Chromium 只把「文字 / 选中态」交给菜单，
   `option` 的 `background-color` **根本不参与绘制**（Chromium issue 41281328，2016 挂到现在）。
   于是 `color: inherit` 生效了、`background` 没有 → 白底压近白字（1.05:1）。
   `color-scheme: dark` 也救不了 —— 它不等于系统主题。

② **节点内 `--cv-field` 是无效值。** `nodes.css:237` 写着 `--cv-field: var(--cv-node-field)`，
   而 `--cv-node-field` **全库没有定义**（唯一那条 `--cv-node-field: var(--cv-node-field-custom,
   var(--cv-field))` 随作废的 `canvas-original.css` 一起没了）。
   实测：节点内 `getPropertyValue('--cv-field')` 返回**空串**，右侧检查器里返回 `#212225`。
   → 节点内任何 `var(--cv-field)` 的背景/底色都落 `unset`（＝透明），
   连「节点里的输入框」本身也是透明的（只是节点底本来深，肉眼看不出来）。

### 正路：`appearance: base-select`

本机 Chromium **152**（Electron 44.4.2），`CSS.supports('appearance','base-select')` 为真。
它把 select 切成**全 CSS 可控**模式，展开面板从原生菜单变成**网页自绘的 `::picker(select)`**
—— `option` 的底归我们了，而且它成了真 DOM，**截图截得到、能验**。

```css
@supports (appearance: base-select) {
  .cv-select { appearance: base-select; white-space: nowrap; }
  .cv-select::picker(select) { margin-top: 4px; padding: 4px; background: var(--cv-float); /* … */ }
  .cv-select option { background: var(--cv-float); color: var(--cv-text); white-space: nowrap; }
  .cv-select option:hover { background: var(--cv-line); }
  .cv-select option:checked { background: var(--cv-accent-soft); color: var(--cv-accent); font-weight: 500; }
}
```

### 三个反直觉的点（全踩了）

1. **`::picker(select)` 自己的 `background` 渲染时不生效。**
   computed 读出来是 `rgba(42,43,47,0.98)`，但注入 `background: red !important` 也不变色 ——
   渲染出来永远是 UA 的白。**真正顶用的是 `option` 自己的底。**
   （中间态 `bsC-node.png` 就是：option 透明 → 露出 picker 的白 → 看起来跟没修一模一样。）

2. **兜底条的位置是命门。** 给不认 `base-select` 的平台留的兜底
   `.cv-select option { color: inherit; background: var(--cv-field); }`
   与 `@supports` 里那条**特异性相同**（都是 0,1,1）→ **同特异性后写的赢**。
   它一开始排在 `@supports` **后面** → 把 `var(--cv-float)` 整个盖掉 → 节点内又透明 → 白。
   **必须写在 `@supports` 之前。**
   最迷惑人的是：检查器那个反而正常（那边 `--cv-field` 有值），
   于是看起来像"打包 vs 注入"的玄学差异 —— 其实是级联顺序。

3. **底取 `--cv-float` 而不是 `--cv-field`。** `--cv-float` 是浮层专用令牌、两档都有值
   （深 `rgba(42,43,47,.98)` / 浅 `rgba(255,255,255,.98)`），且定义在 `.canvas-studio` 上、
   **在 `.cv-node` 里照样继承得到**；`--cv-field` 在节点内无效（见真因②），拿它做底必白。

### `white-space: nowrap` 不能省

`base-select` 下 select 里显示的是选中项文字的**克隆**，长文字会**换行**把下拉撑成两行
（实测 35px → **57.6px**）；原生下拉是截断的。加上之后回到 36.8px（+1.8px，可接受）。

### ✅ 这轮的验证手法（值得抄）

**不看 computed style，看像素。** 这轮所有"computed 说深、渲染是白"的坑都是靠采样破的：

- ⚠️ `Page.captureScreenshot` 出来是 **1440×900**，而工具里看到的是缩放版 ——
  按显示坐标采样会**全部落在画布上**（第一轮就是这么采的，6 张图采出同一个色）。
- 采样用 PIL（装在 `~/.workbuddy/binaries/python/envs/default`）；
  对可疑区域取一列/一片像素看**主色**：

```
bsC-node.png（修前）  →  (255,255,255)                      白
bsD-node-dark.png     →  (46,47,51)  = rgba(42,43,47,.98) 叠深底   ✓
```

- 展开 picker 必须**确认 `:open === true`** 才算数：`Input.dispatchMouseEvent` 点中心不稳
  （同一段代码一次成功、一次失败），**`focus()` + 键盘 `ArrowDown` 是稳的**；
  `showPicker()` 不行 —— 要用户手势，报 `NotAllowedError`。

### 打包产物的真机验收（不注入任何东西）

| 位置 | 档 | popup 主色 |
|---|---|---|
| 节点内（徐先截图那处） | 深 | `(46,47,51)` ✓ |
| 节点内 | 浅 | `(255,255,255)` ✓ |
| 右侧检查器 | 深 | `(41,43,47)` ✓ |

两处都是深底 + 亮字，选中项蓝底白字（`--cv-accent-soft` / `--cv-accent`）。

### 本轮改动文件（2 个）

`canvas/controls.css`（整段重写 + 兜底条挪到 `@supports` 之前）·
`globals.css`（注释更正为"这条在 Windows 上无效"，规则保留给别的平台）。
`build rc=0` / `pack rc=0`。
截图：`design-previews/2026-10-08-下拉面板底色/`（旧假阳性证据已挪进 `_作废-上轮假阳性/`）。
探针：`bs_probe.js` … `bsD_probe.js`（在 `WorkBuddy/2026-09-28-21-27-40/.workbuddy/tmp/`）。

---

## 追加（2026-10-08 02:15）· 下拉里的长文字溢出到框外（`nowrap` 只治了一半）

徐先截图：「字段长度超出文本框了」—— 「文本模型」那条下拉里
`自动（跟随设置 · 本地 · Qwen3.5-4B-UD-Q4_K_XL）` 顶出框外，压到旁边「改写幅度」那一格。

**是我上一轮自己造的**：给 `.cv-select` 加了 `white-space: nowrap` 治「长文字换行把下拉撑成两行」
（35px → 57.6px），**却没同时让它截断** —— 不换行又不裁，就直接溢出去了。
原生下拉本来是截断 + 省略号的，`base-select` 一接手这个默认行为就没了。

修法两行，都在 `@supports (appearance: base-select)` 里跟 `nowrap` 绑在一起：

```css
.cv-select { appearance: base-select; white-space: nowrap;
             overflow: hidden; text-overflow: ellipsis; }
```

### ⚠️ 别拿 `scrollWidth` 当验收

它报的是**内容**宽度，**裁没裁都不变**（裁完还是 321 / clientWidth 240，溢出 81）。
这一条差点又把我带成假阳性。

真正能定案的判据是 **`elementFromPoint`**：溢出来的那段文字，命中测试**仍然归那个 select**
（Chrome 的 ink overflow 参与命中测试）。所以往框右边界外打几个点，看归谁：

| | 框外 +2px | 框外 +6px | 框外 +10px | 框内 −6 / −12 / −20 |
|---|---|---|---|---|
| 修前 | `SELECT(model)` ← **溢出** | `SELECT(model)` ← **溢出** | `SELECT(strength)` | 本 select |
| 修后 | `DIV.cv-param-opts` | `DIV.cv-param-opts` | `SELECT(strength)` | 本 select ✓ |

框内那三点仍归本 select → `::picker-icon`（箭头）没被 `overflow: hidden` 裁掉。
（这三点也顺带证明"修后不是把整个框搞没了"。）

### 走过的弯路（三条，都是像素取证翻车）

1. **整图 `captureScreenshot` 的坐标对不上 `getBoundingClientRect`** ——
   拿 rect 去整图采样，那一整行几乎全是底色；而且两张整图之间还有别的重绘，
   diff 落点分散到 y=303 / 667 去了。**别拿"改前/改后整图 diff"当证据。**
2. **`clip` 截图也不可靠** —— 给 select 打了品红内描边想定位框，结果品红只出现在
   上下两条边（base-select 的盒模型跟普通元素不一样）。坐标换算这条路整体放弃。
3. `bsE` 那版注入 `overflow:hidden` 后两张图**像素完全一致**，一度以为修法无效 ——
   其实是那两点差异只有 ~7px 宽，被邻格自己的字淹没了。**判据选错了就会得到假阴性。**

### ✅ 打包产物验收（不注入任何东西，asar 01:51）

| 落点 | 档 | overflowX / text-overflow | 框外归谁 | 框内归谁 |
|---|---|---|---|---|
| 节点内（徐先截图那处） | 深 | `hidden` / `ellipsis` | 容器 ✓ | 本 select ✓ |
| 节点内 | 亮 | `hidden` / `ellipsis` | 容器 ✓ | 本 select ✓ |
| 右侧检查器（滚进视口后） | 深 | `hidden` / `ellipsis` | 容器 ✓ | 本 select ✓ |

### 顺带查清的一件事：popup 里「选中那一项」是**浅蓝底 + 深灰字**

渲染出来 `(153,200,255)` / `(59,59,59)`，跟我们写的 `--cv-accent-soft`（10% 透明蓝）
**对不上** —— computed 明明是 `rgba(96,165,250,0.1)`。是 Chromium base-select 的 UA
绘制盖在上面（我们的底只有 10% 不透明度，压不住它）。

**跟这一改无关**：把 `overflow` 临时改回 `visible`，同一坐标像素**一模一样**
（见 `展开态-临时改回修法-像素完全一致.png`）。而且鼠标开 / 键盘开都会有，
不是「键盘导航焦点态」。要不要治（把 `option:checked` 的底改成不透明）等徐先定。

### 本轮改动文件（1 个）

`canvas/controls.css`（`@supports` 块里补两行 + 注释写明"`nowrap` 和 `overflow` 是一对"）。
`typecheck rc=0` / `build rc=0` / `pack rc=0`。
截图：`design-previews/2026-10-08-下拉文字溢出/`（5 张）。
探针：`bsE` … `bsL_probe.js`。

---

## 追加（2026-10-08 09:00）· 参数只该有一个落点：右侧栏开着就别在卡片下方再画一份

徐先：「优化提示词以及某些其他的节点，打开右侧的节点参数栏，就在参数栏改参数，
不要出现直接显示在节点下方这种问题，关掉节点参数栏才显示在节点下方」
（截图里同一颗节点，参数栏里一份、卡片下方又一份）。

**根因**：同一个 `NodeParamBar` 有**两个渲染点**，只有一条受了约束。

| 落点 | 谁渲染 | 原来受 `inspectorOpen` 约束吗 |
|---|---|---|
| 右侧参数栏 | `NodeInspector.tsx` | —（它就是那个「开着」的定义） |
| 卡片下方浮条 | `NodeCard.tsx` | ❌ **没有** ← 病根 |
| 节点下方对话框（生成节点） | `CanvasEditor.tsx` | ✅ 有（`!inspectorOpen && dockNode`） |

**修法**：把「参数栏是不是真的看得见」做成一个 Context 发给画布上的每一张卡片。

- 新增 `src/components/canvas/paramPanelMode.ts`：`ParamPanelOpenContext` + `useParamPanelOpen()`，
  **默认 `true`**（拿不到 Provider 时宁可不画，也不能两边各画一份）。
- `CanvasEditor` 里定义 `paramPanelOpen = inspectorOpen && !zen`，用 Provider 包住 `<ReactFlow>`。
- `NodeCard` 渲染参数浮条的条件补 `&& !paramPanelOpen`。

⚠️ **两个反直觉的点**：

1. **值必须带 `&& !zen`**，不能只给 `inspectorOpen`。无遮挡模式下 `NodeInspector` 整个不渲染
   （`inspectorOpen && !zen && <NodeInspector …>`），只看开关的话进无遮挡 = 参数栏看不见、
   卡片下方也不画 → **这颗节点的参数一个入口都没有**。
2. 底部那句提示也跟着分了叉：参数栏开着说「参数在右侧」，关掉才说「参数在卡片下方」——
   不然提示本身就在指错地方。

### ✅ 打包产物验收（不注入，逐个数 DOM）

判据是 `document.querySelectorAll` 的条数（`.cv-node .cv-param-bar` / `.cv-inspector .cv-param-bar` /
`.cv-select`），不看截图：

| 状态 | 参数栏 | 卡片下方 | `.cv-select` | 提示文案 |
|---|---|---|---|---|
| 参数栏开着（默认） | 1 | **0** | 3（全在栏里） | 参数在右侧 |
| 点顶栏「节点参数」关掉 | 0 | **1** | 3（全在卡片下方） | 参数在卡片下方 |
| 再点开 | 1 | **0** | 3 | 参数在右侧 |
| 按 Tab 进无遮挡模式 | 0 | **1** | 3 | 参数在卡片下方 |
| 退出无遮挡 | 1 | **0** | 3 | 参数在右侧 |

**`.cv-param-bar` 的总数在五种状态下恒等于 1。** 生成节点那条路也一样：
参数栏开着时 `data-dock-anchor="inspector"`、关掉变 `"below"`（钉回节点下方），
`.cv-dock` 总数恒等于 1。

### 本轮改动文件（3 个）

新增 `src/components/canvas/paramPanelMode.ts` ·
`src/components/canvas/CanvasEditor.tsx`（Provider + `paramPanelOpen` + 提示文案）·
`src/components/canvas/NodeCard.tsx`（消费 Context）。
`typecheck rc=0` / `build rc=0` / `pack rc=0`。
截图：`design-previews/2026-10-08-参数栏单一落点/`（5 张）。
探针：`bsM_probe.js`（五种状态）/ `bsO_probe.js`（生成节点那条路）。
⚠️ 探针里**首页那个项目链接要等后端，别写死 sleep** —— 先等 `a[href*="/projects/"]` 出现再点，
不然会停在首页，量到的全是 0（`bsO` 第一次就栽在这，看着像"改坏了"）。

---

## 追加（2026-10-08 09:30）· 「右侧怎么什么参数都没有」—— 上一轮的验收是假通过

徐先：「你修的有问题，**右侧怎么什么参数都没有**」。

**我上一轮错在哪**（这条比结论更值得记）：09:00 那轮我宣布「五种状态下
`.cv-param-bar` 总数恒 = 1」，判据是 `document.querySelectorAll(...).length`。
**DOM 在 ≠ 看得见。** 那条断言全绿，屏幕上右侧栏一个字都没有。

### 真因：同一个病第二次，只是换了个组件

`.cv-param-bar`（`src/app/canvas/dock.css:84`）是**为「挂在节点卡片正下方」写的**：

```css
.cv-param-bar { position: absolute; top: calc(100% + 10px); left: -14px; width: 520px; }
```

它被 `NodeInspector` 复用到右侧栏（`<div class="cv-inspector-content"><NodeParamBar/></div>`）后，
包含块变成了 `.cv-inspector` —— 那里有 `position: relative`（给拖宽热区用的）。
于是 `top: calc(100% + 10px)` = **面板高度再往下 10px**，整块被顶到面板外面，
而 `.cv-inspector` 是 `overflow: hidden` → **裁得干干净净**。

`NodeParamBar.tsx:155` 有一句 `if (el?.closest('.cv-inspector')) return;`（在面板里跳过翻边计算），
说明当初知道「它进了面板」，但**没有任何 CSS 把定位撤回来** —— 那半条改动只做了一半。

⚠️ 这与 **2026-10-07** 修过的 `.cv-dock.cv-dock-inspector` 是**同一个病**：
「同一份 JSX 复用进右侧面板，浮层那套定位没撤」。下次再往面板里搬浮层组件，
先照 `.cv-dock-inspector` 那条抄一遍。

### 修法（`panels.css`，紧跟 `.cv-inspector-content`）

```css
.flow-shell .cv-inspector .cv-param-bar {
  position: static; top: auto; left: auto; right: auto; z-index: auto;
  grid-template-rows: auto;      /* 撤掉 minmax(0,1fr)：面板里要「内容多高就多高」 */
  width: auto; max-width: none;  /* 撤掉写死的 520px */
  padding: 0; background: transparent; border: 0; border-radius: 0; box-shadow: none;
}
.flow-shell .cv-inspector .cv-param-body { overflow: visible; }  /* 滚动交给面板那层，别两层都滚 */
.flow-shell .cv-inspector .cv-param-opts { grid-template-columns: 1fr; }  /* 面板里改单列 */
```

三条都是必须的，少一条就有毛病：

1. **撤定位**——不撤就还在面板外面；
2. **撤 `.cv-param-body` 自己的 `overflow-y: auto`**——面板那层已经在滚了，
   两层都滚会出现一条**滚不动的内滚动条**，看着像内容被截断；
3. **`.cv-param-opts` 改单列**——那条「摆两列」的规矩是给 520px 浮条写的
   （`panels.css:2657` 的原话就是「参数条是浮在节点下方的一条，横向很窄」），
   面板可用宽只有 **316px**，两列一开每格 ~154px，「自动（跟随设置 · 本地 · Qwen3.5-4B-…」
   当场被截成半句。

### ✅ 验收（这次判据换成「可见」，不注入任何东西，asar 09:22）

`.cv-inspector .cv-param-bar` 逐项断言：

| 断言 | 结果 |
|---|---|
| `getBoundingClientRect()` 宽 × 高 | **316 × 350**（优化提示词）/ **316 × 189**（首尾帧） |
| 完整落在 `.cv-inspector` 矩形内 | ✅（面板 `x=1098 y=43 w=342 h=857`，条 `x=1112 y=167`） |
| `getComputedStyle().position` | **`static`** |
| 条内打 5×5 = 25 个点做 `elementFromPoint` | **25/25 归参数条自己** |
| 条内 `innerText` 长度 | 723 / 91（非空，真画出了字段） |
| 全局 `.cv-param-bar` 总数 | 恒 **1**（卡片下方那份仍是 0） |
| 关掉参数栏后 | 卡片下方那份 `401 × 294`、命中 25/25 ✅ |

### 「写法」那一栏新增的一档：什么都不填（`__free__`）

徐先：「优化提示词也可以添加一个「写法」，就是什么都不填，按补充要求的走」——
追问后确认要的是**真的一档新行为**，不是给「不指定」换个说法。

| 取值 | 含义 |
|---|---|
| `''`（不指定） | 不挑技能，但 `PROMPT_OPTIMIZE_SYSTEM` 里那句「补全主体、动作、环境、构图、镜头、光线…」**照旧** |
| `__free__` | 连那句也不套，**且不发 `strength`**，system 只留「身份 + 输出格式」，写什么完全由「补充要求」定 |

- 常量在 **`lib/optimizeOptions.ts`**（工程根 `lib/`，不是 `src/lib/` —— 前端与主进程必须解析到同一份）。
- 后端两条路由（`prompt/optimize`、`prompt/describe`）都认它：`skillId` 是哨兵 → `loadSkillForPrompt(undefined)` + `freeform: true`。
- 🔴 **必须同时不发 `strength`**：强度那三句本身就是一套「补全 / 扩写」的写法规矩，
  留着它，这一档跟「标准补全」没区别 —— 等于没加。
- `OptimizeOptions.tsx` 里哨兵**不算「技能已经不在了」**（要显式排除，否则会多出一条
  「`__free__` · 这个技能已经不在了」）。

### 本轮改动文件（7 个）

`src/app/canvas/panels.css`（面板内三条覆盖）·
`lib/optimizeOptions.ts`（哨兵 + `isFreeformSkill` + 提示文案）·
`lib/promptAssistant.ts`（两份 system 拆成「身份/写法/输出」三句 + `*_FREE` 变体 + `freeform` 选项）·
`server/api/prompt/optimize/route.ts`、`server/api/prompt/describe/route.ts`（认哨兵、freeform 时不发 strength）·
`src/components/canvas/OptimizeOptions.tsx`、`src/components/canvas/GenerateDock.tsx`（下拉新增那一档）。
`typecheck rc=0` / `build rc=0` / `pack rc=0`。
截图：`design-previews/2026-10-08-右侧参数栏空白/`（4 张）。
探针：`bsQ_probe.js`（可见性 + 新档位）/ `bsS_probe.js`（回滚 + 换节点）/ `bsT_probe.js`（首尾帧）。

⚠️ **探针里又踩到一个老坑**：**首页列表还没读出来时，页面上已经有 `a[href="/projects/new"]`
（「新建项目」那张卡）** —— 照旧写 `a[href*="/projects/"]` 会点进新建项目页，
然后量到 `kinds: []`、`.cv-inspector` 全无，**看着像「刚改的东西把应用改坏了」**。
必须排除 `/projects/new`（`bsQ` 第一轮就这么白跑一轮）。

---

## 追加（2026-10-08 10:00）· 主页卡片配色：入口卡各一支色 + 项目卡按封面取色

徐先原话：「**主页的卡片颜色可以更丰富一点**」。方向他选的是
「**入口卡 + 项目卡（按缩略图取色）**」。

### 目标与做法

- **入口卡**（画布 / 图片生成 / 资产库）三张 —— 各自上一支属于自己的色，
  沿用深灰主题那轮定下的三支入口色（canvas 蓝 / image 粉 / assets 金）。
- **项目卡** —— 有封面的**用自己封面图的主色**给卡面染一层很淡的底；
  **没封面的回落一组轮换色板**（`--home-tint-1..5`），**不会变回灰块**。
  ⚠️ 这条别省：**没出过图的新项目正是最容易被扫过去的那几张**，
  恰恰是最需要一点颜色把它们从背景里挑出来的。

### 🔴 卡面洗底走 `background-image` 同色渐变，**不是**半透明 `background-color`

```css
.home .home-project {
  background-color: var(--card-face);
  background-image: linear-gradient(var(--card-tint, transparent), var(--card-tint, transparent));
}
```

**为什么不能直接给 `background-color` 上 alpha**：半透明底会让**页面底透上来**，
卡片就不像「架在台面上的一层」了 —— 跟卡片自己的圆角/描边/悬停不对味。
渐变的写法把**不透明的卡面**和**一层 tint** 分开：tint 没定义时整条 `background-image`
失效、回落成没图片（**不会把卡片搞没**），这是刻意留的兜底。
`.`entry-card` 那条同构（用 `--entry-face`）。

⚠️ **hover 必须重写 `background-color` + `background-image` 两条**
—— 只写 `background` 简写会把 `background-color` 一起顶掉，
鼠标一移上去卡片反而变灰。

### 🔴 加洗底之后**必须重算对比度**（这一条是这轮的真正教训）

三支入口色当初是按**中性卡面**压的（5.30 / 5.07 / 6.51），**卡面一亮就不够了**：
真机量到「进入 →」掉到 **3.92 / 4.06**（要求 ≥ 4.5）。

往回压洗底救不回来 —— 算出来 alpha 得压到 **0.027**，等于没铺色。
**正确解法是提字色，不是减洗底**：

| 档 | 原值 | 现值 |
| --- | --- | --- |
| 暗档 canvas | `#8FA3C4` | `#B8CAE2` |
| 暗档 image | `#C78EA6` | `#E3B7CB` |
| 暗档 assets | `#CBB083` | `#DCC9A2` |
| 亮档 image | `#96566F` | `#8C4E66` |
| 亮档 assets | `#836628` | `#7A5C22` |

（亮档 canvas 那支 `#4E6484` 够用，未动；`-soft` / `-line` / `-face` 三支**同源值一起改**。）

复测 **WORST overall = 4.78**：暗档 5.63 / 5.90 / 6.04，亮档 **4.78** / 4.89 / 4.91，全部达标 ✅。

⚠️ **亮档入口卡那支余量只剩 0.28**（4.78 vs 4.5）—— 跟 `--text-mute` 压 `--surface-3`
的 4.57 是同一类账，**以后谁动亮档卡面或那三支色，先回来核这一格**。

### 🔴 对比度必须「算」出来，不能从 computed style 读

computed 给的是 `background-color`（中性面）**加**一层 `background-image` 渐变，
**两层叠加后的实际底色谁都没写出来**。做法：把 `--card-tint` 的 computed
（自定义属性在 computed 阶段已完成 `var()` 替换，拿到的是最终 rgba）
与 `background-color` **手动 over 合成**，再算对比度。

⚠️ **Chromium 会把 `rgba(143,188,164,.15)` 序列化成 8 位十六进制 `#8fbca426`**
—— 解析函数只认 3/6 位的话，alpha 会被当成 1，合成值算成不透明，
**对比度被低估（假安全）**。`bsU_probe.js` 里那个 `hex()` 支持 8 位就是为这个
（`a = parseInt(h.slice(6,8),16)/255`）。这个坑第一版真踩了。

### 🔴 `coverTint.ts` 的三个取色陷阱

新建 `src/lib/coverTint.ts`，从**页面上已有的那个 `<img>`** 现场取样
（不 `new Image()` 再拉一遍，同一张图跑两趟纯属浪费）；缩到 32×32 画布，
返回 `"r, g, b"` 字符串（**alpha 交给 CSS 的 `--card-tint-a`**，色和透明度分开管）。

1. **不对整图求算术平均** —— 会被暗部（描边/阴影）和高光拉成灰，
   一张很蓝的图能平均出中灰色。
2. **只统计够彩的像素**（`s ≥ 0.12` 且 `0.08 < l < 0.94`），按 `s²` 加权
   —— 让「既有色又不太脏」的像素说话，顺便把纯黑纯白踢掉。
3. **色相用圆均值**（`sin/cos` 累加后 `atan2`）—— 直接对色相求平均会把
   0.98（品红侧）与 0.02（红侧）平均成 0.5（**青**），正好是反色。

最后把结果**夹进中段带**（`s` 0.35~0.80、`l` 0.42~0.62）—— 保证作为卡面底不会过艳也不会糊掉。
`getImageData` 的 `SecurityError` 用 `try/catch` 兜住（返回 `''`），
`getContext('2d', { willReadFrequently: true })`。

### 🔴 取色**刻意不用 effect 预取**

`ProjectGrid.tsx` 里 `tints` 那个 state 是在 `<img>` 的 `onLoad` 里当场填的，
**没有** `useEffect` 去遍历 `projects` 预取 —— 依赖 `projects` 会打进死循环
（这文件上面那条注释讲的就是同一个坑）。`onLoad` 天然每张图只跑一次。

### 本轮改动文件（6 个）

新建 `src/lib/coverTint.ts`（取色）
· `src/components/start/ProjectGrid.tsx`（`tints` state + `FALLBACK_TINTS` + 三个分支都挂 `tintStyle`）
· `src/app/globals.css`（新增 `--entry-*-face` 与 `--home-tint-1..5`，深浅两档各一份；三支入口色重调亮度）
· `src/app/start.css`（`--entry-face` 中间变量 + 注释更新）
· `src/app/workspace-home.css`（`--card-tint-a` + 两处洗底 + 图标块底提到 `-line` + hover 重写）。
`typecheck rc=0` / `build rc=0` / `pack rc=0`（asar 02:08）。
截图：`design-previews/2026-10-08-主页卡片配色/`（2 张，暗/亮各一）。
探针：`bsU_probe.js`（颜色来源 + 合成底色 + 对比度一次量完，真机、不注入）。

### 真机实测（`bsU_probe.js`）

```
=== dark  entry=3 project=7
  entr bg rgb(65,67,73)  tint rgb(184,202,226) @0.0901  title 8.88 small 5.9
  entr bg rgb(69,66,71)  tint rgb(227,183,203) @0.0901  title 8.96 small 5.63
  entr bg rgb(68,67,67)  tint rgb(220,201,162) @0.0901  title 8.86 small 6.04
  proj bg rgb(50,67,78)  tint rgb(33,134,181)  @0.16    title 9.27 small 9.27
  proj bg rgb(57,83,86)  tint rgb(81,236,233)  @0.16    title 7.42 small 7.42
  …（7 张项目卡全部有色、全部 ≥ 7.4）
=== light entry=3 project=7
  entr bg rgb(228,229,231) tint rgb(78,100,132) @0.05882 title 14.96 small 4.78
  entr bg rgb(231,228,229) tint rgb(140,78,102) @0.05882 title 14.93 small 4.89
  entr bg rgb(230,228,225) tint rgb(122,92,34)  @0.05882 title 14.94 small 4.91
  …（7 张项目卡 13.7 ~ 15.52）
WORST overall = 4.78 (need >= 4.5)
```

**7 张项目卡里没有一张是灰的** —— 有封面的拿到的是各自封面真的主色
（`rgb(33,134,181)` / `rgb(81,236,233)` / `rgb(105,165,79)` 等），没封面的走轮换色板。

---

## 追加（2026-10-08 10:45）· 日间配色提亮：病根是彩度，不是明度

徐先原话：「**日间模型的主题选项卡颜色要优化一下，现在太深了。颜色可以更加鲜艳明亮一点**」。
问了一句方向，他选「**入口卡 + 项目卡都要**」。

### 🔴 先纠正一个直觉：那三支不是"深"，是"灰"

「太深了」的直觉解法是提明度。但量一下归一化色度（`色域跨度 × 明度离中段的距离`）就知道病在哪：

| 入口 | 旧值 | 彩度 | 新值 | 彩度 |
| --- | --- | --- | --- | --- |
| canvas 蓝 | `#4E6484` | 0.053 | `#004AEB` | **0.201**（3.8×） |
| image 玫瑰 | `#8C4E66` | 0.058 | `#B40459` | **0.145**（2.5×） |
| assets 琥珀 | `#7A5C22` | 0.082 | `#8F4A00` | **0.120**（1.5×） |

`#4E6484` 的明度并不低（L* ≈ 42），它是**青灰** —— 一眼看去"发闷"是彩度不够，不是不够亮。
⚠️ **别用 HSV 的 S 当判据**：`#7A5C22` 的 HSV S 高达 72%，看着还是土 ——
深色的 HSV S 天然虚高（分母 `max` 很小）。所以用上面那个在两段都会衰减的归一化色度。

### 求解：约束下把彩度顶到最大

`bs*_probe` 之外的离线核算脚本（`pal*.py`）做的是一件事：
**在「对比度 ≥ 4.75」这条约束下调 (hue, sat, light) 网格，目标函数 = 归一化色度**。
- 约束必须给：入口卡的「进入 →」是**彩色字**，彩度一上去对比度就掉（见下）。
- 目标函数不能是 HSV 的 S：那个会把解推到 `S100 L20`（几乎发黑）——它确实"最饱和"，但更闷。
- 色相**没动**（蓝 221° / 玫瑰 331° / 琥珀 31°），跟暗档那三支是同一族，
  ⚠️ 别顺手换成别的颜色（切换主题时三张卡会"换了个东西"）。

### 🔴 三档浓度一起提，且**面与字各算各的**

| 档 | 旧（亮） | 新（亮） | 为什么 |
| --- | --- | --- | --- |
| 卡面洗底 `-face` | 0.06 | **0.10** | 0.06 时三张卡几乎还是灰的，分不出三条路 |
| 图标块底 `-line` | 0.26 | **0.22** | 0.26 乘上新高彩度色会把块压暗，图标只剩 3.1:1 |
| 项目卡 `--card-tint-a` | 0.13 | **0.22** | 0.13 时封面取色几乎看不出来 |

⚠️ **入口卡的项目卡不能用一个数**：项目卡的标题与副标题都是 `--text`（#111 深字），
卡面变深**只会更好读**（13.7 → 仍 ≥ 12.2），所以 0.22 可以放心加；
而入口卡的「进入 →」是**彩色字**，卡面一深就掉对比度 —— 它走自己的 `-face`（0.10）。

### 🔴 为什么不给图标另配一支"亮色"

第一版方案是「图标用亮色、文字用深色」两支。**走不通**：量出来图标只剩 2.0。
原因是浅底上**不存在"又亮又读得出来"的彩色图形** —— 想让图标更亮，只能让块更亮；
块一亮，3:1 就没了（`#2563EB` 那种亮蓝压在淡蓝块上只有 3.15，`#3B82F6` 直接 2.0）。
所以亮的那部分交给**面**和**块**（都提过浓度了），图标本身只要够鲜 ——
它跟「进入 →」用**同一支** `--entry`，少一个变量、也少一处会不同步的地方。

### 真机实测（`bsV_probe.js`，不注入，asar 10:42）

```
=== light  entry=3  project=7
  入口 面 rgb(213,220,237)  色 rgb(0,74,235)   彩度 0.201  CTA 4.82  标题 13.78
       块 rgb(166,188,236) @0.22 | glyph rgb(0,74,235)   ratio 3.47
  入口 面 rgb(231,213,222)  色 rgb(180,4,89)   彩度 0.145  CTA 4.84  标题 13.49
       块 rgb(220,167,193) @0.22 | glyph rgb(180,4,89)   ratio 3.34
  入口 面 rgb(227,220,213)  色 rgb(143,74,0)   彩度 0.12   CTA 4.93  标题 13.95
       块 rgb(209,188,166) @0.22 | glyph rgb(143,74,0)   ratio 3.64
  项目 面 rgb(192,214,225) / rgb(230,205,216) / rgb(227,216,198) /
       rgb(201,222,214) / rgb(237,223,203) / rgb(212,227,213) …  标题 12.56 ~ 14.41
=== dark（未动，作对照）  入口 彩度 0.139 / 0.157 / 0.184
WORST overall = 4.82 (need >= 4.5)
```

- 「进入 →」**比改之前还高一点**（旧 4.78 / 4.86 / 4.89 → 新 4.82 / 4.84 / 4.93）。
- 图标（非文字图形，判据 3:1）3.47 / 3.34 / 3.64 ✅
- 暗档完全没动 —— 这轮只治日间。

### 本轮改动文件（2 个）

`src/app/globals.css`（亮档 `--entry-*` 三支换色 + 三档浓度 + `--home-tint-1..5` 换高彩度支）
· `src/app/workspace-home.css`（亮档 `--card-tint-a` 0.13 → 0.22 + 注释）。
**没有改任何标记结构** —— 图标块继续读 `-line`、图标继续读 `--entry`，只是那些令牌的值变了。
`typecheck rc=0` / `build rc=0` / `pack rc=0`（asar 10:42）。
截图：`design-previews/2026-10-08-日间配色提亮/`（暗/亮各一）。
📌 包内验证：压缩器把新令牌转成了 **8 位 hex**（`rgba(48,102,220,.19)` → `#3066dc30`）——
按 `3066dc` 那一类**去掉 alpha 的十六进制**去 grep，不要按 `rgba(48,102,220` 去 grep（那样是 0 命中）。

---

## 追加（2026-10-08 11:05）· 首页两处区块标题各上一支色

徐先原话：「**这里的文字的颜色也可以改下**」+ 圈了「创作」与「最近项目」两处标题
（圈的范围**含它们左边那道小竖条**）。问了一句方向，他选「**两处各一支**」。

### 改了什么

| 区块 | 亮档 | 暗档 | 亮/暗 对比度 |
| --- | --- | --- | --- |
| 创作 | `#004AEB`（跟「画布」入口卡同一支蓝） | `#B8CAE2` | 6.61 / 8.95 |
| 最近项目 | `#00705A`（青绿） | `#9DCFC0` | 6.06 / 8.62 |

原来的色是 `--text`（亮档 #111 / 暗档 #f2f3f6，对比 18.9 / 13.5）。
标题是 20px 粗体，按**大字**判（3:1 就够），所以 6.0 以上很宽裕。

### 🔴 那道竖条必须**跟着一起**换

竖条是 `globals.css` 里 `.section-head h2::before` 画的，底色走 `--bracket`
—— 而 `--bracket` 是**全站**"跟强调色走"的那道装饰（每一套「主题配色」都重定义它）。
只覆盖 `h2` 的 `color` 的话，会剩下「字是蓝的、旁边那道杠还是黑的」这种半吊子状态。
所以四条规则成对写：`h2` 的 `color` 与 `h2::before` 的 `background` 各一条。

⚠️ **竖条的对比度要单独量**：它是 `::before`，得用
`getComputedStyle(el, '::before')` 才读得到 —— 只量 `h2` 的 color 会漏掉这一半。

### 🔴 只作用在首页这两处，不是全站 `.section-head`

靠 `page.tsx` 上加的 `data-head="create" / "projects"` 选中，没有用
`:first-of-type` 那类选择器 —— 这个父级下不稳（中间夹着 `<StartEntries />`
与条件渲染的兄弟节点）。资产页 / 工具页那些区块标题**不动**。

⚠️ **这两支不跟「主题配色」走**：那几套 palette 只重定义 `--bracket`，
不认识 `--home-head-*` 这两个名字。选了别的配色时首页这两处仍是蓝/青绿。
要让它跟着走，就把这两支也加进各 palette 块 —— 现在这样是刻意的（他点名要的就是这两支）。

### 真机实测（`bsW_probe.js`，不注入，asar 11:02）

```
=== dark  底(页面)= rgb(38,39,42)
  「创作」     data-head=create    字 rgb(184,202,226) 对比 8.95  | 竖条 同色 @1 对比 8.95
  「最近项目」 data-head=projects  字 rgb(157,207,192) 对比 8.62  | 竖条 同色 @1 对比 8.62
=== light 底(页面)= rgb(255,255,255)
  「创作」     data-head=create    字 rgb(0,74,235)    对比 6.61  | 竖条 同色 @1 对比 6.61
  「最近项目」 data-head=projects  字 rgb(0,112,90)    对比 6.06  | 竖条 同色 @1 对比 6.06
```

顺带复核上一轮没被改坏：入口卡「进入 →」4.82 / 4.84 / 4.93，项目卡标题 ≥ 12.57 ✅

### 本轮改动文件（3 个）

`src/app/globals.css`（两档各加 `--home-head-create` / `--home-head-projects`）
· `src/app/page.tsx`（两处 `section-head` 加 `data-head`）
· `src/app/workspace-home.css`（四条成对规则）。
`typecheck rc=0` / `build rc=0` / `pack rc=0`（asar 11:02）。
截图：`design-previews/2026-10-08-区块标题配色/`（暗/亮各一）。
📌 探针里又踩了一次**模板字符串里写反引号**（注释里的 `h2::before` 把外层 AUDIT 串截断）
—— 报的是 `SyntaxError: Unexpected identifier 'h2'`，看着像哪里少个括号。
写探针注释时别用反引号。

---

## 仍未做 / 留给下一棒

- 🔴 **亮档入口卡「进入 →」对比度余量只剩 0.32**（4.82 vs 4.5）——
  再想"更鲜艳"就得先动这一格：那三支的彩度已经顶在对比度边界上了（见上），**没有白送的余量**。
- `--surface-3` 一提亮就会拖掉 `--text-mute` 的 4.57 —— 这一对的余量只有 **0.07**，见上。
- 主页（`home.css` / `globals.css` 的表面链）这一轮**只是跟着深灰走**，没做结构改动。
- `canvas-original.css` 是死文件（全库零引用），但里面的旧令牌值（14/10/20px）容易误导，建议删。
- 出厂默认是 **亮色**（`DEFAULT_APPEARANCE.theme = 'light'`），徐先本人用**深色**（存在他
  localStorage 的 `frame.appearance`）。验证视觉时**必须显式锁主题**，否则测的是另一套。
- 强杀应用会丢 localStorage → 下次启动回落默认亮色。自动化截图要**先写 localStorage 再 reload**。
- 深色块那 39 个缺失令牌**还剩 27 个没补**（本轮只补了 12 个直接写死值的）。
  剩下的多是 `var(...)` 引用型 / 尺寸型，随用随补即可 ——
  但**每次新写一个「深色块里查不到」的令牌**，先确认它是不是在偷偷继承亮色值。
- `npm run typecheck` **rc=0**（2026-10-07 23:00 起）。此前挂着的 4 处既有类型错误
  已在预设栏那一轮全部清掉 —— 就是这个检查抓到了「点风格整屏空白」的真因。
  **别再用「`build` 是绿的」把它糊过去**：vite 只转译，一条类型错都抓不到。
- 预设栏宽度写死 **360 逻辑值**（跟参数栏一样乘 `--ui`），**还不能拖** ——
  参数栏那套 `.cv-inspector-resize` 可以照搬过来（`NodeInspector.tsx` 是最现成的模板）。
- 画布载入骨架（`.cv-boot-*`）**刻意没画右侧参数栏、也没画地板点阵** ——
  前者因为真画布刚打开本来就没有，画上去等于自己造一次布局跳动；
  后者因为点阵实测量出来对比度太低（抗锯齿后几乎测不出），加假的会在切换瞬间露馅。
- `index.html` 里 `REVEAL_MS = 400` / `MIN_VISIBLE_MS = 450` 是**本机热启动实测调出来的**
  （原始 180ms 会让牌子闪 150ms 就撤）。换机器、或后端启动变慢/变快后值得重测一次。
- 窄条的悬停提示用的是**原生 `title`**（约 1 秒才弹、样式是系统那套浅色气泡）。
  想做成即时浮层，得先解决 `.sidebar` 的 `overflow-x: hidden` 会把浮层裁掉这件事
  —— 唯一干净的路是把提示用 `position: fixed` + JS 定位重做，见上面那段。
- `--nav-rail-w: 56px` 与 `--nav-w: 248px` 一样**不乘 `--ui`**（沿用现状）。
  真要跟着界面缩放走，两处得一起改，别只动一个。
- ~~原生下拉**选中项**的高亮底/字还是 Chromium 自己给的~~ —— **部分解决（02:15 更正）**：
  `base-select` 之后 `option:checked` **选择器**归我们了（computed 确实是 `--cv-accent-soft`），
  但**渲染出来仍是 UA 的浅蓝底**（`(153,200,255)`）——我们的底只有 10% 不透明度，压不住它。
  ⚠️ 所以上面 02:00 那段里「选中项已统一到软件强调色」这句**只成立于 computed，不成立像素**。
  要真统一，得把 `option:checked` 的底改成**不透明**（或先铺一层不透明的再叠 tint）。等徐先定。
- ~~这个 Chromium 认得 `appearance: base-select`，是彻底接管原生下拉的正路~~ ——
  **已走（02:00）**，见上面那段。**只开在 `.cv-select` 上**：
  全站那些**裸 `<select>`**（设置页 / 工具页 / 各个表单）有**同一个白底病**，
  还没治 —— 要治就照搬 `controls.css` 里那一段（连同兜底条的位置一起），
  但会连带改掉它们的外观（默认 chevron、盒模型、高度 +1.8px），
  **等徐先点到再说**。
- 那个 `--cv-node-field` 至今**没有定义**（`nodes.css:237` 一直在引一个不存在的变量）→
  节点内所有 `var(--cv-field)` 都是无效值、落到透明。这轮**绕开了它**（popup 底改走 `--cv-float`），
  但**没修根**。要修就是在 `.canvas-studio` 层补一句
  `--cv-node-field: var(--cv-node-field-custom, var(--cv-field))`（原设计意图）——
  ⚠️ 那会让节点内一批本来是"透明"的输入框/底变成 `#212225`，**视觉面较大，别顺手改**。

## 追加（2026-10-08 13:00）检测更新：网页路径不通 → 快路径问 API + 20 秒兜底

**症状**（他原话「检测更新好像有点问题」）：点「检查更新」→ 界面卡在「正在检查更新…」、
三个按钮全灰 → 最后甩一句 `检查更新失败：net::ERR_CONNECTION_TIMED_OUT`（一次 8~10 秒，
换源实测最坏 26 秒）。

**真因**：更新源要碰的三个地址**全是 github.com 的网页路径**，本机一律 21 秒超时；
而 `api.github.com` 0.5 秒就回。实测（每条跑两遍）：

| 地址 | 结果 |
| --- | --- |
| `github.com/.../releases.atom` | ❌ 21 秒超时（两遍一致） |
| `github.com/.../releases/latest` | ❌ 21 秒超时 |
| `github.com/.../releases/latest/download/latest.yml` | ❌ 21 秒超时 |
| `api.github.com/repos/.../releases/latest` | ✅ **0.5 秒** 200 |
| `cdn.jsdelivr.net/gh/...` | ✅ 0.4~0.9 秒 200 |
| `raw.githubusercontent.com/...` | ⚠️ 42 秒 / 第二遍直接断 —— 也不稳 |

**🔴 中途走过的弯路（别再走一遍）**：第一反应是「把 generic 换成 electron-updater 的
`github` provider，它就走 API 了」—— **错的**。看
`node_modules/electron-updater/out/providers/GitHubProvider.js`：`getLatestVersion()` 请求
`releases.atom`，`getLatestTagName()` 里明写着 `// do not use API for GitHub to avoid limit`，
三步全是网页路径。换完真机实测**照样 26 秒超时**。

**最终改法（`electron/main/updater.ts`）**：

1. **快路径** `fetchLatestTag()`：源在 GitHub 上时先 `fetch` 一次
   `api.github.com/repos/<owner>/<repo>/releases/latest`（6 秒超时；`User-Agent` **必填** ——
   GitHub 没 UA 直接 403），拿到 `tag_name` 跟自己比（`isNewer()`：去 `v` 前缀逐段比数字，
   不引 semver 依赖）。**没新版 → 当场 `emit not-available` 返回**，根本不去撞网页路径；
   **有新版 → 记下 `latestTag`，交给 electron-updater 走完整流程**。
   ⚠️ 快路径失败**不算失败**：catch 掉静默，落回原流程（那边还有 20 秒兜着）。
2. `withTimeout()` —— electron-updater **没有超时选项**，源不可达就一直挂着，
   界面上一路「正在检查…」+ 三按钮全灰，看着像死了。套 20 秒。
   🔴 两个连带的小坑：① 迟到的 rejection 要自己 `work.catch(() => {})` 吞掉（否则主进程冒
   unhandled rejection 日志）；② **超时之后不能无脑报错** —— electron-updater 的结果常常是
   **事件**先给（`available` / `not-available` / `error`），那个 promise 还挂着，
   20 秒后再甩一句「连接超时」会把已经出来的正确结果盖掉
   （「明明刚说已经是最新版，一转眼又变成连不上」）→ 只在 `updaterState().phase` **还停在
   `checking` / `downloading`** 时才 emit 错误。
2. `feedFor()` 保留 github provider（解析 `latest.yml` + 下载安装那一套仍要它），
   **判地址形态不判字符串相等** —— `update-source.json` 里少个尾斜杠、多个 `www.`、
   大小写不一样，严格相等就悄悄走回 generic。
   ⚠️ 别简写成「把 url 换成 api.github.com」：api 不提供 `latest.yml` 这种静态文件路径，
   generic 拼 `url + 'latest.yml'` 必然 404。
3. `withTimeout()` 20 秒兜底（electron-updater **没有超时选项**，源不可达就一直挂着）。
   🔴 两个连带的小坑：① 迟到的 rejection 要自己 `work.catch(() => {})` 吞掉（否则主进程冒
   unhandled rejection 日志）；② **超时之后不能无脑报错** —— 结果常常是**事件**先给
   （`available` / `not-available` / `error`），那个 promise 还挂着，20 秒后再甩一句
   「连接超时」会把已经出来的正确结果盖掉（「明明刚说已经是最新版，一转眼又变成连不上」）
   → 只在 `updaterState().phase` 还停在 `checking` / `downloading` 时才 emit。
4. `errorText()` 补两句中文：`ETIMEDOUT|ERR_CONNECTION_TIMED_OUT|TIMED_OUT|timeout`、
   `403|429|rate limit` —— 原文那串是 Chromium 的错误码，直接给用户看等于没说。
   若快路径已经问出远端有新版，报错后头再补一句「（远端最新是 x.y.z，只是这份下不下来。）」。

**真机复验证据**（`dist\win-unpacked` 真机 1.0.103，不注入）：

| 场景 | 修好前 | 修好后 |
| --- | --- | --- |
| 手动点「检查更新」 | 8~10 秒后 `ERR_CONNECTION_TIMED_OUT` | 1ms「正在检查…」→ **90ms**「已经是最新版了。」 |
| 启动 8 秒后自动检查 | 同上 | 同样落到「已经是最新版了。」 |
| 源指向不可达地址（192.0.2.1） | 一直转圈、三按钮全灰 | **20.2 秒**给中文超时句，按钮恢复可点 |

**仍未做 / 留给下一棒**：
- 启动 8 秒后才自动检查（`index.ts:393` 那个 `setTimeout(…, 8000)`）是旧节奏，
  现在检查本身只要 0.1 秒，这个延迟没理由这么长 —— 但改它会让「一开应用就去问 GitHub」，
  等他定。
- 🔴 **下载**那一步仍然走 `github.com/.../releases/download/...`（网页路径），
  在这台机器上大概率也下不动。现在能报出「有新版本」，但点下载多半会在 20 秒后超时。
  要真解决得把安装包放到这台机器能下的地方（jsDelivr 只托管仓库文件、有体积上限，
  放不下 240MB 的 exe）—— **等他定**。

## 追加（2026-10-08 13:40）顶栏加一颗「本地 ComfyUI 在不在跑」的状态灯

**位置**是徐先圈出来的：`cv-topbar` 里「N 节点 · M 连线」右边、余额左边
（夹在 `cv-spacer` 和 `--balance-slot` 之间）。**之前那个位置什么都没有**，
画布上从来没有过 ComfyUI 状态 —— 这是个新东西，不是修坏的。

**判据走 `/api/local/connection/test`**（服务端打 ComfyUI 的 `/system_stats`），15 秒一轮：

- ⚠️ **不用主进程的 `comfyuiStatus`**：那只认「**本应用**启动起来的那一个」。
  徐先自己在外头开着的 ComfyUI 照样能跑生成，但 supervisor 一直是 idle，
  拿它点灯就是骗人 —— 探测地址可达才是真判据。
- ⚠️ 路由新增 `silent: true`：它默认会把探测结果 `markLocalStatus()` **写库**，
  那是设置页「点一次测一次」的语义；顶栏十几秒问一次去改连接状态，等于拿显示件带节奏。
- ⚠️ 轮询是 `setTimeout` **串行**，不是 `setInterval` —— 探不通时这一次要等到超时，
  interval 会让请求层层叠起来，越叠越多。

**颜色**新增令牌 `--ok`：夜间 `#3ddc84` / 日间 `#0a8a4a`。
和 `--gold` 一个道理 —— **固定不跟配色走**：跟着 `--accent` 走的话，选到琥珀/黄那几档
就分不出「绿点」和「强调色」了；而绿=运行中是通用语义。未运行用 `--cv-mute`。

**两态都占位**（没在跑时是暗灰点，不是留空）：位置不会左右跳，也让人知道那儿有个灯。
**zen 模式不用管**：`.flow-shell.cv-zen .cv-topbar > * { display: none }` 已经把它一起收了。

**真机证据**（1.0.104，`--ui` 0.8 → 点 7×7）：

| 档 | 底 | 未运行 | 运行中 |
| --- | --- | --- | --- |
| 深 | `rgb(27,28,31)`（`.flow-shell`） | `rgb(155,160,166)` **6.47:1** | `#3ddc84` **9.55:1** |
| 亮 | `rgb(250,251,252)`（`.flow-shell`） | `rgb(110,114,118)` **4.68:1** | `#0a8a4a` **4.27:1** |

可见性按「rect > 0 + 落在顶栏矩形内 + 5×5 `elementFromPoint` 命中」量：**25/25 命中**、
`x=920`（节点数 198 / 余额 935，正好夹在中间）。他那台机器上 ComfyUI 确实在跑，
`title` 是「本地 ComfyUI 正在运行（已连上本机 ComfyUI（NVIDIA GeForce RTX 5060 Laptop GPU · ComfyUI 0.39.0）。）」
—— 状态是**真探测**驱动的，不是写死的。

**仍未做 / 留给下一棒**：
- 点一下**没有行为**（纯显示）。要接的话，最自然的是「没在跑 → 点了去设置页」，
  但那是行为决定，**等他定**。
- ⚠️ 探针教训：手工改 `className` 去模拟某个状态（这里为了量「未运行」长什么样而摘掉 `.on`），
  **可能被 React 重渲染覆盖** —— 真机上出现过一轮摘掉又变回绿。改完要**读回 `className` 确认**，
  否则量到的是没改成的那个样子。
- 失败态下「下载更新」按钮是可点的（`canDownload` 放行 `error`），点了会先重新问一次再下。
  这是 10-01 刻意的设计，不是漏的。
- 更新源**界面上没有入口**（10-01 收掉了），只能改数据目录里的 `update-source.json`。
  这轮验证就是靠临时改它做的，跑完已恢复原样并 diff 校验过。

---

## 追加（2026-10-08 15:10）D站标签选择器节点（`danbooru-tags`，1.0.105）

**他要什么**（原话）：「添加，d站标签选择器节点 `Comfyui-Anima-Tools`，功能参考 comfyui 插件。
我想扩展的功能，选择几个角色，使其在这几个角色之间随机，姿势也一样，环境也一样，画师串，也可以自定义添加标签」。

四个方向由他定：**数据随包内置精简版** / **随机两者都要**（每次运行抽 + 可切固定手动重抽）/
**画师多选全部串在一起** / **输出拼进下游生成节点的提示词**。

### 数据

| 表 | 源 | 条数 | 落库 |
| --- | --- | --- | --- |
| 角色 | `js/character_data.js` | 8000 → **4000**（post_count 降序截断） | `src/public/danbooru/characters.json` |
| 画师 | `js/data.js` 的 `galleryData` | 40600 → **6000** | `artists.json` |
| 姿势 | `js/pose_data.js` | 297 全量 | `poses.json` |
| 环境 | `js/background_data.js` | 1087 全量 | `backgrounds.json` |

共 **1.15MB**，随包走（renderer 的 publicDir 是 `src/public`，预设那 77MB 素材就是这么放的）。
运行时 `fetch('/danbooru/*.json')` + 模块级缓存，不进 JS bundle、不拖慢启动。
姿势 / 环境的预览图是**远程**（`cdn.jsdelivr.net/gh/nregret/AnimaTags-DB@main/...`），
加载不出来就留 44×44 空位，行高不变、条目照样能选。

转换脚本 `.workbuddy/tmp/_anima-conv.js`（node `vm` 求值）。两个坑：文件末尾
`window.xxxData = xxxData` → vm 上下文要先塞一个假 `window`；有的文件是 `export { poseData };`
→ 求值前用正则剥掉（`vm` 解析不了 ESM）。

### 形状

- **存两份**：`tagSelection`（他挑了哪几个，持久）+ `tagText`（本轮抽签结果，落库）。
  与 `optimizedText` 同一个形状 —— 结果属于这一轮，选择属于节点。分开才有「换一批」。
- **抽签**：mulberry32（同 seed 同批，所以「固定」可复现）。角色 / 姿势 / 环境**各抽 1**；
  画师**全部串**（他要的「画师串」）。
- **组装顺序**：`@画师… → 角色 → 环境 tags → 姿势 tags → 自定义`，结尾带 `", "`。
  照 Anima-Tools 的 composer（`SELECTION_SECTIONS`）—— 这串是要**接**在别的字前面的，
  不带尾逗号会和下游粘在一起。
- **不接上游**（`ACCEPTS` 空数组）：它的输入是挑的条目，不是一段字。要和手写提示词组合，
  就**把两个节点都连到生成节点**，文本链自己按连线先后拼（中间空一行）。
- **「启动」时重抽**：`rerollRandomTags()` 跑在**每一遍**的开头，抽完 `waitRender` 等一次渲染
  —— 不等的话下游读的还是上一批，症状是「跑了 3 遍、角色是同一个」。

### 界面

面板 portal 到 `.cv-preset-slot`（与预设栏同一套：**并排**，不盖画布 —— 挑标签要看着节点）。
5 个 tab（角色 / 姿势 / 环境 / 画师 / 自定义）+ 模式切换（每次运行抽 / 固定这一批）+ 换一批 +
底栏实时预览。卡片上两颗**常驻**钮（「标签」「换一批」）+ 正面直接摆本轮抽出来的串
（不是「已选 N 个」那种摘要 —— 抽到谁才是要确认的东西）。

### 真机证据（1.0.104 的包）

四组各**同步连点 4 行** → chips **4/4**；底栏
`@dairi, @ebifurya, @hammer \(sunset beach\), @haruyama kazunori, hatsune miku, roses, delivery motorcycle, street lights, night, arms crossed,`；
**换一批**后角色 `asahina mikuru → hatsune miku`；卡片正面串完整、`insideCard=true`、
5×5 `elementFromPoint` 命中自己。单测（`_tagstest.ts`，23 条）ALL PASS。

### 修过的两个 CSS 坑（都是看截图才发现的）

1. **列表行被压扁、行内文字叠在一起**：`.cv-dtp-row` 写在 column flex 容器里，
   我给它写了 `min-height: 0` —— 一次排 120 行、容器只有 595px，浏览器于是选择
   **把每行压到 ~20px** 而不是滚动。修法是 `flex: none`；同容器其余横条（mode / picked / foot）
   也一律 `flex: none`，**只有可滚区本身**才 `flex: 1; min-height: 0`。
   复验：每行 48px、title/sub 的 rect 不重叠（gap 2px）、列表内容 6325px 可滚。
2. **5 个 tab 在 288px 里排不下**（`--ui` 0.8），「自定义」被裁成「自」——
   而自定义标签是他点名要的功能，点不到等于没有。修法：tab 均分宽度
   （`flex: 1 1 0; min-width: 0; padding: 0 4px`）+ tabs 容器 `overflow-x: auto` 兜底。
   复验：5 颗各 42px、无裁切、全在面板内。

⚠️ 这两条功能探针一条都不会报（元素点得到、值也对），只有**看截图 / 量 rect** 才发现。

### 仍未做 / 留给下一棒

- **「拖线把标签串送进下游」真机没验成**：CDP 模拟拖拽 React Flow 把手，两次（12 步 / 40 步插值）
  连线数都是 0。证据目前只有纯函数层断言（`resolveTextChain` 给下游那段）+ `ACCEPTS` 已放行 ——
  两端都在，中间那一下是**既有的连线机制**。建议他自己拖一次确认。
- 数据只做了角色 / 姿势 / 环境 / 画师；**服饰**（`clothing_data.js` 430 条）没做 —— 他没提。
- 角色只出 `name`（trigger），没带 `hair` / `eye` 那些特征标签；Anima-Tools 那边还有
  `character_official_data.json`（角色官方 tag 列表）也没用。要「角色细节模式」再说。
- 每组固定抽 1 个，没有「抽 N 个」的档位。
- 🔴🔴 **事故（已恢复，但规矩要留下）**：探针收尾「删掉测试加的节点」时按**坐标**点中再按 Delete，
  节点堆叠导致命中了下面那个 —— 把他画布上**原有的 image-generate 删了**。
  最后是备份 `frame.db`、从备份里取出那条节点 UPDATE 回去救回来的（已核：画布只剩那 1 个节点、0 连线）。
  → **真机探针别在他的真项目上加节点**；要加就新建临时项目，删的时候按 `data-id` 定位，不要按坐标。

## 追加（2026-10-08 16:00）修「打开内置浏览器会出现重叠」（1.0.106）

**他报的现象**（截图 1440×900）：抽屉自己占 547~1152 是对的，网页却只画在**右半**
（835~1152），左边 288px 露出 `.cv-browser-slot` 的 `#111` 黑底；右边还压着 D站标签面板。

**根因 —— 原生层不会自己跟着 DOM 走。**

网页是主进程的 `WebContentsView`（原生层），它只认渲染层**主动上报**的矩形。
抽屉是贴着 `.cv-stage` 右边缘的：右侧那几栏（创作预设 / D站标签 / 节点参数）出现或消失时，
`.cv-stage` 变窄，抽屉**整个横着挪一段**（布局变化，一帧到位，不是动画）。
可抽屉自己的**尺寸一点没变**，于是原有三条跟随监听一条都不响：

| 监听 | 为什么没响 |
|---|---|
| `ResizeObserver`（占位区） | 尺寸没变 |
| `window.resize` | 窗口没动 |
| `animationend` | 入场动画早就演完了 |

→ 没人通知主进程，视图留在原地：**左边漏一条黑边，右边盖在后出来的面板上**。

**真机证据**（隔离实例，1440 宽，`--ui=1`）：

| 阶段 | `.cv-stage` | 抽屉 | 网页视图 |
|---|---|---|---|
| 先开浏览器 | 0~1060 | 455~1060 | 正确 455~1060 |
| **再开 D站面板** | 0~700 | **95~700** | **仍停在 455~1060** |

屏幕位图里那条黑边实测 **360px**，正好等于 D站面板宽度（`--ui=1` 时 360×1）。
他截图里的 288 是同一个机制（`--ui=0.8` 时 360×0.8）。

**修法**（`src/components/canvas/CanvasBrowserPanel.tsx`）：

1. `ResizeObserver` 除占位区外**再观察 `.cv-stage`** —— 右栏进出 / 改宽 → 重新上报。
   （`.cv-drawer` 的位置跟着 `.cv-stage` 宽度走，盯住后者就覆盖了全部「右栏变化」。）
2. `rectOf()` **减掉 `.cv-drawer` 当前的 transform 位移** —— 挂载那一帧量到的是入场动画的
   **起点**（整个抽屉还在屏幕右边外面）。报过去之后 `clampBrowserBounds` 里
   `width = min(w, host.width - left)` 会顺手把宽度切成「窗口右边缘 − 那个 x」，
   视图就先落在右侧栏上闪一下。取静止位置就没有这一下，也堵住了「纠正没赶上」的窗口期。

**复验**（同一套像素判据，修复前后各跑一遍同样的操作顺序）：
`y=400/600/800` 三行采样，修复前是 656~1015（宽 360）的连续黑段，修复后最长只剩 11px 的杂散像素。
截图见 `design-previews/2026-10-08-内置浏览器重叠/`。

**教训**：

- 🔴 **凡是「几何位置会变」的跟随逻辑，必须把让位置变的**所有**原因都覆盖**：
  自己的尺寸、窗口尺寸、**以及父容器的尺寸**。
  「尺寸没变」不等于「位置没变」—— 这一条对原生层（`WebContentsView` / `BrowserView`）
  尤其致命，因为 DOM 错了看得见，原生层错了就是「一块东西浮在别处」。
- 🔴 **复现顺序决定成败**：这个 bug 只有「**先开浏览器、再开侧栏**」才出现；
  反过来（先侧栏、后浏览器）一切正常 —— 前两轮探针就是这么跑空的，白跑两次。
  复现之前先把**用户的操作顺序**问清楚（或从截图里的状态倒推）。

## 追加（2026-10-08 16:40）D站服装档 / 角色预览 / 两个选择器贴节点 / 启动两档（1.0.107）

徐先这一轮四件事，一起做的：

### 1. 角色没有预览图

`characters.json`（4000 条）里**本来就没有** preview 字段 —— 上游 `character_data.js` 就没有，
而 `pose_data.js` / `background_data.js` 那两族有（走 jsDelivr 的 `AnimaTags-DB` 仓）。
所以姿势 / 环境两栏有缩略图、角色栏没有，是数据源本身缺，不是渲染漏了。

补法**不写进清单**，而是**现拼地址**（`danbooruTags.ts` 的 `characterThumb()`）：

```
https://blobs.animadex.net/Outputs/thumbs/<name>, <copyright>.webp      （都小写、URL 编码）
```

来源是官方站 animadex.net 的 `api/characters/search` —— 它的每条结果都带 `thumb_url`，
而这条地址是**按 slug + copyright 拼出来的**，所以 4000 条都能自己算，不用存 4000 条 URL
（清单会从 476 KB 翻一倍），也不用发第二次请求。

实测（真机，随机 16 条）：**16/16 命中 200**；探针里连开 120 行，`naturalWidth > 0` 的有 19 张
（`loading="lazy"`，只有可见那几行会去拉），坏图 **0 张**。
`copyright` 为空的那几条拼不出地址 → 返回空串，那一行就是没有缩略图（行高由外面那个
44×44 的固定方块撑着，不会跳）。

### 2. 服装分类

数据来自 `nregret/AnimaTags-DB` 的 `clothing_data.json`（430 条，6 个分类：
制服/西服 108、性感/暴露 160、日常/休闲 188、泳装/内衣 141、礼服/裙装 153、角色扮演/奇幻 52），
转成 `src/public/danbooru/clothings.json`（对齐 `DanbooruScene` 的形状，
`tags` 末尾那个多余的逗号在导入时削掉，`preview` 走 jsDelivr `Dressing-doll` 仓，与姿势/环境同族）。

- 面板顺序：**角色 → 服装 → 姿势 → 环境 → 画师 → 自定义**（挑的时候的思维顺序）。
- 抽签规则同姿势/环境：**抽 1 个**。
- 合成顺序（`composeTags`）：`画师 → 角色 → 服装 → 环境 → 姿势 → 自定义` ——
  服装插在角色之后、环境之前，与上游 Anima-Tools 的 composer
  （`artist, character, clothing, background, pose`）一致。
- 真机验收：底部预览串实测
  `karin (blue archive), evening gown, halterneck, ..., crystal footwear, white background, standing,`
  —— 角色 → 服装 → 环境 → 姿势，顺序对。

🔴 **六档 tab 的兜底从「横滑」改成「换行」**：加了一档之后 288px（`--ui` 0.8）里排不下，
而 `overflow-x: auto` 那条是**看不出还能滑**的 —— 「自定义」会直接消失。
现在写的是 `flex-wrap: wrap` + `flex: 1 0 auto`（不缩 → 文字永不被压扁，放不下就折到第二行）。

### 3. 两个选择器贴到节点旁（参数栏**关着**时）

徐先：「在没有节点参数侧边栏的模式，标签的选择直接在节点的下方显示选择；
风格选择……从侧边栏一点到参数旁边进行选择。」
问过方向后定的口径：**参数栏关着才贴节点**，开着时照旧并排第三栏（那会儿画布已经被夹住了）。

| 面板 | 参数栏关着 | 参数栏开着 |
|---|---|---|
| D站标签选择器 | 浮在**被挑那颗节点正下方**（`data-dtp-anchor="below"`） | 并排第三栏 |
| 预设选择器（风格/滤镜/运镜） | 浮在**参数对话框右边**（`data-cpk-anchor="beside"`） | 并排第三栏 |

实现：两个组件都加一个可选 `anchor?: DockAnchor`，**有锚点就 portal 到 `.cv-stage` 走 absolute，
没有就照旧 portal 到 `.cv-preset-slot`**。位置一律由 `CanvasEditor` 算
（`dockAnchorFor` 多了一个「想要多宽」参数，标签栏传 360；预设栏另算一个「贴对话框右边」的锚点，
右边放不下退左边，两边都放不下就贴画布右缘）。

🔴 **浮动面板的高度跟对话框不是一条规矩**（真机抓到的）：
对话框「不夹上下、装不下就往下伸出画布」是他 2026-10-02 定的 —— 它常驻、位置不能跳，
伸出去丢的是底部操作排，把节点往上挪一下就回来了。
这两块面板是**点一下才出来的浮层**，底部丢的是列表和那行预览串（也就是它唯一的内容），
实测节点在下半屏时 460 高的面板有 **155px 落在窗口外面**，滚动条都在外面，够不着。
所以另立一条 `pickerMaxHeight()`：能塞就塞满，塞不下按「节点下沿到画布底」压，
但**不低于 240**。

### 4. 「启动」拆两档

顶栏那颗「启动」右边挂了一颗只有小箭头（20px 宽、无底色、与主键圆角互补 ——
做成两颗按钮会被读成两个功能）的按钮，点开两档：

- **绕过已经生成过的节点**（主键那一下跑的就是这档）：有结果的生成节点不重复提交；
- **全部运行**：有结果的也重跑一遍。

`runAllNodes(confirmed, mode)` 里两档的差别**只有 `settledBefore` 这一份名单** ——
`all` 时给一个空 Set。预检、依赖顺序、等渲染、停止全部共用同一条循环（另开一条迟早走成两种行为）。
大遍数二次确认那一趟也要把档位带过去（`pendingRunMode` 这个 ref），
不然从「全部运行」点进去、确认完却按「绕过」跑了。
跑完的提示语两档分开写：`all` 必须说出「这次没跳」，否则下次分不清自己点的是哪一档。

**验收**（真机 + 隔离实例，1440 宽，探针 `ui108_probe.js`）：除一条自查项外全 PASS ——
`data-dtp-anchor=below` + 间隙 12px + 在 `.cv-stage` 内 + 可见性四判据全过；
六档 tab 都在且宽度 > 0；角色 120 行有缩略图、加载 19 张 0 坏；
服装 430 条、挑一条后 chip 与预览串都对；启动菜单两档文案正确、点别处能收起。

## 追加（2026-10-08 17:20）自定义标签分类 / 最右侧的加号（1.0.108）

徐先：「标签也可以自己加分类，最右侧加一个加号……就是一个圆圈中有一个加号，可以自己添加标签分类。」

### 1. tab 条最右侧那颗「+」

`.cv-dtp-add`：26×26 的圆形（`border-radius: 999px`）、`margin-left: auto` 靠右、
`flex: none`（⚠️ 不能省 —— 旁边那条 `.cv-dtp .cv-cpk-tab { flex: 1 0 auto }` 是给档位写的，
被它吃到就会把圆圈拉成一条）。
🔴 **`padding: 0` 也不能省**：`globals.css` 给所有 `button` 留了横向内边距，
不压掉真机上量出来是 **30×26** —— 「圆圈」变成横椭圆（探针抓到的，第一轮就 FAIL 在这）。

点它摊开一行新建表单：名字输入框（`autoFocus`，不用再点一下才能打字）+ 两颗互斥胶囊
（**抽 1 条** / **整串接上**）+ 创建。建完自动切到新分类、表单自己收起。

### 2. 三条来源（他三条全要）

一个分类里的标签可以来自：

| 来源 | 怎么做 | 落到的字段 |
| --- | --- | --- |
| ① 手输 | 工具条「加标签」→ 内联输入 → 回车 / 点「加」 | 标签即名字 |
| ② 导入清单 | 工具条「导入清单」→ 系统文件对话框 → 主进程读文件 | 一行一个标签，或 `名字 \| 标签串` |
| ③ 收藏已有 | 工具条「收藏已有」→ 角色 / 服装 / 姿势 / 环境四档 → 点行 | 带缩略图（远程地址） |

🔴 **导入的分隔符只认竖线和 Tab，不认逗号**：标签串本身全是逗号
（`evening gown, halterneck, side slit`），用逗号当分隔符会把一条标签劈成两半 ——
而且劈出来还挺像回事，这种错最难发现。
🔴 **条目 id 取 `tags` 的哈希**（主进程 md5、渲染层 djb2 各一份，语义一致）：
同一条标签导两次、或手输里又打了一遍，得到的 id 一样 —— 否则列表里会出现两条一模一样的，
而用户「明明只加了一次」。收藏角色时行 id 是名字、条目 id 却是 `tags` 的哈希，
所以要翻一次（`collectEntryOf`）。
🔴 **「加标签」加完输入行不关**：可以连着打几条。第一版没想清楚，探针照「再点一次按钮」
打第二条时把输入行收起来了 —— 那是**探针步骤**写错，但也说明这个 toggle 语义值得写下来。

### 3. 提交方式每个分类自己定

`mode: 'pick' | 'all'` 存在**分类上**，不是全局开关 —— 「质量词」这种要整串接的
会和「衣服」这种要抽一个的互相打架。工具条右侧两颗胶囊随时能改。
组装顺序：**画师 → 角色 → 服装 → 环境 → 姿势 → 自定义分类 → 自由文本**。
`all` 按**分类里的顺序**接（不是点击顺序）：那个顺序就是用户排的。

### 4. 存哪儿、谁写

`<dataDir>/danbooru-categories.json`，**只有主进程写**（`electron/main/danbooru-cats.ts`），
三条 IPC：`danbooru-cats:load` / `:save`（整份写回）/ `:import`（只读文件、把条目交回来）。
写盘三档兜底照抄 `preset-import.ts` 的 `writeManifest()`（rename → writeFileSync → unlink+write）。
🔴 `import` **只读不写**：收不收、收进哪个分类由渲染进程决定 —— 点了导入又反悔时磁盘上不该留下任何东西。
🔴 渲染层有一份**模块级缓存 + 订阅**（`src/lib/danbooruCats.ts`）：抽签发生在 `CanvasEditor`
（「启动」时重抽），那时面板可能根本没开 —— 所以写盘之后缓存立刻更新（乐观写）再发 IPC，
面板与画布读的是同一份。读失败**当「还没有」**，不抛。

🔴 **清单不随画布走**：节点上只存「选了哪些条目 id」，分类被删之后老画布不会炸 ——
`drawCustom()` 找不到分类就跳过它（与内置那五档「抽到的 id 已不在清单里」同一条规矩）。
列表里那颗「从分类里删掉这条」**不能**放进行按钮里面（`<button>` 套 `<button>` 非法结构），
所以外面套了一层 `.cv-dtp-row-wrap`。
「删除分类」是**两步确认**（第一下变「确认删除」），不用 `window.confirm` ——
它同步阻塞、样式是另一套，而且会卡住任何自动化点击序列。

**验收**（真机 + 隔离实例，1440 宽，探针 `uicats_probe.js`，37 项 **ALL PASS**）：
加号 26×26 圆、落在 tab 条尾、四判据可见；六档原样都在；新建表单 autoFocus、两档互斥；
建完自动切过去、工具栏三颗动作都在；手输两条 → 列表 2 行、已选 2、预览串末尾
`..., masterpiece, best quality,`；收藏模式四档来源、点一行标「已收」、底栏
`角色 4000 条 · 已收 3`；导入走 IPC 读到 3 条且「名字 | 标签串」拆对了；
落盘 `danbooru-categories.json` 三条齐全；删分类两步确认、删完回到「角色」档、磁盘同步清空。

## 追加（2026-10-08 18:20）创作预设也能自己建：两颗加号 / 自建档与自建分类（1.0.109）

同一套体验搬到创作预设面板（徐先：「好的，风格滤镜运镜哪里的也加上吧」）。
方向是他选定的：**两颗加号都要** + **三条来源全要**。

**两颗加号，两个层级**（与标签面板那颗同一款：圆圈里一个加号）：

| 位置 | aria-label | 建的是什么 |
| --- | --- | --- |
| tab 条（风格 / 滤镜 / 运镜）最右侧 | `新建预设档` | 一个**档**，与内置三档并列；建时要定「可叠加 / 只一条」 |
| 分类胶囊排（全部 / 收藏 / 自定义）最右侧 | `新建预设分类` | 当前档下的一个**分类** |

**自建档的「只一条」不是装饰**：内置运镜只能选一条、风格可以叠好几条，
自建档由建档时那一档决定 —— `maxPicksFor(kind)` 查 `extraKinds[kind].single`。
`orderedKinds()` = 内置三档 + 自建档 + **节点快照里出现过但已删档的**（最后那半是给老画布兜底）。

**三条来源**：分类工具条上三颗 —— `加一条`（手输名字 + 提示词）、
`导入清单`（走主进程 IPC，`.json / .txt / .csv`，一行一条或「名字 | 提示词」）、
`收藏已有`（从**所有**已有预设里挑着收进这个分类，点一下收、再点一下移出）。

**存储**：`<dataDir>/creative-presets/mine.json`，**单独一份**。
不并进 `imported.json` —— 那一份的语义是「同名再导 = 覆盖」，这份要的是「追加」；
两个语义塞一份文件，总有一次会清掉不该清的。写盘三档兜底（rename → writeFileSync → unlink+write）。
档 / 分类**不随画布走**：节点上存整条预设快照，档删了老画布照样读得出来、照样提交。

**这一轮真机抓到的三个 bug**（都不是猜的，是探针量出来的）：

1. 🔴 **收藏模式被当前分类过滤掉，一屏 0 条** —— `visible` 里那层
   `item.category === category` 对自建分类不成立（自建分类本来是空的），
   而收藏模式存在的意义就是「从别处收进来」，于是永远是空白。
   修：`collecting` 时**撤掉**分类过滤（搜索那层留着）。
2. 🔴 **dock 那排按钮把自建档名显示成「预设」** —— 档名注册表原先只在
   预设面板的 `useEffect` 里注册，而生成节点那一排（`GenerateDock`）比面板先出现，
   面板从没打开过时 `kindLabelOf()` 查不到名字、落兜底。
   修：注册挪进 `presetMine.ts` 的 `loadMine()` / `replaceMine()` —— 谁先加载谁注册。
3. 🔴 **卡片左下角那颗「删掉这条」压着名字** —— CSS 注释写的是「挪到左上角」，
   实现却是 `bottom`，而卡片底部那一行正是名字，截图里看着像「名字被图标啃掉一半」。
   修：改回 `top`。探针补了一条几何断言（两个矩形不相交），以后按矩形判不靠眼睛。

**验收**（真机 + 隔离实例 `_hlprobe4` / 端口 9342，1440 宽，探针 `cpkmine_probe.js`，81 项 **ALL PASS**）：
两颗加号 24×24 圆（`padding: 0`）、各在自己那一排的最右侧；内置三档 / 三分类原样都在；
新建档表单 autoFocus + 两档互斥（选「只一条」后 `aria-pressed` 正确）+ 建完自动切过去；
新建分类表单 autoFocus + 建完自动选中；手输两条（加完输入行还开着、两个框都清空、条数 1 → 2）；
导入走 IPC 读到 2 条且「名字 / 提示词」拆对；收藏模式列出 **60** 条（从所有预设里挑）、
每张卡带「＋」标记、点一下变「已收」、退出收藏后分类 3 条（2 手输 + 1 收藏）；
落盘 `mine.json` 档 / 分类 / 3 条预设齐全且 `kind` / `category` 指得对；
分类改名（条目上的 `category` 快照跟着改，不留散的）+ 档改名都验了；
关面板后 dock 那排按钮多出「我的运镜」且点得开、能选中、能进提示词；
删分类 / 删档两步确认（第一下变「确认删除」），删完 tab 回到三档、磁盘同步清空。
全程**没碰他的 `dist` 与 `frame.db`**（验证：他的 `%APPDATA%\holy-light-canvas\creative-presets\mine.json` 不存在）。
截图：`design-previews/2026-10-08-创作预设自建档分类/`。

## 追加（2026-10-09）D站标签加「镜头」档（1.0.118）

徐先：「d站标签添加镜头分组，中景，近景，特写之类的（**去网上找，不要自己加**）」。

**数据不是自编的。** 上游 `nregret/AnimaTags-DB` 只有 character / clothing / pose / background
四类，**没有镜头** —— 所以这一档另起一份 `src/public/danbooru/shots.json`（29 条），
内容是照 **Danbooru 官方 `wiki_pages/tag_group:image_composition`** 那一页抄的三节：

| 分节（官方原文） | 条数 | 举例 |
| --- | --- | --- |
| Framing the body（景别） | 12 | `close-up` / `portrait` / `upper_body` / `cowboy_shot` / `feet_out_of_frame` / `full_body` / `wide_shot` / `very_wide_shot` / `lower_body` / `head_out_of_frame` / `eyes_out_of_frame` / `profile` |
| View Angle（机位） | 12 | `dutch_angle` / `from_above` / `from_below` / `from_behind` / `from_side` / `straight-on` / `three-quarter_view` / `high_up` / `sideways` / `upside-down` / `pov` / `multiple_views` |
| Perspective / Depth（透视） | 5 | `atmospheric_perspective` / `fisheye` / `panorama` / `perspective` / `vanishing_point` |

🔴 **每个 tag 都在官方标签库里逐个查过存在**（不是照着 wiki 的标题拼的）——
wiki 上写的是带空格的标题，实际 tag 混用两种连接符：`close-up` / `straight-on` /
`upside-down` / `three-quarter_view` 是**连字符**，别的一律下划线。
顺手把搜索结果里那份「AI 编的清单」丢掉了：`movie_style` / `cinematic_shot` /
`over_the_shoulder_shot` / `bird's-eye_view` / `worm's-eye_view` / `medium_shot`
在 Danbooru 里**一个都不存在**（`medium_shot` 只有 `cowboy_shot` 这个等价物）。

中文名 = 官方 wiki 那句括号说明的直译（`portrait` = "Face through shoulders" → 脸到肩），
前面那个「近景 / 中景 / 特写」是影视里的对应叫法，纯粹为了**搜得到**（他嘴里说的就是这几个词）。
`preview` 一律空串：这一档没有例图 —— 顺手在 `panels.css` 加 `.cv-dtp-thumb:empty { display: none }`，
把那个空方块撤掉（`:empty` 只命中**真没图**的行，没加载完的 `<img>` 是子节点、不受影响）。

**接线**：`DanbooruScene` 的形状原样复用，所以挑选 / 抽签 / 组装那三套一行没改，
只加了一条数据通路 —— `DanbooruData.shots` / `TagSelection.shots` / `DATA_FILES` /
`Promise.all` 一路 / `TAG_KINDS` / `tagNeedsRedraw` / `TagDraw.shot` / `drawTags` /
`composeTags` / `sceneLabelOf` 的 kind 联合；面板那边是 `Tab` / `TAB_LABEL` / `TAB_ORDER` /
`TAB_KEY` / `SCENE_KEY` / `COLLECT_LABEL` / `COLLECT_ORDER`。

🔴 **组装位置定在姿势之后、自定义之前**（`TAG_KINDS` 里 `shot` 跟在 `pose` 后面）。
不插到前面去：那会悄悄改掉老画布上那些已经调好的串里各段的相对位置。
这一档在老画布上是空的 → 拼出来的串**逐字节不变**（单测里钉了一条）。

**验收**（真机 + 隔离实例，临时包 `C:\Windows\Temp\_hlbuild118`、端口 9364，探针 `shot_probe.js`，**32 项 ALL PASS**）：
`fetch('/danbooru/shots.json')` 在 `app://app` 下取到 29 条（含 4 个编造 tag 的否定断言）；
tab 条 `["角色","服装","姿势","环境","镜头","画师","自定义"]`；点进去列出 29 行、
中景 / 近景 / 特写都在；空缩略图 `display:none`；勾「中景」→ 底栏那串出现 `cowboy_shot, `；
抽签模式那一行挂在 `shot` 这一档；中英文都能搜到。

🔴 **这一轮真机撞到的坑**：点节点卡上那颗「标签」**什么都不会出现** ——
因为 `inspectorOpen` **初值就是 `true`**，而浮动那一支的条件是 `!inspectorOpen`，
就地那一支又只喂给「当前正被检查的那个节点」。探针里得先点顶栏那颗「节点参数」把它收起来。
（这不是 bug，是既有设计；但「点标签没反应」在没有这条认知时会看着像坏了。）

🔴 单测跑法（`_tagstest.ts`）编译完**要给 `@/` 补一份别名**，不然 `Cannot find module '@/lib/danbooruCats'`：
`outDir/node_modules/@` 指向产物根（`cp -r lib components <out>/node_modules/@/`）。

---

## 追加（2026-10-10）资产灯箱：撤「下载」、加「打开文件所在位置」、加「复制」（1.0.119）

> 徐先：「**怎么还有下载，这不是本地的的吗，直接换成打开文件所在位置就行了吧，
> 而且还不能复制，我要可以复制的功能**」

### 一、那颗「下载」为什么撤

资产本来就是**本机落盘**的文件。再存一份到「下载」目录没有意义 ——
用户点它的真正动机不是「我要第二份」，是「**这东西到底在哪**」。
而「下载」恰恰回答不了这个问题（存到哪去了还得再找一次）。
所以换成 `shell.showItemInFolder`：打开父目录**并选中这一份**。

`GalleryItem.downloadUrl` 这个字段**接口还在给**（列表那边没动），
但在注释里写明「界面已经不用它了」，免得下一个人照着字段名以为还有个下载入口。

### 二、复制按类型给三样不同的东西

| 类型 | 复制的是什么 | 为什么 |
|---|---|---|
| 图片 | **图本身**（canvas → PNG → `clipboard.write`） | 他要复制一张图，要的是能粘进别处的那张图 |
| 文本 | 那一段字 | 同上 |
| 视频 / 音频 / latent | **文件路径** | 剪贴板装不下一个视频；这时候「把路径给他」才是能用的那件事（粘到 ComfyUI / 播放器里就能打开） |

图片走 `canvas.toBlob('image/png')` 而不是 electron 的 `nativeImage`：
WebP / GIF 这类 `nativeImage` 读不了的格式，只要 Chromium 解得开就能复制，
粘出去统一是 PNG，最不容易出问题。

按钮文字按类型分两种 —— 图片 / 文本显示「复制」，其余显示「**复制路径**」：
复制出来的是路径这件事，得在按下去**之前**就说清楚。
回执用**按钮自己改字**（复制 → 已复制，1.8s 后退回）而不是在别处加一行提示：
复制是就地一下的动作，回执也该长在他按的那颗按钮上。

### 三、新增的一条接口与一条 IPC

- `GET /api/assets/[id]/path` → 本机绝对路径。**单开一条按需取，不塞进列表**：
  列表一次六十行，每行都要摸一次盘才算出这个字段，而它只在一颗**按下去才会用到**的按钮里出现。
  🔴 路由表里这条**必须排在 `/api/assets/[id]/[file]` 前面** —— `dispatch.ts` 是
  `for (const route of ROUTES)` 取**第一个命中**，排在后面会被 `[file]` 接走（`path` 会被当成文件名）。
- `reveal-file` IPC（`shell.showItemInFolder`）：与既有的 `open-folder` 不是一回事 ——
  后者只打开目录，前者**选中那一个文件**。

🔴 `shell.showItemInFolder` **不返回值**，文件不存在时**静默无反应**（不报错、不开窗）。
所以主进程里先 `fs.existsSync` 判一次，不存在就回一句「这个文件已经不在了」，
服务端那条接口也同理（找不到返回 404，不把空路径甩出去）。

🔴 服务端取路径必须过 `resolveStoredPath()`（见 `lib/assets.ts` 那段的注释）：
`metadata.path` 是**落盘当时**写下的绝对路径，它先在原处找、找不到才在当前产出目录下重定位；
真机实测库里那 60 条返回的都是当初那个路径。搬丢了的才返回 `null` → 404。

### 四、验收

隔离实例（临时包 `C:\Windows\Temp\_hlbuild119`、端口 9371，探针 `asset_copy_probe.js`，
数据目录 `C:\Windows\Temp\_hlprobe119`，**64 项 ALL PASS**），逐类型跑：

- **底栏**：`a[download]` 0 个、文字里搜不到「下载」；底栏实际是
  `删除 / 超清 / 打开所在项目 / 打开文件所在位置 / 复制`。
- **打开文件所在位置**：四类上都在、剪裁框求交后仍有面积、`elementFromPoint` 命中；
  真点一次不报错（资源管理器弹出来了）；`/api/assets/<id>/path` 200 且给的是
  盘符开头的绝对路径，**并且那个文件在磁盘上真的存在**（Node 侧 `fs.existsSync` 再判一次，
  不只看接口返回 200）。
- **复制**：四类都真点了 → 按钮变「已复制」（说明 `clipboard.write` 真的 resolve 了）、无报错；
  再从剪贴板**读回来比对**：图片是 `image/png`、视频 / 音频 / latent 读回来的文本
  与接口给的路径**逐字符相同**；「已复制」过一会儿自己退回。
- 按钮文字：图片「复制」、视频 / 音频 / latent「复制路径」。

⚠️ **文本那一档没在真机跑到** —— 他资产库里目前一条文本资产都没有
（`storage/` 下连一个 `.txt` 都搜不到）。那两行依赖的两个能力
（同源 `fetch(url).text()`、`clipboard.writeText`）都已被真机上别的分支证明过，
但**端到端没跑**。等哪天跑出文本资产再补这一条。

🔴 **探针要点**：`Runtime.evaluate` 里的 `el.click()` **不给 transient activation**，
而 `navigator.clipboard.write()` 要的就是它 —— 必须用 `Input.dispatchMouseEvent` 派真实点击。
读回来比对还要 `Page.bringToFront` + `Emulation.setFocusEmulationEnabled`
（不聚焦的话 `clipboard.read()` 直接报 *Document is not focused*），
外加 `Browser.grantPermissions`（走 `/json/version` 那个**浏览器级** ws，page 级 ws 发不了）。

---

## 追加（2026-10-10）画布页不该能滚（bug）+ 资产右键复制 / 拖出（1.0.119）

> 徐先：「**右键就可以复制，也可以直接将拖入别的软件**」
> 徐先（附两张截图）：「**选中节点下划会直接到一片没用画布的空间**」

### 一、那个 bug：对话框把整页撑出了滚动条

**现象**：选中一个生成节点之后，鼠标往下滑一下，画布整个被推走，满屏一片**没有点阵的空地**，
左下那条缩放条也不见了，只剩底部那个对话框还贴着屏幕底 —— 而且「回不来」。

**根因**（不是猜的，真机上量出来的）：

生成对话框 `.cv-dock` 是**故意往画布外伸**的 —— 那是他以前定的（见 `dockAnchorFor` 上面那段：
「不是压矮」，宁可让最底下那排操作被裁掉，也不要面板变矮）。它的包含块是 `.cv-stage`
（`position: relative`），而 `.cv-stage` 那时 `overflow: visible` ——
**于是伸出底边的那一截直接撑大了文档的 `scrollHeight`**。

真机上量到的现场：`.cv-dock` 底边 **906** / 视口 **903**，`documentElement` 宽从 1440 变成 1430
（滚动条把那 10px 吃掉了）。画布页本该是**固定视口的一屏**，多出来这几像素却让整页可滚 ——
鼠标只要一移出画布（飘到对话框上、或顶上那条栏）往下滚，滚的就是**文档**：
画布被推出视口，剩下的全是没画东西的地方。

**修法**：`.cv-stage` 加 `overflow: hidden`。

```css
.flow-shell .cv-stage { overflow: hidden; }
```

「伸出画布」的效果**一点没变**（那一截本来就在视口外看不见），但整页不再可滚。

🔴 **代价，写在这儿免得下一个人当 bug 再修回去**：`.cv-dock` 里那些 `position: absolute`
的下拉（`DockCombo`）如果也伸出底边，会跟着被裁。它原本落在视口外，用户本来也看不见 ——
但「撑出滚动条让人滚下去看」从来没被当成正经出路。真要修，该让下拉在空间不够时**向上翻**，
而不是让页面能滚。

⚠️ `position: fixed` 的浮层（右键菜单那一层 `.cv-menu-mask`）不受影响 ——
fixed 后代的包含块是视口，除非祖先带 `transform` / `filter`（这里没有）。真机验过：菜单照常弹。

**验收**（隔离实例、端口 9375，`cvfix2_probe.js`，**13 项 ALL PASS**）：
把生成节点从上往下拖 620px，逼对话框伸到视口外（`dock 733~979`，视口 903）——
`doc.scrollHeight == clientHeight == 903`、横向也不滚、rail / vp 都还在视口里；
在对话框上滚 5 下再按 ↓ / PageDown / End，`scrollTop` 恒为 **0**。
**交叉验证**：往 `.cv-stage` 里插一个「伸出底边 500px」的元素，文档照样不滚；
把**同一个**元素挪到 `body` 上，文档立刻被撑大 —— 证明裁剪确实来自 stage 那条 overflow。

### 二、右键复制

卡片右键菜单从 `预览 / 重命名 / 删除` 变成 `预览 / 复制 / 重命名 / 删除`。

复制的是什么**按类型分**，跟灯箱底栏那颗按钮**完全同一套**（`copy()` 一份实现）：
图片 → 图本身；文本 → 那段字；视频 / 音频 / latent → 文件路径。
菜单项的文字也跟着变（「复制」/「复制路径」）—— 从哪儿按只是入口不同，出去的东西必须一致。

🔴 **顺手修掉一个隐患**：`copy()` 原本无条件拿灯箱里那张 `<img>`（`stageImgRef`）去转 PNG。
可右键菜单是在**卡片**上按的，那时灯箱可能开着的是**另一张**、甚至根本没开 ——
再走这条路会**安安静静地复制错图**。现在拿 URL 比一次（`<img>.src` 是解析后的绝对地址，
不能直接跟 `item.url` 比字符串），不是那一张就自己 `new Image()` 载一次。
`copy()` 也因此**刻意不再是 `useCallback`**：报错往哪儿显示（灯箱里那行红字 / 顶部那条提示）
取决于当前这次渲染的 `openId`，闭包得是新的。

### 三、拖到别的软件

- 主进程 `ipcMain.on('start-drag')` → `event.sender.startDrag({ file, icon })`。
- 🔴 **必须用 `ipcMain.on` 而不是 `handle`**：渲染进程的 `dragstart` 处理函数里
  `ipcRenderer.send` 是**不等回话**的，`startDrag` 要在拖拽会话还活着的时候交给系统。
  走 `handle` 等一个 Promise 往返，回来时用户可能已经松手 —— 表现是「拖了没反应」。
- 🔴 **`icon` 不能是空的**（运行时会对空 `NativeImage` 报 `Must specify non-empty 'icon' option`），
  所以 `await app.getFileIcon()`；拿不到就退一张自己画的 1×1，文件照样拖得出去。
- 🔴 **渲染进程里 `event.preventDefault()` 一定要有**：不拦的话 Chromium 会自己起一次
  HTML5 拖拽，落到目标软件里的是「一张图片」或一坨文本，**不是那个文件**，还会跟主进程那次打架。
- 🔴 **路径必须在 `pointerdown` 时就预取**（`pathCache`）：`dragstart` 那一刻必须**已经**拿到路径，
  中间一次 await 都不能有。按下到真正拖起来那几十~几百毫秒，够本地那条接口跑完。
  没取到就照拦、并说一句「正在取位置，稍等一下再拖」—— 宁可这次拖不动，
  也不要让用户以为自己拖出去了、结果落到别处的是别的东西。

`draggable` 挂在卡片的 `<article>` 上（缩略图那两个 `img` / `video` 显式 `draggable={false}`，
让整张卡是唯一拖动源）；**选择模式下不给拖**（那时左键是「勾选」，会跟拖拽抢同一个手势）。
灯箱里的图和视频也挂了同一套。

**验收**（隔离实例、端口 9374，`cvfix_probe.js` **20 项 ALL PASS** + `dragapi_probe.js` **4 项 ALL PASS**）：
卡片 `draggable=true`；卡片右键菜单确实是 `["预览","复制","重命名","删除"]`；
点菜单里的「复制」→ 剪贴板里是 `image/png`、顶部没有报错提示；灯箱里的 `<img>` `draggable=true`；
`window.api.startDrag` 是 function。

⚠️ **「真拖一次」没做自动验证** —— `startDrag` 会把鼠标交给系统进一个拖拽会话，
没有真人松手就一直挂着，探针会僵死。这一步**要人手动试**（把卡片拖到资源管理器 / PS 里）。


---

## 追加（2026-10-09）D站标签第八档「表情」+ 每一档每一行都能收藏（1.0.120）

徐先两句话：「d站标签添加表情分类」、「可以每个选项都有收藏功能」。
问清了两处才动手：**收藏覆盖所有档的每个选项**（不只是新加的表情档），
用起来是**标星 + 只看收藏 + 收藏的排最前**。

### 一、表情这一档

- 数据 `src/public/danbooru/expressions.json`，**79 条**，照 Danbooru 官方
  **`tag_group:face_tags`** 那一页抄（注意页面名是 face **tags**，不是 expression）。
- 🔴 **只收「表情本体」**，官方那页上另外四节一律没收，与上一轮「效果」档同一个口径：
  Sexual（`ahegao` / `aroused` / `fucked_silly` / `torogao` …）、
  Emotes（`:d` `:3` `^_^` `o_o` … 颜文字）、
  Meme faces（`troll_face` / `awesome_face` / `henohenomoheji` …）、
  Drawing styles（`constricted_pupils` / `dot_nose` / `chestnut_mouth` … 五官**画法**，属画风）。
  另 `rape_face` / `glasgow_smile` 不合适没收；`portrait` / `profile` 镜头档已收过，不重复。
- ⚠️ **查 tag 存在性踩到一个坑，必须记住**：一次批 20 条查，那一批被 SSL 握手超时 + RST
  打掉三次，脚本把**整批记成「不存在」** —— 里面躺着 `sad` / `surprised` / `serious`
  这种核心表情，差一点就被当编的删掉。**「没返回」≠「不存在」**，
  批量查失败必须小批重查（这次一条一查、重试 5 次，20 条全在）。
- 拼串顺序：画师 → 角色 → 服装 → 环境 → 姿势 → 镜头 → 效果 → **表情** → 自定义。
  接在内置档的**最后面**，老画布上这一档是空的 → 既有的串**逐字节不变**（单测钉住）。

### 二、收藏（所有档）

- 存储 `<dataDir>/danbooru-favorites.json`（`electron/main/danbooru-favs.ts`），
  形状 `{ version: 1, favs: { 桶: [id…] } }`。
- 🔴 **桶按档分**：内置档用 tab 键（`character` / … / `expression` / `artist`），
  自定义分类用 `custom:<分类 id>`。不分桶的话，在效果档标一条星，
  某个「从效果那档收进来的」自定义分类里同一条也会跟着亮 —— 它们的 id 是同一个哈希。
- 🔴 **只存 id，不存内容**：内置清单随版本增删，抄一份标签串进来，
  「收藏了什么」会跟列表里实际显示的对不上。
- 渲染层 `src/lib/danbooruFavs.ts`：模块级缓存 + 订阅 + **乐观写**
  （先改缓存再发 IPC）。点星要立刻看见，等写盘回来才变会显得没点上；
  写盘失败也不弹红字 —— 星已经点上了，下次开机丢掉而已。
- 🔴 **收藏不影响选中**：星归星、勾归勾，两颗分开的按钮。
  合成一颗的话「标个星」就等于「把这条标签选上」，那是两回事。
- 「只看收藏」是个**面板内**的一次性开关（不进持久数据）：下次打开默认还是看全部，
  否则会变成「我的列表怎么只剩几条」。它摆在搜索框那条横杠的右端**不另起一行** ——
  这一块的高度是按像素数着用的，多一行要从列表里再扣 30px。
- 排序是**稳定**的：收藏的整批挪到前面，两批内部都保持清单里原来的顺序。

**验收**（隔离实例、端口 9380、临时包 `_hlbuild120`、项目 `cmuu1v0o80n7oniyti`，
`expr_probe.js` **45 项 ALL PASS**）：`expressions.json` 取到 79 条分四节且**每条都有中文名**；
不收的那 10 条一个都没混进来；tab 条 `["角色","服装","姿势","环境","镜头","效果","表情","画师","自定义"]`；
列出 79 行、**79 颗星**；点「脸红」的星 → 星亮 + 排到第一行 + 「已选」没变；
「只看收藏」→ 只剩它、底栏「收藏 1 条」；关面板再开星还在；切到效果档也能标星
且两档各存各的（切回表情档，之前那条仍在最前）。

另**盘上核对**：`<根>/danbooru-favorites.json` 内容是
`{"version":1,"favs":{"expression":["exp_0006"],"effect":["eff_0019"]}}` —— 两个桶分开，没有串档。

🔴 单测 `_tagstest.ts` 加了第 12 节（13 条），连同 1~11 节 **ALL PASS**；
`typecheck` rc=0。


---

## 2026-10-09 · 1.0.120（二）资产库分页 + 生成结果能拖出去

徐先：「**生成结果也能拖到别的软件；资产库只能显示最近60，请修复**」。
他随后确认了方案：**分页，一次拉 60**（不是把 60 调成 400 一次给完 ——
四百来张缩略图一次进 DOM，这一页会明显卡住）。

### 一、资产库分页

- `lib/assets.ts` 的 `listAssets()` 加了 `skip`（以前只有 `take`，所以那一页**就是**全部），
  并回 `hasMore`。🔴 `hasMore` 拿**查回来的行数**比，不是 `items.length` ——
  认不出类型的行会被 `items` 丢掉，用 `items.length` 会在最后一页上多报一次「还有」，
  于是滚到底永远在加载、却永远加载不出东西。
- `/api/assets` 认 `?page=N`（认不出当第 1 页），`skip = (N-1) * 60`，上限 `PAGE_MAX = 500`。
- 🔴 **第二页往后只回列表本身**，不带 `projects` / `storage` / `categories` / `latentCount`：
  那几样是给页头、筛选器、存储条用的，第一页已经给过；而 `storageOverview()`
  要逐条 `stat` 全库文件，四百多条盘 IO 每翻一页来一次纯属浪费。
- 🔴 **自动清理（`autoPrune`）只在第一页做**：翻页过程中记录被删会让下一页的 `skip`
  整体错位（少一条就重复一条 / 漏一条），把写操作留在「重新进这一页」的时刻最稳。
- 资产页：第一页照旧由 `useApi` 管，第二页往后攒在 `extra` 里；`items` = 第一页 + `extra`。
  🔴 **任何让第一页重取的动作都要 `resetPaging()`**（删除 / 打分类 / 上传 / 换筛选）——
  对外一律走 `reloadAll`，不用裸 `reload`。不清的话旧的第二页挂在新第一页后面，
  看着像「删掉的那条又回来了」。
- 追加时**按 id 去重**：两页之间可能有人删了东西，`skip` 是按「当前还剩多少」算的，
  下一条会往上顶一位出现两次。
- 计数那行从「显示最近 60 项」（那句是在替一个翻不动的实现打圆场）
  改成「**已显示 N 项**」。
- 🔴 **刻意不用 `IntersectionObserver` 做「滚到底自动加载」**：真机实测滚到底之后，
  哨兵的 `getBoundingClientRect()` 明明白白落在视口里（top 770 / 视口 900），
  observer 却**一次回调都没给**；在页面里另起一个一模一样的 observer 也是 0 次 ——
  不是挂错地方。改成监听**真正滚动的那个容器**的 `scroll` + 自己量一次 rect
  （顺带在挂载后先量一次：第一页没填满一屏时接着往下要）。
- 「加载更多（还有 N 项）」那颗按钮**留着**：它既是兜底入口，
  也把「还有多少没看到」这句话摆给用户。

### 二、生成结果也能拖到别的软件

- 拖拽那一套抽到 `src/lib/file-drag.ts`（`assetIdFromUrl` / `localPathOfAsset` /
  `useAssetFileDrag`），资产卡片、资产灯箱、生成结果三处**共用同一份** ——
  各写一份的话「路径还没取回来时该说哪句」迟早说成三种。
- 🔴 **只有本机那种形状拖得动**：`assetIdFromUrl()` 只认 `/api/assets/<id>/<file>`。
  RunningHub 那类远程结果**没有本机文件**，不给拖也不假装能拖 ——
  让它拖起来、掉到目标软件里却是一串地址，比拖不动更让人困惑。
- 🔴 `<img>` 与 `<a href>` **默认就是可拖的**，必须显式 `draggable={false}`：
  不给的话这次拖拽的源头是那张图/那个链接，`dragstart` 落到内层，
  拖出去的是「一张图片」或一串地址，而不是那个文件。
- `prefetch` 加了「正在取」的并发保护：没有这一层的话，
  「冷拖一下（没取到顺手发起一次）+ 立刻按下鼠标」就是**两趟一模一样的请求**（真机实测过）。
- 提示（「正在取这个文件的位置，稍等一下再拖。」）自己留一行、1.8s 自动收掉 ——
  拖拽是「试一下才知道」的动作，回执一直挂着会挡住结果本身。

### 三、探针写法上踩到的两个坑（值得记）

- 🔴 **`window.api` 是完全冻结的**：属性 `configurable:false / writable:false`，
  连 `window.api` 自身也是。`window.api.startDrag = fn` 在 sloppy 模式下**静默失败**
  （不抛，所以 `try/catch` 兜底那支根本不会跑到），`Object.defineProperty` 直接抛
  `Cannot redefine property`。→ 想验「拖出去」只能换路子：给 `window.fetch` 记账，
  看 `pointerdown` 那一下有没有真的去取 `/api/assets/<id>/path`、路径接口给的是不是
  真绝对路径、取到之后再拖走的是不是「有路径」那一支（不再弹提示）。
  最后一层「交给系统去拖」**真调 `startDrag` 会把鼠标交给系统、探针僵死**，只能手动试。
- 🔴 探针自己发的请求会污染 `fetch` 账本 —— 自己那趟要走 `window.__origFetch`。

---

## 2026-10-10 · 1.0.121 —— D站标签再加四档（头发 / 眼睛 / 画风 / 种族）

徐先看了「我们的 D 站标签还差什么分类」那张表之后，只回了两个字：**「加上」**。

### 一、这四档从哪来（都不是 Anima 那份上游）

上游 `Comfyui-Anima-Tools` 只有 character / clothing / pose / background 四类，
镜头（1.0.118）、效果（1.0.119）、表情（1.0.120）都是照 **Danbooru 官方 tag group** 抄的，
这一轮四档同一条路子：

| 档 | 官方来源 | 条数 |
| --- | --- | --- |
| 头发 `hairs.json` | `tag_group:hair_color`（发色）+ `tag_group:hair_styles`（发型 / 刘海 / 发质） | 112 |
| 眼睛 `eyes.json` | `tag_group:eyes_tags` | 61 |
| 画风 `styles.json` | `tag_group:visual_aesthetic` + 通用媒介标签 | 56 |
| 种族 `creatures.json` | `tag_group:legendary_creatures` + `tag_group:ears_tags` / `tag_group:tail` + `list_of_animals` | 116 |

取舍口径跟效果 / 表情那两轮**完全一致**：

- 头发：官方还有第三页 `tag_group:hair`（讲「跟头发有关的动作 / 物件 / 胡须 / 幻想头发」），
  **只收前两页**。`hairjob`、`cum on hair`、`hair_over_breasts` 那类是成人向；
  `biting hair` / `hair brush` 是动作与道具，不是造型；`intestine hair` / `food-themed hair`
  是怪诞造型，不进常规造型档。
- 眼睛：只收「眼睛长什么样 / 怎么看」。颜文字那几节（`> <`、`@ @`、`^ ^`、`o o` …）
  不收（跟表情档同一条理由）；`looking at breasts / pussy / penis / crotch` 不收；
  作品专属的 `Geass` / `Sharingan` / `Byakugan` 不收。
- 画风：`list_of_style_parodies` 几百条是「模仿某个具体作者 / 作品」的，
  **只取开头「By Decade / By Design」那十来条通用的**（`retro_artstyle`、`animification`…），
  作者名那一大片不收 —— 那是「画师」档的事，盯着一个人名对出图没意义。
- 种族：官方那页按文化归属（Greek / Egyptian / Japanese …）又列了一遍，
  那份是**同一个 tag 的第二次出现**，不收；只收「Type」那一节的种族名，
  再加上兽耳 / 兽尾与几十条常见动物。

每条都逐个在标签库里查过存在，**共 345 条**。

### 二、为什么头发是一档四小节，不是四个 tab

发色 / 发型 / 刘海 / 发质如果各拆一个 tab，tab 条直接二十个。
`DanbooruScene` 本来就有 `categories` 这个分组字段（镜头档用它分「景别 / 机位 / 透视」），
所以合并成一档、内部按 `categories` 分四节，面板那边的渲染一行都不用改。

### 三、🔴 拼进提示词的次序：四档一律接在**最后**

`TAG_KINDS` 里排在 `expression` 之后（= `composeTags` 里接在表情之后）：

```
画师 → 角色 → 服装 → 环境 → 姿势 → 镜头 → 效果 → 表情 → 头发 → 眼睛 → 画风 → 种族 → 自定义 → 自由文本
```

理由和加镜头 / 效果 / 表情那三轮一字不差：接在**末尾**，只有「这一档真选了东西」
时才多出一段 —— 老画布（这四档为空）拼出来的串**逐字节不变**。单测里有一条专门盯着它。

### 四、13 个 tab 会不会挤爆（他问过）

**不会**。`.cv-dtp .cv-cpk-tabs` 早就是 `flex-wrap: wrap`（自建分类可以一直加，
横滑的 tab 条「看不出还能滑」，最后一档会就那么消失）。真机实测：

- tab 条 13 个：角色 / 头发 / 眼睛 / 种族 / 服装 / 姿势 / 环境 / 镜头 / 效果 / 画风 / 表情 / 画师 / 自定义
- 排成**两行**；13 个的 `rect` 宽高全部 > 0，且 `elementFromPoint` 在中心点命中的都是自己
  —— 没有被裁掉、也没有被面板边缘压住

### 五、🔴 这一轮查 tag 存在性踩到的坑（跟上一轮不同）

上一轮（表情）的坑是「批量查被 SSL 打掉、整批记成 MISS」。这一轮是：

**镜像的 `post_count` 不可靠。** `cos.booru.nl` 上 `dragon` 返回 `post_count: 0`、
`cat_ears` 返回 553、`watercolor_(medium)` 返回 0 —— 同一批请求里有的对有的不对。
所以这一轮**只看「查得到 / 查不到」，不看计数**。差一点就因为「0 条」把
`dragon` / `elf` / `cat_ears` 这些核心 tag 全判成无效。

另外 `cos.booru.nl` 与 `donmai.moe` 的可用性也是轮着变的：
上一次 `donmai.moe` 通、`cos.booru.nl` 521；这一次反过来（`donmai.moe` 403 / Cloudflare，
`cos.booru.nl` 200）。**每次动手前先探一遍**，别照抄上一轮的结论。

最后 8 条查不到的（`big_eyes` / `acid_graphics` / `cyber_sigilism` / `sketch_(medium)` /
`digital_media_(medium)` / `3d_(medium)` / `woodcut_(medium)` / `therianthrope`）
用**三种查法**（精确名 / 通配 / 别名表）都查不到，对照组（`dragon` / `cat_ears` /
`watercolor_(medium)`）三种都正常 —— 这才敢删。**「没返回」≠「不存在」这条依然有效**，
只是这次用「对照组正常」把它钉死了。

### 六、验收

- 单测 `_tagstest.ts`：新增 5g 段 9 条（次序 / 老画布空数组 / 老画布串逐字节不变 /
  独立随机流 / 各自一把种子 / 重抽判定 / id 不在清单不炸），**ALL PASS**。
- 真机探针 `db4_probe.js`（临时包 `_hlbuild121`，隔离实例）：**82 PASS / 0 FAIL**。
  含每份 JSON 的条数 / 小节数 / 该有的在 / 不该收的不在 / 每条都有中文名，
  13 个 tab 的顺序与可见性，四档各选一条 → 串里出现对应 tag，
  四档同选 → 串里四段次序正确，中英文搜索各一条。


## 2026-10-10 · 1.0.121 —— 工作流配置里「其实是个枚举」的字段换成下拉

**他报的**：配置页绑定参数时，某些字段是个光秃秃的输入框，而它在 ComfyUI 里是九选一
（`MiniMaxH3IntegrationGH.aspect`：`adaptive / 16:9 / 9:16 / 3:2 / 2:3 / 4:3 / 3:4 / 1:1 / 21:9`）。

**根因**：字段列表是从**工作流图**上扫出来的（`graphToFields`），图上只存着「当前那个值」——
`'adaptive'` 就是个字符串，`inferFieldKind` 只能给出 `text`。真正的答案在 ComfyUI 的
`/object_info/<节点类型>` 里：那一项的规格写着 `['COMBO', { options: [...] }]`
（老式节点写成 `[['a','b'], {}]`）。而 `fieldSchema.options` 在此之前**只有 RunningHub 应用**
那条路会填（从应用的 `fieldData` 里解析），本地 / 云端 ComfyUI 图的 COMBO 从来没被补过 ——
所以「明明有九个档，却要人照着截图手打」。

**改法**（新增 `lib/workflows/fieldOptions.ts`，外加两处调用与一处渲染）：
1. `enrichFieldOptions(fields, userId)`：拿 `classType + fieldName` 去问本机 ComfyUI，
   把选项挂回字段的 `options` 上。`/config` 与 `/fields` 两个 GET 都在**所有来源之后**调它一遍 ——
   从图上扫的、从 RunningHub 拉的、库里存着的老配置，都得到同一份选项。
2. `WorkflowConfigurator` 的值那一栏按 `selected.options` 渲染 `<select>`（新抽的 `valueEditor()`），
   存着的值不在选项里时**单独补一条**：受控下拉会把不在 `options` 里的 value 显示成第一项，
   看上去值没变、一保存却被悄悄改掉了 —— 正是这套界面一直在防的那种静默失败。
3. 画布那侧的「应用参数」面板本来就支持（`GenerateDock` 早就是 `options?.length ? select : input`），
   这次只是终于有人给它喂了选项。

**四条硬边界**（都是为了让改动只会把界面变好、不会把配置弄坏）：
- **查不到就是查不到**：服务没开 / 机器上没这个节点 / 这一项本来就不是挑选型 → 保持文本框，绝不猜。
- **只挂小得像枚举的清单**：2~60 项、每项 ≤80 字（与 `fieldSchema.options` 的上限一致）。
  模型 / LoRA 那种（名单会随用户往 `models` 里丢文件而变）一律不挂 —— 冻进配置里的清单会过期，
  比文本框更糟；超限还会让整份配置在 `safeParse` 处失败，表现出来是「保存不了」。
  判据与 `diagnose.ts` 同一份 `RESOURCE_FIELD` 正则。
- **媒体字段不挂**（kind = image / video / audio / latent，那是上传或文件路径）。
- **整段尽力而为**：读库失败 / 超时 / 形状认不出 → 吞掉，原样返回。它没有把配置页弄挂的能力。

**性能与两个坑**：
- 整份 `/object_info` 在他那台机器上实测 **11.6 MB / 8.2 秒**，所以 `readObjectInfo` 加了
  `{ fullFallback: false }`：`fieldChoices` 只按类型问（`/object_info/<class>`，几毫秒），
  **不退回整份**。关掉退路后 `unavailable` **不缓存**（这个状态多半是「服务这一刻不正常」——
  实测他关掉 ComfyUI 后 8188 上还挂着个转发进程回 502；缓存住会让「打开 ComfyUI 再刷新」拿不到选项）。
- 单次预算 4 秒 / 最多 40 个类型 / 并发 8；动手前先探一次 `/system_stats`，服务没开就一个请求都不发。
- 选项挂在字段上会**跟着配置一起存进去**：用户保存过一次之后，即使 ComfyUI 关着下拉也还在
  （下次查得到仍以本机为准覆盖）。

**验收**（临时包 `_hlbuild122`，隔离实例，靶子是 `wfopt_stub.py` 那个假 ComfyUI ——
他那一刻真机 ComfyUI 没开着，而这个功能有「查不到 / 选项不含当前值 / 清单太大 / 资源字段」
几条分支要逐个走到，拿桩当靶子判据才稳定）：
- `wfopt_probe.js` **35 PASS / 0 FAIL**：9 项枚举与 2 项枚举各成下拉、选项与 ComfyUI 逐字一致；
  70 项的**仍是文本框**（超上限）；`STRING` 的仍是文本框；`unet_name`（资源字段）仍是文本框；
  `sampler_name` 的 3 项都不含当前值时下拉是 4 行（第 1 行是当前值兜底，标题仍写「3 项」）；
  改成 9:16 → 保存 → 重新加载仍是 9:16；`/config`、`/fields` 都带着 options（4 / 69）。
- 无桩模式（= 本机 ComfyUI 关着）**5 PASS / 0 FAIL**：一律退回 textarea，页面不报错。
- 顺带确认：靶子指到哨兵端口时页面仍正常加载 —— 这条能力失败时**绝不**影响配置页本身。

## 2026-10-09 · 1.0.122 —— 资产库灯箱加「上一张 / 下一张」

徐先：「资产库图片的预览可以添加上一张，下一张的按钮」（截图红圈标在灯箱右侧中部）。

**改了什么**

- 灯箱的预览区外面多包一层 `.asset-lightbox-viewport`（只为定位而存在），
  左右两侧各一颗圆形按钮，垂直居中：`data-asset-lightbox-prev` / `data-asset-lightbox-next`。
- 头部那行元信息后面补「第 N / M 项」（M 是**已加载**的条数）。只有一张时不说 —— 那句话是废话。
- 键盘 `←` / `→` 等价于这两颗按钮。焦点在 `input` / `textarea` / `contenteditable` 里时**不抢**
  （那时左右键是移动光标）—— 灯箱里现在没有输入框，但监听挂在 window 上，这条是给以后留的。
- 翻页 = 换 `openId`。🔴 换张时要把上一张的中间状态清掉：「已复制」那两颗字的回执、
  上一张报的红字 —— 不清的话新一张上会挂着上一张的回执（用 `showAt()` 一个口子统一做）。

**四条边界**

- **第一张不画「上一张」**：画一个点了没反应的按钮就是骗人。同理最后一张（且真没有下一页了）
  不画「下一张」。
- **翻到已加载的最后一张时，「下一张」不消失、变成「加载更多」**：资产库 2026-10-09 起一次只给 60 条
  （`.asset-lightbox` 那一屏里翻到第 60 张就停住会让人以为是「就这些了」）。
  点了先把下一页要来（上层那个 `loadMore`，`hasMore` / `onLoadMore` 两个可选 prop 传下来），
  新一页到了再落到第 61 张。
  - ⚠️ 等页有个 10 秒上限：要不到（离线 / 接口错）也得把 `disabled` 收掉，不能一直挂着。
  - ⚠️ 画廊**仍然是纯受控**的：它不自己发请求、不知道页码，只负责叫一声。没传这两个 prop
    的画廊（别处复用）行为就是「单一页，翻到尾即止」。
- **定位宿主是 viewport 不是 stage**：`.asset-lightbox-stage` 自己 `overflow: hidden`，
  按钮放进去会被裁掉一半（图片撑满时它跟图片一样大）。
- **半透明写死 alpha**（元素上的 `opacity`，不是 `color-mix`）：背景色令牌两套主题不一样，
  `color-mix` 出来的东西在深档里会糊成一片。

**验收**（临时包 `_hlbuild122`，隔离实例，拷了他的 storage 副本当靶子）
`lightboxnav_probe.js` **28 PASS / 0 FAIL**：
- 第一张：没有「上一张」；「下一张」宽高 40×40 且**交集中心点 `elementFromPoint` 命中的是它自己**
  （DOM 在 ≠ 看得见）。
- 点「下一张」：标题换成第二张、计数「第 2 / 60 项」、图片 `src` 跟着换；
  「上一张」这时才出现且可见。
- 点「上一张」：回到第一张，那颗按钮自己又消失。
- 键盘 `→` / `←` 等价可用；焦点在输入框里时 `→` **不翻页**。
- 开第 60 张（末尾）：按钮是「加载更多」、提示里写着「后面还有」；
  点它 → 卡片 60 → 120 → 落在「第 61 / 120 项」，按钮变回「下一张」，「上一张」仍在。

## 2026-10-09 · 1.0.122（二）贴进画布的图被判成「尚未上传完成」—— 那道闸只认资产库地址

徐先发来一张截图问「我复制粘贴的图片上传不了吗」：参考图节点上明明看得到图、
写着「已放进画布」，右边的图片生成节点却挂着红字「参考图或 latent 尚未上传完成」。

**真因不是上传，是前端那道就绪闸没认地址形状。**

- 拖 / 粘进画布的图（`CanvasEditor.archiveMedia`）存的是**画布素材**：
  `/api/canvas-media/<projectId>/<uuid>.<ext>` —— 刻意**不进资产库**、没有 Asset 记录
  （2026-10-08 他定的：「从外面添加的图片拉入画布会自动进入资产库，这个 bug 也修复」）。
- 服务端那条路早就认它了（`lib/referenceImages.ts` / `lib/upscale.ts` 里
  `parseCanvasMediaUrl` 那一支，2026-10-08 加的）——**读盘取字节、重传给 RunningHub 都通**。
- 但前端 **`src/components/canvas/mediaChain.ts` 只认 `/api/assets/`**（`LOCAL_ASSET_PREFIX`）：
  `imageUrlsOf()` 对画布素材地址返回**空数组** → `pendingMedia` 判 true →
  点运行被拦，红字就是那句笼统的「参考图或 latent 尚未上传完成」。
  ⚠️ 而它**怎么重新上传都不会好** —— 缺的不是上传。

**改了什么**（`mediaChain.ts`）

- 新增 `CANVAS_MEDIA_PREFIX = '/api/canvas-media/'` 与 `isLocalMediaUrl()`：
  「本机落盘、服务端读得到字节」现在**有两种形状**（资产库的 + 画布素材的）。
- 四处判断改用 `isLocalMediaUrl()`：`isResolvableUrl()`、`imageUrlsOf()` 的
  bytes / submit 两支、`videoUrlsOf()` 的本地那一支。
- `CanvasEditor.tsx` 收参考图那句 `local.startsWith('/api/assets/')` 一并改掉
  （同一把尺子，漏了它就会走到「请等上传完成」那句假话上）。
- 🔴 前缀在 `mediaChain.ts` **又写了一遍**而不是 import `@/lib/canvas-media`：
  那个文件是纯函数层，不许拖进带 `@/` 别名的工作流依赖链（文件头写着）。
  风险由注释兜着：**改前缀要同时改 `lib/canvas-media.ts` 的 `CANVAS_MEDIA_PREFIX`。**

**验收**

- 单测（编译真代码跑断言，`_tsconfig.mediatest.json` + `_mediatest_run.js`）
  **24 PASS / 0 FAIL**：画布素材地址算参考图 / 算「服务端取得到字节」；资产库地址与
  http 链接照旧；`blob:` 与远端文件名照旧**不**算；`videoUrlsOf`、`pickMediaInput`
  （看图反推）两条路都跟着通。
- 真机探针（临时包 `_hlbuild122b` + 隔离实例，打开他那份带参考图的画布）
  `refmedia_probe.js` **13 PASS / 0 FAIL**：
  - 画布上原有的两个参考图节点是 `/api/assets/...`（从资产库来的，对照组）；
  - 派一次真实的 `paste`（`DataTransfer` + `ClipboardEvent`，与用户复制粘贴同一条 `onPaste`）
    → 新节点**先**是 `blob:` 中间态 → `archiveMedia` 落盘后变成
    `/api/canvas-media/<projectId>/<uuid>.png`，回执「已放进画布」；
  - 那条地址在同一台机器上 `fetch` 得到 **200 / image/png / 308 B**（服务端提交时读盘重传的正是它）；
  - 老节点没被动过。
  - ⚠️ 第一轮探针 FAIL 2 条是**探针自己量错了对象**：它在「刚贴上、还是 blob」那一刻就下了结论。
    判据要等落盘之后的那个态 —— 这类「中间态」在画布上很常见，量之前先想清楚等的是哪一刻。


## 1.0.123 —— 自定义接口出图时「参考图上传不了」（2026-10-10 徐先转述 codex）

症状：把图片生成节点的引擎选成「自定义接口」、上游连一张参考图，点生成报
**「第 1 张参考图的地址取不到字节」** —— 卡片上明明看得见那张图，线也是连好的，
重新上传一百遍也没用。

### 真因：服务端有**两份**参考图解析，只跟上了一份

- 工作流那条路（RunningHub / 本机 ComfyUI）用的是 `lib/referenceImages.ts`，
  它在 **2026-10-08** 就认画布素材地址了。
- 自定义接口那条**同步**出图的路用的是**另一份** `lib/providers/referenceBytes.ts`
  —— 它只认 `/api/assets/`（资产库）与 `http(s)://`，
  `/api/canvas-media/...`（拖 / 粘进画布的那张）掉进 else 分支，直接抛「取不到字节」。

也就是说：**上一轮（1.0.122）修好的「贴进画布的图被判成尚未上传完成」，只修了前端判据；
同一份地址在同步出图这条路上仍然是坏。** 图一直在盘上，缺的是那一条分支。

### 顺带修掉前端两条

`CanvasEditor.tsx` 的 `collectReferenceImages()`（只在自定义接口这条路上用）：

1. 它另写了一份上游名单，只认 `image / video-input / frame-extract` 三种 ——
   「生成节点出的图 → 自定义接口」这种连法**一张都收不到**，而界面上什么都不说
   （图没去、结果和参考图无关，属于这套 UI 一直在防的那种静默失败）。
   改成用**和工作流那条路同一把尺子** `isReferenceSource()`。
2. 它用的是递归那份 `upstream`，而工作流那条路用的是 `directUpstream`
   （2026-10-09 他定的：「只收直接连到生成节点的上游」）。递归那份会把链上隔一层的
   节点也算进来 —— 交出去的图比用户连上去的多；而下面新加的那句「取不到字节」是**硬拦**，
   于是远处一个只有 `blob:` 的节点能把整次提交打掉。改成 `directUpstream`。
3. 拿到 `previewUrl` 就往外送。它可能是 `blob:`（刚贴进来、还没落盘），
   交出去只会换来服务端一句「取不到字节」。改成在候选里
   `.find(isResolvableUrl)` 挑**第一个服务端真能取到字节的**。

### 验收（🔴 这一版**不拦请求**，让它真打到服务端）

病根在服务端，在 fetch 层把请求拦下来等于什么都没验 —— 前端那一半在改之前本来就会把
`/api/canvas-media/...` 交出去。所以 seed hook 造了一条**探针接口**：
`encryptedApiKey` 从他库里那条真接口**原样抄过来**（同一把加密钥匙，解得开），
`baseUrl` 指向 `http://127.0.0.1:9`（立马拒绝连接）——
凭据那道闸过得去、请求真的发出去，而**一分钱不花、也不碰外网**。

`customref_probe.js`（临时包 `_hlbuild123` + 隔离实例）**18 PASS / 0 FAIL**：

- 参考图用他**盘上真有的那份**画布素材（158 KB PNG，`HL_COPY_STORAGE=1` 拷进副本）；
- 节点最后停在 `probe-iface：http://127.0.0.1:9/v1/images/edits 连不上：fetch failed`
  —— 走到 **`/images/edits`** 说明参考图字节已经读出来、正要当**文件** multipart 上传；
  「连不上」说明它冲过了凭据那道闸。改之前这一句会是「第 1 张参考图的地址取不到字节」；
- 请求体里 `referenceImages` 正是那条画布素材地址；
- **对照组**（同样的连法、指向一个盘上没有的文件）：服务端说
  「第 1 张参考图读不出来：这份素材已经不在盘上了 —— 重新拖一次。」，且**没有**走到
  `/images/edits` —— 证明画布素材那一支真的被走到了（不是探针自己假通过）。

### 探针上的两个坑（下次直接照抄）

- 🔴 **生成节点的「运行」不在卡片上。** 卡片上那颗 `data-node-run` 只给
  「优化提示词」节点用；生成节点是**选中之后底栏**那颗 `data-dock-run`
  （`GenerateDock` 的发送钮）。流程：先按 `f` 收拢视口（`fitView`）→
  用 `Input.dispatchMouseEvent` 真鼠标点中节点（react-flow 要真事件才选中）→
  再点底栏。只有合成事件时它不选中，所以留了 DOM 派发那条退路。
- 🔴 **别在 fetch 层拦 `/custom-image`。** 那会把服务端那一半整个跳过去。
  要记账就只记账、照旧 `return window.__origFetch.apply(window, arguments)`。
