# 原生问题链路

MVP12 使用 `SessionRequestRouterLive`、`QuestionsServiceLive` 和 SessionManager 的同一 session 邮箱。Router 依赖 Store / DecisionTree / DecisionLog，Manager 依赖 Router，QuestionsService 依赖 Manager，没有互相依赖的 Layer。daemon 组合这些服务后，将 `Op.answer` 交给 QuestionsService。

## 请求与卡片

adapter 将原生题组映射成 `SessionRequest`，不生成答案。Manager 持久化请求和 pendingRequestIds，再执行纯数据 request 树。permission → allow 只审计原生自动放行；question → relay 保存稳定 ID `question:<requestId>` 卡片。卡片引用原请求，客户端读取完整问题、选项、单多选和自由文本约束。多个请求分别闭合；仅最后一个关闭才结束 waiting_user。worker 可在异步提问后继续运行。

同一个 request 可能同时出现在原生问题卡和 chief 生成的题组卡上。两处按 requestId 同步已答或过期状态，后生成的卡片也读取原请求的当前状态。

## 答案投递

先用 `QuestionAnswer` Schema 检查非空答案与唯一 ID，再按原请求验证完整题组、选项、单多选和自由文本。Chief 写初始执行日志后 activate；Manager 邮箱在发送前持久 claim 并核对任务与原通道所有权。结构化卡片和入站树从原文绑定的答案使用同一路径。

answerClaim 包含完整显式用户答案和 decisionLogId，单请求接口返回 answerState；仅对投递已确认的原生问题附带 deliveredAnswer，供只读回看。

| 状态 | 含义 | 后续行为 |
|---|---|---|
| registered | 已登记，尚未调用原生通道 | 不自动重发；用户可显式重新提交，新 claim 使旧 activation 失效 |
| submitting | 已取得发送所有权，等待确认 | 禁止重复提交；原生成功才确认 |
| delivered | 原生成功或原生 answered 事件确认 | 卡片已回答 |
| indeterminate | 可能已经发送，但确认丢失 | 禁止自动/重复投递，保留审计与明确提示 |
| queued | 确认未送达原问题，已转同任务 send | 原请求保持过期状态，卡片已消费，队列只排一次 |

仅 `RequestExpired` 或调用前明确原通道已不存在可以降级。稳定答案消息 `answer:<requestId>`、队列与 queued claim 在同一事务提交；随后沿用正常 handoff 和回包门槛。单纯超时、连接丢失或不明错误永不触发 send。cancelled/archived/failed/interrupted 不因迟答重开，返回模板错误并保留可重新回答的卡片。

daemon 初始化将所有遗留 submitting 置为 indeterminate，包括 idle 或已过期请求，并更新原决策日志与提示。registered 保留显式恢复入口；不自动激活。原生回合结束使未答请求与卡片过期；迟到成功确认可记录 delivered，不会再次投递。

## 验证

`packages/core/src/session-manager/manager.test.ts` 使用真实 SQLite、生产 request 树、QuestionsService 与 FakeAdapter；覆盖原生整组、零自动回答、permission 审计、多 pending 状态、非法答案、重复提交、旧 activation、迟答降级、结束/取消竞态、未知结果与重建 Manager 的恢复。

`spikes/codex/questions-live.ts` 通过真实 Codex、生产 handoff / request 树 / 回包门槛运行 JSON-RPC 原生题组与 async 提问。探针仅对脚本明示且文本、选项完全匹配的合成题提交预设测试答案；遇到其它问题立即失败，不发送答案。真实 CLI 的原始协议依据仍在 `spikes/codex/fixtures/`。
