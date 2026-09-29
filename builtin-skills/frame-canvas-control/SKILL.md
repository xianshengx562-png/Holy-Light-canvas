---
name: frame-canvas-control
description: 用画布 MCP（frame_* 那 14 个工具）直接读写 Holy Light画布（FRAME）的画布 —— 加 / 改 / 删节点、连线与断开、改节点参数与提示词、读画布现状、查任务、跑生成。当用户说「加一个文生图节点」「把它连到生图节点」「画布上现在都有什么」「把提示词改成…」「删掉那个节点」「跑一次生成」这类**动画布结构**的话时用；只是聊提示词怎么写、不改画布时不要用。内含必须先知道的几条规矩：projectId 每次都得传（别按项目名猜）、改完用户在界面上要重进项目页才看得到、连线合法性由应用自己判、跑生成要两把锁、以及任务没有「超时」也没有我们的扣款。MCP 装不上 / 工具一个都没有 → 去看 `frame-canvas-agent-control`。
metadata:
  short-description: 用 frame_* 工具直接改画布：加节点、连线、改参数、跑生成
version: 1.0.0
agent_created: true
---

# 控制 Holy Light画布（FRAME）

画布不是一张图，是一张**有向图**：节点（文本提示词 / 参考图 / 生成 / 输出…）加连线（数据从谁流向谁）。
这套工具让你直接改那张图 —— 不用让用户自己去点。

## 每次动笔前的四步

1. **`frame_status`** —— 确认走哪条路。
   `transport: "pipe"` = 转发给应用自己的后端（应用开着，改动立刻生效）；
   `transport: "in-process"` = MCP 自己开库写（应用没开，改动下次打开才看得见）。
   这一条决定了你该怎么跟用户说「改完了」。
2. **`frame_list_projects`** —— 拿到 `projectId`。
3. **`frame_describe_canvas`**（带 `projectId`）—— 读现状。
   优先用它而不是 `frame_get_canvas`：它把节点压成「id / 类型 / 名字 / 坐标 / 关键参数」的清单，
   还会把**不合法的连线**单独列出来，一眼能看懂。
4. **动手 → 再 `frame_describe_canvas` 复核一次**，确认改成了想要的样子再回复用户。

## 工具（14 个）

| 用途 | 工具 |
| --- | --- |
| 看状态 / 找项目 | `frame_status`、`frame_list_projects`、`frame_get_project`、`frame_create_project` |
| 读画布 | `frame_describe_canvas`（推荐）、`frame_get_canvas`（原始 JSON） |
| 改结构 | `frame_add_node`、`frame_update_node`、`frame_remove_node`、`frame_connect`、`frame_disconnect` |
| 查工作流 / 任务 | `frame_list_workflows`、`frame_get_task` |
| 跑生成 | `frame_run_generation`（锁着，见下） |

## 硬规矩（踩过的都在里面）

- 🔴 **`projectId` 每次都要传**，别按项目名猜。名字会重名，id 不会。
- 🔴 **`frame_update_node` 的 `data` 是覆盖语义**：写了的字段换掉，**没写的保持原样**，
  要删某个字段传 `null`。想「只改提示词」就只传提示词那一个键，别把整个 data 回写。
- **连线合法性由应用自己判**，不要自己发明规则。`frame_describe_canvas` 会把 `illegalEdges`
  列出来 —— 看到有，说明画布上已经存在一条不该存在的连线，照它报的改。
- **改完怎么跟用户说**：
  - 转发模式：数据已经落库，但**界面要重进一次项目页才会重画** —— 提醒用户一句，
    否则他会以为没生效。
  - 进程内模式：现在界面上看不到，**下次打开应用才有** —— 更要说清楚。
- **删除前先说清楚删哪个**（报出节点名字和 id）。`frame_remove_node` 没有撤销，
  而用户可能正在看着那个节点。
- **改之前先说要改什么**，别闷头改一串。用户是在画布上工作的，静默大改等于破坏他的现场。

## 跑生成（`frame_run_generation`）

这是唯一会真的花钱 / 真跑上游的动作，**双锁**：

1. 长期开关（默认关着）；
2. 本次调用要显式 `confirm: true`。

所以标准做法是：先用 `dryRun: true` 把「这次到底会提交什么」完整吐给用户看 →
用户点头 → 再带 `confirm: true` 真跑。拿 `frame_get_task` 跟进度。

两条**口径**必须记住，说错了比不说更糟：

- **不存在「超时」**：任务只有成功与失败两种结果，跑多久是上游的事。
  不要因为等久了就告诉用户「这次算了 / 已经取消了」。想停只能由用户自己喊停。
- **不存在我们的扣款**：生成走的是用户自己的账号（ComfyUI 或他自己的云端工作流），
  我们没扣过钱。所以**永远不要说「积分已退回」** —— 那是一句没发生过的话。

## 三个常见任务的标准做法

**加一个文生图节点并接上**
`frame_add_node`（kind 照现有同类节点）→ `frame_describe_canvas` 拿到新节点 id →
`frame_connect`（source = 提示词节点，target = 新节点）→ 复核 `illegalEdges` 为空 →
告诉用户「重进一次项目页就能看到」。

**改提示词 / 改参数**
`frame_describe_canvas` 找到节点 id → `frame_update_node` 只传要改的那一个字段 → 复核。

**「画布上都有什么」**
`frame_describe_canvas`，把节点与连线**说成人话**总结给用户（不要把他没问的原始 JSON 全倒出来）。

## 工具没出现 / 报错

- 工具列表是空的、或调用说 server 不存在 → MCP 没挂上或没被信任。
  排障步骤都在 **`frame-canvas-agent-control`** 那个技能里（配置、批准指纹、握手自检、
  转发模式怎么验），照它走一遍 —— 那份是 WorkBuddy 侧的，Codex 侧只看其中「配置与握手」两节即可。
- `frame_list_projects` 返回空 → 数据目录不对（多半是用了另一个 `%APPDATA%` 下的库）。
  用 `frame_status` 里的 `dataDir` / `dbFile` 对一下。
