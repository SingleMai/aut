# chief 决策树

> 本文分两部分：**§1–§5 框架（稳定）**，改动需 ADR；**§6–§9 v1 实验树（可随时调整）**，改动只需同步本文 + 树配置 + fixture。
> v1 的分支与阈值来自设计讨论中的设想，**未经数据验证**，以 MVP 的决策日志为准迭代。

## 1. 框架概览

决策树是一份**声明式配置**（YAML/JSON，经 Effect Schema 校验），由通用执行器解释执行。共有几棵树：

| 树 | 输入 | 输出 |
|---|---|---|
| `inbound` | 一条 main thread 用户消息（或 UI 动作） | 一个 `Op` |
| `reply-gate` | 一份 worker/慢脑/fork 的回包 | 放行 / 改写 / 截断 |
| `request` | 一个 `SessionRequest` | 自动放行 / 转问题卡片 |
| `handoff-prune` | 交接时的候选 main thread 消息 | 选中的片段列表 |

桌面的“路由试验”使用独立 `inbound` 配置版本 `route-test-1.1.0`（ADR-0027）：
一个 classify 节点只询问 bot choice（state 中可路由 Bot 的专长与英文候选判据），成功输出诊断用 new Op，
失败输出不可用 clarify。调用方只返回日志中的概率，不调用 OpExecutor，也不显示这张卡或创建任务。
试验 eventRef 以 `route-test:` 开头；完整日志仍保留，失败返回 503，不能填充虚构概率。

## 2. 节点类型

| 类型 | 作用 | 是否用 LLM |
|---|---|---|
| `rule` | 对 state 做确定性谓词判断（如"是否点了卡片""目标 task 是否 running""长度是否超限"） | 否 |
| `classify` | 一次 Classifier 调用，**批量**提出多个类型化问题（`choice` / `noul` / `score`），结果写入上下文 | 是（Jev，快脑） |
| `branch` | 读取 classify 结果与阈值，选择下一节点 | 否 |
| `action` | 产出最终 `Op`（或 gate 结果）并结束 | 否 |
| `slow` | 产出 `escalate`，由主助手开启协调会话 | 是（慢脑，异步） |
| `rewrite` | 在 reply-gate 中 fork session 改写回包 | 是（harness，异步） |

除 `classify` / `slow` / `rewrite` 外，任何节点不得调用模型。新增节点类型需要 ADR。

配置的精确字段、纯数据 Expr/Predicate AST、节点引用校验与执行预算见 `protocol.md` §12（ADR-0016）。
`classify` 必须声明 `onError`；`slow` 仅用于 inbound，`rewrite` 仅用于 reply-gate。

## 3. classify 节点

- 一个节点内的所有问题**合并为一次 Classifier 请求**（Jev 支持多问题并行作答），目标延迟 ~200ms。
- `choice` 的选项分两种：
  - **静态**：写在树配置里（如 op 列表）。
  - **动态**：从 state 中的 Bot、任务和待答问题生成。选项键使用实体 ID，英文判据引用候选位置。
- state 中的任务描述预计算相对时间、序号和状态等信息，例如
  `t_42: "Competitor research report · bot: Researcher · running · created 2h ago · #2 most recent · just replied to user"`。
- 动态候选需截断：活跃 task + 最近 N 个（默认 N=10），其余合并为一个 `older_task` 选项（命中则走 clarify → 搜索）。
- v1 的活跃状态包括 created/running/waiting_user/reporting/failed/interrupted；引用目标额外纳入。
  older_task 命中展示真实旧任务候选并提示缩小范围，不生成未定义的 search Op。
- instructions / criteria 使用英文。Bot 名称与专长、任务摘要和待答问题原文随各自的候选 ID 进入 state。英文判据按位置引用候选，选项键仍是实体 ID。
- state 只放该节点问题需要的字段，避免噪声。

## 4. 阈值与降级

- 所有阈值写在树配置里，不得硬编码。
- Classifier 调用失败/超时（默认 1.5s）/限流：
  1. 若用户配置了备用 Classifier 后端 → 重试一次备用；
  2. 否则该节点结果视为"全部低置信度" → 走 `clarify`（确定性卡片，列出可选动作）。
- 主后端和最多一次备用调用共享单节点总预算；主调用耗尽预算后不再追加一份备用预算。
  总预算可配置，默认1500ms。两次调用分别保留响应/错误及延迟，不把失败伪装为零概率响应。
