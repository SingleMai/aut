# ADR-0061：全局 MCP 服务器注册表、工具授权与 daemon supervisor

- 状态：已接受
- 日期：2026-11-23

## 背景

aut 已支持把 Bot 配置中的 MCP server 直接注入 harness 会话，也有一个始终挂载的内置 `aut` MCP bridge。当前外部 server 配置仍保存在 Bot 的 `mcpServers[]` 中，桌面端通过 JSON 文本框编辑，缺少连接测试、工具发现、OAuth、健康状态和逐工具授权。

OpenMausBot 的 MCP 页面把 server 注册、连接测试、按 Bot 分配、工具目录和失败降级放在同一条链路中。其静态 header 和环境变量在 UI 中按只写字段处理，OAuth token 单独存储。aut 需要沿用这种可观察的交互和失败语义，同时使用自己的 Effect、Schema、配置和 daemon 边界。

## 决策

1. **全局注册表**

   外部 MCP server 和 Bot grant 统一保存到 `~/.aut/mcp.json`。每个 server 有稳定 ID、名称、传输方式、连接参数、认证状态、健康状态和最近一次工具目录。每个 server 使用一套 OAuth 凭据。Bot 通过独立 grant 引用 server。内置 `aut` bridge 不进入注册表，也不受外部 server 开关影响。

2. **传输方式**

   首期只支持工具能力，覆盖本地 `stdio`、Streamable HTTP 和旧式 SSE 的握手、`tools/list` 与 `tools/call`。配置中的 `http` 表示 Streamable HTTP，`sse` 只用于明确提供 SSE endpoint 的旧 server。`resources`、`prompts` 和 elicitation 留到后续阶段。

3. **认证与密钥**

   敏感的环境变量、HTTP header 和 OAuth token 不写入 `bots.json`、`mcp.json`、日志或 API 返回值。静态凭据使用 `secret:` 或 `env:` 引用，真实值由现有 `SecretStore` 和 `SecretReader` 解析。

   HTTP OAuth 首期支持 RFC 9728 protected-resource metadata、PKCE S256、动态 client registration 和预注册 client ID 两条路径。daemon 使用本机 loopback 回调完成浏览器登录。OAuth token、refresh token 和 client secret 存在本地凭据存储中。修改 server URL、移除 server 或显式退出登录都会清理关联 token。Bot 不执行登录，未完成登录的 server 不注入任何回合。

4. **Bot 与工具授权**

   每个 Bot 使用 `McpBotGrant` 引用 server，grant 包含启用状态和精确的 `allowedTools`。新 server 默认关闭，新的 grant 默认关闭且工具列表为空。只有用户显式分配 Bot、开启 grant 并选择工具后，工具才会进入该 Bot 的会话。

   工具名称使用 server 返回的稳定名称，首期不支持通配符。工具目录变化后，旧授权只保留仍存在的精确名称，新增工具保持关闭。

5. **daemon supervisor**

   daemon 新增 MCP supervisor，负责 server 的长期生命周期、握手、工具目录、健康状态、重启和退避重试。保存后由用户显式测试，启用的 grant 在首个任务需要工具时懒连接。每个 Bot grant 的 stdio server 使用独立进程和独立环境，避免不同 Bot 共享工作目录、凭据或工具权限。远程 HTTP/SSE server 不启动本地进程，按 server 与 Bot grant 维护隔离的连接状态。

   supervisor 为 harness 提供受授权的 MCP proxy。proxy 只暴露当前 Bot grant 的 `allowedTools`，把调用转发给对应的长期 server。harness 不直接接触全局注册表中的原始凭据。`aut` bridge 继续通过当前 task identity 单独注入。

6. **连接失败与运行失败**

   server 保存成功不代表已启用。测试失败、未登录、握手超时或工具目录读取失败时，server 保持关闭，并只从受影响的 Bot grant 中排除。任务继续运行并收到结构化状态提示，其他 server 和 `aut` bridge 不受影响。

   已建立连接的工具调用失败通过 MCP `isError` 返回给 harness，允许当前回合继续处理。连接结果不确定时不自动重复调用。supervisor 按退避计划重试并更新健康状态，避免每个任务重复启动同一个坏 server。

7. **首期配置边界**

   首期直接切换到全局注册表和 Bot grant，不读取或迁移 Bot 配置中的 `mcpServers[]`。`BotConfig` 删除该字段，旧配置格式不在首期支持范围内。配置文件损坏时保留原文件并返回配置错误。

8. **桌面交互**

   新增顶层 MCP servers 页面，提供 server 卡片、transport 表单、测试、启用、OAuth 登录/退出、健康状态和工具目录。Bot 编辑器增加 server 分配入口和工具选择入口，移除旧 JSON 配置入口。工具运行记录继续沿用 `docs/omb-tool-parity.md` 的 server/tool 摘要、错误和详情展示。

9. **范围**

   首期只覆盖 macOS、本地 daemon、Codex 主链路和现有 Claude/ACP adapter 已声明的 MCP 注入接口。团队共享、组织策略、云端凭据同步、动态工具搜索和模型工具数量优化另行设计。

## 后果

- MCP 配置从 Bot 内嵌 JSON 变为可测试、可观测、可按 Bot 和工具授权的全局能力。
- daemon supervisor 会增加进程、连接和 OAuth 生命周期管理，需要独立的 fixture、探针和恢复测试。
- 任务启动不再因为单个外部 MCP server 故障而整体失败，用户可以在 MCP 页面查看并修复具体 server。
- 首期不承担旧 Bot 配置迁移，Bot 配置模型可以直接收敛到全局注册表和 grant。
- MCP proxy、SecretStore 和 harness adapter 的边界需要在实现前分别补充 protocol schema、local API 和 adapter fixture。

