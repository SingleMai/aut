# ADR 0031：daemon 的会话配置与 MCP 组装

- 状态：已采纳（既定组件的运行时组装）
- 日期：2026-11-16

## 背景

SessionManager 依赖会话 MCP 配置，MCP 的提议工具依赖 Chief，而 Chief 的 OpExecutor 又依赖
SessionManager。直接把三个 Layer 互相注入会形成构建环。bot soul 还需要在工作目录落地，
但不能覆盖用户原有 AGENTS.md、Provider 或 harness 全局配置。

## 决策

- daemon 以 harness kind → factory 注册表实现 HarnessResolver；core 仍只看接口和 capabilities。
  配置的 command/args/env 原样传入 factory，不写 CLI 配置。
- 独立 SessionBridge Service 保存一次性 Deferred<BridgeSocket>，只在执行 prepare 时等待。
  SessionManager/Chief 完成构建后启动 MCP listener 并绑定 Deferred，最后开放 HTTP 入站。
  Layer 获取阶段不调用 prepare，因此没有构建循环；session 的 Scope 拥有凭据注册。
- listener 使用本次 daemon 独占的短路径临时目录（0700）和 socket（0600），凭据包含实际
  socket 路径。关闭只清理本次目录。崩溃后的旧路径不会阻止下一次启动，也不需要盲删旧 socket。
- SessionSetup 使用 bot 配置的现有 workdir，在其 `.aut/souls/<sha256(botId)>.md` 原子写入
  受 aut 管理的 soul。拒绝该管理目录的 symlink 和来源不明的同名文件；不覆盖 AGENTS.md。
  固定开发指令声明角色文件位置、MCP 按需读取上下文与统一回包要求。文件仅存长期角色指令，
  不追加对话、记忆或完整主会话。
- `aut` 是会话 MCP 保留名称；bot 的额外 MCP 不能占用该名称。运行时凭据只通过子进程
  env 注入，不能写入 bots.json、Task、交接包或 DecisionLog。
- HTTP 入站先按串行 admission 顺序原子落消息和 StoredEvent，再投递常驻 Queue；提交到
  入队之间不可中断，HTTP 调用取消不会留下只落盘却未交接的消息。chief 使用该 StoredEvent.id
  作为 eventRef，仍是所有用户消息与慢脑提议的唯一决策排序点。
- 开放 HTTP 前，按事件存储顺序恢复没有任何关联 DecisionLog 的用户事件。已有日志的事件
  不重跑分类或执行。若记录仍为 Execution pending、没有回执，或进度查询只有回执没有结果，
  写入稳定 ID 的恢复提示；未确认登记的日志标记中断。实际任务按既定 interrupted 流程恢复，
  用户显式 resume/retry 后再执行。重复启动不能重复提示或重放已经登记的工作。

## 后果

依赖方向不变，启动顺序明确。更改 bot 配置只影响后续 session 建立；现有会话保留自己的
adapter 和配置快照。原生 fork 沿用父会话的 MCP 凭据，fork 关闭不撤销父凭据。
