# ACP 适配器探针

ACP 适配器直接连接 provider CLI 的 ACP stdio 端点，运行时链路是：

```text
aut core → aut ACP adapter → provider CLI
```

OpenMausBot 只提供 Apache-2.0 代码来源和协议处理参考。aut 不 fork OpenMausBot，也不把它作为运行时依赖，`enterprise/` 目录没有被使用。来源、固定 commit 和复用文件见根目录 `NOTICE`。

## 已验证的 provider

本目录包含 **OpenCode 1.19.5** 和 **Grok 1.0.89** 的真实 ACP 收发样本。探针在 macOS 上启动 provider 的 ACP stdio 进程，使用独立临时工作目录，不读取或修改已有会话配置。

已录制的场景如下。

| 文件 | 场景 |
|---|---|
| `fixtures/normal-opencode-1.19.5.jsonl` | `session/new`、普通 `session/prompt`、消息流和 `end_turn` |
| `fixtures/permission-opencode-1.19.5.jsonl` | 原生 `session/request_permission`，回填 `allow_once` |
| `fixtures/interrupt-opencode-1.19.5.jsonl` | `session/cancel` 和 `stopReason: cancelled` |
| `fixtures/resume-opencode-1.19.5.jsonl` | 新进程 `session/load` 后继续 prompt |
| `fixtures/fork-opencode-1.19.5.jsonl` | provider `session/fork` 返回新 session ID |
| `fixtures/auth-required-grok-1.0.89.jsonl` | Grok `initialize` 宣布 `grok.com` 登录方式，未登录时 `session/new` 返回认证错误 |

OpenCode 的 `initialize` 实测公布 `close`、`fork`、`list`、`resume` 能力。通用 aut ACP adapter 当前只声明 `resume`，因为 provider 的 fork 结果尚未安全包装成独立的 aut `SessionHandle`。这不影响 provider 能力的记录，后续实现需要保持父 session 与 fork session 的 Scope 和传输隔离。

当 `session/new` 或 `session/load` 返回模型 `configOptions` 时，adapter 会通过 `session/set_config_option` 应用 Bot 选择的模型和已声明的 effort。provider 没有公布对应配置项时，adapter 保留 provider 的 session 默认值。

## Grok 扩展

OpenMausBot 的 ACP 源码还包含 Grok 的 `_x.ai/ask_user_question` 扩展。生产 adapter 已解析多问题、选项、多选标记和自由文本注释，并将答案回填为 Grok 的 `answers` / `annotations` 结构。Grok 1.0.89 的真实样本确认了 `initialize` 和认证边界，当前机器没有可用的 Grok 登录凭证，尚未录制真实回合。完成 `grok login` 后，需用同一探针录制普通回合、提问、interrupt、resume，再更新能力声明。

## 复现探针

要求 Node 24 LTS 和已经登录的 provider CLI。脚本拒绝覆盖已有输出文件。

```sh
rtk proxy node --experimental-strip-types spikes/acp/probe.ts normal /tmp/aut-acp-normal.jsonl
rtk proxy node --experimental-strip-types spikes/acp/probe.ts permission /tmp/aut-acp-permission.jsonl
rtk proxy node --experimental-strip-types spikes/acp/probe.ts interrupt /tmp/aut-acp-interrupt.jsonl
rtk proxy node --experimental-strip-types spikes/acp/probe.ts resume /tmp/aut-acp-resume.jsonl
rtk proxy node --experimental-strip-types spikes/acp/probe.ts fork /tmp/aut-acp-fork.jsonl
```

可用环境变量覆盖 CLI 路径和参数。

```sh
AUT_ACP_BIN=/path/to/provider AUT_ACP_ARGS="acp" \
  rtk proxy node --experimental-strip-types spikes/acp/probe.ts normal /tmp/aut-acp-normal.jsonl
```

Grok 使用 `agent stdio` ACP 入口。

```sh
AUT_ACP_BIN=grok AUT_ACP_ARGS="agent stdio" \
  rtk proxy node --experimental-strip-types spikes/acp/probe.ts normal /tmp/aut-acp-normal-grok.jsonl
```

`spikes/acp/fake-acp-cli.ts` 是离线测试用的确定性协议端点。它只覆盖 adapter 测试所需的 JSON-RPC 生命周期，不代表任何 provider 的真实协议能力。

## 离线验证

生产代码位于 `packages/adapters/src/acp/`，测试会逐行解码本目录的真实收发样本，并使用 fake ACP 端点覆盖普通回合、原生问题、Grok 扩展和 resume。

```sh
rtk proxy pnpm exec vitest run packages/adapters/src/acp
rtk proxy pnpm exec tsc --build packages/adapters/tsconfig.json
```
