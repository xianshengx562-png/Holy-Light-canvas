# Holy Light画布

画布式的 AI 创作工作流桌面应用 —— 把「文本 → 出图 → 出视频」串成一张可以反复跑的图。

数据全部在你自己的机器上（`%APPDATA%\holy-light-canvas`），没有账号体系之外的任何云端依赖。

---

## 它能做什么

**画布与节点。** 在无限画布上拖节点、连线，组成一条生成流水线。节点类型包括文本、
图片生成、视频生成、优化提示词、首尾帧、视频拼接、资产与素材等；每个节点都能单独
「绕过」（右键菜单或按 `B`），绕过时只把上游的值传下去，不执行自己那一步 ——
调试长链时不用反复拆线。

**四种出图来源。**

| 来源 | 说明 |
| --- | --- |
| 本机 ComfyUI | 走你自己跑着的 ComfyUI（含随包扩展），把工作流里的字段绑到画布节点上 |
| RunningHub | 云端工作流应用，异步提交 + 轮询 |
| 自定义接口 | 任意 OpenAI 兼容的网关（`/v1/images/generations` 与 `/v1/images/edits`），比例 + 分辨率算成像素串发出去 |
| 视频 | 视频生成节点，同样支持本机 / RunningHub / 自定义接口 |

**内置技能（skills）。** 把你的方法论固化成可复用的提示词改写规则：一个技能就是一个
目录（`skill.json` + 若干提示词文件），「优化提示词」节点按技能改写上游那句文本。

**其它。** 资产库（分类 / 批量操作 / 孤儿清理）、工作流库、导演台（批量分镜）、
工具页（视频拼接、视频分割）、站点账号与额度、软件内更新。

**Codex 集成。** `tools/frame-mcp` 是一个 MCP 服务：让 Codex 直接读写画布里的
项目 / 节点 / 连线 / 工作流 / 任务（默认不允许触发生成，要显式打开开关）。

## 技术栈

- **Electron 44** + **electron-vite**（单进程结构，后端跑在 utility process 里）
- **React 19** + **TypeScript 5** + **@xyflow/react**（画布）+ **zustand**（状态）
- **zod** 做接口层校验、**Tailwind 4** 与一套自写的 CSS 令牌做主题
- 数据层：本机 **SQLite**（`node:sqlite`），可用 `HOLYLIGHT_DB_ENGINE=json` 退回 JSON 引擎
- **electron-updater** 做软件内更新

## 目录结构

```
src/            渲染进程：页面（app/）、画布与各种组件（components/）
electron/       主进程：窗口 / 托盘 / 后端进程管理 / 更新 / 随包扩展
server/api/     路由层（被主进程直接 dispatch，不是真的 HTTP 服务）
lib/            前后端共用的领域代码：工作流、提供商、数据库、技能、媒体……
tools/frame-mcp 给 Codex 用的 MCP 工具包
builtin-skills/ 随包的内置技能
integrations/   随包的 ComfyUI 扩展
resources/      随包的原生运行时（llama.cpp，二进制未入库）
```

## 开发

```bash
npm install
npm run dev          # 起开发模式
npm run typecheck    # tsc 两套
```

## 出包

```bash
npm run dist         # 免安装目录 dist/win-unpacked
npm run installer    # NSIS 安装包
```

产物在 `dist/`。安装包与便携版的文件名由 `package.json` 的 `build.nsis.artifactName`
与 `build.portable.artifactName` 决定。

## 数据放在哪

默认在 `%APPDATA%\holy-light-canvas`：

```
data/       SQLite 库（项目、画布、任务、资产元数据、用户与密钥）
storage/    媒体文件（生成的图 / 视频 / 上传的参考图）
skills/     自己导入的技能
logs/       运行日志
```

三种改位置的途径：**便携模式**（在程序目录同级建 `data/portable.json` 标记）、
环境变量 `HOLYLIGHT_DATA_DIR`、或者在设置页里改产出目录。

## 软件内更新

走 GitHub Releases（`generic` provider 指到本仓库的
`releases/latest/download/`）。发版时把安装包与 `latest.yml` 一起传到 Release 即可；
地址也能在「设置 · 更新」里改成别的。

## 许可

未指定 —— 未经许可请勿分发或商用。
