# aut 协议与接口

> 下文用 TypeScript 风格伪代码描述结构；**实现时一律用 Effect `Schema` 定义**，放在 `packages/protocol`，类型由 Schema 推导。
> 字段名为规范，实现不得私自改名；需要新增字段时同步本文。Schema 推导的对象与数组为 readonly；下方伪代码省略只读修饰。

## 1. 事件

```ts
type AutEvent =
  | { source: "user";    kind: "message"; messageId: MessageId }
  | { source: "user";    kind: "ui-action"; action: UiAction }
  | { source: "session"; kind: SessionEvent["kind"]; taskId: TaskId; event: SessionEvent }
  | { source: "trigger"; kind: "fired"; triggerId: TriggerId; payload: JsonValue;
      runId?: TriggerRunId; occurrenceKey?: string; scheduledAt?: Timestamp;
      botId?: BotId; prompt?: string }

type UiAction =
  | { type: "card-choice"; cardId: string; optionId: string }          // 问题卡片 / 澄清卡片
  | { type: "question-answer"; cardId: string; requestId: RequestId; answer: QuestionAnswer } // 整组提交
  | { type: "quote-reply"; quotedMessageId: MessageId; text: string }  // 引用某条 task 消息回复
  | { type: "correct-dispatch"; decisionLogId: string; change: { kind: "undo" } | { kind: "reroute"; botId: BotId } }
  | { type: "task-control"; taskId: TaskId; action: ControlAction }    // 任务面板按钮
```

## 2. Main thread 消息

```ts
interface MainThreadMessage {
  id: MessageId
  at: Timestamp
  author: "user" | "chief" | { botId: BotId; taskId: TaskId }
  kind: "text" | "ack" | "reply" | "question-card" | "clarify-card" | "notice"
  text: string
  sources?: Array<{ url: string; label: string }> // 原报告 HTTP(S) 来源，最多 32 个，见 ADR-0063
  taskId?: TaskId            // 回包/问题卡片/通知所属 task
  card?: Card                // question-card / clarify-card
  fullReportRef?: string     // reply 被截断/改写时，原文在 task 详情中的位置
  decisionLogId?: string     // chief 产生的消息关联的决策日志
  dispatch?: { botId: BotId; canUndo: boolean; status: "open" | "undo" | "reroute" | "corrected" } // 按原记录映射到派发确认
  botCreation?: { botId: BotId; status: "available" | "undone" | "changed" | "used" | "removed" } // Agent 创建回执
}

interface Card {
  id: string
  prompt: string
  options: Array<{ id: string; label: string; op?: Op }>   // clarify 的选项绑定完整 Op
  multiSelect: boolean
  allowFreeText: boolean
  requestId?: RequestId      // question-card 对应的 SessionRequest
  state: "open" | "answered" | "expired"
}
```

## 3. Op（决策树输出）

```ts
type Op =
  | { op: "new";      botId: BotId; requestMessageIds: MessageId[] }
  | { op: "new-trigger"; triggerId: TriggerId; runId: TriggerRunId;
      occurrenceKey: string; scheduledAt: Timestamp; botId: BotId;
      prompt: string; payload: JsonValue }
  | { op: "ask";      taskId: TaskId; mode: "fast" | "deep"; messageId: MessageId }
  | { op: "send";     taskId: TaskId; delivery: "immediate" | "queue" | "steer" | "restart"; messageIds: MessageId[] }
  | { op: "control";  taskId: TaskId; action: ControlAction }
  | { op: "answer";   requestId: RequestId; answer: QuestionAnswer }
  | { op: "clarify";  card: Card }
  | { op: "escalate"; reason: string; decisionLogId: string; messageIds: MessageId[] }

type ControlAction = "cancel" | "retry" | "resume" | "archive"
```
- `send.delivery = "immediate"` 仅用于目标空闲；目标运行中时必须是 `queue | steer | restart`。
- `steer` 在 adapter 不支持（或返回 `refused`）时降级为 `queue`，并在决策日志中记录降级。

