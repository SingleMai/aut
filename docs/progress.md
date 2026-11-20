# 进度查询

`ProgressQueryLive` 提供 `ProgressQuery.register(op, decisionLogId)`，返回与 Chief 相同的 RegisteredExecution。
依赖 Store、ConfigStore、SessionManager.snapshot、HarnessResolver、SessionSetup、SessionReplyGate。

fast 不调用任何模型或 adapter，仅将持久化结构化状态渲染为不超过 200 码点的模板。
deep 在后台隔离 fork 或 transcript 临时会话中回答，默认子回合超时 120 秒，可配置。
原任务状态、queue、pendingRequestIds 和 lastReport 都不改动；结果保存为独立主会话 reply 与不可变完整报告。
详见 ADR-0030。
