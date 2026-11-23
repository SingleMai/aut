# 会话 MCP bridge

`packages/mcp-bridge` 使用官方 `@modelcontextprotocol/server` 2.4.0，所有业务边界由 Effect Schema 校验。
协议与权限决策见 ADR-0024。SDK 内部使用 Zod，本项目不导入它定义业务 schema。

## 组装与生命周期

daemon 注入 `BridgeBackend`，在自身 Scope 中运行 `makeBridgeSocket({ socketPath })`。
建议使用短路径 `~/.aut/bridge.sock`；路径必须绝对且 UTF-8 长度小于104字节，以适配 macOS。
已有路径监听失败时返回类型化错误，不删除现有 socket。成功监听后的权限为0600；Scope关闭销毁连接与请求，清理自身 socket。

SessionManager 在会话 Scope 中调用 `bridge.register({ botId, taskId, role })`，得到临时凭据。
`mcpServerConfig(credentials)` 生成名为 aut 的 stdio MCP 配置，使用当前 Node 与构建后的 stdio.js。
该配置只加入本次 StartSessionInput，不写入 bots.json，不写决策日志。listener支持独立Scope注册；
当前adapter fork继承来源task的父会话凭据，不增加权限。关闭fork只释放其进程与上下文，不撤销父凭据；父Scope关闭后共同失效。

stdio 子进程只读取 `AUT_MCP_SOCKET` 和 `AUT_MCP_TOKEN`；token不在命令行参数中。
在 Electron 的 Node 模式下，配置显式传入 `ELECTRON_RUN_AS_NODE=1`，不依赖 harness 继承父进程环境；打包后的 stdio.js 与 daemon 入口同目录。
每次调用通过 Unix socket 查令牌绑定，再由 Backend.authorize 核验 Bot、任务和角色。主助手的普通任务使用 worker 身份，来自 slow 节点的主助手协调任务使用 coordinator 身份。
HTTP请求不能自报身份，权限变更或Scope撤销立即作用于后续调用。

## 工具

| 工具 | 可见角色 | 约束 |
|---|---|---|
| read_main_thread | 所有合法bot | ids为1–50个唯一ID；与before/limit互斥。分页默认50、上限50 |
| list_tasks | 所有合法bot | 可按bot/status过滤，默认50、上限50 |
| get_task | 所有合法bot | 指定TaskId，返回结构化Task |
| create_bot | worker、coordinator | 创建普通 Bot，返回 ID 和名称。模型选择与工作目录可继承调用者，可指定形象 `characterId`。与手动创建共用 Administration |
| create_trigger | worker、coordinator | 创建 once、daily、cron 或 interval 计划。worker 只能指定自身 Bot，coordinator 可指定任一已配置 Bot。可提供稳定 `id`，超时或断线后用该 ID 核对结果 |
| get_trigger | 所有合法bot | 按稳定 `triggerId` 读取一个触发器，用于核对 `create_trigger` 的不确定结果 |
| list_triggers | 所有合法bot | 最多返回50个触发器，可按 `botId`、`enabled` 和 `limit` 筛选，按更新时间倒序排列 |
| list_trigger_runs | 所有合法bot | 按 `triggerId` 读取最近50条运行记录，可用 `limit` 限制，按计划时间倒序排列 |
| update_trigger | worker、coordinator | 修改触发器字段或暂停/恢复。worker 只能修改自身 Bot 的触发器，coordinator 可管理任一已配置 Bot |
| propose_route | 仅主助手的协调会话 | 只接ProposableOp与rationale，进入Chief同一串行队列 |

成功创建时，daemon 在主会话保存用户可操作的创建回执。撤销条件见 [ADR-0046](decisions/0046-agent-bot-creation-undo.md)。

ask_user不注册，Codex原生question仍走adapter。服务端按会话角色校验 propose_route。
MCP返回text content中的原输出JSON，并提供 `structuredContent: { result }`。

propose_route只等待登记结果，不等待worker。日志path为slow-brain/propose_route，包含来源、理由、Op与执行结果。
网络中断或默认10秒总超时产生Indeterminate；提议、创建 Bot 或创建 trigger 出现此结果时，先核对任务、Bot 或 trigger 列表。已存在的 Bot ID 或 trigger 稳定 ID 返回冲突，原记录保留。
socket输入最多1MiB、输出最多16MiB；超限返回错误，不截断为表面成功的数据。

## 验证

先 `pnpm build`，再 `pnpm exec vitest run packages/mcp-bridge/src/bridge.test.ts`。
测试覆盖真实Unix socket、0600权限、伪造/撤销令牌、fork凭据隔离、重复监听、路径长度、
请求取消、listener关闭中断挂起请求、不确定结果不重试、工具可见性/调用权限、分页，以及官方SDK启动真实stdio子进程后调用工具。
所有输入是合成fixture，不需要用户凭据。

参考资料：
- [官方Standard Schema支持](https://ts.sdk.modelcontextprotocol.io/v2/advanced/schema-libraries)
- [官方stdio生命周期](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html)
- [OpenMausBot工具权限](https://github.com/milind-soni/OpenMausBot/blob/738ec88/server/drivers/agents-mcp.ts)
- [OpenMausBot本地身份与不确定投递](https://github.com/milind-soni/OpenMausBot/blob/738ec88/server/harness-mcp-request.ts)