## 4. Task

```ts
interface Task {
  id: TaskId
  botId: BotId
  title: string               // 初始取自首条请求（截断），可由首个回包更新
  status: TaskStatus
  createdAt: Timestamp; updatedAt: Timestamp; lastActivityAt: Timestamp
  session: { instanceId: string; cursor?: ResumeCursor }
  pendingRequestIds: RequestId[]
  lastReport?: { full: string; delivered: string; rewrites: number }
  queue: Array<{ messageIds: MessageId[]; queuedAt: Timestamp }>
  origin: { kind: "user" | "trigger"; decisionLogId?: string } | { kind: "coordination"; decisionLogId: string }
}

type TaskStatus =
  | "created" | "running" | "waiting_user" | "reporting" | "idle"
  | "failed" | "interrupted" | "cancelled" | "archived"

interface Trigger {
  id: TriggerId
  name: string
  enabled: boolean
  botId: BotId
  prompt: string
  payload: JsonValue
  schedule: TriggerSchedule
  overlap: "skip"
  createdAt: Timestamp
  updatedAt: Timestamp
  nextAt?: Timestamp
}

type TriggerSchedule =
  | { kind: "once"; at: Timestamp }
  | { kind: "interval"; startAt: Timestamp; everyMs: number }
  | { kind: "daily"; at: string; timeZone?: string }
  | { kind: "cron"; expression: string; timeZone?: string }

interface TriggerRun {
  id: TriggerRunId
  triggerId: TriggerId
  occurrenceKey: string
  scheduledAt: Timestamp
  status: "queued" | "running" | "ran" | "failed" | "missed" | "skipped"
  taskId?: TaskId
  startedAt?: Timestamp
  finishedAt?: Timestamp
  error?: string
}
```

**合法转移表**（实现必须表驱动，非法转移是 bug）：

| from \ 事件 | turn.started | request.opened(question) | request answered | turn.completed(ok=true) | gate done | turn.failed | daemon restart | cancel | retry | resume | archive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| created | running | | | | | failed | interrupted | cancelled | | | |
| running | | waiting_user | | reporting | | failed | interrupted | cancelled | | | |
| waiting_user | | waiting_user | waiting_user / running¹ | reporting | | failed | interrupted | cancelled | | | |
| reporting | | | | | idle | | interrupted | cancelled | | | |
| idle | running | | | | | | | cancelled | | | archived |
| failed | | | | | | | | cancelled | running | | archived |
| interrupted | | | | | | | | cancelled | | running | archived |
| cancelled | | | | | | | | | | | archived |

（`idle → running` 由 `send` 触发的新回合引起。`waiting_user` 下回合结束时，未答问题的卡片置为 `expired`，后续回答按 `send` 处理。）

¹ `request answered` 的转移以移除已回答 request 后的 `pendingRequestIds` 为依据：仍有待答项则保持 `waiting_user`，为空才转 `running`。实现将这两个条件定义为转移表中的互斥规则，禁止无条件在第一次回答时转为 `running`。`waiting_user` 表示存在未答问题；非阻塞提问的 worker 可继续工作（ADR-0015）。

中断结束按 ADR-0017 沿用 OpenMausBot 的调度顺序，并使用以下表驱动规则：

| 当前状态 | 当前回合的结束结果与已记录意图 | 目标状态 |
|---|---|---|
| running / waiting_user | turn.completed(ok=false, stopReason=interrupted)，已有 restart 投递 | idle |
| running / waiting_user | turn.completed(ok=false, stopReason=interrupted)，无 restart | interrupted |

restart 先持久排队再停止；旧回合清理完成后才允许排出队列，新回合用 `turn.started` 转为 `running`。
cancel 先持久化 `cancelled` 并撤销回合所有权，再请求中断；旧 turn ID/执行代次的通知只审计，不再驱动状态机，不能覆盖新回合。
retry/resume 等启动动作与相应 `turn.started` 确认只执行一次领域转移。

