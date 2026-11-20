# Harness 适配层

> Codex 列与 §3 已按 **codex-cli 0.167.0、模型 gpt-6.1-sol、Provider openai** 的真实探针修订（2026-11-16），见 `spikes/codex/README.md` 与 `fixtures/`。

后续兼容复验：Codex **0.169.0** 已完成真实主会话 new/send、原生 RPC 题组、async 通知、
queue/steer、取消/重试/恢复、fork 回包与 deep 查询，以及慢脑原生 MCP 派活。
独立 Plan 探针另确认 `isBlocking=true`、挂起时进程存活与自由文本回填。
默认模式主会话题组仍为 `isBlocking=false`，不将其误称为 Plan 模式实测。
各版本证据独立保存，见 `docs/acceptance.md` 和 `spikes/e2e/results/`；不覆盖旧原始样本。
> Claude Code / ACP 仍来自 OpenMausBot 源码阅读（commit `738ec88`），不是 CLI 实测。每个 adapter 实现前必须先录制当前 CLI 样本。
> OpenMausBot 路径均相对其仓库根目录（`github.com/milind-soni/OpenMausBot`）。

## 1. 优先级

| 阶段 | Harness | 接入方式 |
|---|---|---|
| MVP | **Codex** | `codex app-server`，NDJSON JSON-RPC over stdio |
| 后续 | Claude Code | `claude -p` 常驻进程，stream-json 输入/输出 |
| 后续 | OpenCode / Grok CLI / Gemini 等 | ACP（Agent Client Protocol）通用 adapter |

## 2. 能力表（Codex 已探针，其余待确认）

| 能力 | Codex | Claude Code | 通用 ACP |
|---|---|---|---|
| resume | ✅ `thread/resume` | ✅ `--resume <id>` | ✅ `session/load` 或 `session/resume`（视 agent） |
| fork（原生） | ✅ `thread/fork`，源 thread 未混入 fork 回合 | ✅ `--resume <id> --fork-session`（OMB 内部用于 keep-warm） | ❓ 未见 |
| steer | ✅ `turn/steer` | ✅ 回合中写 stdin | ⚠️ 无标准方法（OMB 用 agent 公布的 slash command 变通） |
| 原生全放行 | ✅ | ✅ `--permission-mode bypassPermissions` | ⚠️ 视 agent（Grok 有、Gemini/Qwen `--yolo`、OpenCode 无→由 adapter 自动回复） |
| 原生提问 | ✅ Plan 阻塞请求；Default 可选非阻塞请求；async 通知（见 §3.3） | ⚠️ 见 §4.2，两种方案待定 | ✅ `session/request_permission`（`interaction_` 前缀），Grok 扩展 `_x.ai/ask_user_question` |
| 多问题 / 多选 / 自由文本 | ✅ 两题实测 / ❌ 保守声明（协议无多选字段） / ✅ 非选项文本实测 | ✅ / ✅ / ✅（原生 AskUserQuestion） | ❌ 单问题 / ❌ / ⚠️ 仅选项 |
| transcript 导出 | ✅ `thread/read({includeTurns:true})` | ✅ 会话 JSONL 文件 | ❓ |

能力表的最终值写进各 adapter 的 `capabilities` 常量，并在本文同步。

## 3. Codex（MVP）

参考：`server/drivers/codex.ts`、`server/drivers/codex-questions.ts`、`server/drivers/codex-approval-config.ts`。
注意 OMB 的 Codex 驱动约 1,700 行，依赖其沙箱、计费、MCP bridge 等模块，**不可整体复制**；按 aut 的 `HarnessAdapter` 接口重写精简版。

### 3.1 进程与会话
- 启动常驻 `codex app-server`，stdio 上收发 NDJSON JSON-RPC。
- 实测方法：`initialize` → `initialized`；`thread/start`、`thread/resume`、`thread/fork`、`thread/read`、`turn/start`、`turn/steer`、`turn/interrupt`。
- `initialize.capabilities.experimentalApi = true`；普通 turn、同进程和新进程 resume 均已录制。
- 通知事件（OMB 消费）：`turn/started`、`turn/completed`、`item/started`、`item/completed`、`item/agentMessage/delta`、
  `item/reasoning/*`、`item/commandExecution/outputDelta`、`item/fileChange/patchUpdated`、`thread/tokenUsage/updated`。
- `finalReport`：只在 `turn/completed.params.turn.status = "completed"` 时交付；取该回合最后一个 `type = "agentMessage"`、`phase = "final_answer"`、`delivery != "async"` 项的 `text`。事件流的 `item/completed.params.item` 可保存完整项；当前 `turn/completed` 的 `itemsView = "summary"` 也带最终项。`interrupted` / `failed` 不是成功回包，async 问题项即便标为 `final_answer` 也不是报告。
- `turn/steer` 必须传 `expectedTurnId`；运行中返回同一 `turnId`，输入由当前回合消费；空闲返回 JSON-RPC `-32600: no active turn to steer`，不能当投递成功。

