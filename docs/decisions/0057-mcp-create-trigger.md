# ADR-0057：通过 MCP bridge 创建主动触发器

- 状态：已接受
- 日期：2026-11-21

## 背景

MVP-18 的主动触发器已经由 daemon 内的 `TriggerRegistry` 负责规则校验、持久化和运行账本。worker 与主助手协调会话需要能够通过已有 MCP bridge 创建计划任务，供 OpenMausBot 风格的 agent 工作流使用。另起一套 MCP 调度或存储实现会造成规则和权限语义分叉。

## 决策

1. 新增 MCP 工具 `create_trigger`。工具输入复用本地 API 的 `CreateTriggerInput`，输出返回完整的已持久化 `Trigger`。
2. `CreateTriggerInput` 支持可选稳定 `id`。调用方在投递结果不确定时可以用该 ID 核对触发器，重复的显式 ID 返回冲突并保留已有记录。未提供 ID 时由 `TriggerRegistry` 生成 UUID。
3. MCP bridge 继续使用现有 `SessionIdentity` 和 `BridgeBackend.authorize`。worker 只能为自身 Bot 创建触发器，coordinator 可以为任一已配置 Bot 创建触发器。目标 Bot 必须由 `TriggerRegistry` 校验为当前配置中的 Bot。
4. `create_trigger` 对两种合法会话角色可见，属于写操作，默认不声明为幂等或破坏性操作。网络超时或连接中断返回 `Indeterminate` 时 MCP 客户端不得自动重试，应使用稳定 ID或列表查询核对结果。
5. 工具只调用现有 `TriggerRegistry.create`，不新增调度器、运行账本、权限令牌或持久化路径。创建后的触发器继续由 daemon 的 `TriggerScheduler` 驱动。

## 后果

- agent 可以通过与其他 MCP 工具相同的本地会话身份创建计划任务，权限与任务生命周期保持一致。
- 稳定 ID 让调用方能够在不确定结果后安全核对，显式重复创建不会覆盖既有触发器。
- MCP bridge、protocol 和 daemon 需要同步维护输入输出 schema 与鉴权测试。