## 5. SessionRequest

```ts
interface SessionRequest {
  id: RequestId
  taskId: TaskId
  kind: "permission" | "question"
  openedAt: Timestamp
  questions: Array<{
    id: string
    text: string
    options?: Array<{ id: string; label: string; description?: string }>
    multiSelect: boolean
    allowFreeText: boolean
  }>
  permission?: { tool: string; summary: string }   // kind = permission 时
  raw: unknown                                      // harness 原始请求，用于调试与回放
}

interface QuestionAnswer {
  perQuestion: Array<{ questionId: string; optionIds?: string[]; text?: string }>
}
```
本地单请求详情只对确认投递的原生问题返回 `deliveredAnswer?: QuestionAnswer`；此投影不产生 Action，不用于再次提交（ADR-0041）。

adapter 负责把 `QuestionAnswer` 翻译回原生格式（见 `harness-adapters.md`），上层不感知差异。
同一 request 内多道 questions 一次整组提交；同一 task 的多个 request 独立回答。原生阻塞性由 adapter 保留，不把异步提问强制变为阻塞。回填与回合结束必须串行处理，避免重复投递。
能力不足时（如只支持单问题/无自由文本），UI 依据 `capabilities.questions` 降级展示。

## 6. HarnessAdapter

```ts
interface HarnessAdapter {
  readonly kind: string                       // "codex" | "claude" | "acp:<agent>"
  readonly capabilities: AdapterCapabilities
  startSession(input: StartSessionInput): Effect<SessionHandle, AdapterError, Scope>
  resumeSession(cursor: ResumeCursor, input: StartSessionInput): Effect<SessionHandle, AdapterError, Scope>
}

interface AdapterCapabilities {
  resume: boolean
  fork: boolean                      // 原生 fork（不污染原 session）
  steer: boolean                     // 运行中插入消息
  nativeFullAccess: boolean          // 有原生"全放行"模式；否则由 adapter 自动回复 permission
  questions: { native: boolean; multiQuestion: boolean; multiSelect: boolean; freeText: boolean }
  transcript: boolean                // 能导出 transcript（无 fork 时 ask/rewrite 的降级依赖它）
}

interface StartSessionInput {
  taskId: TaskId                    // 临时 fork 沿用源 task ID
  bot: BotConfig
  model: string; effort?: string
  cwd: string
  instructions: string               // bot soul + aut 固定指令（模板）
  mcpServers: McpServerConfig[]      // 包含 aut McpBridge，以及当前 Bot 已授权的 MCP proxy
}

interface SessionHandle {
  readonly cursor: ResumeCursor
  readonly events: Stream<SessionEvent>
  startTurn(input: TurnInput): Effect<void, AdapterError>
  steer(input: TurnInput): Effect<"steered" | "refused" | "indeterminate", AdapterError>
  interrupt(): Effect<void, AdapterError>
  respond(requestId: RequestId, response: { allow: true } | QuestionAnswer): Effect<void, AdapterError>
  fork(): Effect<SessionHandle, AdapterError, Scope>           // capabilities.fork 为 false 时返回 NotSupported
  transcript(): Effect<ReadonlyArray<TranscriptEntry>, AdapterError>
}

type SessionEvent =
  | { kind: "turn.started"; turnId: string }
  | { kind: "message.delta"; turnId: string; text: string }        // 仅用于任务面板实时展示
  | { kind: "session.changed"; turnId: string; itemId?: string } // 只读快照失效，不能驱动状态转移
  | { kind: "turn.completed"; turnId: string; ok: true; finalReport: string }
  | { kind: "turn.completed"; turnId: string; ok: false; stopReason: "interrupted" }
  | { kind: "turn.failed"; turnId: string; error: string }
  | { kind: "request.opened"; request: SessionRequest }
  | { kind: "request.closed"; requestId: RequestId; reason: "answered" | "turn-ended" | "cancelled" }
  | { kind: "cursor.updated"; cursor: ResumeCursor }
  | { kind: "process.exited"; code: number | null }
```
- `permission` 请求在 adapter 内部可直接自动放行，但仍要发出 `request.opened/closed` 事件供审计。
- **`question` 请求 adapter 永远不得自动回答。**
- `turn.completed` 是统一结束通知，只有 `ok:true` 才进入 ReplyGate；中断结束不得带 finalReport。
  回合终止先关闭其未答请求，再发布一次结束通知；参考 ADR-0017，进程本身保持常驻。