- 永远不允许因为 Classifier 不可用而阻塞 main thread。

## 5. 决策日志

每次执行一棵树写一条 `DecisionLog`（结构见 `protocol.md`），包括：输入 state（含动态选项快照）、每个 classify 问题的完整 probabilities、
经过的节点路径、产出 Op、执行结果、延迟、Classifier 后端与模型版本。用户后续的纠正行为（点了"不是这个"、撤销、改投）回写到该日志的 `correction` 字段。

---

## 6. `inbound` 树（当前版本 1.3.0）

### 6.1 state
```
message          用户原文
uiAction?        卡片点击 / 引用回复 / 任务面板操作（若有）
pendingRequests  所有 waiting_user 的问题（ID、来源 bot/task、问题文本）
taskCandidates   活跃 + 最近 N 个 task（预计算描述）
bots             主助手与专长助手的 ID、名称和原语言专长
primaryBotId     主助手的实际 ID，供新任务兜底和澄清选项使用
recentMessages   main thread 最近 K 条（默认 K=6）的简短摘录，用于指代消解
```

### 6.2 流程
```
R0 rule  uiAction 是卡片动作?
         ├─ correct-dispatch → 按原派发记录和用户选项绑定 new 或 control(cancel)
         ├─ question-answer 整组提交 → action: answer(requestId, answer)
         ├─ 问题卡片选项 → action: answer(requestId, choice)
         ├─ 澄清卡片选项 → action: 卡片上绑定的 Op（"都不是" → slow）
         └─ 任务面板按钮 → action: control(taskId, action)
R1 rule  uiAction 是引用回复某条 task 消息? → 固定 target = 该 task（C1 跳过 target 问题）

C1 classify（一次调用）
  op:            choice { answer_pending*, new_work, ask_progress, talk_to_task, control_task, other }
                 *仅当 pendingRequests 非空时出现
  pending:       choice <pendingRequests>            （仅当非空）
  target:        choice <taskCandidates> + none      （R1 命中时跳过）
  bot:           choice <bots>
  control:       choice { cancel, retry, resume, archive }
  delivery:      choice { queue, steer, restart }
  status_only:   noul "Is the user only asking about status (running / blocked / waiting), not about content?"
  multi_intent:  noul "Does the message contain several distinct instructions, or refer to several tasks at once?"

B1 branch
  multi_intent ≥ 0.5                → slow
  op.confidence < 0.4               → slow
  0.4 ≤ op.confidence < 0.6         → clarify(op 概率前 2 名)
  op = other                        → slow
  op = answer_pending  → B2
  op = new_work        → B3
  op = ask_progress    → B4
  op = talk_to_task    → B5
  op = control_task    → B6

B2 pending.confidence ≥ 0.6 → answer(pending, message)；否则 clarify(pending 前 2 名)
B3 bot.confidence ≥ 0.6     → new(bot)；否则 new(主助手)
B4 target.confidence ≥ 0.8  → status_only ≥ 0.6 ? ask(target, fast) : ask(target, deep)
                              否则 clarify(target 前 2 名)
B5 target.confidence ≥ 0.8  → send(target, target 是否 running ? delivery : 立即)
                              否则 clarify(target 前 2 名)
B6 target.confidence ≥ 0.85 且 control.confidence ≥ 0.8（破坏性操作阈值更高）
                            → control(target, control)；否则 clarify
```

多意图指多个独立目标或任务。同一目标的参数、操作步骤、输出格式属于一个意图。用户要中断当前回合并带新指令重做时，选择 talk_to_task 的 restart 投递。取消整个任务或重试已失败的任务才属于相应的 control 操作。若 control 指向已确定的运行中或待答任务，分类结果为 retry/resume，同时 delivery 判为 restart（置信度 ≥0.8），澄清卡提供「中断本轮并按新指令重做」。点击后按原始消息 ID 登记 restart。

### 6.3 clarify
- 确定性卡片：问题文本由模板生成（如"你指的是哪个任务？"），选项来自 probabilities 前 2–3 名 + "都不是"。
- 每个选项绑定一个完整 Op，用户点击后走 R0。意图候选 other 的文案为「和主助手讨论」，选「都不是」也进入 `slow`。
- 概率与实体数据的组合使用 entries/record/filter/choose AST；意图→Op 模板也在配置中，不在运行时构造器中按意图分支。
- target 为 none 或置信度不足时，只列真实任务的候选；older_task 时列旧任务。任务操作门槛不足时要求用户确认完整操作。
- B2 仅在所选 request 恰好一题且 allowFreeText 时将原文绑定到该题。多题或禁自由文本时，
  卡片绑定 requestId，由客户端读取原请求题组并提交 question-answer；不复制同一句到每题。
