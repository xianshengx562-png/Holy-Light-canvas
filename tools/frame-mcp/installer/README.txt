Holy Light画布 · 让 AI 直接改你的画布
================================

这是一个 MCP 服务：装上以后，Codex / WorkBuddy / Claude Desktop 里的 AI
可以直接读写 Holy Light画布的画布 —— 建项目、加节点、连线、改参数、查任务。

不需要懂配置文件的格式，双击 `install.cmd` 就行。


一、怎么装
----------

1. 先确认本机有 Node.js >= 22.5。
   没有的话去 https://nodejs.org/ 下载 LTS 版装上（一路下一步即可）。
   命令行里输入 `node -v` 能看到 v22.x 之类的字样就说明好了。

2. 双击 `install.cmd`。

   会弹出一个黑窗口，做四件事：
     1. 找一个够用的 node（版本 >= 22.5，且能 require('node:sqlite')）；
     2. 把服务本体复制到 %LOCALAPPDATA%\frame-mcp\（所以这个解压出来的
        文件夹装完就可以删了，配置不会断）；
     3. 把服务的绝对路径写进各个 AI 客户端的配置里；
     4. 真把这个服务拉起来跑一遍，握手成功才报 OK。

   看到 "装好了" 就完事了。改过的配置文件都会留一份 .bak-时间戳 备份。

3. **完全退出 WorkBuddy / Codex，再重新打开。** 这一步不能省：

   安装器已经顺手在 ~/.workbuddy/mcp-approvals.json 里给你授信了（等同于你在
   连接器管理界面点一次「信任」），但 daemon 的这张批准表是**每个进程只读一次**
   的 —— 正在跑的那个进程看不到刚写进去的那条，日志里会一直出现

        [MCP Security] buildDesiredConfigs: skipping untrusted server "frame"

   重启之后才会读到它，界面上才会变成「已连接」。

4. 之后直接说话就行，比如：
     "看看 Holy Light画布里有哪些项目"
     "在 XX 项目里加一个文生图节点，prompt 写……"
     "把这两个节点连起来"


二、命令行用法（可选）
----------------------

install.cmd 只是个壳，真正的活是 setup.js 干的。想细粒度控制就直接跑它：

  node setup.js                      安装到所有检测到的客户端
  node setup.js --target=workbuddy   只装 WorkBuddy
                                     （可选值：workbuddy / codex / claude，逗号分隔）
  node setup.js --check              只看现状，不动任何文件
  node setup.js --uninstall          摘掉配置里的 frame
  node setup.js --allow-generate     放开"允许触发真实生成"
  node setup.js --help               看全部参数


三、关于"允许触发生成"
----------------------

生成任务是要真花钱调厂商 API 的，所以默认**关**着：
AI 只能读写画布结构，调 frame_run_generation 会被拒，并告诉它怎么申请。

确定要放开时跑一次 install.cmd / node setup.js --allow-generate，
或者手工把配置里 frame 那一项的 env 改成 HOLYLIGHT_MCP_ALLOW_GENERATE=1。
就算开着，调生成时仍然要求显式传 confirm=true —— 两道锁。


四、能做什么（14 个工具）
------------------------

  看：frame_status           服务与 Holy Light画布应用是否在跑、数据在哪个目录
      frame_list_projects    项目列表
      frame_get_project      单个项目详情
      frame_get_canvas       画布原始 JSON
      frame_describe_canvas  给人读的画布摘要（节点/连线/可接关系）
      frame_list_workflows   可用工作流
      frame_get_task         查生成任务状态

  改：frame_create_project   建项目
      frame_add_node         加节点
      frame_update_node      改节点（标题、参数、位置……）
      frame_remove_node      删节点（连带它的连线）
      frame_connect          连线（自动查方向合法性 + 防环）
      frame_disconnect       断线

  跑：frame_run_generation  触发生成（受上面的开关控制）


五、注意事项
------------

· Holy Light画布要是开着，MCP 会走应用的命名管道，**所有改动都会实时落到库里**，
  并且 UI 会自动同步（除了当前打开的那个项目页需要手动刷一次 —— 已知边界）。
· Holy Light画布没开时它会退化成"直接读同一个 SQLite 库"，照样能用，但**此时千万别
  再打开 Holy Light画布让它同时写** —— 两边的缓存会互相覆盖。
· 服务本体和数据都在本地，不联网、不上传。


六、出问题怎么办
----------------

· 双击闪一下就没了：说明没找到 node。装 Node.js 22.5+ 后重试。
· "Ran into an error" / AI 说找不到工具：确认客户端是**完全退出后重开的**。
· 想确认到底装上没：`node setup.js --check`。
· 想回退：各配置文件旁边有 .bak-时间戳 备份，或者直接 `node setup.js --uninstall`。