### 6.1 完整会话只读快照（ADR-0035）

`AdapterCapabilities.sessionHistory?: boolean` 声明完整会话读取能力。可选的
`HarnessAdapter.readSession(cursor): Effect<SessionHistory, AdapterError, Scope>` 用于无 worker 时的只读读取，
`SessionHandle.readSession(): Effect<SessionHistory, AdapterError>` 用于现有 worker；不得启动回合或改变业务状态。

```ts
type SessionItemStatus = "running" | "completed" | "failed" | "interrupted" | "unknown"
interface SessionItem {
  id: string
  kind: "user" | "assistant" | "tool" | "note"
  status: SessionItemStatus
  text: string
  startedAt?: Timestamp; completedAt?: Timestamp
  phase?: "commentary" | "final"
  tool?: { name: string; input: string; output: string; exitCode?: number }
}
interface SessionTurn {
  id: string; status: SessionItemStatus
  startedAt?: Timestamp; completedAt?: Timestamp
  error?: string
  items: SessionItem[]
}
interface SessionHistory { turns: SessionTurn[] }
```

`GET /v1/tasks/:id/session?before=<turnId>&limit=<1..20>` 默认最新 10 轮，页内按原生顺序排列。
返回 `{ task, history, availability, message?, hasEarlier, nextBefore? }`；availability 为
`available | pending | unsupported | unavailable`。任务不存在或游标不存在返回 404。
所有 ID 在一次 session 中稳定，时间统一为毫秒。原生执行中快照与实时 item 按 ID 合并，
终态完整输出覆盖增量拼接；`session.changed` 只触发回读，不能充当完整历史项。

## 7. Classifier

```ts
interface Classifier {
  readonly backend: string           // "jev" | 未来 "litellm" 等
  readonly model: string             // 必须是固定版本，如 "jev-1.13.0"，禁止 "latest"
  decide(req: DecisionRequest): Effect<DecisionResponse, ClassifierError>
}

interface DecisionRequest {
  state: Record<string, unknown> | string
  questions: Record<string,
    | { type: "choice"; instructions: string; criteria: Record<string, string> }
    | { type: "noul";   instructions: string }
    | { type: "score";  instructions: string; criteria: string[] }>
}

interface DecisionResponse {
  answers: Record<string,
    | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
    | { type: "noul";   noul: number }
    | { type: "score";  score: number; probabilities?: Record<string, number> }>
  latencyMs: number
  usage?: { inputTokens: number; cost?: number }
}
```
score.probabilities 保留厂商的完整层级分布；Jev 必填，其他 backend 可省略。legend 由该次请求的 criteria 下标还原。
形态对齐 Jev 的 System One / OpenRouter Decisions API。choice.confidence 是所选项概率（等于 probabilities[choice]），不是厂商返回的分布集中度；按 ADR-0019 映射。后端由用户在设置中配置；未配置时决策树按 `decision-tree.md` §4 降级。

## 8. 交接包

