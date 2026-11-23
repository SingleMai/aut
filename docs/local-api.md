# 本地 daemon API

> ADR-0021；所有路由需要本地 token。`packages/protocol/src/api.ts` 是请求与响应的 Schema 来源。

| 方法 | 路径 | 请求 | 成功结果 |
|---|---|---|---|
| GET | `/v1/health` | — | `{ status:"ok" }` |
| GET | `/v1/messages` | `before?`, `limit?`（1–50） | `{ messages: MainThreadMessage[] }` |
| POST | `/v1/messages` | `{ text:string, id?:MessageId }` | `{ message: MainThreadMessage }`，201 |
| POST | `/v1/actions` | `UiAction` | `{ accepted:true }`，202 |
| GET | `/v1/tasks` | `status?`（逗号分隔）, `botId?`, `limit?` | `{ tasks:Task[] }` |
| GET | `/v1/tasks/:id` | — | `{ task:Task }` 或 404 |
| GET | `/v1/triggers` | — | `{ triggers:Trigger[] }` |
| POST | `/v1/triggers` | `CreateTriggerInput` | `{ trigger:Trigger }`，201 |
| PUT | `/v1/triggers/:id` | `UpdateTriggerInput` | `{ trigger:Trigger }` |
| GET | `/v1/triggers/:id/runs` | — | `{ runs:TriggerRun[] }` |
| POST | `/v1/triggers/:id/pause` | — | `{ trigger:Trigger }` |
| POST | `/v1/triggers/:id/resume` | — | `{ trigger:Trigger }` |
| GET | `/v1/requests/:id` | — | `{ request:SessionRequest, answerState?, deliveredAnswer?:QuestionAnswer }` 或 404（仅原生 question 的 claim 为 delivered 时附答案），问题卡片可按 requestId 读取完整题组和投递状态 |
| GET | `/v1/reports/:ref` | — | `{ ref, text }`，精确读取历史原始报告；未知或非成功完成事件 404 |
| POST | `/v1/route-test` | `{ text }` | `{ decisionLogId, selectedBotId, probabilities:[{botId,name,probability}], backend, model }`；未配置/分类失败 503 |
| GET | `/v1/bots` | — | `{ bots:BotConfig[] }` |
| POST | `/v1/bots` | `BotConfig` | `{ bot:BotConfig }`，201；不能创建 system 标记 |
| POST | `/v1/messages/:id/undo-bot-creation` | — | 返回原创建回执 `{ message }`。同一撤销可重试，回执已失效返回 409，未知回执返回 404 |
| PUT | `/v1/bots/:id` | `BotConfig` | `{ bot:BotConfig }`；ID 与 system 标记不可改变 |
| DELETE | `/v1/bots/:id` | — | `{ deleted:true }`；主助手和仍被任务引用的 Bot 受删除保护 |
| GET | `/v1/mcp/servers` | — | `{ servers:McpServer[] }` |
| POST | `/v1/mcp/servers` | `McpServerInput` | `{ server:McpServer }`，201；新 server 默认关闭 |
| PUT | `/v1/mcp/servers/:id` | `McpServerInput` | `{ server:McpServer }`；连接参数变化会清空工具目录并关闭 server |
| DELETE | `/v1/mcp/servers/:id` | — | `{ deleted:true }`；同时删除该 server 的 Bot grant |
| POST | `/v1/mcp/servers/:id/test` | — | `{ server:McpServer }`；发现工具并更新健康状态 |
| POST | `/v1/mcp/servers/:id/enable` 或 `/disable` | — | `{ server:McpServer }` |
| POST | `/v1/mcp/servers/:id/auth/start` | — | `{ serverId, authorizationUrl, expiresAt }`；仅 HTTP/SSE server 支持 |
| POST | `/v1/mcp/servers/:id/auth/logout` | — | `{ server:McpServer }`；删除本地 OAuth token |
| GET | `/v1/bots/:id/mcp-grants` | — | `{ grants:McpGrant[] }` |
| PUT | `/v1/bots/:id/mcp-grants/:serverId` | `{ enabled, allowedTools }` | `{ grant:McpGrant }`；工具名只保留当前目录中的精确名称 |
| POST | `/v1/secrets` | `{ name, key }` | `{ apiKeyRef:"secret:<name>", configured:true }`；同名原子替换 |
| GET | `/v1/secrets/status?ref=...` | `SecretStatusInput` | `{ apiKeyRef, configured:boolean }`，绝不返回密钥 |
| GET | `/v1/config` | — | `AutConfig` |
| PUT | `/v1/config` | `AutConfig` | `AutConfig`；不能删除仍被 bot 使用的 harness 实例 |
| GET / upgrade | `/v1/events` | WebSocket 握手 | 实时 `DaemonEvent` JSON；初始数据从读取接口获取 |

