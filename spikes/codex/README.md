# Codex P0 协议探针

2026-11-16 在 macOS 上实测 **codex-cli 0.167.0 / gpt-6.1-sol / openai**。CLI、模型、Provider 均沿用现有配置；没有修改用户 `config.toml`、登录或 Provider。每个进程使用新建的系统临时工作目录，普通测试只输出固定标记；steer/interrupt/async 测试只执行无副作用的 `sleep`。

本目录是开发探针，不进入生产构建。`probe.ts` 直接操作第三方 CLI 的 stdio 边界，使用 Node 原生子进程、Promise 和超时；生产 adapter 必须遵守 Effect/Schema/Scope 约定，不能把本脚本当生产实现搬入。

## 结论

| 能力 | 结论与证据 |
|---|---|
| 原生全放行 | 每次 thread start/resume/fork 都传 `approvalPolicy:"never"`、`approvalsReviewer:"user"`、`sandbox:"danger-full-access"`；每次 turn 传 `sandboxPolicy:{type:"dangerFullAccess"}`。shell 实测执行成功。 |
| 同步提问 | Plan 模式原生 `item/tool/requestUserInput` 带 `isBlocking:true`；两题同批，原 JSON-RPC ID 回填，模型收到答案。 |
| 默认模式同步提问 | 未启用 feature 的基线按精确提示返回 `TOOL_UNAVAILABLE`；子进程启用 `default_mode_request_user_input` 后发同名请求，`isBlocking:false`。基线结果不泛化为所有模型都不可用。 |
| 异步提问 | 默认模式即可发 `agentMessage.delivery:"async"` 和 `questions`，无需 server request；`turn/steer` 回填成功。未答时启动了 shell，证实不挂起独立工作。`send_message_to_user_async` flag 不是本次成功的必要条件。 |
| 多问题 / 自由文本 | 两题同批得到 `Blue` / `Circle`；`plan-free` 填非选项文本 `Teal fixture text`，模型原样收到。 |
| 多选 | 保守声明不支持。当前 CLI 导出的 question 类型无多选字段；不能仅凭答案类型是数组宣称支持。 |
| 进程与提问 | 同步问题保留 5 秒，进程仍在，未自动空答；随后通过原通道回填成功。5 秒是测试等待，不是产品问答超时。 |
| finalReport | 成功 `turn/completed` 中最后一个 `agentMessage`，要求 `phase:"final_answer"` 且 `delivery != "async"`。async 问题本身也可能是 `final_answer`！中断/失败不能当成功回包；中断前的 commentary 也不能回包。 |
| steer | 运行中传 `expectedTurnId`，同一回合消费新消息并输出新标记；空闲明确返回 `-32600: no active turn to steer`。 |
| interrupt | 返回成功后收到 `turn/completed`、`status:"interrupted"`。 |
| resume | 同进程恢复成功；退出原 app-server 后，新进程恢复同一持久 thread 并完成新回合。 |
| fork | 原生 `thread/fork` 产生新 thread；fork 继承两个父回合，追加第三回合后，重新读父 thread 仍只有两个回合。 |
| transcript | `thread/read({includeTurns:true})` 返回所有回合及 items；本轮不需要读取本地会话文件。CLI 推荐的分页 API 只查看了类型，尚未实测。 |

能力事实同步在 `docs/harness-adapters.md`。非阻塞问题的任务状态语义见已接受的 `docs/decisions/0015-question-waiting-semantics.md`；探针没有替产品选择默认 collaboration mode，更没有强制所有 worker 进入 Plan。

## 复现

要求 Node 24 LTS、可运行且已登录的 `codex`。在仓库根目录运行（每次使用新输出文件，脚本拒绝覆盖已有证据）：

```sh
rtk proxy node spikes/codex/probe.ts normal /tmp/aut-normal-new.jsonl
rtk proxy node spikes/codex/probe.ts plan /tmp/aut-plan-new.jsonl
rtk proxy node spikes/codex/probe.ts default /tmp/aut-default-new.jsonl
rtk proxy node spikes/codex/probe.ts default-enabled /tmp/aut-default-enabled-new.jsonl
rtk proxy node spikes/codex/probe.ts default-delayed /tmp/aut-default-delayed-new.jsonl
rtk proxy node spikes/codex/probe.ts plan-free /tmp/aut-plan-free-new.jsonl
rtk proxy node spikes/codex/probe.ts async /tmp/aut-async-new.jsonl
rtk proxy node spikes/codex/probe.ts async-enabled /tmp/aut-async-enabled-new.jsonl
rtk proxy node spikes/codex/probe.ts async-delayed /tmp/aut-async-delayed-new.jsonl
rtk proxy env AUT_CODEX_RESUME_FIXTURE=/tmp/aut-normal-new.jsonl node spikes/codex/probe.ts resume-persisted /tmp/aut-resume-new.jsonl
```

