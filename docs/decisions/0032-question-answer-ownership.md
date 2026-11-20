# ADR-0032：原生问题的答案投递所有权

状态：已接受（用户已授权实现；root 已确认下述实现细化）

## 背景

原生问题可能在提交前、提交中或 daemon 重启时关闭。异步问题继续运行，不能把 `waiting_user` 当作 CLI 暂停。对已经发送但确认丢失的答案再次投递，会重复影响 agent；只在内存标记也不能防止重启后重复回答。沿用 ADR-0015、0017、0023 的持久登记、撤销所有权和明确未投递/结果未知区分。

## 决策

1. `request` 是纯数据树：permission → allow（adapter 已放行，树只审计），question → relay。整组原生问题只创建一个稳定 ID 卡片；没有自动回答分支。原请求持久化且不可被卡片压平替代。
2. `QuestionsService` 验证 `QuestionAnswer` Schema，再按原请求校验问题集合、选项、单/多选和自由文本。成功登记返回 `RegisteredExecution`，Chief 完成初始日志后才 activate。Chief 不提前消费原生问题卡。
3. `StoredRequest.answerClaim` 保存 claimId、完整用户答案、decisionLogId、更新时间及阶段：registered、submitting、delivered、indeterminate、queued。注册阶段仅显式新提交可替换，旧 activation 的 claimId 失效。actor 在 RPC 前持久化 submitting；RPC 结果作为同一 session 邮箱事件处理。确认 answered 事件或成功响应才确认 delivered；未知错误不可重投。
4. daemon 初始化把遗留 submitting 改成 indeterminate。registered 不自动激活；用户可显式重新提交。读取限制由 ADR-0041 局部更新：仅已确认 delivered 的 question 可回看答案，其余阶段不公开答案值。UI 默认禁止已登记/投递中/结果未知/已排队的重复提交，明确说明结果未知；registered 额外提供“重新提交”恢复入口，由用户主动解锁原题组并提交，新 claim 仍须走服务校验。
5. 明确 `RequestExpired` 或调用前确认原通道不存在时，按同任务普通 send 降级。稳定 `answer:<requestId>` 用户消息、投递队列和 queued claim 在同一事务落盘，避免崩溃窗口重复排队；内容由原题与用户答案确定性呈现。queued 不声称原 RPC 成功。
6. cancelled/archived/failed/interrupted 遵循普通 send 的限制，迟答不能隐式重开。返回明确模板（失败请重试、中断请恢复），保留卡片可回答状态和已提交答案的审计，不能标记 answered。用户显式控制后可再答。
7. 多个 request 分别闭合；只有最后一个待答 request 关闭才从 waiting_user 回到 running。回合结束将未答请求与卡片过期。原生非阻塞问题仍可继续运行。所有 native 事件、request 树决定和投递结果都持久记录。

## 后果

Manager 新增必需的 SessionRequestRouter 端口，负责树和卡片；QuestionsService 通过 Manager 邮箱提交答案，避免暴露 SessionHandle.respond 或服务依赖环。内部 claim 是执行元数据，不改变跨模块 SessionRequest。投递结果未知需要用户查看实际状态；系统不会冒险自动重复发送。
