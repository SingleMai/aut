# aut 架构

> 状态：v0 设计稿（2026-11-16）。数据结构的精确定义见 `protocol.md`，决策树见 `decision-tree.md`。

## 1. 目标与非目标

**目标**
- 一个快速响应的 personal agent：用户的每句话在百毫秒级得到确定性的反馈（路由确认、问题卡片、澄清选项）。
- 帮用户管理所有 agent 会话：派发、问进度、继续对话、取消/重试，全部在一个入口完成。
- 协调者行为可预测、可回放、可评测：不"自作主张"。
- 复用现有 harness CLI，用户自由选择模型与工作流（bot）。
- bot 长期记忆由 aut 按 bot 隔离管理，设计与落地范围见 [Bot 记忆](memory.md)（ADR-0068、ADR-0069）。

**非目标（MVP）**
- 不向用户开放底层 session 的直接交互界面（只读的任务面板除外）。
- 不做云端或外部事件驱动的主动型 agent。v1 的本地主动型 agent 通过 TriggerRegistry 实现，触发器定义和 occurrence 运行账本持久化在 SQLite，daemon scoped scheduler 只负责到期检查和把 trigger.fired 事件投递给 Chief。调度语义与重启追赶边界见 ADR-0056。
- 不做多用户/云端/团队功能。

## 2. 快与慢

| | 快脑 | 慢脑 |
|---|---|---|
| 谁 | chief（决策树执行器）+ Classifier（Jev） | harness session（工作会话 / 主助手协调会话 / 改写 fork） |
| 延迟 | 一次 Jev 调用约 200ms，规则节点 ~0 | 秒到小时 |
| 能做什么 | 选择题、阈值判断、模板回复、调度 | 理解、生成、执行工具 |
| 不能做什么 | 生成实质内容、做开放式判断 | 直接改变任务结构（只能通过 `propose_route` 提议） |

chief 处理不了的情况（意图不明、跨多任务的元请求等）**下沉到主助手的协调会话**：chief 先用模板回"我想想"，
慢脑在后台运行，回来后在 main thread 与用户继续讨论。下沉本身是决策树的一个节点。

## 3. 核心概念

| 概念 | 说明 |
|---|---|
| **Main thread** | 用户与 aut 的唯一对话流。包含用户消息、chief 模板回复、回包、问题卡片、澄清卡片。持久化在 SQLite。 |
| **Bot** | 用户配置的"岗位"：名称、路由专长（以原语言进入 Jev 的 state）、soul（长期指令）、使用哪个 harness 实例与模型、workdir。外部 MCP server 与 Bot grant 由全局注册表管理。 |
| **主助手** | 唯一内置的主助手 aut，可直接工作、承接路由兜底，也可在 chief 下沉时协调。 |
| **Harness 实例** | 一个可用的 harness 配置（如"本机 Codex，路径 X"），bot 通过 `instanceId` 引用。 |
| **Task** | 一次委托。**一个 task = 一个 bot 的一个 session**，创建后不能换 bot；一个 bot 可同时有多个 task。 |
| **Session** | harness 侧的会话（Codex thread 等），由 adapter 管理，存 resume 游标。fork 出的 session 是临时的。 |
| **SessionRequest** | session 运行中发出的需要外部回答的请求：`permission` 或 `question`。 |
| **Op** | 决策树的输出动作：`new / ask / send / control / answer / clarify / escalate`（见 `protocol.md`）。 |
| **Decision log** | 每次路由的完整记录。 |

## 4. 组件

```
┌──────────────── apps/desktop (Electron renderer) ────────────────┐
│  Main thread 视图 · 问题/澄清卡片 · 任务面板(只读) · Bot 配置      │
└───────────────▲──────────────────────────────────────────────────┘
                │ 本地 API（HTTP + WebSocket 事件流）
┌───────────────┴──────────────── daemon ──────────────────────────┐
│  MainThread ──▶ Chief(串行) ──▶ DecisionTree 执行器               │
│                    │   ├─ Classifier (Jev / 用户配置的后端)        │
│                    │   └─ DecisionLog                            │
│                    ▼                                             │
│  TaskRegistry(状态机) ◀──▶ SessionManager ──▶ HarnessAdapter(codex)│
│        ▲                     │  每 session: Fiber + 投递 Queue      │
│        │                     ▼                                   │
│   ReplyGate(门槛+fork改写)   SessionRequest 路由 ──▶ 问题卡片       │
│                                                                  │
│  McpBridge（给 agent 的工具：read_main_thread / list_tasks /      │
│            get_task / create_bot / propose_route / ask_user*）    │
│                                            EventBus(PubSub)  Store │
└──────────────────────────────────────────────────────────────────┘
        │ 子进程（长连接）
   codex app-server / (后续) claude stream-json / ACP agents
```
`ask_user*`：仅在某 harness 没有原生提问通道时由 adapter 注入（见 `harness-adapters.md`）。