```ts
interface HandoffPacket {
  header: string                     // 模板
  request: Array<{ messageId: MessageId; at: Timestamp; text: string }>
  excerpts: Array<{ messageId: MessageId; at: Timestamp; author: string; text: string; relevance?: number }>
  relatedTasks: Array<{ taskId: TaskId; bot: string; status: TaskStatus; title: string }>
  toolHint: string                   // 模板：说明 read_main_thread / list_tasks / get_task 的用法
  decisionSummary?: string           // 仅 escalate：为什么下沉（由决策日志模板化生成）
}
```
渲染为纯文本后作为new/send回合的输入。渲染模板放在 `packages/core`，有快照测试。
relevance仅在真实分类结果存在时填写；分类失败的最近2条降级不伪造概率（ADR-0029）。
默认2000预算仅约束相关片段及其渲染metadata；用户原话保持完整，以UTF-8字节数保守估算token上界。

## 9. DecisionLog

```ts
interface DecisionLog {
  id: string
  at: Timestamp
  tree: "inbound" | "reply-gate" | "request" | "handoff-prune"
  treeVersion: string
  input: { eventRef: string; state: unknown; dynamicOptions: Record<string, Record<string, string>> }
  classifierCalls: Array<{ backend: string; model: string; request: DecisionRequest; response?: DecisionResponse; error?: string; latencyMs: number }>
  path: string[]                     // 经过的节点 ID
  output?: Op | { gate: "deliver" | "rewrite" | "truncate" } | { request: "allow" | "relay" } | { excerpts: MessageId[] } // 缺失仅允许 execution.ok=false
  execution: { ok: boolean; error?: string; degraded?: string[] }   // 如 steer→queue
  correction?: { at: Timestamp; kind: "clarify-none" | "undo" | "reroute" | "manual"; detail?: string; decisionLogId?: string }
}
```

## 10. aut McpBridge 工具（提供给 agent）

| 工具 | 可用于 | 输入 | 输出 |
|---|---|---|---|
| `read_main_thread` | 所有 bot | `{ ids?: MessageId[]; before?: MessageId; limit?: number (≤50) }` | 消息列表（作者、时间、文本、关联 taskId、原报告来源 sources） |
| `list_tasks` | 所有 bot | `{ status?: TaskStatus[]; botId?: BotId; limit?: number }` | task 摘要列表 |
| `get_task` | 所有 bot | `{ taskId }` | task 详情 + 最近一次完整报告 |
| `create_bot` | 工作会话与主助手协调会话 | `CreateBotInput` | `{ id: BotId; name: string }` |
| `mcp_info` | 所有合法 bot | `{ serverId?: McpServerId }` | `{ servers: McpServerSummary[], grants: McpGrant[], bots: {id,name}[] }`；摘要无连接参数和凭据 |
| `mcp_server` | 仅主助手 | 按 `action` 区分 create/update/test/enable/disable/restart/remove/grant；create/update 使用当前 `McpServerInput`，grant 显式指定 botId/enabled/allowedTools | `{ serverId, action }`，随后用 mcp_info 读取状态 |
| `propose_route` | 仅主助手的协调会话 | `{ op: Op（除 clarify/escalate 外）; rationale: string }` | `{ accepted: boolean; result?: string; rejectReason?: string }` |


- `propose_route` 提交的 Op 由 chief 用与决策树产出相同的执行器执行，并写一条 `DecisionLog`（`path` 以 `slow-brain` 开头）。
- MVP 使用 Codex 原生提问通道，问题与回答通过 `SessionRequest` 登记。
- 查询工具读取 Store。建 Bot 工具通过 daemon 配置服务保存普通 Bot。任务变更由 chief 登记，见 [ADR-0045](decisions/0045-bot-creation-and-dispatch-corrections.md)。
- ADR-0024：stdio MCP 通过0600权限的本地 Unix socket访问daemon，令牌绑定会话bot/task身份；
  身份不由工具参数指定。每次请求重新授权，propose_route同时受工具可见性与调用权限限制。
  MCP的structuredContent包装为 `{ result: 工具输出 }`，text content保留原工具输出JSON。


