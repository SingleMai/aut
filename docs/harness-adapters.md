# Harness 适配层

> Codex 列与 §3 已按 **codex-cli 0.167.0、模型 gpt-6.1-sol、Provider openai** 的真实探针修订（2026-11-16），见 `spikes/codex/README.md` 与 `fixtures/`。

后续兼容复验：Codex **0.169.0** 已完成真实主会话 new/send、原生 RPC 题组、async 通知、
queue/steer、取消/重试/恢复、fork 回包与 deep 查询，以及慢脑原生 MCP 派活。
独立 Plan 探针另确认 `isBlocking=true`、挂起时进程存活与自由文本回填。
默认模式主会话题组仍为 `isBlocking=false`，不将其误称为 Plan 模式实测。
各版本证据独立保存，见 `docs/acceptance.md` 和 `spikes/e2e/results/`；不覆盖旧原始样本。
> Claude Code 已按 **Claude Code 2.1.325** 的真实探针修订，原始收发见 `spikes/claude/fixtures/`，探针与复现方法见 `spikes/claude/README.md`。通用 ACP adapter 已按 **OpenCode 1.19.5** 的真实探针接入，原始收发见 `spikes/acp/fixtures/`，探针与复现方法见 `spikes/acp/README.md`。
> OpenMausBot 路径均相对其仓库根目录（`github.com/milind-soni/OpenMausBot`）。

## 1. 优先级

| 阶段 | Harness | 接入方式 |
|---|---|---|
| MVP | **Codex** | `codex app-server`，NDJSON JSON-RPC over stdio |
| 后续 | Claude Code | `claude -p` 常驻进程，stream-json 输入/输出，已完成 2.1.325 探针 |
| 后续 | OpenCode / Grok CLI / Gemini 等 | ACP（Agent Client Protocol）通用 adapter，OpenCode 1.19.5 已接入 |

## 2. 能力表（Codex、Claude Code、OpenCode ACP 已探针）

| 能力 | Codex | Claude Code | 通用 ACP |
|---|---|---|---|
| resume | ✅ `thread/resume` | ✅ `--resume <id>`（2.1.325 实测） | ✅ `session/load` 或 `session/resume`（视 agent） |
| fork（原生） | ✅ `thread/fork`，源 thread 未混入 fork 回合 | ✅ `--resume <id> --fork-session --no-session-persistence`（2.1.325 实测） | ⚠️ OpenCode 1.19.5 已公布并实测 `session/fork`，aut adapter 暂声明 `false` |
| steer | ✅ `turn/steer` | ✅ 回合中写带 `uuid` 的 stdin user frame（2.1.325 实测） | ⚠️ 无标准方法，adapter 默认 `false`，可选 provider slash command 仅在能力公布时启用 |
| 原生全放行 | ✅ | ✅ `--permission-mode bypassPermissions`（2.1.325 实测） | ⚠️ 视 agent（Grok 有、Gemini/Qwen `--yolo`、OpenCode 无→由 adapter 自动回复） |
| 原生提问 | ✅ Plan 阻塞请求；Default 可选非阻塞请求；async 通知（见 §3.3） | ✅ 通过 aut 注入的 MCP `ask_user` 工具拦截，答案回填为 tool result（2.1.325 实测） | ✅ `session/request_permission`（`interaction_` 前缀），Grok 扩展 `_x.ai/ask_user_question` |
| 多问题 / 多选 / 自由文本 | ✅ 两题实测 / ❌ 保守声明（协议无多选字段） / ✅ 非选项文本实测 | ✅ / ✅ / ✅（aut `ask_user` MCP 工具） | 通用能力保守声明为 ❌ / ❌ / ❌，Grok 扩展已实现多问题和自由文本解析 |
| transcript 导出 | ✅ `thread/read({includeTurns:true})` | ✅ 运行期 transcript（Claude 会话 JSONL 可作为后续只读实现依据） | ✅ 运行期 transcript，`sessionHistory: false` |
| 原生上下文状态 | ✅ `sessionContext: true`（0.171.0 自动压缩与用量通知实测） | 暂未声明，`sessionContext: false` | 暂未声明，`sessionContext: false` |

能力表的最终值写进各 adapter 的 `capabilities` 常量，并在本文同步。

### 2.1 会话上下文与原生压缩

工作会话的模型上下文由 Harness 管理，包括其原生压缩策略。aut 不增加第二套摘要器、
不按交接片段的估算成本触发压缩、不重放同一会话的完整 transcript，也不覆盖用户的压缩配置。
这是 Harness 的职责边界，不保证所有 Provider 或版本均支持相同的压缩功能（[ADR-0066](decisions/0066-native-session-context.md)）。