- 后端全部失败的卡片明确提供“交给主助手创建新任务”、引用所指任务的继续操作（普通消息使用最近真实任务，若存在）、“都不是”；
  没有概率时不伪造概率排序，也不自动执行推测动作。

### 6.4 slow
- 模板回复"我想想"，在同一个主助手上创建 `origin.kind = "coordination"` 的协调 task，交接包附本次决策日志摘要。

### 6.5 实现与回放

- 数据配置：`packages/core/src/decision-tree/inbound.ts`（仅生成可 JSON 序列化 AST）。
- 分支与阈值 fixture：同目录 `inbound.test.ts`；解释器行为与预算：`engine.test.ts`、`expression.test.ts`。
- Chief 使用单 Queue/Fiber，不做 debounce。submit 返回已入队的 receipt；状态在消费时重新读取。
  OpExecutor 返回前必须完成 Task 登记/持久入队，后续事件才能引用刚创建的任务；后台 session 工作不占用 Chief Fiber。
- 每次树运行先写决策日志，执行登记完成后事务补 execution；无输出的失败不伪造 Op，已有 correction 不被覆盖。

## 7. v1 `reply-gate` 树（实验）

```
R1 rule  长度 ≤ 200 中文字符（英文按 120 词）?
C1 classify  readable: noul "Is this reply concise and understandable for a non-technical user, without unexplained jargon, logs or code dumps?"
B1 R1 通过 且 readable ≥ 0.6 → action: deliver
   否则 若已改写次数 < 2 → rewrite（fork 原 session；不支持 fork 则临时 session 只给报告原文）→ 回到 R1
   否则 → action: deliver(截断 + "详情见任务面板")
```
改写指令（模板，英文）："Rewrite your last report as a reply to the user: at most 200 Chinese characters, plain language, conclusions first, no logs or code."

实现 state 为 report、characters（Unicode 码点）、words（空白分词）、hasHan、rewrites。
空报告不放行；含汉字的混合文本按字符门槛，否则按词门槛。长度不合格直接进入改写预算分支；
可读性 classify 失败也进入改写预算分支，不伪造 noul。rewrite 异常走 truncate；
正常改写更新 state 并重新从长度规则开始。截断包含固定提示且同时满足两种长度上限。
内部改写的 Scope、事件审计与原 session 隔离见 ADR-0028。

## 8. v1 `request` 树（实验）

```
R1 rule  kind = permission → action: allow
R2 rule  kind = question   → action: relay（task → waiting_user，main thread 问题卡片）
```
（预留：未来可加 `noul "Can only the user answer this (credentials, payment, personal preference)?"`，低概率时模板回复"按合理默认继续"。v1 不启用：**question 永远转给用户**。）

实现配置为 `packages/core/src/decision-tree/request.ts`。permission 已由 adapter 原生放行，allow 节点只记录审计，不再重复调用 respond；relay 按 requestId 创建一张卡片，完整题组保留在原 `SessionRequest`，不压平成单选题。答案投递、迟答和重启恢复遵循 ADR-0032；Chief 不在登记成功时提前将原生问题卡标为已回答。

## 9. v1 `handoff-prune` 树（实验）

```
候选：本次最早请求之前最近20条已持久化 main thread 消息（排除本次全部请求）
R0 rule 空候选 → action: excerpts=[]
C1 classify 对每条候选一个 noul（英文问题显式指向 candidate_0 等候选，同一次调用）
A1 action 取 ≥ 0.5 的消息 → 概率降序稳定排序 → budget贪心选完整片段 → 恢复时间顺序
失败 → A2 action 最近2条候选 → 相同budget → 恢复时间顺序（不伪造relevance）
```

阈值relevance=0.5、候选20、降级2与相关片段预算2000均声明在树配置。
预算计入ID、时间、作者、原文与分隔符，以UTF-8字节数作为保守token上界；超大项跳过后继续挑较小项。
用户原话不受剪枝预算截断，相关task只提供ID等摘要入口；new/send统一经此树（ADR-0029）。
请求与片段按主会话入库顺序排列，时间戳仅作metadata；当前请求只接持久化user/text引用。
