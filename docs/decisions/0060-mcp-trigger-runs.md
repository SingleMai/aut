# ADR-0060：通过 MCP bridge 读取触发器运行账本

- 状态：已接受
- 日期：2026-11-21

## 背景

桌面自动化页面已经可以展开触发器运行记录，agent 仍只能通过 `get_trigger` 判断计划是否存在，无法读取 occurrence 的排队、执行、失败或跳过状态。daemon 已有 `TriggerRegistry.listRuns`，MCP 应复用这一边界，避免为 agent 再造一套运行历史查询。

## 决策

1. 新增只读 MCP 工具 `list_trigger_runs`。输入包含 `triggerId` 和可选 `limit`，默认返回最近 50 条，最大值为 50。
2. 工具先确认触发器存在，再通过 `TriggerRegistry.listRuns` 返回按 `scheduledAt` 倒序排列的运行记录。未知触发器返回 `NotFound`。
3. 工具对 worker 和 coordinator 可见，沿用现有 MCP bridge 的会话授权边界，不触发调度、任务创建或运行账本写入。
4. 输出使用现有 `TriggerRun` schema，保留 `taskId`、时间、状态和错误字段。调用方可以用 `get_trigger` 与 `list_trigger_runs` 核对不确定的创建或更新结果。

## 后果

- Bot 可以在 MCP 会话内确认触发器是否实际排队、运行、完成、失败或被跳过。
- 读取上限与其他 MCP 列表工具一致，避免运行账本无界增长响应。
- 运行记录仍由 `TriggerRegistry` 统一定义，未来删除和重试继续单独定义权限与语义。