- [交接包](handoff.md)只管理本次请求附带的主会话片段；其预算不是工作会话的模型窗口或 token 用量。
- `transcript` / `readSession` 负责历史读取，分页是历史展示与读取性能问题；原生压缩不授权 aut 删除持久化消息或任务报告。
- ReplyGate 的独立 fork 只改写面向用户的回包，不整理或替换原工作会话上下文。
- Codex 0.171.0 已录制自动压缩与用量探针，声明 `sessionContext: true`，通过只读 `SessionHistory.context`
  提供最近原生输入 token、窗口与压缩节点。`last.inputTokens` 是最近读数，`total` 是累计计费，不能混用。
  压缩过程和完成后先隐藏旧读数，等待新的有效输入 token 通知；冷读没有用量字段时保持未知。
  Claude / ACP 暂未声明此能力。接入与 UI 边界见 [ADR-0067](decisions/0067-native-context-status-ui.md)，不提供手动压缩操作。

### 2.2 原生自动记忆

aut 统一管理 bot 记忆，不提供原生记忆来源选择（[ADR-0068](decisions/0068-aut-managed-bot-memory.md)）。
Claude / Codex adapter 在新建、恢复、fork 会话时强制关闭原生自动记忆，覆盖继承环境和实例参数中的启用设置：

- Claude Code 2.1.330：进程环境与最终 settings 的 env 均强制 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`，
  最终 settings 同时设 `autoMemoryEnabled:false`，保留其余实例设置。只设置进程环境会被 settings.env 中的 `0` 覆盖，
  已用临时 MEMORY 标记复现；关闭自动注入后 CLAUDE 指令仍可读取。
- Codex 0.171.0：进程参数 `--disable memories`、`-c memories.use_memories=false`、`-c memories.generate_memories=false`；
  初始化后 `config/read` 核对关闭状态，工作线程配置同时显式保持三项关闭。恢复已有 aut 线程后、发送工作回合前，
  调用 `thread/memoryMode/set` 将该线程资格设为 disabled；新建/fork 由 generate 开关持久化 disabled。
  配置不符、协议不支持或关闭失败时返回现有 adapter 错误并释放子进程，不静默回退。
- Codex 只读历史进程也带关闭参数，但不恢复会话、不改线程资格。用户在 aut 外的原生配置和记忆不受影响。

这不改变项目指令、原生历史或原生压缩。已经载入旧会话的内容不会被清除。ACP 未经原生记忆开关验证，
不将上述结论泛化到其 provider。探针与边界见 `spikes/claude/native-memory.md`、`spikes/codex/native-memory.md`。

## 3. Codex（MVP）

参考：`server/drivers/codex.ts`、`server/drivers/codex-questions.ts`、`server/drivers/codex-approval-config.ts`。
注意 OMB 的 Codex 驱动约 1,700 行，依赖其沙箱、计费、MCP bridge 等模块，**不可整体复制**；按 aut 的 `HarnessAdapter` 接口重写精简版。

### 3.1 进程与会话
- 启动常驻 `codex app-server`，stdio 上收发 NDJSON JSON-RPC。
- `thread/start`、`thread/resume` 与 `thread/fork` 的 RPC 等待预算为 30 秒。Codex 0.169.0 冷启动内置 MCP 服务时可能超过 15 秒，较短预算会把尚未确认的会话误判为失败。
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

## 4. Claude Code（2.1.325）

参考：`server/drivers/claude.ts`、`server/permission-proxy.ts`、`server/drivers/claude-keepwarm.ts`、`server/drivers/claude-unusable-tools.ts`。

### 4.1 进程
- `claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages --replay-user-messages`，每个 session 一个常驻进程，`--resume <sessionId>`。生产 adapter 已按 2.1.325 真实样本消费 `system/init`、`stream_event`、`assistant`、`user`、`result` 和回合排队字段。
- 每回合配置写入 0600 临时文件，用 `--mcp-config` / `--settings` 传入。
- 沿用 OpenMausBot 的进程边界设置 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`、`CLAUDE_CODE_DISABLE_CRON=1`，aut 的 session 由 daemon 管理，后台任务和定时器不能绕过 chief。
- fork：`--resume <id> --fork-session --no-session-persistence`，2.1.325 已实测分支回合与父会话隔离。
- 中断：`SIGINT` 会收到 `result.is_error:true` 与 `terminal_reason:"aborted_streaming"`，adapter 映射为 `turn.completed(ok:false, stopReason:"interrupted")`。
- steer：写入带 UUID 的 `user` frame。原生回放 `isReplay:true` 用来确认消息已被模型接收，`result` 到达前 adapter 保留结果并等待 continuation grace。

