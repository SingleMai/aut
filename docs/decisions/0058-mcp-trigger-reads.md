# ADR-0058：通过 MCP bridge 读取主动触发器

- 状态：已接受
- 日期：2026-11-21

## 背景

`create_trigger` 已经支持稳定 ID和不确定结果保护。调用方需要在连接超时后通过 MCP 查询触发器，确认创建是否已经落盘。daemon 已有 `TriggerRegistry.get` 与 `TriggerRegistry.list`，重复实现读取和筛选会让 MCP 与本地 API 的数据语义分叉。

## 决策

1. 新增只读 MCP 工具 `get_trigger` 与 `list_triggers`。两者都通过现有 `SessionIdentity` 鉴权，并复用 `TriggerRegistry`。
2. `get_trigger` 接收 `triggerId`，返回完整 `Trigger`。触发器不存在时返回 `NotFound`。
3. `list_triggers` 支持可选 `botId`、`enabled` 和 `limit`，`limit` 默认 50，最大 50。结果按 `TriggerRegistry.list` 的更新时间倒序返回。
4. 两个工具对 worker 和 coordinator 可见，声明为只读且幂等。worker 的写入限制继续只作用于 `create_trigger`，读取遵循现有 MCP bridge 的会话授权边界。
5. 读取工具只做持久化查询，不触发调度、Chief 路由、任务创建或运行账本写入。调用方在 `create_trigger` 返回 `Indeterminate` 后优先使用 `get_trigger` 搭配稳定 ID核对结果。

## 后果

- MCP 调用方可以在一次不确定创建后完成无副作用的结果核对。
- 读取筛选和上限与 `list_tasks` 的 MCP 约束一致，避免一次响应无界增长。
- 未来的删除工具和失败重试仍需单独定义权限和不确定写入语义。