## 11. 基础类型、配置与补充接口（ADR-0016）

以下字段为规范；对象默认只编码已定义字段。`JsonValue` 为 null / boolean / string / 有限 number /
递归数组 / 字符串键对象，禁止非 JSON 值。所有协议中的 `unknown`（包括 raw/state/payload）实现为此 Schema。

```ts
type TaskId = string & Brand<"TaskId">       // 非空，其他 ID 同理
type MessageId = string & Brand<"MessageId">
type RequestId = string & Brand<"RequestId">
type BotId = string & Brand<"BotId">
type Timestamp = number                    // 非负安全整数，Unix epoch 毫秒
interface ResumeCursor { kind: string; data: JsonValue }
interface TurnInput { text: string; messageIds: MessageId[] }
interface TranscriptEntry {
  role: "user" | "assistant" | "tool" | "system"
  text: string
  at?: Timestamp
  turnId?: string
}
type McpServerConfig =
  | { name: string; transport: "stdio"; command: string; args: string[]; cwd?: string; env?: Record<string, string> }
  | { name: string; transport: "http" | "sse"; url: string; headers?: Record<string, string> }
interface McpTool { name: string; description?: string; inputSchema?: JsonValue }
interface McpServerBase {
  id: McpServerId; name: string; enabled: boolean
  auth: { status: "none" | "required" | "authenticated" | "error"; message?: string; updatedAt?: Timestamp }
  health: { status: "unknown" | "ready" | "error"; message?: string; checkedAt?: Timestamp }
  tools: McpTool[]
}
type McpServer =
  | (McpServerBase & { transport: "stdio"; command: string; args: string[]; cwd?: string; env?: Record<string, string> })
  | (McpServerBase & { transport: "http" | "sse"; url: string; headers?: Record<string, string>; oauth?: { clientId?: string; clientSecretRef?: string } })
interface McpGrant { botId: BotId; serverId: McpServerId; enabled: boolean; allowedTools: string[] }
interface McpConfig { schemaVersion: 1; servers: McpServer[]; grants: McpGrant[] }
interface BotConfig {
  id: BotId; name: string; description: string; soul: string
  characterId?: string  // 可选的稳定形象 ID
  modelSelection: { instanceId: string; model: string; effort?: string }
  cwd: string
  system?: "primary"  // 仅内置主助手设置此字段
}
interface HarnessInstanceConfig {
  id: string; name: string; kind: string; command: string; args: string[]
  env?: Record<string, string>
  authMethodIds?: string[]  // ACP initialize 返回的认证方式，按优先级排列
}
interface ClassifierBackendConfig {
  backend: string; model: string; endpoint: string; apiKeyRef?: string
}
interface AutConfig {
  harnessInstances: HarnessInstanceConfig[]
  classifier?: { primary: ClassifierBackendConfig; fallback?: ClassifierBackendConfig }
}
type BotsConfig = BotConfig[]
```

- bots 与 harnessInstances 的 ID 唯一；主助手标记 `primary` 至多出现一次。
- `characterId` 是可选非空字符串。后端透传 ID，客户端按已安装的形象目录解析。回退与动作契约见 [ADR-0053](decisions/0053-bot-character-module.md)。
- MCP server 不属于 `BotConfig`。全局注册表和 grant 保存在 `mcp.json`，任务启动时由 daemon 按 Bot 授权生成受限 proxy 配置。
- 名称、命令、路径、实例标识、游标 kind、模型与密钥引用为非空字符串；文本和 soul 可为空。
- URL/endpoint 只允许 http(s) 的绝对地址。classifier model 不得含 `latest` 别名。
- `TurnInput.messageIds` 可为空，支持内部改写/询问；普通用户请求仍保留引用。
- `QuestionAnswer.perQuestion` 非空且 questionId 唯一，每题至少有非空 optionIds 或非空 text；
  必须覆盖 request 全组的问题及选项是否合法，由拥有该 request 的服务校验。
