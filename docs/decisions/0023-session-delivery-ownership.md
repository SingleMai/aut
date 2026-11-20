# ADR-0023：SessionManager 的持久投递与执行所有权

发布前存储格式现行规则见 [ADR-0048](0048-pre-release-data-baseline.md)。

- 状态：已接受（ADR-0017、0018、0022 的实现细化）
- 日期：2026-11-16

## 背景与参考

chief 只等待动作的持久登记；真实 CLI、交接剪枝和回包检查不能阻塞主会话。
排队移除后若进程退出，必须区分确定未投递与结果未知，不能把两者都重新入队。
参考 OpenMausBot `738ec88472a3b888ff7b7793755d89da613ed301` 的 Apache-2.0 部分：
`server/admission.ts` 的相邻项时间窗口与条数限制、`server/steer-queue.ts:195` 的先认领再执行、
`server/runtime/runtime.ts:502/746` 的所有权保护和先持久化取消、
`server/routes/bot-messages.ts:415` 的不确定投递保护。不读取 enterprise，不引入其并发上限。

## 决策

1. 每个 task/session 一个长期 Fiber 与 Queue。队列串行处理控制和原生事件；耗时的
   setup、handoff、CLI RPC、gate 放在所属 Scope 的子 Fiber，结果返回同一个邮箱。
   不在 SQLite 事务中等待 CLI 或模型，不在 chief 中等待真实回合。
2. `OpExecutor.execute` 返回 `{ execution, activate? }`。chief 先持久化登记结果，再调用
   activate 放行已登记命令；它只释放邮箱工作，不等待执行结束。这样实际 steer 降级/失败的
   日志更新不会被 chief 的初始完成记录覆盖。快路径无需 activate。
3. 在内部 `StoredSession.execution` 保存 generation、待投递登记、已认领的 active attempt、
   最近 attempt 和不确定投递。Task.queue 是待投递消息的公开视图，两者在同一事务更新。
   `saveTask` 保留内部字段；旧记录无 execution 时可从 Task.queue 建立初始登记。
   认领先从待投递队列移除并持久化 active，再启动 RPC；恢复不能自动重投已认领项。
4. 合并只发生在排出时：同一 task 从队头起，相邻项排队时间非递减且相差不超过 120 秒，最多 30 个排队项，
   两项均可配置。不等待凑批、不 debounce。不同 task 独立工作，不设置并发上限。
5. cancel 先事务写 cancelled、撤销 active 所有权，再停止执行；archive 同样先持久化并清理。
   restart 先持久化新消息与意图。旧回合即便竞态返回成功，也只审计、清理而不回包；
   按 restart 结束规则转 idle，再由统一 drain 启动下一回合。旧 generation/turn ID 事件
   完整记录，但不得覆盖新状态、关闭新问题或生成回复。
6. steer 不支持或明确 refused 才降级 queue；indeterminate 留存不确定结果且禁止自动重投。
   retry 只由显式 control 发起，使用最近失败投递的原始 TurnInput；未知投递不能自动重试。
   resume 优先排出尚未投递的队列；无队列时，恢复 cursor 后用固定英文继续指令，明确要求
   avoid repeating completed actions，不重放旧用户原文。所有启动复用同一管道。
   显式 retry/resume 可替换尚未认领的旧恢复登记；旧 activate 只能匹配其 operation ID，
   不会放行替代登记。遗留的 steer flight 转为 uncertain，解除阻塞但不自动重投。
7. SessionSetup、HandoffBuilder、SessionReplyGate 是必需的 Service 端口。
   生产没有原文直出的默认 gate，也没有把完整 main thread 注入 session 的默认 handoff。
   测试/开发可以显式注入最小合成交接和 gate。gate 未配置时保留 reporting 与完整报告，
   不写用户 reply，不伪造 gate.done。
8. 成功原始报告先作为不可变 StoredEvent 保存，gate 接收 reportEventId。
   gate 通过后，reply、lastReport 与 gate.done 同事务提交；fullReportRef 使用
   `event:<reportEventId>`，历史回复不引用可被覆盖的 latest report。
9. request 的打开/关闭与 task.pendingRequestIds 在同一事务更新。permission 仅审计；
   question 永不自动作答。MVP-12 在此基础上增加卡片与整组 answer 编排。

## 后果与验收

公开 Task/SessionEvent 不增加字段；内部存储 Schema 使用可选 execution 字段兼容旧记录。
需要覆盖：并发任务、首轮、FIFO 与合并边界、steer 三态、restart 成功竞态、cancel 迟到事件、
retry/resume、问题过期、gate 缺失/取消竞态、Scope 退出，以及真实 new→gate 回包→send。
真实验收只使用合成输入和明确注入的测试 gate，不把它作为生产回包规则。
