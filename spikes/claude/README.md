# Claude Code 协议探针

原生自动记忆开关的 **2.1.330** 对照实测与证据边界见 [native-memory.md](native-memory.md)，统一关闭的接入决策见 ADR-0068。

本目录保存 Claude Code `2.1.325` 在 macOS 上的真实 `stream-json` 收发样本。探针只使用新的临时工作目录和固定合成提示，不读取已有会话，也不修改全局配置。Claude Code 的认证和模型沿用当前机器配置。

## 已确认的协议

| 场景 | 结论 | 样本 |
|---|---|---|
| 普通回合 | `system/init` 提供 `session_id`，随后输出 `stream_event`、`assistant`、`user` 工具结果和 `result`。`result.result` 是最终文本，成功由 `is_error:false` 与 `terminal_reason:"completed"` 确认。 | `fixtures/normal-2.1.325.jsonl` |
| 问题 | `bypassPermissions` 仍可调用 MCP 的 `ask_user`。答案通过本地 socket 回到工具结果，模型继续产生最终回包。 | `fixtures/question-2.1.325.jsonl` |
| steer | 在 stdin 写入带 `uuid` 的第二个 `user` frame，会先收到 `command_lifecycle:queued`，随后收到带 `isReplay:true` 的回放和第二个原生回合，最终 `result.user_message_uuids` 包含该 UUID。 | `fixtures/steer-2.1.325.jsonl` |
| interrupt | `SIGINT` 会产生 `[Request interrupted by user]`、`result.is_error:true`、`terminal_reason:"aborted_streaming"`，进程随后退出。 | `fixtures/interrupt-2.1.325.jsonl` |
| resume | 新进程使用 `--resume <sessionId>` 能恢复持久会话并继续回合。 | `fixtures/resume-2.1.325.jsonl` |
| fork | `--resume <sessionId> --fork-session --no-session-persistence` 能启动隔离分支。 | `fixtures/fork-2.1.325.jsonl` |

探针按原始协议记录 `meta`、`send`、`receive`、`stderr`、`exit` 和少量断言行。生产代码只消费协议字段，不能把探针中的固定答案带入运行时。

## 复现

要求 Node `24.18.0`、可运行且已登录的 `claude`。每次输出都必须是新文件，脚本拒绝覆盖已有文件。

```sh
node --experimental-strip-types spikes/claude/probe.ts normal /tmp/aut-claude-normal.jsonl
node --experimental-strip-types spikes/claude/probe.ts question /tmp/aut-claude-question.jsonl
node --experimental-strip-types spikes/claude/probe.ts steer /tmp/aut-claude-steer.jsonl
node --experimental-strip-types spikes/claude/probe.ts interrupt /tmp/aut-claude-interrupt.jsonl
node --experimental-strip-types spikes/claude/probe.ts resume /tmp/aut-claude-resume.jsonl
node --experimental-strip-types spikes/claude/probe.ts fork /tmp/aut-claude-fork.jsonl
```

`AUT_CLAUDE_BIN` 和 `AUT_CLAUDE_MODEL` 可覆盖 CLI 路径与模型。`question` 场景使用已构建的 `packages/adapters/dist/claude/question-proxy.js`，因此运行前先执行 `pnpm --filter @aut/adapters build`。

生产 adapter 的真实联调脚本会验证完成回合、MCP 问题卡片、steer、中断、跨进程 resume 和 Scope 清理：

```sh
pnpm --filter @aut/adapters build
node --experimental-strip-types spikes/claude/adapter-live.ts
```

固定版本和源码来源记录见根目录 `NOTICE`。生产 Claude adapter 的回放测试必须以这些真实字段为依据，OpenMausBot 代码只作为 Apache-2.0 的可移植实现来源。