### 4.2 提问拦截

- 当前 adapter 采用 OpenMausBot 已验证的方案 A。`--permission-mode bypassPermissions` 负责权限全放行，aut 通过临时 MCP 配置注入 `aut-questions` 的 `ask_user` 工具。工具进程只通过本地 Unix socket 与 adapter broker 通信，问题进入 `SessionRequest`，用户答案再作为 MCP tool result 回填。决策与取舍见 [ADR-0055](decisions/0055-claude-question-interception.md)。
- 2.1.325 真实样本确认了多问题、多选和自由文本在该工具路径上可用。权限请求即使漏到 broker 也发布 `request.opened` / `request.closed` 审计事件后自动允许，question 永不自动回答。
- `spikes/claude/fixtures/question-2.1.325.jsonl` 保存了真实 MCP 工具发现、问题 broker、工具结果和最终 `result` 的完整收发。

## 5. 通用 ACP（当前实现）

参考：`server/drivers/acp/core.ts`、`server/drivers/acp/grok.ts`、`server/drivers/acp/opencode-go.ts`。
- 运行链路是 `aut core → aut ACP adapter → provider CLI`。OpenMausBot 仅作为 Apache-2.0 源码来源，aut 不依赖其运行时，也没有使用 `enterprise/`。
- OpenCode 1.19.5 真实探针已覆盖 `initialize`、`session/new`、`session/prompt`、`session/cancel`、新进程 `session/load` 和 provider `session/fork`。原始收发保存在 `spikes/acp/fixtures/`，逐行解码测试见 `packages/adapters/src/acp/wire.test.ts`。
- 方法：`session/new`、`session/load` / `session/resume`、`session/prompt`、`session/cancel`。每个 aut session 独占 ACP 子进程、transport、事件总线和回合状态。
- `HarnessInstanceConfig.authMethodIds` 可以保存 provider 的认证方式优先级。adapter 会从 `initialize.authMethods` 中选择第一个匹配项并调用 `authenticate`，没有配置时沿用 provider 自己的登录状态。
- 当 provider 在 `session/new` 或 `session/load` 返回模型 `configOptions` 时，adapter 通过 `session/set_config_option` 应用 Bot 的 `model`，并按同一规则应用已声明的 `effort`。没有公布对应选项的 provider 保留自身 session 默认值，不能把该 provider 的模型切换能力写成已验证事实。
- 权限：client 收到 `session/request_permission`，回复所选 optionId（`allow_once` / `allow_always` / `reject_once`）或 `{ outcome: { outcome: "cancelled" } }`。
  回合之间到达的请求一律 `cancelled`，避免 agent 阻塞。
- 提问：`session/request_permission` 中 `toolCallId` 以 `interaction_` 开头者为提问，只支持单个选项集；Grok 走扩展方法 `_x.ai/ask_user_question`，
  回复 `{ outcome: "accepted", answers: { "<问题文本>": ["<label>"] } }`。
- 全放行：Grok `--permission-mode bypassPermissions`；Gemini/Qwen `--yolo`；OpenCode 没有原生全放行模式，adapter 按项目默认最高权限自动选择允许项，并记录 permission 审计事件。question 永不自动回答。
- 能力边界：OpenCode provider 已公布 `session/fork`，但通用 adapter 目前仍声明 `fork: false`，避免把同一 transport 直接复用成两个 aut handle。ACP 没有标准 steer，adapter 只有在配置的 slash command 由 provider 公布时才尝试发送，默认返回 `refused`。
- Grok 1.0.89 当前已完成 ACP `initialize` 和认证边界探针，未登录时 `session/new` 返回 `Authentication required`，尚未录制真实回合。Gemini 和 Qwen 在本机未安装，不能把其能力写成已验证事实。

## 6. 探针要求（每个 harness）

`spikes/<harness>/` 下：
1. 最高权限启动，记录 CLI 版本。
2. 一个普通回合：确认事件序列与 `finalReport` 的取法。
3. 一个必然触发提问的 prompt：录制原始请求，回填答案，确认 agent 拿到答案并继续。
4. 回合运行中 steer、interrupt 各一次。
5. resume；fork（若支持）；transcript 导出（若支持）。
6. 所有原始收发保存为 fixtures（JSONL，带版本号），作为 adapter 测试的回放来源。

ACP 当前样本和复现命令见 `spikes/acp/README.md`。provider 宣布的能力与 aut adapter 对外声明可能不同，能力表以 adapter 的 `capabilities` 为准。
