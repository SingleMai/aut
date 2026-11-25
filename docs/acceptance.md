# MVP 验收结果

2026-11-18 已在真实 Codex 0.169.0、Jev 和 macOS arm64 开发包验收下列功能。2026-11-21 追加真实本地计划触发器验收，2026-11-23 使用 Codex 0.171.0 追加 MCP 管理与搜索计划验收。人工评审待进行，300 ms 路由确认仍有超时样本。开发包用于本机验收。

## 验收范围

合成场景使用隔离数据目录与真实本地 HTTP/WS API；原生链路调用已登录的 Codex 和固定版本 Jev。
默认数据目录启动另有本机补验。Provider 配置保持不变，预设答案仅用于明确命名的测试题。

| 场景 | 结果与边界 | 证据 |
|---|---|---|
| 单一内置主助手 | 空目录只创建 aut。它直接算出 37 + 48 = 85，随后在独立协调会话中通过 MCP 把验证任务交给手动创建的回声助手。三个任务最终均为 idle | [发布前复验](../spikes/e2e/results/pre-release-baseline-0.169.0.json) |
| 手动与 Agent 创建专长助手 | 桌面表单创建成功。工作会话和主助手协调会话分别通过原生 `create_bot` 建立星表助手和潮汐助手，按中文专长的路由试验选中了星表助手 | [发布前复验](../spikes/e2e/results/pre-release-baseline-0.169.0.json)、[桌面表单](../spikes/e2e/results/finder-inbound-1.1.2.json) |
| 创建回执与重启 | 已使用的星表助手有任务引用，潮汐助手可撤销。用同一目录重启 daemon 后，四份任务执行登记、Bot 列表和两张回执的状态均正确 | [发布前复验](../spikes/e2e/results/pre-release-baseline-0.169.0.json)、[事务测试](../packages/daemon/src/daemon.test.ts) |
| 引用、改派及撤销 | 分类器不可用时继续选项绑定被引用的任务。改派使用原请求新建任务，原任务保留。撤销在原日志留下纠正决策 ID。重复提交与已确认派发的后续状态有事务回归测试 | [决策记录](../spikes/e2e/results/bot-dispatch-0.169.0.json)、[事务回归](../packages/core/src/session-manager/manager.test.ts) |
| 两个并行任务、自然语言澄清与取消 | 两个 worker 同时待答时，在线分类为指代不明的取消请求列出两个任务。「取消刚才新建的那个任务」只取消了较新的任务。另一次分类超出 1.5 秒预算，显示降级卡 | [并发与澄清](../spikes/e2e/results/concurrent-delivery-0.169.0.json) |
| 排出合并与运行中 restart | 两条排队消息进入同一后续原生回合，报告顺序一致。运行中要求重做时，用户点击重做选项，原生历史记录同会话一轮中断、下一轮完成，队列清空 | [排队](../spikes/e2e/results/concurrent-delivery-0.169.0.json)、[重做](../spikes/e2e/results/restart-0.169.0.json) |
| macOS 启动与重开 | 当前 arm64 开发包启动了内置 daemon，Bot 页只显示一张 aut 主助手卡片，关闭窗口后服务仍健康。桌面重开后的回包与纠正状态另有 LaunchServices 实测 | [发布前复验](../spikes/e2e/results/pre-release-baseline-0.169.0.json)、[桌面重开](../spikes/e2e/results/finder-inbound-1.1.2.json) |
| Bot、路由、新任务与引用续聊 | 通过；降级场景生成澄清卡，不派发未确认任务 | [主链路](../spikes/e2e/results/main-thread-0.169.0.json) |
| 原生 RPC 题组、异步提问与回答 | 通过；默认模式非阻塞，答案确认送达 | [问答](../spikes/e2e/results/questions-main-thread-0.169.0.json) |
| fast / deep 进度与回包门槛 | 通过；隔离查询和改写不污染原任务、报告或会话 | [主链路](../spikes/e2e/results/main-thread-0.169.0.json)、[进度](../spikes/e2e/results/progress-0.169.0.json) |
| queue / steer | 通过；同任务同会话投递，等待问题时追加指令保持排队 | [投递](../spikes/e2e/results/delivery-0.169.0.json) |
| 取消、故障重试与重启恢复 | 通过；取消后不发迟到回包，重启不自动重放 | [控制](../spikes/e2e/results/control-0.169.0.json) |
| 本地计划触发器 | 通过；真实 Codex session 在 Jev 已配置的 daemon 中由数据驱动触发树创建 `trigger` 来源任务，决策日志无分类器调用。运行台账到 `ran` 并绑定任务 ID，原始报告与主线程回包均含 `TRIGGER_E2E_OK`。一次性计划自动停用，暂停、恢复和更新均通过 | [触发器](../spikes/e2e/results/trigger-0.169.0-verified.json) |
| 主助手 MCP 管理与计划搜索 | 通过；隔离目录中的真实主助手使用 `mcp_info` / `mcp_server` 创建、测试和启用 You.com 公开搜索服务，只向自身授权 `you-search`，再用 `create_trigger` 创建一次性计划。原生 transcript 记录实际搜索参数及成功结果；运行台账到 `ran`，主会话收到 `MCP_LIVE_OK`，触发决策日志已保存 | [MCP 实测](../spikes/e2e/results/mcp-management-live.json) |
| MCP 粘贴接入和桌面授权 | 通过浏览器预览的实际 IPC/API 路径；粘贴 URL、保存测试发现 3 个工具、启用和逐工具勾选，刷新后授权仍保留。自动化页同样可读取 API。解析器另覆盖 JSON、带引号的命令、占位符、Docker 环境值与凭据引用；本轮未重打 Electron 安装包 | [导入边界](../apps/desktop/src/mcp-import.test.ts)、[授权界面](../apps/desktop/src/mcp-page.dom.test.tsx)、[桌面 IPC](../apps/desktop/src/bridge.test.ts)、[截图](assets/desktop/mcp-management.png) |
| Bot 编辑器 MCP 授权 | 创建、编辑和 MCP 服务页复用逐工具勾选。保存后刷新、重开保留精确授权，未启用的全局服务保持关闭。回归覆盖取消不写授权、读取失败不撤权，以及部分保存失败后仅重试未完成授权、不重复创建 Bot | [界面实测](../spikes/e2e/results/bot-mcp-sources-ui.json)、[表单回归](../apps/desktop/src/bot-editor.dom.test.tsx)、[截图](assets/desktop/bot-mcp-grants.png) |
| 回包来源链接 | 普通及 deep 回包从不可变原报告保留来源元数据，`read_main_thread` 可按需读取；末次截断保留标签，门槛和改写次数不变。隔离桌面预览实测刷新后来源仍在，点击复制的 447 字符 URL 与原值完全一致 | [界面实测](../spikes/e2e/results/bot-mcp-sources-ui.json)、[提取与截断](../packages/core/src/report-sources.test.ts)、[截图](assets/desktop/report-sources.png) |
| MCP 连接、撤权及登录竞态 | 真实 stdio 子进程经过 proxy 保留参数、输出 Schema、annotations 和结构化结果；分页目录、撤权、禁用、更新配置、退出登录及删除通过。OAuth 合成服务验证 PKCE，以及回调/刷新与退出、更新、删除、重新登录的 8 个竞态场景 | [supervisor](../packages/daemon/src/mcp-supervisor.test.ts)、[OAuth](../packages/daemon/src/mcp-oauth.test.ts) |
| 主助手协调与 MCP 派活 | 同一主助手在协调会话提议派发一次，专长助手独立完成工作，双方均经回包门槛 | [发布前复验](../spikes/e2e/results/pre-release-baseline-0.169.0.json) |
| 密钥设置、题组、草稿、菜单与历史滚动 | 通过真实 API/WS 界面验收 | [设置](../spikes/e2e/results/desktop-settings.json)、[界面](../spikes/e2e/results/ui-position-qa.json) |
| Bot 形象与动作 | 单眼 a 与纸鸟可预演。隔离桌面数据实测保存、重开、历史静态恢复及原生回执。图片渲染器覆盖自定义状态、动作替换和减少动态效果 | [编辑器实录](assets/desktop/bot-characters.gif)、[播放器](../apps/desktop/src/character-player.dom.test.tsx)、[预演与配置](../apps/desktop/src/characters/character-editor.dom.test.tsx) |
| 桌面外观与配置表单 | arm64 实包在下拉菜单打开时切换外观，原生控件与弹层同步。键盘可从 Bot 头像进入并返回。折起的 MCP 字段和多实例配置错误均可定位与修正 | [实包验收](../spikes/desktop/packaged-smoke.ts)、[字段定位](../apps/desktop/src/settings-page.dom.test.tsx)、[组件预览入口](desktop.md#组件预览) |
| 本机首次启动、答题与重开 | 通过；继承已认证开发环境，结果持久化 | [本机补验](../spikes/e2e/results/local-desktop-0.169.0.json) |
| 工作会话与工具展示 | 分页、实时更新、折叠、定位及原生 IPC 通过；查看不恢复任务 | [会话](../spikes/desktop/task-session-qa-results.md)、[工具对照](omb-tool-parity.md) |
| 构建、类型、格式、依赖检查及打包 | 78 个测试文件、1,226 个用例全部通过，另有 1 个在线 Jev 用例按条件跳过。macOS arm64 开发包通过主助手展示、创建回执撤销和设置页检查 | [发布前复验](../spikes/e2e/results/pre-release-baseline-0.169.0.json) |
| MCP 增量回归（2026-11-23） | `pnpm check` 通过：构建、生产/测试类型、格式、依赖边界及 89 个测试文件的 1,328 个用例；1 个在线 Jev 用例按条件跳过。桌面 bundle 构建及 `git diff --check` 通过 | [MCP 测试](../packages/daemon/src/mcp-supervisor.test.ts)、[协议边界](../packages/protocol/src/protocol.test.ts) |
| 文件输入、成果交付与版本（2026-11-23） | 两次真实 Codex 0.171.0 / Jev 验收通过：上传 CSV，Bot 读取并交付 Markdown 与 CSV；引用成果在同一任务续聊，旧版保持 TOTAL=42，新版为 TOTAL=43。成果在回包改写前保存，原始报告保留；最终截断正文只留文件标签 | [最终原生实测](../spikes/e2e/results/message-files-live-final.json)、[初次实测](../spikes/e2e/results/message-files-live.json)、[快照边界](../packages/core/src/message-files.test.ts)、[回包回归](../packages/core/src/reply-gate.test.ts) |
| 文件桌面交互 | 隔离 daemon 的浏览器预览验证选文件、拖入 CSV、剪贴板 items 图片、图片/文本预览、移除、发送、刷新保留、引用文件数量提示和保存副本；旧/新版内容分别核对，保存副本与新版字节一致。上传失败重试、迟到上传不恢复已删草稿、保存取消和原生 ID 边界另有回归 | [界面记录](../spikes/e2e/results/message-files-ui.json)、[截图](assets/desktop/message-files.png)、[界面回归](../apps/desktop/src/message-files.dom.test.tsx)、[原生动作边界](../apps/desktop/src/native-files.test.ts) |
| 文件生命周期与原生操作（2026-11-24） | 未发送附件的过期回收、续期、移除及迟到上传释放已完成；历史引用、成果、损坏清单和并发发送均有保护回归。arm64 实包验证启动回收、原生 IPC 保存/取消、保存副本字节一致、Finder 目标与 Quick Look 窗口打开/关闭 | [实包记录](../spikes/e2e/results/message-files-native-final.json)、[应用内预览截图](assets/desktop/message-files-native.png)、[生命周期](../packages/core/src/message-files.test.ts)、[草稿回归](../apps/desktop/src/message-files.dom.test.tsx) |
| 文件能力增量回归（2026-11-24） | `pnpm check` 通过：构建、生产/测试类型、格式、依赖边界及 92 个测试文件的 1,347 个用例；1 个在线 Jev 用例按条件跳过。桌面 bundle 与 macOS arm64 开发包构建通过；补充损坏清单断言后文件测试、测试类型及格式检查通过 | [快照/API 测试](../packages/daemon/src/daemon.test.ts)、[文件回归](../packages/core/src/message-files.test.ts)、[原生保存边界](../apps/desktop/src/native-files.test.ts) |
| MCP 界面源码对齐（2026-11-24） | 按固定 OpenMausBot 源码迁入统一编辑器、密码行、服务行和可检索授权。隔离 daemon 实测 stdio 导入、发现 3 个工具、启用、精确授权、刷新保留、凭据留空编辑、删除取消及 Bot 草稿取消；修复并回归授权刷新收起工具区的问题。1040px 无横向溢出，深浅主题通过。远程状态为合成展示，未实登第三方 OAuth 或复验安装包。`pnpm check`：93 个文件、1,357 通过、1 跳过；桌面 bundle 通过 | [来源映射](mcp-ui-parity.md)、[界面记录](../spikes/e2e/results/mcp-ui-parity.json)、[服务列表](assets/desktop/mcp-management-parity.png)、[编辑器](assets/desktop/mcp-editor-parity.png)、[授权](assets/desktop/mcp-grants-parity.png)、[深色](assets/desktop/mcp-grants-dark.png) |

验收 JSON 保存决策日志样例，包含输入、分类问题、概率、路径及执行结果。

2026-11-24 原生上下文状态增量验收：Codex 0.171.0 真实自动压缩和独立进程冷读探针通过；
界面以隔离 API/WS 的合成状态验证用量环、只读详情、整理中/完成、新读数、未知窗口、
读取失败恢复及深色窄窗口。未增加手动压缩按钮或写 API；当前仅 Codex 声明支持。
`pnpm check` 通过：95 个文件、1,368 个用例通过、1 个在线用例按条件跳过；桌面 bundle 通过。
本轮未重新验收 Electron 安装包。证据见 [原生探针](../spikes/codex/README.md)、
[协议回放](../packages/adapters/src/codex/context.test.ts)、
[界面增量记录](../spikes/desktop/task-session-qa-results.md#原生上下文状态增量验收2026-11-24)、
[用量界面](assets/desktop/session-context.png) 和 [整理状态](assets/desktop/session-context-compacting.png)。

2026-11-24 Bot 记忆增量验收：按 bot 隔离的文件记忆、默认每日整理、桌面编辑与只读快照已完成。
Claude Code 2.1.330 / Codex 0.171.0 原生记忆关闭策略有真实探针与 adapter 回归；
真实 Codex 0.171.0 使用现有 `agy-cli/gemini-4-neon` Provider/model，两个共享 cwd 的 bot 分别读取各自注入的随机标记，
原生工具写会话笔记，整理触发器启动独立会话，通过 `read_task_session` 读取原工作记录、提升事实并删除已合并笔记；
另一 bot 的目录保持不变，整理前快照、任务、原生 session 与运行台账保留。
真实 Jev 完成 9 次可读性判断；合成标记报告经过两次改写后触发既有截断回退，不代表直接通过可读性门槛。
证据见 [原生实测](../spikes/e2e/results/memory-live-0.171.0.json)、[Claude 探针](../spikes/claude/native-memory.md)、
[Codex 探针](../spikes/codex/native-memory.md)。

隔离 daemon 的完整桌面预览通过新建/编辑、草稿保护、删除/清空确认、清空前快照读取、暂停后刷新保留及恢复；
深浅主题与 1040px 窗口无横向溢出。[界面记录](../spikes/e2e/results/memory-ui.json)、
[浅色界面](assets/desktop/bot-memory-light.png)、[深色界面](assets/desktop/bot-memory.png)、
[窄窗口](assets/desktop/bot-memory-narrow.png)。构建、生产/测试类型、Biome、依赖边界、桌面 bundle 与 diff 检查通过；
全套 `vitest run --maxWorkers=4`：100 个文件、1,443 用例通过，1 个在线用例按条件跳过。
默认高并行运行曾有两个 stdio 测试超时；单独复跑及上述全量复跑通过。未重验 Electron 安装包。

2026-11-24 Memory 阅读与知识图谱增量验收：默认阅读核心记忆，知识图谱/列表/搜索、跨分区文档链接、
显式编辑、只读快照、断链提示及次级管理完成。图按文件内容重建，未引入剪枝或使用热度。
真实 Codex 0.171.0 沿用现有 `agy-cli/gemini-4-neon/high`：笔记经定时整理生成两个知识文件、一条有效关联，
核心 Memory 留短入口；新会话实际读取入口及关联目标，正确回答未在新提示中提供的验收事实，另一 Bot 未受影响。
12 次真实 Jev 调用成功，但四个回包均经过两次改写后进入既有截断回退，不能表述为可读性放行。
隔离桌面预览验证编辑/新增/删除后的图谱更新、草稿保护、历史图谱、原生修改刷新、断链、整理开关，以及深浅主题和 820px 窗口布局。
构建、生产/测试类型、Biome、依赖边界和桌面 bundle 通过；全套 102 个文件、1,504 用例通过，1 个在线用例按条件跳过。
证据：[真实整理与回读](../spikes/e2e/results/memory-graph-live-0.171.0.json)、[桌面实测](../spikes/e2e/results/memory-graph-ui.json)、
[核心记忆](assets/desktop/memory-core-reading.png)、[知识图谱](assets/desktop/memory-knowledge-graph.png)。未重验 Electron 安装包。

## 当前限制

- 主会话问答验收使用默认模式；Plan 阻塞行为仅由 [独立协议探针](../spikes/codex/fixtures/plan-free-0.169.0.jsonl) 验证，产品未提供 Plan 切换。
- 从桌面提交到确认行出现在 DOM，最终构建的首次派发为 600 ms，其中分类调用 506 ms。随后三次状态查询为 278、289、283 ms，daemon 除分类调用外各用 8–9 ms。另一轮开发包热态也曾超过 300 ms。测量取桌面 DOM 变更和持久化事件时间戳。[最终构建](../spikes/e2e/results/finder-inbound-1.1.2.json)、[对照样本](../spikes/e2e/results/finder-inbound-1.1.1.json)
- 当前数据格式的原生复验中，主助手首次直接派发到 daemon 写入确认用了 718 ms，其中 Jev 分类为 636 ms。另一次派发到专长助手为 1,519 ms。这些样本仍高于 300 ms 目标。[发布前复验](../spikes/e2e/results/pre-release-baseline-0.169.0.json)
- 超长原生历史分页尚未实测；Codex 的读取兼容边界见 [Harness 适配层](harness-adapters.md)。工具输出与宿主适配边界见 [工具展示对照](omb-tool-parity.md)。
- Bot 记忆隔离是目录归属和加载规则，不是操作系统沙箱。Claude 当前不支持冷历史读取，整理使用保存的报告及笔记降级；记忆文件、预算和审查范围见 [Bot 记忆](memory.md)。
- 开发包未完成发行签名、公证和自动更新；包名、哈希及构建对应关系以包记录为准。
- MCP 真实服务验收使用公开搜索端点；第三方账户 OAuth 登录尚未实测。本轮 Bot 授权及来源补充验收使用隔离 daemon 和桌面浏览器预览，尚未复验 Electron 安装包。
- 文件能力当前为每个 20 MiB、每条消息合计 16 个（含引用沿用），需要任务正文。应用内预览文本与 PNG/JPG/GIF/WebP；其他格式交给 macOS Quick Look。实包探针控制保存对话框的选择结果，实际 IPC 与文件写入未替换；Quick Look 以系统窗口身份验证打开/关闭，截图为应用内文本预览。目录上传、解压和 Office 在线编辑不在本次范围。

## 复验

先执行 `pnpm check`；桌面复验见 [桌面验收说明](../spikes/desktop/README.md)，真实 Codex/Jev 场景见 [端到端探针说明](../spikes/e2e/README.md)。
真实模型探针需要已有认证和显式密钥。新结果单独保存；历史样本按各自版本与范围解释。