## 5. Bot 配置（摘自 OpenMausBot `WireBot` 的子集）

```
id, name
characterId?     客户端形象注册 ID，见 ADR-0053
description      用户填写的专长，可用中文。路由与试验使用同一套英文判据匹配该专长
soul             长期指令/人设，写入 workdir 下的指令文件（harness 自己读取，如 AGENTS.md）
modelSelection   { instanceId, model, effort? }
cwd              workdir
system?          "primary"（当前内置主助手标记）
```
普通 Bot 可由用户在配置页创建，也可由工作或协调会话里的 Agent 创建，详见 [会话 MCP bridge](mcp-bridge.md)。
权限固定为最高，不提供配置项。Bot 配置页提供"路由试验"：输入一句话，展示 Jev 对各 bot 的概率分布，帮助用户写出不重叠的描述。

daemon 根据 `system: "primary"` 查找主助手。首次启动或保存配置时按需初始化，模型探测与工作目录选择见[内置主助手](primary-assistant.md)。

## 6. Task 状态机

```
            ┌────────────── control:cancel ───────────────┐
 created ──▶ running ──▶ waiting_user ──(answer)──▶ running │
              │   ▲  │                                     ▼
              │   │  └──(turn end)──▶ reporting ──▶ idle ──▶ cancelled
              │   └──────── send / resume ─────────────┘
              ├──(error)──▶ failed ──(control:retry)──▶ running
              └──(daemon 重启时回合中断)──▶ interrupted ──(control:resume)──▶ running
 idle 也可 control:archive ──▶ archived
```
- `reporting`：回合结束，ReplyGate 正在检查/改写回包。
- `waiting_user`：存在待回答问题，不代表 worker 已暂停。阻塞请求由 harness 挂起，非阻塞请求允许继续工作；最后一个待答 request 回填后才回到 `running`（ADR-0015）。
- `idle`：回合结束、回包已送达，等待后续 send。task 不会自动"完成"，由用户 archive 或长期闲置。
- 状态的精确定义与合法转移表见 `protocol.md`，实现必须用表驱动。

## 7. 关键流程

### 7.1 用户消息 → 路由
1. 用户消息写入 main thread，入 chief 的串行队列。
2. chief 构造 state（见 `decision-tree.md` §2），执行决策树：规则节点（如"点了卡片"）→ classify 节点（一次 Jev 调用批量问多个问题）→ 阈值判断 → 得到 Op。
3. 写决策日志 → 执行 Op → 发出模板确认（≤300ms 内用户可见）。
4. 下一条消息才开始处理（保证"刚创建的任务"已登记，后续消息可引用）。

### 7.2 new：派发新任务
1. Op 指定 bot（classify 节点从 bot 列表中选；Bot 选择低置信度 → 主助手）。
2. 组装交接包（§8），SessionManager 创建 session 并发起首个回合。
3. task 进入 `running`，main thread 显示"已交给『X』"。

### 7.3 send：投递给已有任务
- 目标 session 空闲：立即 resume 并开始回合。
- 目标 session 正在运行：决策树按语义选择投递方式：
  - `queue`：排到当前回合之后（默认）。
  - `steer`：插入当前回合（用户在纠偏："停一下 / 改成…"）；adapter 不支持则降级为 `queue`。
  - `restart`：沿用 OpenMausBot 的顺序：先把新消息持久化入队，再停止当前回合；结束清理后转为空闲，由同一个队列排出流程开启新回合（ADR-0017）。
- 队列**排出时**合并同一 task 已排队的多条消息为一个回合（窗口与条数上限可配置，参考 OpenMausBot：120s / 30 条）。

### 7.4 ask：问进度
1. **快速路径**：只问状态类信息（在跑吗/卡在哪/等我什么）→ 直接用 TaskRegistry 维护的结构化数据回答（模板），并引导到任务面板。
2. **开放式问题**：adapter 支持原生 fork → fork session 提问，回答走 ReplyGate；
   不支持 → 新开一个临时 session，交给它该 task 的 transcript 并提问。
3. 不对 harness 事件流做程序化解析来推断进度。

### 7.5 回包：ReplyGate
```
worker 回合结束 → 取最终报告
  → 门槛：长度 ≤ 200 中文字符（规则）且 Jev noul「对普通用户可读」≥ 阈值
  → 通过：写入 main thread（标注来源 task/bot）
  → 不通过：fork worker session，指令"改写为面向用户的简洁答复"→ 再过门槛（最多 2 次）
      不支持 fork：新开临时 session，只交给它报告原文改写
  → 仍不通过：截断 + "详情见任务面板"
```
完整原文始终保存在 task 详情里。改写 fork 不回写原 session。

