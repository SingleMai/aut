# ADR 0027：桌面路由试验与历史报告 API

- 状态：已采纳（既定 MVP-16 功能的接口细化）
- 日期：2026-11-16

## 背景

桌面需要显示各 bot 的路由概率，并能从旧回包展开该次完整报告。直接调用分类器会绕过
树与日志约束；读取 Task.lastReport 则会在后续回合结束后把旧消息指向新报告。

## 决策

1. `POST /v1/route-test` 接收 `{text}`，通过专用的 `inbound` 树配置
   （版本 `route-test-1.0.0`）执行一个明确的 classify 节点，选项为当前可路由 bot。
   输出仅供试验，不送入 OpExecutor，不创建任务或主会话消息。每次试验写完整决策日志，
   eventRef 为 `route-test:<UUID>`；失败保留日志并返回 503，不制造概率。
2. 成功返回 `{decisionLogId, selectedBotId, probabilities:[{botId,name,probability}], backend, model}`。
   这只测试 bot 描述的区分效果，正式输入仍经主会话与完整 inbound 树处理。
3. `fullReportRef` 使用 `event:<StoredEvent.id>`，指向已持久化的成功 `turn.completed`
   事件。`GET /v1/reports/:ref` 返回 `{ref,text}`，text 为该事件的 finalReport。
   未知引用、非成功完成事件均返回 404；不回退到任务的最新报告。
4. 两个接口沿用 daemon 本地认证、Schema 校验和错误清理；路由试验不会自动触发，
   UI 说明输入会发送到用户配置的分类服务。密钥保存见已采纳的 ADR 0026：独立 0600 本地文件。

## 后果

历史报告无需新增重复存储表。路由试验与正式路由共享分类器配置和决策树执行器，
能够从日志核对原始概率；试验只影响诊断日志。

运行时组装按每次执行读取分类器配置快照，避免更改设置后仍使用旧 endpoint/key。
树执行入口可携带本次执行的内存 RewritePort，优先于 Layer 默认端口；端口只会在显式
rewrite 节点调用，不进入持久化 state。这样回包树能够使用当前 worker 的隔离 fork。
