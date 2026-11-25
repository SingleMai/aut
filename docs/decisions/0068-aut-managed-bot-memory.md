# ADR-0068：bot 记忆由 aut 统一管理

- 状态：已接受（用户明确要求统一关闭 Harness 原生自动记忆，不提供来源选择）
- 日期：2026-11-24

## 背景

原规范只提供 soul，未定义 bot 长期记忆。用户已确认采用按 bot 隔离的文件系统记忆，
并默认通过现有定时机制整理。Harness 的原生自动记忆可能按项目或用户目录共享，无法代替 bot 的边界。
Claude Code 2.1.330 和 Codex 0.171.0 探针确认可以在 aut 子进程中关闭原生自动记忆，无需修改全局配置。

## 决策

1. bot 记忆统一归 aut 管理，不增加 Harness 原生记忆与 aut 记忆的来源选择。设计规范集中在 [memory.md](../memory.md)。
2. aut 启动的 Claude / Codex 工作、协调、恢复及 fork 会话统一关闭原生自动记忆。
   soul、项目指令文件、原生会话历史及原生上下文压缩仍按各自职责工作。
3. Claude 子进程与最终 settings 的 env 都强制 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`，最终 settings 另设
   `autoMemoryEnabled:false`。保留其余实例设置，防止 CLI 在启动后通过 settings.env 重新开启原生记忆。
4. Codex 子进程关闭 `features.memories`、`memories.use_memories` 和 `memories.generate_memories`，
   并核对启动配置。恢复已有 aut 线程时显式将持久学习资格设为 disabled；不修改其他用户线程。
   无法确认关闭时走现有 adapter 错误路径，不静默启用原生记忆或增加用户选择流程。
5. 只使用已有探针确认的 Harness 控制。ACP 没有在本次获得通用原生记忆开关，后续接入该能力须先验证具体 provider；不伪造已关闭的状态。

## 理由

由一个系统负责长期记忆，避免项目级共享记忆绕过 bot 隔离，也让用户只需要维护一套文件。
进程级开关不影响用户在 aut 外自行使用 CLI。Codex 仅关闭读取不足以禁止将会话用于未来学习，
仅关闭生成也不代表停止整个后台整理管线，因此需要同时处理三项设置与已有线程资格。

## 后果

本 ADR 定义原生自动记忆关闭策略；bot 记忆目录、读取注入、用户编辑与默认定时整理由
[ADR-0069](0069-bot-memory-files-and-dreams.md) 接续定义并实现。旧会话已载入的内容不会被开关从历史中移除。
探针证据见 `spikes/claude/native-memory.md`、`spikes/codex/native-memory.md`；后台长期整理停用的语义
由官方说明和对应版本实现核对，尚无长时间后台整理动态测试。
