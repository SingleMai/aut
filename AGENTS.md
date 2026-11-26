# AGENTS.md — aut 实现总纲

本文件是给所有参与实现 aut 的模型/开发者的**硬性规则**。`CLAUDE.md` 是指向本文件的软链。
规则与代码冲突时，以本文件和 `docs/` 为准；要改规则，先改文档并新增 ADR（见文末"变更流程"）。

## 0. aut 是什么（一句话）

aut 是一个开源的 personal agent 客户端：用户只在 **main thread（主会话）** 里说话，
一个**非 LLM 的协调者 chief**（由 Jev 分类器驱动的工程决策树）把消息路由给用户配置的 **bot**，
内置主助手既能直接工作，也能在 slow 节点承担协调。bot 的工作跑在现有 harness CLI（Codex 优先，之后 Claude Code / ACP 系）的 **session** 里，结果再回到 main thread。

设计思路是《快与慢》：chief + Jev = 快脑（毫秒级、确定性），harness session = 慢脑（深度工作）。

## 1. 按任务查阅

先读本文件，再按任务读取对应文档及其引用的相关 ADR。

- 架构与进程边界：`docs/architecture.md`。
- 远程主机、连接凭据与传输组件：`docs/decisions/0072-personal-remote-host.md`。
- chief、路由、回包与交接：`docs/decision-tree.md`。
- 数据结构与跨模块接口：`docs/protocol.md`。
- Harness 接入与协议探针：`docs/harness-adapters.md`。
- Bot 记忆、文件组织与定时整理：`docs/memory.md`。
- 桌面交互：`docs/desktop.md`；工具展示对照：`docs/omb-tool-parity.md`；品牌：`docs/brand.md`。
- 存储、本地 API、MCP：分别读 `docs/storage.md`、`docs/local-api.md`、`docs/mcp-bridge.md`。
- 分类器：`docs/classifier.md`。
- 阶段范围与验收：分别读 `docs/roadmap.md`、`docs/acceptance.md`。
- 借用外部实现：`docs/references.md`；决策依据在 `docs/decisions/`，按对应文档中的编号查阅。

## 2. 铁律（违反即视为错误实现）

### 协调者
1. **chief 是确定性决策树。** LLM 只允许出现在决策树显式声明的节点上：
   `classify`（Jev/分类器）、`slow`（主助手的协调任务）、`rewrite`（回包改写 fork）。
   决策树之外的任何 LLM 调用一律禁止。
   （执行 Op 时启动/驱动的 worker session——如 `new`、`send`、`ask(deep)`——是"执行"而非"决策"，不受此条限制；
   但 chief 不得为了**做决定**或**生成文本**而在树外调用任何模型。）
2. **chief 自己不生成面向用户的自然语言**，只能使用模板（如"我想想"、"已交给『X』"）。
   用户看到的实质内容只来自：worker 的报告、改写 fork 的输出、主助手协调会话的回复。
3. **决策树是数据，不是 if-else 散落在代码里。** 新增/修改分支必须先改 `docs/decision-tree.md`，
   再改树配置；执行器代码不得出现针对具体业务意图的硬编码分支。
4. **每一次路由决策都必须写决策日志**（输入 state、问题、概率、选择、执行结果、用户是否纠正）。
   这是调阈值和建评测集的唯一数据来源，不可省略、不可采样丢弃。
5. **main thread 的消息由 chief 串行处理**（chief 是全局唯一排序点）。不同 session 的执行是并发的。
6. **即时响应 + 排队，不做输入停顿合并。** 禁止"等用户说完再处理"的 debounce。
   只有在投递队列**排出**时，才允许合并已在队列中的消息。

### 上下文
7. **main thread 不默认全量注入任何 session。** 交接包只包含：模板任务头、用户原话、
   经 Jev 剪枝且受 token 预算约束的相关片段、引用 ID。其余上下文由 agent 通过 MCP 工具 `read_main_thread` 按需拉取。
8. **bot 记忆由 aut 按 bot 隔离管理。** Harness 原生自动记忆由 adapter 统一关闭，不提供来源选择；文件职责与接入范围见 `docs/memory.md`（ADR-0068）。长期指令继续放在 `soul`，与工作积累的记忆分开。

### 权限与问答
9. **默认最高权限**，使用各 harness 原生的放行方式；仍到达的 permission 请求自动放行。
10. **问答必须原生拦截**（harness 的 ask-user 协议/工具 → 统一 `SessionRequest` → main thread 问题卡片 → 原通道回填）。
    禁止用"回合结尾写 NEEDS INPUT"之类的文本约定替代。
11. **自动放行只作用于 `permission`，永远不得自动回答 `question`。**（自动"批准"一个提问工具会让 agent 拿到空答案。）

### 回包
12. **面向用户的回包必须过门槛**（默认：≤200 个中文字符 + Jev 可读性判断）。不过门槛时 **fork** worker session 改写，
    原 session 上下文不得被污染；最多改写 2 次，仍不过则截断并提示"详情见任务面板"。