### 7.6 问答拦截：SessionRequest
1. adapter 把 harness 原生的提问/审批统一为 `SessionRequest`。
2. `permission` → 自动放行（最高权限）。
3. `question` → task 进入 `waiting_user`，main thread 显示问题卡片（标注来源 bot/task）；阻塞请求由 harness 挂起回合，非阻塞请求允许继续工作。question 不设超时（直到回合结束）。同一 task 可以有多个待答 request，最后一个回填完成才回到 `running`。
4. 用户点卡片 → 确定性回答；用户直接打字 → 决策树的 `answer` 分支判断回答哪个待处理问题（优先级最高）。
5. 同一 request 的多道 questions 以 `QuestionAnswer` 整组提交，通过 adapter 原通道回填；回合已结束后才回答的，作为下一条消息 send。回填与回合结束串行处理，同一答案不得重复投递。

### 7.7 主助手的协调任务（escalate）
1. 决策树判定快脑无法处理 → Op `escalate`。
2. chief 模板回复"我想想"，在主助手上创建一个协调 task（任务面板可见）。交接包同 §8，额外附上本次决策日志摘要（为什么下沉）。
3. 主助手可以自行工作、向用户提问、创建专长助手，回复经过 ReplyGate。需要分工时，协调会话通过 `propose_route` 提交结构化 Op，由 chief 校验、执行并记录。完整工具权限见[会话 MCP](mcp-bridge.md)。
4. 用户对协调任务的后续回复，按普通 `send` 路由到该 task。

## 8. 交接包（handoff packet）

```
[任务头]   模板：你是 <bot>，受 aut 主会话委托；完成后给出面向用户的结论；需要用户输入时直接提问
[本次请求] 用户原话（若为排队合并，则多条按时间顺序）
[相关片段] Jev 从最近 N 条 main thread 消息中剪枝出的相关消息（原文 + 消息 ID + 时间 + 发言人），受 token 预算约束
[相关任务] 被引用 task 的 ID、bot、状态、最终报告摘要入口
[工具提示] 更多上下文请用 read_main_thread / list_tasks 按 ID 查阅
```
- 剪枝：对候选消息批量提 Jev `noul`「与本次请求相关吗」，按概率排序截断到预算。
- 引用遵循"给 ID、按需拉取"原则（参考 DeepSeek super-agent 的 Chain of Recall）。
- 工作会话上下文与原生压缩的职责见 [Harness 适配层](harness-adapters.md#21-会话上下文与原生压缩)，不与交接片段预算混用。

## 9. 进程模型与恢复

- daemon 常驻（Electron 主进程拉起，也可独立运行），UI 关闭不影响 session。
- 每个 harness 进程长连接（Codex：`codex app-server` JSON-RPC），问题挂起期间进程必须存活。
- 每个 session 一个 Effect Fiber，持有投递 Queue；子进程绑定 Scope，Fiber 中断即清理进程。
- daemon 重启：从 SQLite 恢复 task；`running` 中断的标记为 `interrupted` 并在 main thread 通知；其余按 resume 游标懒恢复。
- 不设并发上限。
- 回合取消/重启沿用 OpenMausBot 的执行所有权保护：取消先持久化终态再中断；旧 turn ID/执行代次的迟到事件只审计，不能覆盖新回合。意外中断进入 `interrupted` 等待恢复；重启投递则在旧回合清理后从队列排出。底层中断是结束结果，不是成功报告（ADR-0017）。

## 10. 事件模型与主动型 bot

所有输入统一为 Event { source: user | session | trigger, ... }。trigger 事件经过独立声明式 trigger 树输出 new-trigger，到指定 Bot 创建独立 Task，回包照常进 main thread。v1 支持本地 once、daily、cron、interval，Webhook 和文件变化事件另行设计。

## 11. 存储布局

```
~/.aut/
  config.json        harness 实例、classifier 后端与密钥引用
  bots.json          bot 配置
  aut.db             SQLite：main_thread_messages, tasks, sessions, session_requests, events, decision_logs, triggers, trigger_runs
  workspace/         全空配置首次初始化时的默认 workdir；已有 bot 始终使用配置的 cwd
  logs/
```

soul 文件按 ADR-0031 写入各 bot 工作目录的 `.aut/souls/<sha256(botId)>.md`，
只保存角色指令，不覆盖用户的 `AGENTS.md`，不追加主会话或记忆。

## 12. Effect 映射

| 组件 | Effect 形态 |
|---|---|
| Store / MainThread / TaskRegistry / DecisionLog | Service + Layer（SQLite 实现） |
| Chief | Service；内部一个串行 `Queue<Event>` + 单 Fiber 消费 |
| Classifier | Service 接口，Jev 实现为 Layer；`Effect.timeout` + `Schedule` 重试 |
| SessionManager | Service；每 session 一个 Fiber + `Queue<Delivery>` |
| HarnessAdapter | Service 接口，每种 harness 一个 Layer；子进程用 `Scope` 管理 |
| EventBus | `PubSub<AutEvent>`，UI 通过 daemon API 订阅 |
| 配置/协议 | `Schema`，所有边界解码校验 |
