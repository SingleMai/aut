# 交接包

`HandoffBuilderLive()` 实现 SessionManager 的必需 HandoffBuilder 端口，依赖 Store、ConfigStore、DecisionTree 与 DecisionLog。
new/send 都先从持久化消息ID恢复user/text原话；拒绝把bot/chief输出当作用户请求。
顺序以主会话入库序号为准，不受时钟回拨或同时间戳影响；send 使用后续任务模板，不重放整个会话。

候选只取本次最早请求之前最近20条主会话消息。`handoffPruneV1` 将候选按固定ID批量提出英文noul问题，
保留相关性≥0.5的完整片段，按概率优先分配预算后恢复原顺序。选择、概率、分类错误与结果均保留决策日志。
空候选不调用分类器。分类失败时只考虑最近2条，并应用相同预算；降级片段不填 relevance。

默认2000预算只用于相关片段，计入消息ID、epoch毫秒时间、作者、原文和分隔符。
`estimateTokens` 使用UTF-8字节数作为保守token上界，因此中文或emoji可能比真实token计数更早触及上限。
原话永不裁剪；`excerptTokenBudget` 可覆盖预算，包括0。超大候选跳过，继续尝试较小的候选。

模板提供任务头、多条原话、引用上下文、相关任务ID与工具提示，不复制其他任务的完整报告或bot soul。
首次下沉慢脑还从原决策日志渲染原因摘要。分类降级仅保留任务头、原话、预算内最近2条与工具提示。
额外信息由agent使用read_main_thread、list_tasks、get_task按需读取。

验证包括10条树fixture、预算表达式非法输入/精确边界、真实SQLite候选范围与请求排除、降级无伪造概率、
多消息模板快照，以及HandoffBuilder端口调用。详情见ADR-0029。
