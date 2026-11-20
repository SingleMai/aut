# MVP 验收结果

2026-11-18 已在真实 Codex 0.169.0、Jev 和 macOS arm64 开发包验收下列功能。人工评审待进行，300 ms 路由确认仍有超时样本。开发包用于本机验收。

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
| 主助手协调与 MCP 派活 | 同一主助手在协调会话提议派发一次，专长助手独立完成工作，双方均经回包门槛 | [发布前复验](../spikes/e2e/results/pre-release-baseline-0.169.0.json) |
| 密钥设置、题组、草稿、菜单与历史滚动 | 通过真实 API/WS 界面验收 | [设置](../spikes/e2e/results/desktop-settings.json)、[界面](../spikes/e2e/results/ui-position-qa.json) |
| Bot 形象与动作 | 单眼 a 与纸鸟可预演。隔离桌面数据实测保存、重开、历史静态恢复及原生回执。图片渲染器覆盖自定义状态、动作替换和减少动态效果 | [编辑器实录](assets/desktop/bot-characters.gif)、[播放器](../apps/desktop/src/character-player.dom.test.tsx)、[预演与配置](../apps/desktop/src/characters/character-editor.dom.test.tsx) |
| 桌面外观与配置表单 | arm64 实包在下拉菜单打开时切换外观，原生控件与弹层同步。键盘可从 Bot 头像进入并返回。折起的 MCP 字段和多实例配置错误均可定位与修正 | [实包验收](../spikes/desktop/packaged-smoke.ts)、[字段定位](../apps/desktop/src/settings-page.dom.test.tsx)、[组件预览入口](desktop.md#组件预览) |
| 本机首次启动、答题与重开 | 通过；继承已认证开发环境，结果持久化 | [本机补验](../spikes/e2e/results/local-desktop-0.169.0.json) |
| 工作会话与工具展示 | 分页、实时更新、折叠、定位及原生 IPC 通过；查看不恢复任务 | [会话](../spikes/desktop/task-session-qa-results.md)、[工具对照](omb-tool-parity.md) |
| 构建、类型、格式、依赖检查及打包 | 69 个测试文件、1,159 个用例全部通过，包含在线 Jev 检查。macOS arm64 开发包通过主助手展示、创建回执撤销和设置页检查 | [发布前复验](../spikes/e2e/results/pre-release-baseline-0.169.0.json) |

验收 JSON 保存决策日志样例，包含输入、分类问题、概率、路径及执行结果。

## 当前限制

- 主会话问答验收使用默认模式；Plan 阻塞行为仅由 [独立协议探针](../spikes/codex/fixtures/plan-free-0.169.0.jsonl) 验证，产品未提供 Plan 切换。
- 从桌面提交到确认行出现在 DOM，最终构建的首次派发为 600 ms，其中分类调用 506 ms。随后三次状态查询为 278、289、283 ms，daemon 除分类调用外各用 8–9 ms。另一轮开发包热态也曾超过 300 ms。测量取桌面 DOM 变更和持久化事件时间戳。[最终构建](../spikes/e2e/results/finder-inbound-1.1.2.json)、[对照样本](../spikes/e2e/results/finder-inbound-1.1.1.json)
- 当前数据格式的原生复验中，主助手首次直接派发到 daemon 写入确认用了 718 ms，其中 Jev 分类为 636 ms。另一次派发到专长助手为 1,519 ms。这些样本仍高于 300 ms 目标。[发布前复验](../spikes/e2e/results/pre-release-baseline-0.169.0.json)
- 超长原生历史分页尚未实测；Codex 的读取兼容边界见 [Harness 适配层](harness-adapters.md)。工具输出与宿主适配边界见 [工具展示对照](omb-tool-parity.md)。
- 开发包未完成发行签名、公证和自动更新；包名、哈希及构建对应关系以包记录为准。

## 复验

先执行 `pnpm check`；桌面复验见 [桌面验收说明](../spikes/desktop/README.md)，真实 Codex/Jev 场景见 [端到端探针说明](../spikes/e2e/README.md)。
真实模型探针需要已有认证和显式密钥。新结果单独保存；历史样本按各自版本与范围解释。
