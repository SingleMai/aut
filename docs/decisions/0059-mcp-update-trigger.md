# ADR-0059：通过 MCP bridge 修改主动触发器

- 状态：已接受
- 日期：2026-11-21

## 背景

MCP bridge 已能创建和读取触发器，但 agent 仍需要通过本地 HTTP API 才能暂停、恢复或调整计划。`TriggerRegistry.update` 已经实现了 schema 校验、目标 Bot 校验和 schedule 变更后的下一次 occurrence 计算，MCP 应直接复用该服务。

## 决策

1. 新增 MCP 工具 `update_trigger`。输入由 `triggerId` 和现有 `UpdateTriggerInput` 组成，输出返回更新后的完整 `Trigger`。
2. worker 只能修改当前会话 Bot 所拥有的触发器，也不能把触发器改指向其他 Bot。coordinator 可以修改任一已配置 Bot 的触发器，目标 Bot 继续由 `TriggerRegistry` 校验。
3. 工具对两种合法会话角色可见，标记为写操作和幂等操作，不声明为破坏性操作。MCP 客户端仍不自动重试不确定的写请求，调用方应使用 `get_trigger` 核对结果。
4. 暂停与恢复使用 `enabled: false` 或 `enabled: true`。schedule 变化沿用 `TriggerRegistry.update` 的下一次 occurrence 计算，不新增调度逻辑。
5. 本切片不引入删除、失败自动重试或新的持久化路径。删除和重试需要分别定义运行账本与权限语义。

## 后果

- agent 可以在 MCP 会话内完整调整现有计划的常用字段。
- 修改权限与创建权限保持一致，避免 worker 通过更新操作绕过 Bot 归属约束。
- 不确定更新结果可以通过只读 `get_trigger` 查询确认。

