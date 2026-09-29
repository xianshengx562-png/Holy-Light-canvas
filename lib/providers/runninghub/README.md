# RunningHub 接入边界

当前已登记测试工作流 `2099453228814528513` 和运行路径 `/run/workflow/2099453228814528513`，但尚未调用接口。

两个用户提供的 JSON 是 ComfyUI workflow graph 导出，包含 H3 节点、提示词节点、参考图上传节点和 RH_NodeInfoListNode 映射。它们没有提供 RunningHub HTTP 请求的完整鉴权、请求体、轮询和结果字段协议，因此不能安全地猜测 client 实现。

Phase 4 根据官方文档增加 client.ts、types.ts、workflows.ts、tasks.ts。需要：官方 API 文档、可运行的 Workflow ID、工作流输入节点与字段映射、上传文件协议、状态/错误码、结果有效期与幂等语义。

测试密钥只应放在本机 `.env` 的 `RUNNINGHUB_API_KEY`，服务端读取，绝不能出现在代码、日志或浏览器响应中。没有完成真实连接校验前，不标记 connected。
