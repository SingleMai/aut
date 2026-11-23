# core 存储与领域服务

对应 ADR-0018。所有方法返回 Effect，所有失败为 `CoreError`；运行时组合 `CoreLive({ dataDirectory })`，
默认目录为 `~/.aut`。Store、EventBus 与独立 Changes 生命周期绑定 Scope。
事务接口在 `packages/core/src/store.ts`，SQLite 实现与初始化在 `packages/core/src/sqlite-store.ts`。

## SQLite

aut.db 使用 WAL、foreign_keys 与 busy_timeout；九张表为
main_thread_messages、tasks、sessions、session_requests、events、decision_logs、bot_creations、triggers、trigger_runs。
每表保存 `seq INTEGER PRIMARY KEY AUTOINCREMENT`、`id TEXT UNIQUE`、`task_id TEXT`、`data TEXT`。
seq 是稳定分页顺序，data 读写都经过对应 Schema；SQL 用户值全部通过参数绑定。

Session 辅助记录为 `{ id: TaskId, instanceId: string, cursor?: ResumeCursor, execution: SessionExecution }`；
request 辅助记录为 `{ id: RequestId, taskId: TaskId, request: SessionRequest,
state: open | answered | expired | cancelled, closedAt?: Timestamp, answerClaim?: AnswerClaim }`；
event 辅助记录为 `{ id: string, at: Timestamp, event: AutEvent }`。
辅助记录的 Schema 位于 core；其他表直接使用 protocol Schema。
execution保存持久化投递队列、执行代次、当前所有权与不确定投递；answerClaim保存题组投递所有权和状态，
分别遵守ADR-0023与ADR-0032，不是可随意重放的历史命令。

`Store.transaction(tx => Effect)` 提供 `get(table,id)`、`insert(table,value)`、`set(table,value)`、
`list(table,{before?,limit?})`。get 返回 Option；insert 拒绝重复 ID；set 为原子 upsert。
默认分页返回最新 50 条，页内按插入顺序排列；before 必须引用存在的 ID。回调不得重入 Store。
空库在一次事务中创建全部表与索引，并写入 PRAGMA user_version = 5。daemon 可重开同版本数据库，已有表的无版本数据库及其他版本会报错。开发时可用新的 AUT_DATA_DIR 单独启动。见 ADR-0048。触发器的 nextAt 与运行账本的 occurrenceKey 由同一事务更新，避免 daemon 重启或重复 tick 造成重复投递。
私有 `bot_creations` 表保存仍需核对的创建回执身份、来源任务、配置摘要及写入阶段。启动时与实际 Bot 配置核对，完成的回执保存在原主会话消息中。任务的 Bot ID 有独立索引，所有任务状态均计入使用记录。见 [ADR-0046](decisions/0046-agent-bot-creation-undo.md)。
批量取交接消息和读取用户事件均按 seq 排序；同一 eventRef 有多条决策日志时取最后入库的一条。见 [ADR-0043](decisions/0043-indexed-routing-reads.md)。
事务跟踪实际写入，COMMIT 成功后以 Changes 发布去重资源集合；COMMIT 和发布之间不可中断。
main_thread_messages → messages，tasks/sessions → tasks，session_requests → requests；
events/decision_logs 不直接触发资源失效。只读、无变化的 set、回滚与失败不发布。
失败和中断回滚，连接 Semaphore 在所有退出路径释放。

## JSON 配置

`bots.json` 保存 `BotsConfig`，`config.json` 保存 `AutConfig`，`mcp.json` 保存版本为 1 的
`McpConfig`。MCP 配置包含全局 `servers` 注册表和 Bot 到 server 的 `grants`。server 保存连接参数、
启用状态、认证状态、健康状态和最近一次工具目录。敏感环境变量、请求头和 OAuth token 不写入 `mcp.json`，
前两者使用 `secret:` 或 `env:` 引用，后者写入独立的 0600 `secrets.json`。

文件缺失时 `mcp.json` 返回 `{schemaVersion:1, servers:[], grants:[]}`。文件解析或编码失败时保留原文件并返回
配置错误。`ConfigStore.readMcp/writeMcp/updateMcp` 与其他配置文件共用跨文件 mutation 锁，成功保存后发布
`mcp` Changes 资源。`ConfigStore` 不读取或迁移旧 Bot 内嵌的 `mcpServers[]` 字段。

## 领域服务

- `MainThread.append(message)`、`page({before?,limit?})`、`get(id)`、`getByIds(ids)`。
- `SessionRecords.readRequest(id)` 和 `readReport(ref)` 为本地 API 读取已保存的会话请求及历史报告。
  详情见 [ADR-0041](decisions/0041-delivered-answer-readback.md) 和 [ADR-0027](decisions/0027-desktop-support-api.md)。
- `TaskRegistry.create(task)`、`get(id)`、`list({status?,botId?,limit?})`、`transition(id,event)`、
  `update(id,pureFn)`。create 接受状态为 created、待答列表和队列均为空的任务，并原子创建会话执行登记。update 可修改任务内容，身份、来源、状态、待答列表和投递队列由各自的登记流程管理。
- `DecisionLog.write(log)`、`get(id)`、`correct(id,correction)`、`complete(id,execution)`；
  修订只替换 correction，执行结果回写只替换 execution，两者事务化更新且保留原始路由记录。
- `ConfigStore.readConfig/writeConfig/updateConfig`、`readBots/writeBots/updateBots`、`readMcp/writeMcp/updateMcp`。
  缺失文件分别返回 `{harnessInstances:[]}`、`[]` 与空 `McpConfig`；非法文件报告错误，不静默重置。
  `withMutation(effect)`为跨文件配置检查与修改提供共享工作流锁；Administration 与主助手初始化共用它，
  内部单文件I/O锁独立，避免重入并防止旧快照覆盖新配置。
- `EventBus.publish(event)`、`subscribe`（返回绑定调用方 Scope 的 Dequeue）。
- `Changes.publish(resources)`、`subscribe`；独立 PubSub 发布资源失效，不能充当 chief 输入。
  ConfigStore 原子保存成功后发布 bots/config/mcp；保存与发布不可中断，失败不发布。

TaskRegistry 的转移事件使用 `type`：`turn.started`、`request.opened {requestId}`、
`request.answered {requestId}`、`turn.completed {ok:true}` 或
`turn.completed {ok:false,stopReason:"interrupted",restart:boolean}`、`gate.done`、`turn.failed`、
`daemon.restart`、`cancel`、`retry`、`resume`、`archive`。
`request.opened` 在此 API 中仅表示 question；permission 仅记审计，不改变状态。
重复 open 与回答未知 request 是明确错误。完成/失败/重启/取消清除 pending IDs；
其他 request 记录及卡片由调用方在同一事务中收尾，不能以清空 pending 等同问题已回答。
调用方撤销回合所有权后须过滤旧 turn 通知；TaskRegistry 不推断执行代次。

状态机表完全对应 `protocol.md` §4。request answered 根据移除后的 pending 数量选择互斥规则；
成功完成进入 reporting，restart 中断进入 idle，非 restart 中断进入 interrupted。
retry/resume 的启动确认只提交一次领域转移，不能在已 running 后再次发送 turn.started。