### 3.2 最高权限（OMB `codex.ts` `namedApprovalParams("full")`）
Codex 会把这些设置持久化在 thread 上，所以 **start、resume、每个 turn 都要显式传**：
```jsonc
// thread/start, thread/resume
{ "approvalPolicy": "never", "approvalsReviewer": "user", "sandbox": "danger-full-access" }
// turn/start
{ "approvalPolicy": "never", "approvalsReviewer": "user", "sandboxPolicy": { "type": "dangerFullAccess" } }
```
即便如此仍可能到达的审批请求，adapter 自动接受并发出审计事件：
`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`。
`mcpServer/elicitation/request`（非审批类）：OMB 一律 `decline`。**未知的 server request 必须 fail closed，不得被"全放行"误接受。**

### 3.3 提问拦截（0.167.0 实测）

| 模式 | 配置 | 观测结果 | fixture |
|---|---|---|---|
| Default | 默认配置 | 显式要求同步工具时返回 `TOOL_UNAVAILABLE`；此结论限本次模型与配置 | `default.jsonl` |
| Plan | `turn/start.collaborationMode.mode = "plan"` | 原生 server request `item/tool/requestUserInput`，`isBlocking:true` | `plan.jsonl` |
| Default | 子进程 `--enable default_mode_request_user_input` | 同名 server request，`isBlocking:false` | `default-enabled.jsonl` |
| Default async | 无额外 flag | `item/completed` 的 `agentMessage.delivery:"async"` 与 `questions`，没有 server request | `async.jsonl`、`async-delayed.jsonl` |

- 同步/Default 请求含 `threadId`、`turnId`、`itemId`、`questions[]`、`isBlocking`、`autoResolutionMs:null`。回填保留原 JSON-RPC `id`：
  ```json
  { "id": 0, "result": { "answers": { "probe_color": { "answers": ["Blue"] } } } }
  ```
  `answers` 使用选项 label 或用户原文，不是 aut 的 option ID；adapter 负责映射。两题同批与非选项自由文本均已实际回填。仅测试脚本针对固定合成题 ID/文本有预设答案，生产代码不得自动回答。
- `plan-free.jsonl` 保留问题 5 秒，进程存活且收到回复后继续；`default-delayed.jsonl` 同样保留请求 5 秒，未发送空答案。`isBlocking:false` 是协议标记，不能据此伪造请求完成。
- async `questions[]` 是 `{title, options:string[]|null}`，没有稳定 question ID；由 adapter 映射为 aut ID。回答经 `turn/steer` 注入原回合。`async-delayed.jsonl` 中未答问题时已出现 shell 命令开始，证明**不会暂停独立工作**。
- `--enable send_message_to_user_async` 的 A/B 也成功，但未加 flag 已成功，故不能认定此 flag 是 async 提问前提。
- 多选：当前导出协议的 `ToolRequestUserInputQuestion` 与 `AsyncUserInputQuestion` 均无多选字段，保守声明 `multiSelect:false`，不能因回填类型是字符串数组就宣称原生 UI 支持多选。
- **状态语义**：按已接受的 ADR-0015，`waiting_user` 表示有未答问题，保留 harness 原生阻塞/非阻塞行为；最后一个待答问题关闭后才恢复 `running`。Plan 会改变 worker 的执行方式，不可为了提问能力擅自把所有 worker 切到 Plan。

### 3.4 fork / transcript

0.169.0 工作会话补充实测（`session-view-0.169.0.jsonl` / `session-mcp-0.169.0.jsonl` / `session-read-0.169.0.jsonl`）：

- `item/started` / `item/completed` 共享原生 item ID，`params` 带 threadId / turnId；userMessage、agentMessage、commandExecution、fileChange、mcpToolCall 的 ID 与后续 `thread/read` 一致。通知外层 `emittedAtMs`、item 的 `startedAtMs` / `completedAtMs` 为毫秒，turn 的 `startedAt` / `completedAt` 为秒。
- commandExecution 的 status 从 inProgress 到 completed，包含 command、cwd、aggregatedOutput、exitCode、durationMs；`item/commandExecution/outputDelta` 通过 itemId 关联。录制中首段输出没有 delta，只在完成的 aggregatedOutput 出现，完成快照必须权威替换增量。
- fileChange 包含 `changes[{path,kind:{type},diff}]` 与 status；另有 `turn/diff/updated` 的整回合 unified diff。MCP 工具包含 server / tool / arguments / result / error，合成 echo 工具的 result 同时有 text content 与 structuredContent。
- 正在运行的 `thread/read(includeTurns:true)` 虽声明 `itemsView:full`，仍可能暂缺已经收到 started 事件的命令；live reader 用稳定 ID 合并原生快照与实时缓存，不能按缺项删除正在运行的工具。
- 冷读已用独立 app-server 实测：仅 initialize → initialized → thread/read，不 resume、不启动 turn，读取后关闭自身进程。新 `readSession` 返回只读 SessionHistory，不调用 SessionSetup 或改 Provider。
- `includeTurns:true` 在 `historyMode:paginated` 的线程上仍可用，但 0.169.0 明确发出弃用通知，建议未来迁移 thread/turns/list 与 thread/items/list。本次未实测大型历史的原生分页，不声称覆盖该边界。
- `spikes/codex/schemas/session-items-0.169.0.json` 是当前 CLI 本地 `generate-json-schema --experimental` 的定义投影，**不是模型实测 fixture**。据此兼容 webSearch（query/action/results）、dynamicToolCall（arguments/contentItems）、collabAgentToolCall 和图片工具的文本结构，未为测试发出真实搜索或图片请求。未知类型保留为 note；reasoning 只展示明确 summary。读取顺序保持原生数组顺序，实时缺项按事件顺序补入，不靠可能缺失的时间戳重排。

