# ADR-0056：主动触发器沿用 OpenMausBot 的调度与运行账本语义

- 状态：已接受
- 日期：2026-11-20

## 背景

aut 已经预留了 trigger 事件来源，但 Chief 仍只接收用户事件。OpenMausBot 的 routines 实现已经验证了计划规则、运行去重、重启追赶、重叠运行和失败恢复的边界。重新设计一套后台调度协议会重复引入这些状态一致性问题。

## 决策

1. v1 在本地 daemon 内支持 once、daily、cron 和 interval 四种计划规则。规则计算使用墙上时钟，daemon 通过 Effect 的 Clock、Schedule、Queue、Fiber 和 Scope 驱动检查。
2. 触发器定义与 occurrence 运行账本分表保存。每个 occurrence 使用稳定的 occurrenceKey 去重，运行状态使用 queued、running、ran、failed、missed 和 skipped。
3. 默认 overlap 策略为 skip。daemon 重启时最多追赶最近 12 小时内的一个 occurrence，更早的 occurrence 聚合记为 missed。追赶窗口内存在多个 occurrence 时只投递最新一个。
4. 触发器固定目标 Bot。每次 occurrence 创建独立 Task，Task 的 origin.kind 为 trigger，并携带触发器运行账本的引用。触发器 prompt 持久化为主会话 notice，交接包继续复用现有 SessionManager。
5. 触发事件先进入声明式 trigger 决策树，再输出 new-trigger Op。Chief 只负责选择树、写 DecisionLog 和执行 Op，不在代码中按业务意图分支，也不调用模型判断时间。
6. 首个切片提供本地结构化 HTTP API 和桌面 Automations 页面。MCP trigger 创建、读取、运行账本查询和更新通过 ADR-0057 至 ADR-0060 接入。Webhook、文件变化事件、可配置 overlap 策略和重复失败重试留到后续 ADR。
7. 调度边界和运行账本的实现参考 OpenMausBot commit 738ec88472a3b888ff7b7793755d89da613ed301 的 server/routines.ts、server/routine-schedules.ts、server/due-timer.ts、server/routine-catch-up.ts、server/routine-ledger.ts 与 server/routine-recovery.ts。只借用 Apache-2.0 部分，不引入 enterprise/，迁入文件保留来源头并更新 NOTICE。

## 后果

- daemon 重启、睡眠恢复和重复消息不会依赖内存状态，触发器和运行历史可以从 SQLite 恢复。
- 触发任务会像普通任务一样进入 main thread、reply-gate 和任务面板，用户可以通过现有任务控制入口处理它。
- 时间规则的解析、时区和 DST 需要基于 occurrence fixture 持续补充。Webhook 需要独立鉴权边界，不能直接复用 loopback 调度 API。