- `SessionRequest` 的 question 分支须至少有一道问题；permission 分支须带 permission 字段，questions 为空。
- 概率和 relevance 在 [0,1]；时长/费用非负有限；计数为非负安全整数；score 只要求有限。
- `AutEvent` 的 session 分支外层 kind 必须与 event.kind 相同。
- `AdapterError` 与 `ClassifierError` 为 `Data.TaggedError`，字段 `{ code, message, detail?: JsonValue }`。
  Adapter code：`NotSupported | ProcessExited | TransportError | ProtocolError | InvalidResponse | RequestExpired | InvalidAnswer | DeliveryIndeterminate`；
  Classifier code：`NotConfigured | Timeout | RateLimited | TransportError | InvalidResponse`。
  `RequestExpired` 仅表示确认未投递的过期请求；传输结果未知用 `DeliveryIndeterminate`，不能据此自动重投 send。
  Service 的 `Context.Tag` 放在 adapter/classifier 包的 `/interface`，协议包只提供接口类型与错误类型。

### 11.1 MCP 精确输出

```ts
interface MainThreadExcerpt { id: MessageId; at: Timestamp; author: MainThreadMessage["author"]; text: string; taskId?: TaskId }
interface TaskSummary {
  id: TaskId; botId: BotId; title: string; status: TaskStatus
  createdAt: Timestamp; updatedAt: Timestamp; lastActivityAt: Timestamp
  pendingRequestIds: RequestId[]
}
type ReadMainThreadOutput = MainThreadExcerpt[]
type ListTasksOutput = TaskSummary[]
type GetTaskOutput = Task
type CreateBotInput = Pick<BotConfig, "id" | "name" | "description" | "soul" | "characterId">
  & Partial<Pick<BotConfig, "modelSelection" | "cwd">>
type CreateBotOutput = Pick<BotConfig, "id" | "name">
type CreateTriggerInput = {
  id?: TriggerId
  name: string; botId: BotId; prompt: string; payload?: JsonValue
  schedule: TriggerSchedule; enabled?: boolean
}
type CreateTriggerOutput = Trigger
type GetTriggerInput = { triggerId: TriggerId }
type GetTriggerOutput = Trigger
type ListTriggersInput = { botId?: BotId; enabled?: boolean; limit?: number }
type ListTriggersOutput = Trigger[]
type ListTriggerRunsInput = { triggerId: TriggerId; limit?: number }
type ListTriggerRunsOutput = TriggerRun[]
type UpdateTriggerToolInput = { triggerId: TriggerId; update: UpdateTriggerInput }
type UpdateTriggerOutput = Trigger
type ProposeRouteInput = { op: Exclude<Op, { op: "clarify" | "escalate" }>; rationale: string }
type ProposeRouteOutput = { accepted: boolean; result?: string; rejectReason?: string }
type AskUserInput = { questions: SessionRequest["questions"] }
type AskUserOutput = string
```

`read_main_thread.limit` 为 1–50 整数；`list_tasks.limit` 为正安全整数。
`ids` 若提供则为1–50个唯一ID，与before/limit互斥；分页默认50、limit最多50，list_tasks同样适用。
ask_user 的 questions 非空且 questionId 唯一，MVP不注册该工具。

## 12. 决策树配置数据格式（ADR-0016）

ADR-0022 补充：DecisionLog.output 在 execution.ok=false 时可缺，用于记录尚未生成输出的解释失败；
成功执行必须有 output。执行登记后更新 execution 时必须保留已有 correction。

