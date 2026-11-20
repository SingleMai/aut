# ADR-0017：沿用 OpenMausBot 的回合结束与重启调度设计

- 状态：已接受（按用户要求，参考 OpenMausBot 已有设计）
- 日期：2026-11-16

## 背景

P0 真实样本在 `turn/interrupt` 后发出 `turn/completed(status: interrupted)`。
现有 `SessionEvent` 只有成功完成和失败，不能准确表达这一结果。一个 task 可以有多个回合，
中断旧回合既可用于取消任务，也可用于 `send(restart)`；因此不能将任何底层中断都当成任务取消或成功回包。
现有任务转移表也没有运行中 restart 的状态规则。

## 参考证据

固定参考 commit `738ec88472a3b888ff7b7793755d89da613ed301`，只查阅 Apache-2.0 部分：

- `server/drivers/codex.ts:1199`：用 `turn.completed` 的 `ok:false`、`stopReason:"interrupted"` 表示中断。
- `server/admission.ts:101`、`server/index.ts:7333`、`server/host/person-stop.ts:84`：restart 先排队再 Stop。
- `server/steer-queue.ts:195`：排出前占有并移除待投递项，避免并发结束通知重复排出。
- `server/person-stops.ts:15`、`server/runtime/runtime.ts:502`：停止标记与执行所有权绑定具体回合。
- `server/runtime/runtime.ts:746`：先持久化取消状态，再撤销执行；迟到成功不得覆盖取消。
- `server/routes/bot-messages.ts:415`、`server/drivers/codex-questions.ts:29`：不确定投递不得自动重放。
- `server/person-replies.ts:116`：迟到问题回答复用普通消息投递与稳定幂等标识。

参考回归用例：`server/runtime/runtime.test.ts:524`、`server/steer-queue.test.ts:884`/`:905`/`:980`、
`server/drivers/codex.test.ts:3092`/`:3121`。未复制参考代码；后续若改编实现，须增加文件头署名与 NOTICE。

## 决策

1. 沿用统一结束事件，不新增独立 `turn.interrupted` 事件。
   成功为 `turn.completed { turnId, ok:true, finalReport }`；中断为
   `turn.completed { turnId, ok:false, stopReason:"interrupted" }`，不得携带成功报告。
   执行错误继续用已有 `turn.failed` 表达。
2. SessionManager 区分自己已发起的取消/重启与未预期中断：
   - `control(cancel)`：先持久化 `cancelled` 并撤销旧回合所有权，再中断执行；后续旧通知只审计，不再转移。
   - `send(restart)`：先持久化投递队列，再请求停止当前回合；旧回合结束清理后转 `idle`，
     由同一个队列排出流程开启新回合，`turn.started` 再转 `running`。不建立第二条重启启动路径。
   - 未预期中断：活动任务进入 `interrupted`，等待用户 `control(resume)`。
3. 转移表按结束结果与已记录意图增加互斥规则：中断且因 restart 时
   `running / waiting_user → idle`；其余当前回合的意外中断转 `interrupted`。
   已撤销所有权的旧回合不进入状态机。其余非法转移继续报类型化错误。
4. 旧回合结束时使其未答问题过期，迟到回答按已有 `send` 规则处理。状态更新按 task/turn ID
   串行处理，旧回合通知不得覆盖新回合状态。
5. 创建/继续/retry/resume/restart 的领域转移与 harness 的 `turn.started` 确认只应用一次，
   不把同一启动重复应用为非法 `running → running`。确认事件仍完整审计，不丢弃决策日志。
6. `respond` 只有在确定未投递或明确已过期时返回 `RequestExpired` 供上层转 `send`；
   传输中断且无法确认是否投递时返回独立错误，不自动重复发送答案。
7. 复用设计与测试情形，不照搬 OMB 的每回合进程清理：aut 按既定架构保持 session 子进程长连接，
   回合清理关闭待答请求与旧回合资源，进程生命周期由 Scope 管理。

## 理由

保留现有 cancel/restart/resume 的产品含义，用明确生命周期事件表达真实协议。
成功回包、执行失败、用户取消和回合重启各有可验证行为，避免错误回包或双重投递。

## 后果与验收

同步 `protocol.md` 的事件与转移表、`architecture.md` 的 restart/恢复流程。
需要覆盖：取消后到达的中断确认、restart 的旧回合通知、意外中断后恢复、
等待问题时 restart、答案投递不确定时不自动 send。所有分支仍由表与类型化协议描述。
