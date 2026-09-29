# frame-mcp —— 让 AI 操作 Holy Light画布一个 **stdio 的 MCP 服务**，把 Holy Light画布桌面版的能力暴露成 14 个工具：
列/建项目、读画布、加节点、连线、改参数、列工作流、查任务，以及在双重确认下触发生成。

接进 Codex / WorkBuddy / Claude Desktop 都走同一份 bundle。

## 分发：installer

别人机器上 Node 在哪、配置该写哪一栏，都不能预先知道，所以有一条专门的分发路径：

```bash
node tools/frame-mcp/build.mjs        # 产物 dist/frame-mcp.js
python tools/frame-mcp/pack-setup.py  # 产物 dist/frame-mcp-setup.zip
```

zip 里是 `install.cmd`（找 node 的外壳） + `setup.js`（真正干活）+ `server/frame-mcp.js`。
`setup.js` 干四件事：找 node、落盘 bundle、写客户端配置、**真跑一遍握手自检**。
参数：`--check` / `--uninstall` / `--target=workbuddy,codex,claude` / `--allow-generate`。

详细介绍与产物布局见 `installer/README.txt` 和 `installer/setup.js` 头部的注释。

## 它怎么接进去的

```
Codex ──stdio(JSON-RPC)──► frame-mcp ──┬─► 命名管道 ──► Holy Light画布自己的后端进程 ──► 48 个路由
                                       └─► （Holy Light画布没开时）同一批路由，在 MCP 进程里跑
```

两条路的取舍不是「省一次 SQLite 打开」。`lib/db/store-sqlite.ts` 的模型是
**整表读进内存、脏了整表写回**：两个进程同时改，后写的那个会把先写的整表覆盖，
而且不报错、不冲突提示，只有「刚才的改动没了」。
所以**凡是 Holy Light画布开着，一律转发给应用自己的后端进程** —— 那是唯一的写者。

两条路跑的是同一批 `server/api/**` 路由，没有重写任何业务规则：
连线合法性来自 `canConnect`，新节点的默认值来自 `newNodeData`，超清工作流来自 `upscaleWorkflowFor`。
`frame_status` 会告诉你这次走的是哪条路。

一个残留的窄窗口：后端**崩溃重启的那几秒**里管道连不上，MCP 会退回进程内。
这段时间两个进程都可能在写。窗口很短（探测失败只到下一次成功为止），但它是**这一版设计里
唯一保留的理论风险** —— 要彻底消除得给后端加一个跨进程锁，量级上不值。

## 怎么知道 Holy Light画布在不在

后端每次 ready 都会往 `<数据目录>/logs/backend-lifecycle.jsonl` 追加一行，里面记着本次的管道名。
MCP 拿最后一条去**真的连一次** —— 连得上才算「活着」，因为「进程还在」和「后端正在接请求」
不是一回事，而两者之间的那几秒恰恰是必须切回进程内那条路的时候。

## 构建

```bash
node tools/frame-mcp/build.mjs
```

产物是 `tools/frame-mcp/dist/frame-mcp.js`（单文件，无需 npm install）。
alias / shim / `NEXT_PUBLIC_HOLYLIGHT_EDITION` 这些是从 `electron.vite.config.ts` 的 main 段照抄的，
**改那边的构建配置时这边要跟着看一眼**。

## 挂载到 Codex

`~/.codex/config.toml`：

```toml
[mcp_servers.frame]
type = "stdio"
command = "C:\\Users\\徐先生\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe"
args = ["E:\\codex网站开发\\本地\\studio\\tools\\frame-mcp\\dist\\frame-mcp.js"]
startup_timeout_sec = 60

[mcp_servers.frame.env]
# 允许触发生成。默认关着 —— 那是唯一会花钱 / 占显卡的动作。
HOLYLIGHT_MCP_ALLOW_GENERATE = "0"
# 数据目录不用配，默认就是 Holy Light画布在用的那个（%APPDATA%\holy-light-canvas）。
# HOLYLIGHT_DATA_DIR = "C:\\Users\\徐先生\\AppData\\Roaming\\holy-light-canvas"
```

⚠️ 两条注意事项：

1. **`command` 里必须是绝对路径**。Codex 起进程时没有 shell，`node` 这个名字不一定能解析出来
   （本机的 `node` 只在 WorkBuddy 注入 PATH 之后才有）。哪天这个版本的 Node 不在了，
   改这一行即可，比如换成 Codex 自带的 `...\AppData\Local\OpenAI\Codex\runtimes\cua_node\*\bin\node.exe`。
   要求是 **Node ≥ 22.5**（数据层用 `node:sqlite`）。
2. **Codex 有时会整体重写 config.toml**，改之前先备份一份。

改完重启 Codex，`frame_status` 应该可用。

上面这一整块 installer 会自动写；手改的话照着这个格式来。

## 挂载到 WorkBuddy

配置文件是 **`~/.workbuddy/mcp.json`**（不是 `~/.workbuddy/.mcp.json`，也不是
`connectors/default/mcp.json` —— 后者是连接器市场生成的目录，会被覆盖重写）：

```json
{
  "mcpServers": {
    "frame": {
      "command": "C:\\...\\node.exe",
      "args": ["C:\\...\\frame-mcp.js"],
      "type": "stdio",
      "env": { "HOLYLIGHT_MCP_ALLOW_GENERATE": "0" },
      "timeout": 120000,
      "disabled": false
    }
  }
}
```

**只写这个文件不会生效。** WorkBuddy 有个「第三方 MCP 需要批准」的闸门：daemon 在
`buildDesiredConfigs()` 里逐个调 `isUserServerApproved()`，没批准就 `continue` 掉 ——
不报错，只在日志里留一行 `skipping untrusted server "frame"`。批准记录在
`~/.workbuddy/mcp-approvals.json`，key 是：

```
sha256( command + "|" + args.sort().join(",") + "|" + Object.keys(env).sort().join(",") ) + "::frame"
```

注意 **args 或 env 的键名一改，指纹就变了**，得重新批准；installer 每次都会把旧的 `::frame`
记录清掉再写新的。

还有一层：**批准表是每个 daemon 进程只读一次**（`approvalsLoaded` 标志）。安装器在你已经
开着 WorkBuddy 的时候写入批准记录，当前这个进程看不到，**必须完全退出重开**才生效。

## 触发生成：两把锁

`frame_run_generation` 默认拒绝，必须同时满足：

1. `HOLYLIGHT_MCP_ALLOW_GENERATE=1`（长期开关，挂在 config.toml 的 env 里）；
2. 这一调用传了 `confirm: true`；

只想知道这次会提交什么，用 `dryRun: true`。

Generation is the one irreversible, metered action here; an LLM misfire costs a real run
while a refusal costs one sentence. That asymmetry is why it defaults to off.

## 已知边界

- **开着的项目页面不会自动重画。** MCP 改的是库里那份画布，已经渲染出来的窗口还拿着旧 state。
  重新进一次那个项目就能看到；反过来也是 —— 窗口里正在编辑的那份如果再自动保存一次，
  会把 MCP 的改动覆盖掉（这正是优先走转发那条路的原因）。
- **转发模式下 MCP 不打开数据库**，`frame_status` 里 `dbEngine` 会显示「未探测」。
