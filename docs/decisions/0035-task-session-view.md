# ADR-0035：任务按工作会话展示

- 状态：已接受（用户明确选择完整工作会话，包含工具过程）
- 日期：2026-11-17

## 背景

用户反馈任务详情仍像资料卡，并指出它应当类似 Agent session。架构 §3 已定义一个
Task 对应一个 Bot 的持久 session；同一 session 可以包含多个 turn，idle 后仍可继续委托。
当前桌面只呈现状态、队列和最近完整报告，没有体现这一工作会话模型。

## 变更前核实的实现

- `SessionManager.receiveEvent` 将全部 SessionEvent 写入 events，并通过事件总线发布。
  `message.delta` 已持久化，桌面尚未消费它。
- 本地 API 只能读取 Task 快照、单个问题和按引用查报告，尚无任务历史分页接口。
- Codex adapter 已有 `transcript()`，通过 `thread/read(includeTurns: true)` 读取
  user / assistant / tool 文本；当前统一返回值没有稳定 item ID 或结构化工具卡信息。
- 统一 SessionEvent 没有工具开始/完成事件，也没有跨历史/实时通道共用的事件 ID。
- 取消或重启后的迟到通知仍先写审计记录，不能直接把每条审计记录当作当前有效执行。

## 决策

保持单一主会话输入入口，将任务详情改为只读工作会话：顶部显示 Bot、状态和必要控制，
正文按回合呈现收到的委托、助手输出、待答问题、结果与中断。继续交流和回答回到主会话并定位来源。
任务列表显示标题、Bot、最近活动和状态；内部 ID、队列计数等移入次要信息区域。

- 采用完整原生会话快照：`SessionHistory` 按原生 turn ID 分组，`SessionItem` 保留稳定 item ID、
  用户/助手/工具/记录类型、状态、时间及工具输入输出。工具使用可折叠步骤展示，未知状态不推断为成功。
  借鉴 OpenMausBot 的 `ToolActivity.tsx` / `ActivityRun.tsx`，保留 aut 的原生 DOM/Effect 客户端。
- 新增可选 `sessionHistory` 能力和 adapter/handle 的 `readSession` 方法。
  已运行的任务读取现有 handle；冷任务只启动有 Scope 的临时 app-server，执行 initialize 与 thread/read，
  读取后退出。禁止为查看历史调用 SessionSetup、resumeSession 或 startTurn；不改任务状态、队列或 Provider 配置。
- `GET /v1/tasks/:id/session` 返回任务与按回合分页的快照，默认 10 轮、最多 20 轮，分页游标为 turn ID。
  未创建会话、能力不支持与原生记录不可用分别明确标注，不能以空列表冒充完整历史。
- 实时通道使用现有 `message.delta` 和新增 `session.changed` 作为失效通知，客户端回读快照。
  不把无稳定 ID 的 WS 通知直接拼进历史，不把审计事件当作权威完整 transcript。
  同任务读请求串行；客户端在请求进行中合并刷新需求，保留工具/历史展开状态和阅读位置。
- Codex 0.169.0 实测发现：执行中 thread/read 可能尚不包含正在运行的工具，outputDelta 也不一定覆盖全部输出。
  live adapter 必须以稳定 ID 合并原生快照和流式观察，不因快照缺项删除当前步骤；completed 的完整输出具有权威性。
  turn 的秒级时间与 item 的毫秒时间在 adapter 归一化，不推断未确认工具成功。

## 验证依据

当前版本探针见 `spikes/codex/fixtures/session-view-0.169.0.jsonl` 与
`session-read-0.169.0.jsonl`：包含命令、文件修改、开始/结束、原生 item ID 和无 resume 的冷读。
MCP 工具的当前版本真实样本另随 adapter 落盘。协议映射与合并规则以这些样本回放验证。

## 边界

本决策不修改 chief 路由、Task 状态机、问题投递所有权或回包门槛，不另开 Bot 私聊输入框。
保持现有持久化格式；新增通知只用于展示，不能驱动任务状态转移。旧 adapter 缺少可选能力时明确降级。