`AUT_CODEX_BIN` 可指定 CLI 二进制。`resume-persisted` 从 `AUT_CODEX_RESUME_FIXTURE` 指定的 normal 样本读取探针 thread ID，省略时使用本仓库 `fixtures/normal.jsonl`；换机器时按上例先录制自己的 normal 样本，再显式指定它，原始 fixtures 无需删除。也可使用下一节的离线回放，不要恢复用户已有对话。真实回合使用当前账号额度。

`probe.ts` 只为规定的合成题 ID、题目文本、对应 thread/turn 回填预设 fixture 答案；异步题额外检查选项列表。遇到意外问题立即记录并退出，不返回 `Blue`、空答案或批准。此白名单仅用于测试，不是生产 question 策略。每个 RPC 和事件等待均有 90 秒探针超时；退出/解析/管道失败会终止挂起等待；结束先 SIGTERM，5 秒未退再 SIGKILL，并等待进程退出。

## Fixtures 与离线回放

`fixtures/*.jsonl` 的每行是 `{at,direction,payload}`：

- `meta`：CLI 版本、参数、场景、临时目录与时间。
- `send` / `receive`：实际 JSON-RPC 对象，保留原字段、ID 与值，未以 mock 替代。
- `stderr` / `exit`：真实进程输出/退出；`probe`：探针自身断言所需的注释，不是 CLI 事件。

原有 10 份 0.167.0 样本均完成；另补 1 份 0.169.0 Plan 阻塞样本，见下文。CLI 临时目录与 session 文件路径属于真实证据。未录制配置文件、认证 token 或用户已有对话。旧样本对应早期脚本版本，后续加固仅收紧合成题校验和超时，不改写原始收发。

```sh
rtk proxy node --test spikes/codex/verify.test.ts
```

23 个回放测试通过，覆盖版本与 RPC 完整性、全放行、finalReport 边界、fork 隔离、空闲 steer 拒绝、同步/异步提问、5 秒存活、自由文本、新进程 resume，以及 0.169.0 真正阻塞模式的原通道回填。此验证不调用模型。生产 adapter 的回放测试复用这些样本，见下节。

协议字段先用当前二进制导出核对：

```sh
rtk proxy codex app-server generate-ts --experimental --out /tmp/aut-codex-protocol
```

