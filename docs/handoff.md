# 交接包

`HandoffBuilderLive()` 实现 SessionManager 的必需 HandoffBuilder 端口，依赖 Store、ConfigStore、DecisionTree 与 DecisionLog。
它只构造本次交接，不管理工作会话的模型上下文；原生压缩与历史读取的边界见[Harness 适配层](harness-adapters.md#21-会话上下文与原生压缩)。
用户触发的 new/send 都先从持久化消息ID恢复user/text原话；拒绝把bot/chief输出当作用户请求。
计划触发的请求使用该次触发已持久化的 chief/notice，不将其冒充用户原话。
顺序以主会话入库序号为准，不受时钟回拨或同时间戳影响；send 使用后续任务模板，不重放整个会话。

候选只取本次最早请求之前最近20条主会话消息。`handoffPruneV1` 将候选按固定ID批量提出英文noul问题，
保留相关性≥0.5的完整片段，按概率优先分配预算后恢复原顺序。选择、概率、分类错误与结果均保留决策日志。
空候选不调用分类器。分类失败时只考虑最近2条，并应用相同预算；降级片段不填 relevance。

默认2000预算只用于相关片段，计入消息ID、epoch毫秒时间、作者、原文和分隔符。
默认值只在 `handoffPruneV1.thresholds.tokenBudget` 声明，builder 不维护另一份默认预算。
`handoff/excerpts.ts` 集中管理片段渲染和成本：使用UTF-8字节数作为保守token上界，
因此中文或emoji可能比真实token计数更早触及上限；这不是 Harness 的原生 token 用量。
选择前先扣除片段标题，每个候选保守预留一个分隔符；完成后按实际渲染的整段文本校验。
原话永不裁剪；`excerptTokenBudget` 可覆盖预算，包括0。超大候选跳过，继续尝试较小的候选。

模板提供任务头、多条原话、引用上下文、相关任务ID与工具提示，不复制其他任务的完整报告或bot soul。
首次下沉慢脑还从原决策日志渲染原因摘要。分类降级仅保留任务头、原话、预算内最近2条与工具提示。
额外信息由agent使用read_main_thread、list_tasks、get_task按需读取。

验证包括10条树fixture、预算表达式非法输入/精确边界、真实SQLite候选范围与请求排除、降级无伪造概率、
多消息模板快照，以及HandoffBuilder端口调用。详情见ADR-0029。
