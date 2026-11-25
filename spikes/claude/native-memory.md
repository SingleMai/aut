# Claude Code 原生记忆关闭探针

2026-11-24 验证本机真实 Claude Code **2.1.330**。独立探针确认能力后，按 ADR-0068 接入生产 adapter，并补充 settings.env 优先级复核。

## 结果

| 新会话启动配置 | 临时 `CLAUDE.md` 标记 | 临时原生 `MEMORY.md` 标记 |
| --- | --- | --- |
| `autoMemoryEnabled: true`，关闭变量未设置 | 读取成功 | 读取成功 |
| `autoMemoryEnabled: true`，`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | 读取成功 | 返回 `null` |
| `autoMemoryEnabled: false`，关闭变量未设置 | 读取成功 | 返回 `null` |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` | 复核读取成功 | 复核读取成功 |

上述对照未在 settings 中设置同名环境变量。在这个条件下，当前版本可在启动子进程时用 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 关闭原生自动记忆注入，同时保留项目指令文件。无需修改用户的全局 settings、认证或 Provider 配置。`--settings` 中的 `autoMemoryEnabled: false` 也通过本机对照。

首次 `env=0` 正例返回了两个 `null`，单独重跑后两个随机标记都正确返回。原因未确定；首次失败原样保留，不能把整轮 fixture 说成全部通过。其余三组首次均通过。该版本 `system/init` 未提供 `memory_paths`，证据来自不含标记答案的提问与模型返回值，且模型工具数为 0。

### settings.env 的优先级复核

生产接入复核发现，Claude 会在启动后应用 `settings.env`，因此仅覆盖子进程环境还不充分。同版 CLI 的独立 canary 实测如下：

| 子进程环境 | `--settings` | `CLAUDE.md` 标记 | `MEMORY.md` 标记 |
| --- | --- | --- | --- |
| 关闭变量为 `1` | `autoMemoryEnabled:true`，`env` 中同名变量为 `0` | 可见 | 可见，原生记忆被重新开启 |
| 关闭变量为 `1` | `autoMemoryEnabled:false`，`env` 中同名变量为 `1` | 可见 | 返回 `null` |

据此生产 adapter 在进程环境和最终 CLI settings 两层同时强制关闭。实例 `--settings <JSON/path>` 或 `--settings=<JSON/path>` 的最后一份设置经 Schema 校验后复制到 0600 临时文件，仅覆盖 `autoMemoryEnabled` 及同名环境变量，其他设置、Provider 环境和 hooks 保留。相对文件路径按 session cwd 解析，原文件不改动；配置失败不会回退到原生记忆开启状态，临时文件随 Scope 清理。

## 证据边界

- **运行时已验证**：新会话的自动记忆读取开关，以及关闭后 `CLAUDE.md` 仍被读取。探针用临时工作目录、显式临时 `autoMemoryDirectory`、随机标记、禁工具/MCP/hooks、`--no-session-persistence`；没有读取或编辑真实记忆文件。只保存白名单协议字段和标记匹配结果；未保存原始系统提示词、用户配置或 stderr 内容。
- **官方文档说明与本机补充探针**：关闭变量停止原生记忆文件的自动创建与加载；`=0` 可覆盖 `autoMemoryEnabled: false`。接入需要同时固定子进程环境和最终 `settings.env` 中的 `=1`，不能只依赖其中一层。子 agent 的 `memory` 配置也受这个开关控制。
- **本机可执行文件核对，未实测后台写入**：2.1.330 内的自动提炼、auto-dream 启动路径检查自动记忆启用状态；关闭变量会使此判断返回 false。探针所有场景均额外设 `autoDreamEnabled: false`，因此不能把它当作关闭变量阻止后台整理的动态验证。
- **未覆盖**：恢复已有会话时清除历史中已注入的记忆；子 agent 的独立运行探针；长时间后台整理。关闭自动记忆也不是文件系统访问控制，普通文件工具仍可能按显式指令读写文件。

默认原生记忆目录依仓库/项目确定，同仓库的 worktree 和子目录共用；它本身不按 aut bot ID 隔离。新会话显式传入的临时目录在正例中生效，但本次没有把原生目录重定向作为 aut 方案决策。

## 复现与样本

```bash
rtk proxy node spikes/claude/native-memory-probe.ts /tmp/claude-memory-new-run.jsonl
rtk proxy node spikes/claude/native-memory-probe.ts /tmp/claude-memory-env-recheck.jsonl env-forced-on
rtk proxy node spikes/claude/native-memory-probe.ts /tmp/claude-memory-settings-bypass.jsonl settings-env-overrides-process
rtk proxy node spikes/claude/native-memory-probe.ts /tmp/claude-memory-settings-off.jsonl settings-env-forced-off
```

输出路径必须不存在。每个进程最多运行 60 秒，探针会清理自己的临时目录。可选 `AUT_CLAUDE_BIN` 选择 CLI，`AUT_CLAUDE_MODEL` 选择本次探针模型；默认使用当前 Provider 的模型配置。

- `fixtures/native-memory-2.1.330.jsonl`：四组首次结果，含保留的 env=0 正例失败。
- `fixtures/native-memory-env-recheck-2.1.330.jsonl`：env=0 单独复核通过。
- `fixtures/native-memory-settings-env-bypass-2.1.330.jsonl`：证实 settings.env=0 可覆盖进程 env=1 并重新注入记忆。
- `fixtures/native-memory-settings-env-off-2.1.330.jsonl`：两层均关闭后，记忆标记不可见、项目指令仍可见。

官方来源（检索日期同上）：

- [自动记忆开关与目录范围](https://code.claude.com/docs/en/memory#auto-memory)
- [环境变量说明](https://code.claude.com/docs/en/env-vars)
- [每次启动的 settings 与优先级](https://code.claude.com/docs/en/settings)
- [子 agent 的持久记忆与关闭条件](https://code.claude.com/docs/en/sub-agents#enable-persistent-memory)
