# 实现路线

每个阶段都有完成标准（DoD）。上一阶段 DoD 未满足不得进入下一阶段。MVP = P0–P6。

## P0 协议探针（Codex）
- 按 `harness-adapters.md` §6 完成 `spikes/codex/`。
- **首要问题**：Codex 在什么配置/模式下会发出 `item/tool/requestUserInput` 与 async 提问？
- 确认：`finalReport` 取法、是否有原生 fork、transcript 来源、steer 行为。
- **DoD**：fixtures 已录制并标注版本；`harness-adapters.md` 能力表中 Codex 列无 ❓；若提问能力受限，提交 ADR 说明对策。

## P1 工程骨架
- pnpm monorepo、TS strict、lint/format、Effect 锁定版本并写入 AGENTS.md §3。
- `packages/protocol`：`protocol.md` 中全部 Schema。
- `packages/core`：Store（SQLite）、MainThread、TaskRegistry（表驱动状态机）、EventBus、DecisionLog。
- **DoD**：状态机转移表 100% 用例覆盖；daemon 可启动并通过本地 API 读写 main thread。

## P2 Codex adapter
- 实现 `HarnessAdapter`：start/resume/turn/steer/interrupt/respond、全放行参数、提问拦截（同步 + async）、能力声明。
- **DoD**：基于 P0 fixtures 的回放测试全部通过；真实 Codex 下能完成"派发 → 提问 → 回答 → 回包"。

## P3 Classifier + 决策树执行器
- `packages/classifier`：`Classifier` 接口 + Jev 后端（参考 OMB `server/decider/jev.ts`），固定模型版本，超时与重试。
- 决策树配置 Schema、通用执行器、`inbound` v1 树、clarify 卡片、决策日志。
- **DoD**：`decision-tree.md` §6 每个分支有 fixture；Classifier 不可用时降级到 clarify 的用例通过。

## P4 端到端主链路
- new / send（immediate、queue、steer、restart、排出合并）/ control / answer。
- handoff-prune 树与交接包渲染；McpBridge：`read_main_thread`、`list_tasks`、`get_task`。
- request 树（permission 放行、question 转卡片）。
- **DoD**：真实 Codex 上跑通 `docs/` 中所有流程（ask 除外）；每次路由都有完整决策日志。

## P5 回包与进度
- reply-gate 树：长度规则 + Jev 可读性 + fork/临时 session 改写 + 截断。
- ask：fast（结构化数据模板）/ deep（fork 或临时 session 读 transcript）。
- **DoD**：超长/技术性回包被改写的用例通过；原 session 上下文未被改写污染（以 transcript 校验）。

## P6 主助手协调与桌面端
- 一个内置主助手 aut。普通任务直接执行，escalate 创建协调会话，协调会话可用 `propose_route`。
- Electron：main thread、问题/澄清卡片、任务面板（只读）、bot 配置与"路由试验"、classifier 后端设置。
- **DoD**：用户可手动在 Bot 页建 Bot，也能在主会话委托 Agent 创建。用户通过主会话完成派活、回答提问、问进度、追加指令、取消/重试、与主助手讨论。

## MVP 任务拆分（Tutti 项目任务 `[MVP-NN]`）

| 任务 | 内容 | 依赖 | 阶段 |
|---|---|---|---|
| MVP-01 | Codex 协议探针 | — | P0 |
| MVP-02 | 工程骨架 | — | P1 |
| MVP-03 | protocol Schema | 02 | P1 |
| MVP-04 | core 存储/状态机/日志 | 03 | P1 |
| MVP-05 | daemon + 本地 API + 恢复 | 04 | P1 |
| MVP-06 | Classifier + Jev | 03 | P3 |
| MVP-07 | Codex adapter | 01, 03 | P2 |
| MVP-08 | 决策树执行器 + inbound 树 | 04, 06 | P3 |
| MVP-09 | SessionManager + new/send/control | 03, 04（联调 07） | P4 |
| MVP-10 | mcp-bridge | 04（propose_route 依赖 08） | P4 |
| MVP-11 | 交接包 + handoff-prune | 08, 09, 10 | P4 |
| MVP-12 | 问答拦截全链路 | 07, 08, 09 | P4 |
| MVP-13 | reply-gate | 08, 09 | P5 |
| MVP-14 | ask 进度 | 08, 09, 13 | P5 |
| MVP-15 | 主助手与协调会话 | 09, 10, 11, 13 | P6 |
| MVP-16 | Electron 桌面端 | 05（可先 mock 03） | P6 |
| MVP-17 | 端到端验收 | 全部 | — |

可并行起步：01 ∥ 02；03 完成后 04 ∥ 06 ∥ 07（需 01）∥ 16（mock）。

## 之后
- Claude Code adapter 已完成 2.1.325 的协议探针和生产 adapter，后续继续做 provider 版本复验。
- 通用 ACP adapter 已接入 OpenCode 1.19.5，并复用 provider 的 ACP 认证握手。Grok、Gemini、Qwen 仍需各自的真实回合探针和能力确认。
- 备用 Classifier 后端（LiteLLM 等结构化输出）。
- 基于决策日志的评测集与阈值调优工具。
- trigger 事件源与主动型 bot。
- request 树的"只有用户能回答吗"自动默认策略（需 ADR）。