HTTP 鉴权头：`Authorization: Bearer <token>`。WebSocket 可使用同一 header，或子协议
`aut`、`aut-token.<token>`；服务只协商 `aut`。不提供跨域匿名访问。

消息文本非空；同一个指定 ID 与相同文本重复提交返回已有消息（200），不重复投递；相同 ID 不同内容返回 409。
触发器创建可提供稳定 `id`，重复 ID 返回 409 并保留原记录，便于在客户端无法确认响应时核对结果。
路由试验仅写决策日志，不执行 Op 或追加主会话消息。历史报告引用 `event:<事件ID>`，
路径参数应 URL 编码；它指向不可变成功完成事件，不随 Task.lastReport 更新（ADR-0027）。
MCP server 配置保存在 `mcp.json`，Bot 配置不再接受内嵌 `mcpServers[]`。静态环境变量和 header 只接受
`secret:`、`env:` 引用或非敏感值。OAuth token 不出现在 API、配置文件和日志中。新 server、grant 和工具授权默认关闭，
只有已启用且已授权的工具才会以 MCP proxy 方式注入任务会话。单个 server 测试或连接失败只影响对应 grant，
不会阻止 `aut` bridge 或其他 server 注入。
分页以 Store 的插入顺序为准，before 是排他的消息游标。错误统一为
`{ error: { code:string, message:string } }`，不回传异常堆栈、密钥或本地凭据。

启动参数由环境读取：`AUT_DATA_DIR`（默认 `~/.aut`）、`AUT_PORT`（默认 4317）。
同一数据目录只允许一个 daemon，在任务恢复之前通过独立 `daemon-lock.sqlite` 连接的
`BEGIN EXCLUSIVE` 取得进程所有权锁；重复启动报明确冲突，不能重做恢复。锁数据库不会被删除，
正常关闭释放连接，进程崩溃由操作系统释放文件锁，因此无需清理陈旧 PID 文件。
关闭进程只关闭本实例拥有的资源。恢复通知持久化后，下一次启动不会重复生成同一轮通知。

`/v1/messages` 与 `/v1/actions` 在同一串行 admission 中完成落盘和入队，chief 使用持久事件 ID
记录路由决策。真正的路由、任务执行和 bot soul 工作目录落地由组合的业务服务承担，
不由 HTTP handler 承担。启动顺序与未确认入站恢复语义见 ADR-0031。

## WebSocket 输出与持久化顺序

每条帧由 `DaemonEvent` Schema 校验：

```ts
{ type: "event", event: AutEvent }
{ type: "changed", resources: ["messages", "tasks", "requests", "bots", "config", "mcp", "triggers"] }
```

`resources` 是非空去重子集。`event` 保留输入/会话事件；`changed` 通知 UI 回读对应 API，
覆盖 chief ack/reply/card、任务状态、问题、bot、配置、MCP server 和触发器变更。输出不会再次作为用户输入送给 chief。
每个已提交 SQLite 事务最多发一条资源变更通知；读取、回滚和失败不会发。
JSON 配置原子保存成功后发对应通知。通知是当前连接的实时失效信号，不是持久化事件回放；
首次连接或重连后应重新读取 API，以获得断开期间的最终状态。

`quote-reply` 入队前必须原子保存用户原文与原始 UiAction 事件；引用不存在返回 404，且不写入两者。
消息 ID 为 `quote:${storedEvent.id}`，其 at 与事件一致，author=user、kind=text，text 为原文，
taskId 继承引用消息。有归属任务时 StateSource 固定目标，无归属任务时使用常规路由；两者均按事件 ID 读取已落盘的引用回复。

密钥遵循 ADR-0026，保存到独立的 0600 secrets.json；普通 config.json 仅保存 apiKeyRef。
name 为安全短 ID（1–64 ASCII 字母、数字、下划线、短横线，首位字母或数字），不能作为文件路径。
状态查询支持 secret:<name>、env:NAME 与既有裸环境变量名；损坏存储返回通用错误且不覆盖原文件。