核对了 `ThreadStartParams`、`ThreadResumeParams`、`ThreadForkParams`、`ThreadReadParams`、`TurnStartParams`、`TurnSteerParams`、`ToolRequestUserInputParams`、`ToolRequestUserInputQuestion`、`AsyncUserInputQuestion`、`ThreadItem`；没有把生成文件复制进生产代码。官方接口背景：[Codex App Server](https://learn.chatgpt.com/docs/app-server)，本项目能力结论以此目录的真实样本为准。


## MVP07 生产 adapter 验证

实现位于 `packages/adapters/src/codex/`，导出 `makeCodexAdapter` 与 `CodexAdapterLive`。每个 session 的 app-server 绑定调用者 Scope，回合结束后保持存活；fork 使用自己的子进程与 Scope。获取失败立即清理，正常退出先 SIGTERM，2 秒未退升级 SIGKILL，并等待退出确认。reader 与退出等待显式允许中断，避免 Effect finalizer 的中断屏蔽导致超时失效。消费 `events` 时先订阅，再调用 `startTurn`。

原生默认模式仅为子进程启用 `default_mode_request_user_input`，不强制 Plan。模型、effort、工作目录、开发指令与 MCP 配置按接口传入，Provider 沿用用户现有配置；不写全局配置。`item/permissions/requestApproval` 只回填实际请求的权限，排除 null grant；未知或结构错误的原生请求明确拒绝。permission 开关事件留作审计，question 只在上层明确调用 `respond` 后回填。

同步回答保留原 JSON-RPC ID；异步回答使用绑定原 turn 的 `turn/steer`。整组题目、选项及自由文本先校验；不确定投递记录提交状态，禁止重复发送。CLI 的 `serverRequest/resolved` 与回合结束会关闭问题，迟到答案返回 `RequestExpired`。`turn/start` 的不确定结果或调用中断会关闭该 session，防止重复工作。中断按 ADR-0017 回传 `ok:false/stopReason:interrupted`，无成功报告。

```sh
rtk proxy pnpm --filter @aut/adapters build
rtk proxy pnpm exec vitest run packages/adapters/src/codex
rtk proxy node spikes/codex/adapter-live.ts
rtk proxy node spikes/codex/adapter-mcp-live.ts
```

离线/本地测试 **45 项通过**：10 份原始样本经过生产 Schema 与 adapter 回放，整组问题/自由文本校验，过期与重复请求，异步和同步答案不确定投递，中断/失败，权限审计，非法 JSON-RPC，RPC 超时，获取失败清理，空闲 Scope 退出及忽略 SIGTERM 后升级 SIGKILL。

真实 CLI 结果保存在 `results/adapter-live-0.167.0-lifecycle.json`：原生提问→严格白名单固定答案→完成；fork 独立关闭、父会话继续且 transcript 无污染；运行中 steer；native interrupt；跨进程 resume；三个子进程均确认结束。初次 8 项运行也保留在 `results/adapter-live-0.167.0.json`。`results/adapter-mcp-0.167.0.json` 验证按 thread 注入的本地 stdio MCP server 能被 CLI 发现，不调用模型；`results/adapter-mcp-dotted-name-0.167.0.json` 进一步验证带点名称必须使用嵌套 MCP 表而非 dotted key；最终实现读取当前有效 MCP 配置后合并 bot 的额外服务（同名由 bot 覆盖），移除 CLI 序列化的 null 可选值，再使用嵌套表作为 thread 覆盖；空列表不设覆盖。`results/adapter-mcp-merge-0.167.0.json` 实测保留已有服务、同名覆盖、带点名称均通过；结果只记录合成服务的名称与工具名，未记录 config/read 响应或凭据。HTTP MCP 配置字段通过当前 CLI 类型核对并有映射测试，尚未连接真实 HTTP server。

CLI 更新为 **0.169.0** 后，`../e2e/questions-main-thread-live.ts` 在独立数据目录通过完整 daemon、本地 HTTP 主会话和真实 Jev 复验默认模式原生题组与异步题。
结果见 `../e2e/results/questions-main-thread-0.169.0.json`：原生 RPC 两题（`isBlocking:false`）及 async 通知一题均原通道确认 delivered，卡片 answered，任务最后 idle；异步题在用户答案发送前仍输出 `ASYNC_WORK_CONTINUES`，证明 waiting_user 没有强制暂停；Scope 关闭后两个 CLI 子进程均退出。
`fixtures/questions-0.169.0.json` 保存此次 `SessionRequest.raw` 的最小请求投影，不包含配置、密钥或完整 RPC 流；通知缺省 ID 在投影中为 null。对应 `current-questions.test.ts` 验证当前原生题组仍能解析，async 的 final_answer item 不会被误当作完成报告。旧 0.167.0 完整录制未改写。

同版本另外运行独立 `probe.ts plan-free`，完整协议记录在 `fixtures/plan-free-0.169.0.jsonl`。
实际模式为 Plan、`isBlocking:true`，题组挂起整 5 秒时 app-server 仍存活，未提前结束回合；随后通过原 JSON-RPC ID 回填非选项文本 `Teal fixture text` 和选项 `Circle`，得到精确报告 `TEST_ANSWER:Teal fixture text:Circle`，进程正常退出。
该补充只证明当前 CLI 的阻塞协议、自由文本与进程生命周期；它不是 aut 主会话的 Plan 模式切换功能。生产 adapter 仍采用默认模式，不强制 Plan，模型与 Provider 继续沿用当前 CLI 配置。

`adapter-live.ts` 只对单个精确 ID/题目/选项的合成问题提交 Blue。意外提问会直接失败并随 Scope 清理，生产代码没有自动回答逻辑。复跑默认生成新的临时结果文件；`AUT_CODEX_ADAPTER_RESULT` 可指定一个不存在的结果路径，`AUT_CODEX_MODEL` 可覆盖测试模型而不修改用户 Provider。

## SessionManager 联调

`session-manager-live.ts` 使用真实 Codex 与生产 SessionManager、HandoffBuilder、DecisionTree、ReplyGate，
Classifier 明确注入确定性测试实现。`results/session-manager-live-0.167.0.json` 记录 new→300 字合成报告→
原生 fork 改写→同 session send：253 个原生事件、6 条决策日志，原 session 无改写指令，两个 CLI 子进程均已退出。
探针的临时 setup 不挂 daemon Bridge；这不代表完整 daemon 链路已验收。详情见 `docs/session-manager.md`。

```sh
rtk proxy pnpm --filter @aut/core build
rtk proxy node spikes/codex/session-manager-live.ts
```

## MVP12 原生问题联调

`questions-live.ts` 使用真实 Codex、生产 SessionManager / QuestionsService / request 树 / handoff / 回包门槛；
Classifier 是显式确定性 fixture，SessionSetup 为临时目录的合成设置。`results/questions-live-0.167.0.json`
记录 JSON-RPC 原生同步两题和 async 单题分别完成建卡、waiting_user、登记后激活、原通道回填、原生成功报告与重复提交拒绝。
两个子进程 44518 / 44740 随 Scope 结束退出。未更改用户 Provider / 全局配置。

```sh
rtk proxy pnpm --filter @aut/core build
rtk proxy node spikes/codex/questions-live.ts
```

脚本仅对 `Which fixture color?`（Blue / Red）与同步模式的 `Which fixture shape?`（Circle / Square）
精确题组提交事先声明的合成测试答案，意外问题立即失败，不会给一般用户问题自动作答。
默认写临时目录新文件；可用 `AUT_QUESTIONS_RESULT` 指定不存在的结果路径。FakeAdapter 的 46 项 Manager 测试中，
15 项覆盖本阶段的原生整组、权限审计、非法/重复答案、迟答、取消/完成竞态和重启投递不确定性。

默认结果写入新建的系统临时目录；`AUT_SESSION_MANAGER_RESULT` 可指定不存在的输出路径。
测试只写临时 aut 数据目录，不读取用户 main thread，不改变用户 Provider 或全局配置。

## MVP13 回包门槛实测

`reply-gate-live.ts` 使用真实 Codex worker、隔离 fork 和 Jev 可读性节点。
`results/reply-gate-live-0.167.0.json` 记录 432 字的合成原报告经一次 fork 改写，
Jev noul=0.74 放行短回复；改写前后原 worker 的完整 transcript 严格相等，Scope 退出后无子进程。
该探针不会回答任何 question，结果中不含密钥。

```sh
rtk proxy pnpm --filter @aut/core build
rtk proxy node spikes/codex/reply-gate-live.ts
```

需要已有 `TYPESAFE_API_KEY`。默认结果写入新的临时目录；`AUT_GATE_RESULT` 可指定一个不存在的路径。
单元测试另覆盖 200 字符/120 词、0.6 边界、两次上限、临时 session、超时/退出/中断/空报告/额外提问、
分类器故障与截断提示长度；每次内部改写只操作自己的 Scope。

## ADR-0035 工作会话与工具过程（0.169.0）

新增三份未经虚构补齐的原始录制：`session-view-0.169.0.jsonl`（临时目录新增小文件、printf/sleep 工具、实时文本与两次历史读取）、
`session-mcp-0.169.0.jsonl`（临时本地 stdio echo 工具）、`session-read-0.169.0.jsonl`（独立进程冷读前述会话）。
均沿用已登录 CLI 与 Provider；没有全局配置写入、没有自动回答问题。

```sh
rtk proxy node spikes/codex/probe.ts session-view /tmp/aut-session-view-new.jsonl
rtk proxy node spikes/codex/probe.ts session-mcp /tmp/aut-session-mcp-new.jsonl
rtk proxy env AUT_CODEX_READ_FIXTURE=/tmp/aut-session-view-new.jsonl node spikes/codex/probe.ts session-read /tmp/aut-session-read-new.jsonl
rtk proxy node --test spikes/codex/session-view.test.ts
```

8 项事实验证覆盖稳定 item ID、command/file/MCP 结构、时间单位、冷读无 resume/turn，以及两个重要边界：
运行中 thread/read 可暂缺已 started 的工具，outputDelta 可缺首段；实时缓存须保留缺项，完成 aggregatedOutput 则权威替换。
当前冷读 `includeTurns:true` 仍完整返回，但 CLI 已提示在 paginated threads 上弃用，未来应另测 thread/turns/list 与 thread/items/list。
本次没有宣称验证大型历史分页。

`schemas/session-items-0.169.0.json` 来自当前 CLI 的本地 `app-server generate-json-schema --experimental`，
用于补充 webSearch、dynamicToolCall、collab 与图片工具的字段兼容。此文件是生成定义而非真实模型输出；
对应测试使用明确标注的 schema 示例，没有外发搜索或图片生成请求。原生顺序优先，缺时间戳不引发条目重排。

生产 adapter 冷读复验：`history-read-live.ts` 读取上述两个已存在的合成 thread，
`results/history-read-0.169.0.json` 记录请求仅为两组 initialize / thread/read，包含规范化工具结构，
子进程 19594 / 19678 均退出。没有 resume、startTurn 或 SessionSetup。
完整 MCP 结果保留后的最终复验见 `results/history-read-full-result-0.169.0.json`，
子进程 31492 / 31527 均退出，请求仍仅 initialize / thread/read。

```sh
rtk proxy pnpm --filter @aut/adapters build
rtk proxy env AUT_HISTORY_READ_RESULT=/tmp/aut-history-read-new.json node spikes/codex/history-read-live.ts
```

该复验需要同一 CLI 会话存储中仍有前述 thread；换机器先按前述命令重新录制，
再通过 `AUT_HISTORY_VIEW_FIXTURE=/tmp/aut-session-view-new.jsonl` 与 `AUT_HISTORY_MCP_FIXTURE=/tmp/aut-session-mcp-new.jsonl`
指定本机样本，无需覆盖仓库证据。
