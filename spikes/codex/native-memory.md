# Codex 原生记忆关闭探针

2026-11-24 验证本机真实 **codex-cli 0.171.0**。独立探针确认能力后，按 ADR-0068 接入生产 adapter，见下方联调结果。

## 结果

aut 启动自己的 app-server 时可以传入以下进程级参数，无需编辑用户全局配置：

```text
--disable memories
-c memories.use_memories=false
-c memories.generate_memories=false
```

| 控制 | 作用与证据 |
| --- | --- |
| `features.memories=false`，等价于 `--disable memories` | 原生读取扩展与后台提取/整理管线的总开关；当前版本源码默认 false。实测严格配置校验接受，`config/read` 读回 false。 |
| `memories.use_memories=false` | 禁止注入原生记忆上下文和提供专用 memory tools；实测有效配置为 false，作用由对应版本的扩展入口核对。 |
| `memories.generate_memories=false` | **新建线程**持久化为 `memory_mode=disabled`；实测新建和 fork 的合成线程均为 disabled。它本身不禁止启动整个后台整理管线。 |
| `thread/memoryMode/set`，`mode:"disabled"` | 修改某个线程持久化的学习资格；真实 RPC 返回 `{}`，仅查询探针线程的隔离 SQLite 行确认 enabled → disabled。这个 RPC 不控制记忆读取。 |

三个配置应一起使用：只关 feature，仍可能把新建线程标记为允许未来学习；只关 generate，也不是完整停用后台管线。

旧线程也需要处理。探针将自己的合成线程标为 enabled，再用已经关闭全部记忆的进程调用 `thread/resume`，该标记仍为 enabled；显式 `thread/memoryMode/set` 后变为 disabled。此次 resume 发生于同一 app-server；冷恢复不重写该标记的结论另由录制器 Resume 分支核对。未来接入应只修改 aut 所属线程，不能批量改用户其他会话。

## 验证范围

- **动态验证**：实际 CLI 严格配置校验、有效配置读回、一次无工具的合成回合、新建/fork 线程的持久资格、现有线程资格的设置与恢复行为。模型沿用已有 Provider 配置，本次为 `agy-cli/gemini-4-neon`。
- **源码核对**：固定 `rust-v0.171.0` 的读取与后台写入入口。没有开启原生记忆执行后台提炼，也没有做读取真实用户记忆的正反对照，不能把本次结果描述成完整后台读写实测。
- `debug prompt-input` 自建的扩展 registry 没有注册 memories，不能用它前后都没有 memory 的结果证明开关有效。
- 探针只读取自己的隔离状态数据库与合成线程，不读取真实记忆。原生会话记录仍由 CLI 按原有配置保存；不会改 `HOME`、`CODEX_HOME`、Provider、认证或全局 config。fixture 只保留记忆配置、合成 ID 与结果投影。
- 初次尝试在首个 turn 前检查状态行，尚未落盘而失败；脚本调整为合成回合完成后查询，正式 fixture 通过。

关闭开关不会删除已有记忆，也不会清除已进入旧会话历史的内容。`AGENTS.md` 属于独立的项目指令加载路径；此处没有关闭它。普通文件工具的读写权限也不由 memory 开关限制。

若机器存在管理员强制配置，不能仅凭启动参数显示“原生记忆已关闭”；应核对有效能力和配置。当前本机没有遇到阻止关闭的约束。

## 复现与来源

`native-memory-adapter-live.ts` 直接使用生产 adapter，故意在实例参数中启用三个原生记忆设置，
确认 aut 覆盖后可以完成一个合成回合，新线程持久资格仍为 disabled。随后仅把自己的合成线程标为 enabled，
关闭原进程，启动新进程恢复：生产 adapter 主动将旧资格改为 disabled；再 fork 的新线程也为 disabled。
三个 adapter 子进程均随 Scope 关闭。结果保存在 `fixtures/native-memory-adapter-0.171.0.json`，
Provider 与全局配置保持原样，仅在临时 SQLite 中读取探针自己的线程。

```sh
rtk proxy node spikes/codex/native-memory-adapter-live.ts /tmp/codex-native-memory-adapter-new.json
```

运行联调探针前需构建 `packages/adapters`。独立原生能力探针复现如下：

```sh
rtk proxy node spikes/codex/native-memory-probe.ts /tmp/codex-native-memory-new.json
```

输出路径必须不存在。`fixtures/native-memory-0.171.0.json` 保存本次结果；探针使用临时 workdir、SQLite 和日志目录。无生产 adapter 引用。

- [feature 定义](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/features/src/lib.rs#L1483)
- [读取与专用工具开关](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/ext/memories/src/extension.rs#L45)
- [后台管线启动条件](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/memories/write/src/start.rs#L19)
- [新线程学习资格](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/core/src/config/mod.rs#L1723)
- [线程资格设置 RPC](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server/src/request_processors/thread_processor.rs#L2037)
- [新建与恢复的记录行为](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/rollout/src/recorder.rs#L1012)
- [管理员 feature 约束](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/core/src/config/managed_features.rs#L217)
