# ADR-0055：Claude Code 提问拦截采用 adapter 注入的 ask_user 工具

- 状态：提议
- 日期：2026-11-20

## 背景

铁律 9 要求默认最高权限，铁律 10 要求问答原生拦截。Claude Code 在 `--permission-mode bypassPermissions` 下不提供原生 `AskUserQuestion`。`docs/harness-adapters.md` §4.2 原先列出两个方案，计划以探针结果定案并写入 ADR：

- 方案 A：bypass 放行权限，aut 注入 MCP `ask_user` 工具接收提问。
- 方案 B：不用 bypass，用 `--permission-prompt-tool` 指向 aut 审批工具，自动放行所有工具，并在原生 `AskUserQuestion` 处回填答案。

Claude Code 2.1.325 的探针只录制了方案 A（`spikes/claude/fixtures/question-2.1.325.jsonl`）。方案 B 没有录制样本。

## 决策

- Claude adapter 采用方案 A。权限由 `bypassPermissions` 原生放行，问题经 adapter 注入的 `aut-questions` MCP server 的 `ask_user` 工具进入。
- `aut-questions` 由 Claude adapter 持有，独立于 mcp-bridge（ADR-0024）。每个 session 通过 `--strict-mcp-config` 临时配置注入，工具进程只经 0600 Unix socket 连接该 session 的 adapter broker。ADR-0024 中 mcp-bridge 不注册 `ask_user` 的约定不变。
- 工具调用映射为统一 `SessionRequest`（question），答案作为 MCP tool result 回填。漏到 broker 的 permission 请求记录 `request.opened` / `request.closed` 审计事件后自动允许；question 永不自动回答。
- adapter 声明 `questions: { native: true, multiQuestion: true, multiSelect: true, freeText: true }`。

## 理由

- 方案 A 已由 2.1.325 真实样本验证：bypass 下仍可调用 `ask_user`，答案回填后模型继续回合。方案 B 没有当前版本样本，按铁律 13 不能作为实现依据。
- 方案 A 的权限放行是 harness 原生方式，每次工具调用不经过 aut。方案 B 每次工具调用要多一次本地 MCP 往返，且需另行确认没有漏网的审批。
- 提问走结构化工具调用，aut 在协议层拦截并经原通道回填，满足铁律 10 的意图，不依赖文本约定。

## 后果

- 多问题、多选、自由文本依赖 aut 定义的 `ask_user` 工具 schema，与 Claude 原生 `AskUserQuestion` 的输入格式无关。模型需通过工具描述学会使用它。
- desktop 打包需要随 daemon 携带 `question-proxy.js`。
- 方案 B 保留为候选。若后续 Claude Code 版本在 bypass 下提供原生提问，或方案 A 失效，先录制方案 B 样本，再新增 ADR 取代本条。
