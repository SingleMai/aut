# ADR-0022：决策树解释、输入绑定与失败日志

- 状态：已接受
- 日期：2026-11-16

## 背景

MVP-08 将既定树落成可回放配置。动态概率需要转换为选项，澄清卡必须携带完整 Op；
若这些变换藏在按意图分支的构造器中，就无法通过修改树数据调整策略。
现有日志强制 output，无法如实记录预算耗尽或表达式错误时尚未生成输出的情况。

## 决策

- Expr 增加通用 entries、record、filter、choose。它们只变换 JSON 数据，条件仍使用 Predicate；
  choose 只解释命中的一边。动态键禁止原型相关名称，record 的重复键报错，不静默覆盖。
- lookup 只读取自身属性，缺失返回 null；exists 对 null 返回 false。错误类型产生 TreeError。
  执行限制节点步数（默认1000）、表达式嵌套（100层）及最多两次 rewrite。
- classify 的主后端与可选备用后端共享单节点总预算（默认1500ms，可配置）；
  主调用失败且仍有预算时最多调用一次备用。每次调用均留完整请求、响应或错误。
- DecisionLog.output 仅在 execution.ok=false 时可缺。决策成功先持久化为执行待定，
  Op 完成登记后事务更新 execution，并保留其间写入的 correction。
- B2 仅对单题且允许自由文本的请求，将本条原文绑定到该题。多题/禁自由文本转绑定
  requestId 的澄清卡，复用原 SessionRequest 的整组题目，由 question-answer UI 提交。
  禁止复制同一句答案到多个题目。
- older_task 命中后展示真实旧任务候选的完整 Op，提示缩小范围并保留“都不是”慢脑出口；
  不增加协议不存在的 search Op。
- Chief 使用单 Queue/Fiber。submit 只入队；处理时重新读取状态，运行树、写日志、同步执行
  Op 的持久登记/入队部分，然后处理下一项。长时间 session 工作由 SessionManager 管理。
  确认文本来自固定模板，不调用模型。输入消息只由现有入口持久化一次。
- StateSource 的 UI 选项只从持久化原卡读取完整 Op，不信任客户端提供的动作内容。
  普通消息仅使用其之前六条摘录；引用回复由入口与事件原子保存为 quote:eventRef，随后同样只读之前的消息。
  待答候选同时满足 request=open 和 task.pendingRequestIds 成员。问题回答按原请求整组验证：
  expired/cancelled 允许交给 SessionManager 判断迟到转 send；answered 拒绝重复。
  task/bot/request 动态键拒绝 none/older_task 与原型键冲突；候选描述含预计算时间与报告短摘。
  “都不是”回写原日志 correction。Op 登记成功后，来源卡关闭与确认消息在同一 Store 事务保存；
  执行失败保留卡片，串行后续点击读取 answered 后被拒绝。

## 理由

沿用 OpenMausBot 的有限上下文、预计算候选与失败回落原则（738ec88 的 room-routing.ts）；
aut 的纯数据树由既定 DSL 解释，不借用其 LLM chief。通用集合变换让实验策略保持可审查。

## 后果

同步 protocol 与 decision-tree 文档、Schema、配置和行为 fixture。rewrite 仅通过显式端口调用，
本阶段提供未配置错误，后续 ReplyGate 注入实际实现。无输出失败仍有完整日志与类型化错误。
