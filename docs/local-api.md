# 本地 daemon API

> ADR-0021；所有路由需要本地 token。`packages/protocol/src/api.ts` 是请求与响应的 Schema 来源。

远程访问按 ADR-0072 显式开启，使用独立访问密钥，监听地址仍为本机回环。
`GET /v1/remote/identity` 返回主机身份；`GET/PUT /v1/remote/host` 查询/设置远程主机，
`POST /v1/remote/connection` 导出连接信息。后两组路由仅接受本地 token；连接信息不进入日志或普通配置响应。
配置和状态的 Schema 见 `protocol/src/remote.ts`。关闭或轮换远程凭据会终止既有远程 WebSocket。

Bot 文件记忆（ADR-0069，Schema 位于 `protocol/src/memory.ts`）：`GET /v1/bots/:id/memory?snapshot=...` 返回目录、文件、快照及整理计划；
`GET /v1/bots/:id/memory/file?path=...&snapshot=...` 读取当前或快照文件，`PUT /v1/bots/:id/memory/file` 接受 `{path,content}`，
`DELETE /v1/bots/:id/memory/file?path=...` 删除当前文件，`POST /v1/bots/:id/memory/clear` 清空当前记忆。
写操作返回更新后的文件或 `{accepted:true}`；快照只读。目录归属与限额见 [Bot 记忆](memory.md)。
`GET /v1/bots/:id/memory/graph?snapshot=...` 按需解析当前文件或选定快照，返回 `MemoryGraphResponse`：
`botId`、知识文件节点 `nodes`（`path,title,updatedAt`）、有效有向链接 `edges` 和缺失知识目标 `brokenLinks`（均为 `source,target`）。
不读取其他 Bot，不把缺失目标伪装为节点，不保存独立图数据；链接约定见 ADR-0070。

| 方法 | 路径 | 请求 | 成功结果 |
|---|---|---|---|
| GET | `/v1/health` | — | `{ status:"ok" }` |
| GET | `/v1/messages` | `before?`, `limit?`（1–50） | `{ messages: MainThreadMessage[] }` |
| POST | `/v1/messages` | `{ text:string, id?:MessageId, fileIds?:FileId[] }` | `{ message: MainThreadMessage }`，201 |
| POST | `/v1/files` | `{ name, base64 }` | `{ file:MessageFile }`，201；单文件最多 20 MiB |
| GET | `/v1/files/:id` | — | `{ file, base64 }`；只读已保存的快照 |
| POST | `/v1/files/keepalive` | `{ ids:FileId[] }` | `{ accepted:true }`；续期仍在编辑的上传草稿 |
| DELETE | `/v1/files/:id` | — | `{ released:boolean }`；仅释放无消息引用的上传草稿，成果始终保留 |
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
| GET | `/v1/bot-models/options` | — | `BotModelOptionsResponse`；已有接入与已登记程序候选，不写配置或启动进程 |
| POST | `/v1/bot-models/discover` | `BotModelDiscoveryInput` | `BotModelsResponse`；在执行主机读取原生模型和思考/速度选项（ADR-0077），不发送工作回合；ACP 会打开空的原生会话，读取预算 15 秒，进程清理另计（ADR-0076） |
| POST | `/v1/bot-models/connection` | `HarnessInstanceConfig` | `{ instance }`；加锁复用相同接入或追加新引用，不覆盖已有实例，供 Bot 编辑器保存使用（ADR-0075） |
| PUT | `/v1/config` | `AutConfig` | 返回实际保存的配置。省略 classifier 时保留现有快脑配置。仍被 bot 使用的 harness 实例受引用保护 |
| GET / upgrade | `/v1/events` | WebSocket 握手 | 实时 `DaemonEvent` JSON；初始数据从读取接口获取 |

HTTP 鉴权头：`Authorization: Bearer <token>`。WebSocket 可使用同一 header，或子协议
`aut`、`aut-token.<token>`；服务只协商 `aut`。不提供跨域匿名访问。

消息文本非空；同一个指定 ID 与相同文本、附件 ID 顺序重复提交返回已有消息（200），不重复投递；相同 ID 不同内容返回 409。文件上传路由使用独立有界 body 限额，其余路由保持 1 MiB。引用回复可携带新附件 ID，并继承原消息的文件引用；合并去重后最多 16 项。见 ADR-0064。
触发器创建可提供稳定 `id`，重复 ID 返回 409 并保留原记录，便于在客户端无法确认响应时核对结果。
路由试验仅写决策日志，不执行 Op 或追加主会话消息。历史报告引用 `event:<事件ID>`，
路径参数应 URL 编码；它指向不可变成功完成事件，不随 Task.lastReport 更新（ADR-0027）。
MCP server 配置保存在 `mcp.json`，Bot 配置不再接受内嵌 `mcpServers[]`。静态环境变量和 header 只接受
`secret:`、`env:` 引用或非敏感值。OAuth token 不出现在 API、配置文件和日志中。新 server、grant 和工具授权默认关闭，
只有测试成功、已启用且已授权的工具才会以 MCP proxy 方式注入任务会话。撤销授权即时约束已运行的 proxy，退出登录同时停用 server；配置变化关闭旧连接并清除失效的登录凭据。单个 server 测试或连接失败只影响对应 grant，
不会阻止 `aut` bridge 或其他 server 注入。
保留服务名 `aut`；创建或编辑时拒绝与内置桥同名。OAuth 失效规则及接入流程统一见 [ADR-0062](decisions/0062-mcp-onboarding-and-management.md)。
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