### Harness
13. **协议细节以对当前 CLI 版本的探针结果为准。** 参考代码（OpenMausBot 等）只是线索，不是事实。
    每个 adapter 必须附带探针脚本和录制的真实协议样本（fixtures），测试基于样本。
14. **每个 adapter 必须声明 `capabilities`**，上层只能按能力降级，禁止出现 `if (harness === "codex")` 之类按名字分支的上层代码。
15. **harness 进程在问题挂起期间必须存活**：daemon 常驻，长连接管理子进程；禁止"每轮启动 CLI 再退出"的模型。

### 范围
16. 不 fork OpenMausBot；允许借用其 Apache-2.0 部分的代码，但**必须**在文件头注明来源并更新 `NOTICE`。
    禁止借用其 `enterprise/` 目录下的任何内容。
17. 不设并发 session 上限。MVP 只做 macOS、只做 Codex adapter。

## 3. 技术约定

- **语言/运行时**：TypeScript（`strict: true`），Node **24.18.0 LTS**（`.nvmrc` / `engines`），pnpm **10.33.0** workspace monorepo。
  远程传输组件的 Go 例外仅限 ADR-0072 的节点登录与固定目标网络转发；业务仍使用 TypeScript / Effect。
- **业务逻辑统一用 Effect 3.22.4**（精确锁定于 pnpm catalog；保留本文既定的 `Context.Tag` / `Layer` / `Schema` API，避免在工程初始化中引入 Effect 4 迁移；测试使用兼容的 `@effect/vitest` 0.27.0）：
  - 模块 = `Context.Tag` Service + `Layer` 组装；daemon 入口只做 Layer 组合。
  - 所有跨进程/持久化/配置数据用 `Schema` 定义并校验（不再引入 zod 等第二套 schema 库）。
  - 错误用 `Data.TaggedError`，业务代码不 `throw`；`Promise` 只出现在与第三方库交界处，立即 `Effect.tryPromise` 包装。
  - 事件总线用 `PubSub`；每个 session 的投递邮箱用 `Queue`；每个 session 一个 `Fiber`；子进程生命周期绑定 `Scope`。
  - 重试/超时用 `Schedule` / `Effect.timeout`，禁止手写 setTimeout 重试。
- **存储**：SQLite（main thread、任务、事件、决策日志）；JSON（bot、harness 实例、classifier 配置）。数据目录 `~/.aut/`。首次发布前仅维护当前数据格式，见 [ADR-0048](docs/decisions/0048-pre-release-data-baseline.md)。
- **客户端**：Electron；renderer 只是 daemon 的客户端（通过本地 IPC/HTTP+WS），不持有业务状态。
- **语言**：文档中文；代码、注释、日志、提交信息英文；UI 先中文并预留 i18n；**Jev 的 instructions/criteria 一律英文**。

## 4. 包结构与依赖方向

```
packages/
  characters/   独立 UI 模块：Bot 形象注册、动作播放及内置角色（ADR-0053）
  protocol/     共享 Schema 与类型（零运行时依赖，除 effect）
  transport/    Effect 传输进程管理 + Go/tsnet 网络组件（ADR-0072）
  core/         chief、决策树执行器、任务状态机、main thread、存储、事件总线
  classifier/   Classifier 接口 + Jev 后端（+ 未来 LiteLLM 等）
  adapters/     HarnessAdapter 接口 + codex/（MVP）+ claude/、acp/（后续）
  mcp-bridge/   aut 提供给 agent 的 MCP server（read_main_thread、list_tasks、get_task、create_bot、propose_route）
  daemon/       进程入口，Layer 组装，本地 API
apps/
  desktop/      Electron + UI
spikes/         各 harness 的协议探针脚本与录制样本（不进生产构建）
```

依赖方向：`protocol` ← `classifier` / `adapters` / `mcp-bridge` ← `core` ← `daemon` ← `apps/desktop`（仅通过 API）。
`core` 只依赖 `HarnessAdapter` / `Classifier` 接口，不依赖具体实现。
桌面 renderer 可依赖 `@aut/characters`。该包只处理呈现，独立于 daemon 与业务协议。
`transport` 只依赖 `protocol`；daemon 与 desktop 主进程可依赖 `transport`，core 和 renderer 不依赖它。

## 5. 测试要求

- 决策树：每个分支至少一条 fixture（state → 期望 op），Classifier 用确定性 mock；阈值边界必须有用例。
- 任务状态机：所有合法/非法转移都要覆盖。
- Adapter：基于 `spikes/` 录制的真实协议样本回放测试；样本需标注 CLI 名称与版本。
- 不允许为了让测试通过而修改决策日志或跳过门槛逻辑。

## 6. 变更流程

- 改架构/协议/规则：先在 `docs/decisions/` 新增 ADR（编号递增，写清背景/决策/理由/后果），再改对应文档，最后改代码。
- 改决策树：改 `docs/decision-tree.md` + 树配置 + fixture，三者同一提交。
- 遇到文档没覆盖、又会影响架构的问题：**停下来提问**，不要自行发明方案。
- 文档维护当前规范，验收只留结论、范围和证据入口；原始过程留在探针与测试记录中。同一规则集中维护，其余文档用链接引用（ADR-0042）。