```ts
interface TreeConfig {
  name: "inbound" | "reply-gate" | "request" | "handoff-prune"
  version: string
  entry: string
  thresholds: Record<string, number> // 有限数，概率/数量等阈值统一在此
  nodes: Record<string, TreeNode>
}
type Expr =
  | { kind: "literal"; value: JsonValue }
  | { kind: "ref"; path: string[] } // 根只能为 state / answers / vars / thresholds
  | { kind: "object"; fields: Record<string, Expr> }
  | { kind: "array"; items: Expr[] }
  | { kind: "get"; from: Expr; key: Expr }
  | { kind: "map"; from: Expr; as: string; value: Expr } // 临时绑定在 vars[as]
  | { kind: "entries"; from: Expr } // object → [{key, value}]
  | { kind: "record"; from: Expr; as: string; indexAs?: string; key: Expr; value: Expr }
  | { kind: "filter"; from: Expr; as: string; where: Predicate }
  | { kind: "choose"; when: Predicate; then: Expr; else: Expr } // 只求值命中分支
  | { kind: "take"; from: Expr; count: Expr }
  | { kind: "budget"; from: Expr; by: string[]; limit: Expr } // 按顺序贪心保留成本可容纳项
  | { kind: "sort"; from: Expr; by: string[]; direction: "asc" | "desc" }
  | { kind: "concat"; items: Expr[] }
  | { kind: "length"; value: Expr }
  | { kind: "template"; text: string; values: Record<string, Expr> } // 命名占位符 {name}
type Predicate =
  | { kind: "exists"; value: Expr }
  | { kind: "compare"; op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; left: Expr; right: Expr }
  | { kind: "all" | "any"; predicates: Predicate[] }
  | { kind: "not"; predicate: Predicate }
interface QuestionBinding {
  id: Expr
  question:
    | { type: "choice"; instructions: string; criteria: Expr }
    | { type: "noul"; instructions: string }
    | { type: "score"; instructions: string; criteria: Expr }
  when?: Predicate
  repeat?: { from: Expr; as: string }
}
type TreeNode =
  | { type: "rule"; when: Predicate; then: string; else: string }
  | { type: "branch"; cases: Array<{ when: Predicate; next: string }>; otherwise: string }
  | { type: "classify"; state: Expr; questions: QuestionBinding[]; next: string; onError: string }
  | { type: "action"; output: Expr }
  | { type: "slow"; reason: Expr; messageIds: Expr }
  | { type: "rewrite"; instructions: string; next: string; onError: string }
```

- 所有 ID、节点名、绑定名非空。路径与动态 lookup 只读自身属性，不允许 `__proto__`、`prototype`、`constructor`。
- Schema 静态检查 entry、全部边、thresholds 引用；不接受指向不存在字段的 threshold 引用。
- branch 按 cases 顺序首次命中；classify 展开 when/repeat 后的所有问题只发一次请求，结果放 answers。
  动态 criteria 使用 state 的预计算候选描述；question ID 展开后不得重复，request/response 都须验证。
- action 结果必须通过 `DecisionOutput` Schema，且不得输出 escalate；slow 生成 escalate 并绑定当前日志 ID。
  inbound 输出 Op；reply-gate 输出 gate；request 输出 allow/relay；handoff-prune 输出 excerpts。
- slow 仅用于 inbound；rewrite 仅用于 reply-gate，调用 fork/临时 session 后更新当前报告再进入 next。
  rewrite 的 instructions 是确定性模板，不是可执行代码；失败进入 onError。
- Expr 只做固定类型的数据变换，不支持函数调用或计算脚本；排序稳定，同值保留输入顺序。
  entries/record/filter/choose 见 ADR-0022；record 可通过 indexAs 绑定当前元素的零基位置，键必须唯一并通过 SafeKey 校验。lookup 缺失返回 null，
  exists 对 null 为 false，其他类型不合法时返回类型化错误。表达式嵌套最多100层。
  所有概率阈值必须从 thresholds 读取，不写入执行器代码。
- 执行器必须限制总步骤预算（默认 1000）并执行最多两次 rewrite；预算耗尽作为类型化失败记入决策日志。
  Schema 不替代运行时预算。schema 阶段不改变 §6–§9 v1 树分支和阈值。
