# 内置主助手

aut 预置一个名为 aut 的主助手。它可以直接完成任务，也能在同一主会话与用户讨论、把任务交给专长助手。用户可在 Bot 页手动创建专长助手，也可委托 Agent 创建。明确指定专长助手时，chief 可直接派发。

## 配置与初始化

- `bots.json` 通过可选的 `system: "primary"` 标识唯一主助手。专长助手省略该字段。名称、模型、工作目录和 MCP 配置可编辑。两个助手不能共用 ID，初始 ID 从 `aut`、`aut-2` 依次选取可用值。
- daemon 启动时检查主助手。已有主助手且实例可用时直接使用。需要创建时，优先复用已配置助手的模型、effort 和工作目录。
- 缺少模型选择时，只读查询已配置的 Codex 实例。优先取 `config/read` 的模型与 effort，其次取 `model/list` 的唯一默认模型及其 effort。全新配置使用本地 Codex 实例与数据目录下的 `workspace/`。
- 探测总预算为 30 秒。探测失败时返回 `needsConfiguration`，用户可通过设置补齐实例和模型。保存后 daemon 在后台重试。设置保存和主助手初始化共用 `ConfigStore.withMutation`，串行修改配置。

字段与唯一性由[共享协议](../packages/protocol/src/config.ts)校验。[core](../packages/core/src/primary-assistant.ts) 定义默认配置与协调任务的判定条件，[daemon](../packages/daemon/src/primary-assistant.ts) 负责探测和初始化。桌面通过本地 API 读取同一份助手列表。

## 工作与协调

普通派发与协调使用各自独立的原生会话。主助手和专长助手的普通任务均使用 `worker` 权限。决策树的 `slow` 节点为同一主助手创建来源为 `coordination` 的任务，同时保存原决策 ID。这个会话以 `coordinator` 身份接收决策摘要，可通过 `propose_route` 提议派发。两种会话共享执行、提问、创建专长助手和回包流程。详见[决策树](decision-tree.md)和[会话 MCP](mcp-bridge.md)。

发布前数据格式见 [ADR-0048](decisions/0048-pre-release-data-baseline.md)。原生会话与桌面验证见 [MVP 验收](acceptance.md)。