- 已实测原生 `thread/fork`：新 thread ID，继承父 thread 的两个回合；fork 中追加 `TEST_FORK_ONLY` 后再读父 thread，父 thread 仍只有原两个回合。`capabilities.fork = true` 有真实隔离证据。
- `thread/read({threadId,includeTurns:true})` 返回 `thread.turns[].items[]`，可导出 transcript，无需读取或解析本地会话文件。当前 thread `historyMode` 为 `paginated`。
- 当前 CLI 导出的协议提示，paginated thread 长期推荐 `thread/turns/list` + `thread/items/list`；本轮只验证完整读取，分页尚不作为已验证能力宣称。
- `resume-persisted.jsonl` 由新 app-server 进程恢复 `normal.jsonl` 的持久 thread，确认进程退出后的 resume 可用；探针不读取用户已有对话。

## 4. Claude Code（后续）

参考：`server/drivers/claude.ts`、`server/permission-proxy.ts`、`server/drivers/claude-keepwarm.ts`、`server/drivers/claude-unusable-tools.ts`。

### 4.1 进程
- `claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages`，每个 session 一个常驻进程，`--resume <sessionId>`。
- 每回合配置写入 0600 临时文件，用 `--mcp-config` / `--settings` 传入。
- OMB 设置的环境变量：`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`、`CLAUDE_CODE_DISABLE_CRON=1`（aut 的 session 由 daemon 管理，后台任务/定时器会绕过 chief，建议同样禁用）。
- fork：`--resume <id> --fork-session --no-session-persistence`。

### 4.2 提问拦截：两个方案（实现前用探针 A/B）
- **方案 A（OMB 已验证）**：`--permission-mode bypassPermissions`；此模式下 CLI 不提供原生 `AskUserQuestion`，
  由 aut McpBridge 注入 `ask_user` 工具，经本地 socket 连回 daemon，答案作为工具结果返回。
- **方案 B**：不用 bypass，`--permission-prompt-tool mcp__aut__approve` 指向 McpBridge 的审批工具，对所有工具自动放行；
  遇到原生 `AskUserQuestion` 时回复 `{"behavior":"allow","updatedInput":{...input, "answers": {...}}}`（answers 以问题文本为 key）。
  优点：原生工具支持多问题/多选且模型更熟悉；代价：每个工具调用多一次本地 MCP 往返。需确认是否存在漏网的审批。
- 倾向 B，以探针结果定，结论写入 ADR。

## 5. 通用 ACP（后续）

参考：`server/drivers/acp/core.ts`、`server/drivers/acp/grok.ts`、`server/drivers/acp/opencode-go.ts`。
- 方法：`session/new`、`session/load` / `session/resume`、`session/prompt`、`session/cancel`。
- 权限：client 收到 `session/request_permission`，回复所选 optionId（`allow_once` / `allow_always` / `reject_once`）或 `{ outcome: { outcome: "cancelled" } }`。
  回合之间到达的请求一律 `cancelled`，避免 agent 阻塞。
- 提问：`session/request_permission` 中 `toolCallId` 以 `interaction_` 开头者为提问，只支持单个选项集；Grok 走扩展方法 `_x.ai/ask_user_question`，
  回复 `{ outcome: "accepted", answers: { "<问题文本>": ["<label>"] } }`。
- 全放行：Grok `--permission-mode bypassPermissions`；Gemini/Qwen `--yolo`；OpenCode 无原生模式，adapter 自动回复所有 permission。

## 6. 探针要求（每个 harness）

`spikes/<harness>/` 下：
1. 最高权限启动，记录 CLI 版本。
2. 一个普通回合：确认事件序列与 `finalReport` 的取法。
3. 一个必然触发提问的 prompt：录制原始请求，回填答案，确认 agent 拿到答案并继续。
4. 回合运行中 steer、interrupt 各一次。
5. resume；fork（若支持）；transcript 导出（若支持）。
6. 所有原始收发保存为 fixtures（JSONL，带版本号），作为 adapter 测试的回放来源。
