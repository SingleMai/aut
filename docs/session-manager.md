# SessionManager 接入与验证

实现：`packages/core/src/session-manager/`。持久化与所有权规则见 ADR-0023；
取消、重启及原生结束语义继续遵守 ADR-0017。

## 组合入口

- `SessionManagerLive({ coalesceWindowMs?, maxBatchItems? })`：默认相邻项窗口 120 秒、每次最多 30 个排队项。
- `SessionManager.register(op, decisionLogId)`：支持 new/send/control，返回 RegisteredExecution。
  调用方先写入 `execution`，再运行 `activate`；chief 已遵守这一顺序。
- `SessionOpExecutorLive`：提供上述动作、answer和clarify的局部组合入口。
  正式daemon使用`OperationExecutorLive`组合全部七种Op，ask交给ProgressQuery，escalate交给SlowBrain。
- `SessionManager.answer(op, decisionLogId)`：持久化整组答案的投递claim；QuestionsService委托此入口，
  原生投递与回合/取消事件通过同一个actor邮箱归并，详见`questions.md`。
- `SessionManager.snapshot(taskId)`：返回持久 Task 与可选的 live 只读能力（cursor/fork/transcript）、
  adapter 和 session input。它不冻结生命周期；调用方应处理取消与读取之间的关闭竞态。

需要 Store、TaskRegistry 所用的领域函数、ConfigStore、DecisionLog、EventBus，以及以下明确端口：

| 端口 | 职责 |
|---|---|
| HarnessResolver | 按 task 固定的 instanceId 返回 adapter，不按 harness 名字写业务分支 |
| SessionSetup | 在 session 子 Scope 中生成 StartSessionInput，注册 aut Bridge 凭据；不修改全局 Provider |
| HandoffBuilder | 通过正式剪枝树准备 new/send 的交接输入；retry 复用已保存输入，resume 无队列时用固定继续模板 |
| SessionReplyGate | 检查/改写报告，返回文本与改写次数；由 manager 原子发布，避免取消后迟到回复 |
| SessionRequestRouter | 使用request树确定permission放行或question建卡，不改变原生问题阻塞能力 |

没有默认的绕过 gate 实现。缺少 gate 或 gate 出错时任务保持 reporting，完整报告仍可在任务详情查到；
不会发布未经检查的 reply。回复的 fullReportRef 指向 `event:<id>`，不会随 latest report 改变。

## 生命周期

每个 task 的 actor Fiber 串行处理邮箱，耗时工作在所属 Scope 的子 Fiber 完成后再进入同一个邮箱。
Task.queue 与 StoredSession.execution 中的待投递登记、claim、generation 同事务保存。
清理确认之前不排出 restart 后继；明确 refused 的 steer 重新排队，未知结果留下 uncertain 记录。
daemon 恢复后，已有 active 不会自动重放；显式 resume 会解除遗留 steer flight 阻塞且不重投它。

request 原始事件全部持久化。question 的 pending 增减与状态机同事务进行；permission 仅审计。
旧 turn ID、旧 generation 与取消后的结束事件不改变当前状态，但保留审计记录。
task 的 botId/instanceId 不变，不设置同时运行的 session 数量上限。

## 验证

```sh
rtk proxy pnpm exec vitest run packages/core/src/session-manager/manager.test.ts packages/core/src/task-registry.test.ts packages/core/src/storage.test.ts
rtk proxy pnpm --filter @aut/core build
rtk proxy node spikes/codex/session-manager-live.ts
```

MVP09初始SessionManager 31项回归通过；MVP12新增15项问答测试后为46项。
覆盖持久登记与 activation、并行 session、FIFO/合并窗口/条数、steer 三态、restart 成功竞态、
停止清理屏障、取消后迟到报告、过期恢复登记、旧 failure 与新 Scope 隔离、cold resume、
未知投递不重发、多个 question、缺失 gate、历史报告引用及 Scope 清理。

真实合成记录位于 `spikes/codex/results/session-manager-live-0.167.0.json`：
正式 HandoffBuilder/DecisionTree/ReplyGate 处理 new→300 字原始报告→独立 fork 改写→send；
原 worker transcript 没有改写指令，253 个事件、6 条决策日志持久化，两个 CLI 子进程均已退出。
此记录的 Classifier 是明确的确定性测试实现；setup 未挂 daemon 的 aut Bridge，完整 daemon 接线另行验收。
