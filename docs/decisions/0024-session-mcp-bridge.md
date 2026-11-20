# ADR-0024：会话 MCP 桥与本地身份绑定

- 状态：已接受
- 日期：2026-11-16

## 背景

agent 需要按 ID 拉取主会话与任务，慢脑需要提出结构化路由。mcp-bridge 不能依赖 core，
更不能让 stdio 子进程直接修改存储或相信工具调用参数中的身份。

## 决策

- 使用官方稳定 TypeScript MCP SDK server 2.4.0；业务输入/输出继续只有 Effect Schema。
  通过 Standard Schema 与 JSON Schema 转换接 SDK，Zod 仅为 SDK 内部实现依赖。
- MCP 服务运行在 harness 启动的 stdio 子进程中，通过 HTTP over Unix socket 连接 daemon。
  socket 权限0600；本地配置只含 socket 路径与随机会话令牌，令牌通过子进程环境注入，不写日志。
- daemon Scope 持有 listener。每次注册将令牌绑定 botId/taskId/worker或slow-brain角色，
  会话 Scope 关闭或显式撤销后令牌失效。每次请求既验证令牌，又调用后端重新校验当前 bot/task 身份。
- mcp-bridge 定义 BridgeBackend Context.Tag，daemon 实现只读查询与 Chief 提议投递，保持依赖方向。
  read_main_thread/list_tasks/get_task 对所有合法 bot 开放；propose_route 仅对 slow-brain 列出，
  服务端每次调用再次授权。ask_user 保留协议但不注册，不替代原生问答。
- read_main_thread 的 ids 精确读取模式：1–50个唯一 ID，与 before/limit 分页模式互斥。
  分页默认50、上限50；list_tasks 同样默认50、上限50。
- propose_route 只接 ProposableOp，进入 Chief 的同一串行队列；记录完整来源、理由、Op，
  path 以 slow-brain 开头。Chief再次核对配置的 slow-brain bot与来源 task，再走同一 OpExecutor。
  返回登记结果，不等待 worker 工作。超时或连接中断不自动重试可能已产生作用的提议。
- 输入/输出按 Effect Schema 验证；MCP structuredContent 使用 { result } 包装数组或对象，
  text content 同时提供原工具输出的 JSON。socket 请求和响应限定字节数，不暴露请求头或令牌。

## 理由

参考 OpenMausBot 738ec88 的 drivers/agents-mcp.ts 工具可见性与调用双重检查、
harness-mcp-request.ts 的本地身份转发及不确定操作不自动重放原则；不复制其 LLM chief。
官方 SDK 管理 MCP 兼容性，Effect 仍控制业务验证、错误、取消与生命周期。

## 后果

daemon 组装 BridgeBackend；SessionManager 注册/撤销凭据并注入 stdio 配置。
测试使用真实 Unix socket 与 stdio MCP 协议，并验证普通 bot不能列出或调用慢脑提议。

## 官方依据

- https://ts.sdk.modelcontextprotocol.io/v2/advanced/schema-libraries
- https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html
- https://github.com/modelcontextprotocol/typescript-sdk
