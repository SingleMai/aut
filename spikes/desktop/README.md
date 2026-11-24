# 桌面交互验收

`chat-ui-qa.ts` 提供独立临时数据目录、真实 daemon HTTP / WebSocket API 和浏览器预览。
它使用 `DaemonApiLive`，不运行 chief、Harness 或模型；UI 提交的消息和动作真实落盘，
测试状态变更由验收者明确触发。它不使用 `~/.aut` 或固定的 4317 端口。

## 启动

从仓库根目录执行：

```sh
pnpm build
pnpm --filter @aut/desktop bundle
node --experimental-strip-types spikes/desktop/chat-ui-qa.ts
```

启动输出给出临时目录、API/preview 随机空闲端口，以及 fixture/preview PID。
在浏览器打开输出的 `url`。预览每次请求读取当前 `dist/`，重新 bundle 后刷新页面即可。
所有测试数据都是合成内容，Codex Provider 配置不会被写入。

## 覆盖

- 65 条历史消息 + 最近消息，验证首次分页和“查看更早消息”锚点。
- 单题单选、开放题、包含单选/多选/自由文本的三题题组；没有预选答案。
- 已登记、提交中、结果未知、已排队、已送达的原生问题状态。
- 等待回答、运行、空闲、失败和中断任务的导航与动作可用性。
- 独立历史原文引用和较新的 Task.lastReport，验证“完整报告”仍打开原事件内容。
- 长报告、消息引用、IME 输入、多行输入、滚动跟随和输入框避让。

上游行为依据为 OpenMausBot `738ec88472a3b888ff7b7793755d89da613ed301` 的
`Composer.ime.test.ts`、`QuestionCard.answer.test.ts`、`ChatView.follow.test.ts`、
`ReplyQuote.test.ts` 等回归用例；本 fixture 独立实现，不复制上游测试源码。

## 动态变化与审计

在 fixture 的标准输入中输入一行 JSON：

```json
{"command":"audit"}
{"command":"create-bot"}
{"command":"source-report"}
{"command":"append","text":"验收追加消息：阅读历史时不应被强制滚到底部。"}
{"command":"phase","requestId":"qa-single","phase":"submitting"}
{"command":"settle","requestId":"qa-single"}
```

`audit` 输出实际保存的 UI 动作、用户消息和数量，另写入临时目录 `audit.json`。
`create-bot` 经同一配置服务创建合成的「观测助手」。在主会话点击「撤销创建」后重载页面，可核对回执状态和 Bot 列表。
`source-report` 保存一份含普通来源和超长 URL 的合成原报告，调用实际末次截断与来源提取函数，并发出真实变更通知。检查正文不含被切断的 URL，消息下方的来源能复制完整地址，刷新后仍保留；此场景不调用模型或分类器。
`append` 经 Store 事务提交并触发真实变更通知，可检查未提交输入是否保留。
`phase` 更新题目投递状态；可选 `registered/submitting/indeterminate/queued/delivered`。
`settle` 将已明确提交的合成答案标记送达，并折叠其问题卡片。
没有已提交答案或既有测试 claim 时，后两者失败，不会生成答案。

三题请求是 `qa-multi`，开放题是 `qa-open`，状态题是 `qa-registered` 等。
`qa-latch` 用于检查单题收到 HTTP 202 后保持锁定，以及进入 `registered` 后仅显式重试可以再次提交。
完整报告引用为 `event:qa-immutable-report`，尾行是 `END_OF_IMMUTABLE_REPORT`。
UI 的一次 HTTP 202 只证明动作已落盘；本 fixture 不声称它已经被真实 Harness 接收。

滚动回归先刷新页面，确认只加载最新 50 条，再用真实滚轮向上阅读并等待惯性停止。
记录当前可见消息 ID 与其屏幕纵坐标，执行 `append` 后两者应保持稳定，且不应自动加载
当前最早消息之前的历史。随后点击“回到最新”，再次 `append`，确认继续跟随到底部。
另一次独立刷新后点击“查看更早消息”，确认主动分页保留原先第一条消息的屏幕位置。
先手动加载全部历史会掩盖实时刷新意外带入更早页面的问题，因此不能替代首次分页场景。

完成后对本次 fixture 按 Ctrl+C 或发送 SIGTERM，Scope 会关闭 API 并终止它启动的 preview。
临时目录保留，便于核对审计记录。不要终止用户原有的 daemon 或应用。

## 完整工作会话

`task-session-qa.ts` 为 ADR-0035 提供独立场景，使用真实 `SessionReader`、分页 API、
HTTP / WebSocket 与桌面预览，只将 HarnessResolver 换为合成只读适配器。
`startSession` / `resumeSession` 明确失败并计数，不启动 CLI 或模型。

```sh
pnpm build
pnpm --filter @aut/desktop bundle
node --experimental-strip-types spikes/desktop/task-session-qa.ts
```

保持进程标准输入可用；自动化启动时使用 TTY。它创建随机端口和临时数据目录，
不访问真实 `~/.aut`。默认任务 `qa-session-full` 有 12 轮，首次读取 10 轮，
包含长交接输入、助手过程与最终结果、命令、文件变更、MCP 调用及失败和未知状态。
另有未建立、不支持、不可用、空会话四种读取结果。

标准输入控制命令：

```json
{"command":"audit"}
{"command":"tick"}
{"command":"unavailable"}
{"command":"available"}
{"command":"finish"}
```

`tick` 替换同一 `qa-live-command` 工具的输出，并发布两次相同 `session.changed` 通知，
用于验证 UI 回读后不重复插入卡片。`finish` 完成本轮工具并追加唯一的最终结果；
待答问题保留，明确区分原生回合结束与问题答复。`unavailable` / `available` 模拟读取故障恢复。
`audit` 记录读取次数、执行尝试、稳定工具项数量与实际用户动作；正常验收应保持
`startAttempts: 0`，且查看或跳转不会自动回答问题。

独立审查回归还支持：

```json
{"command":"bury-question"}
{"command":"activity"}
{"command":"report"}
{"command":"hold-read"}
{"command":"switch-session"}
{"command":"release-read"}
```

`bury-question` 追加 60 条合成 notice；刷新浏览器后，待答问题不在首次 50 条消息内，
可检查任务中的回答入口是否补读并聚焦旧卡片。`activity` 只改任务活动时间，
`report` 更新最近报告，用于分别检查不必要的标题重建，以及必要重建时的展开/焦点保留。
`hold-read` 挂起下一次只读快照：先在 UI 刷新，等标准输出 `readHeld: true`，
再运行 `switch-session` 换 cursor；界面应立即清空旧记录。最后 `release-read`
释放旧响应，界面只应展示新会话 `qa-replacement-turn`，不能串入旧回合。
挂起通过 Effect Deferred 控制，没有定时碰运气或执行真实 Harness。

浏览器检查步骤和已验收记录见 `task-session-qa-results.md`。

## LaunchServices 冷启动

`finder-live.mjs` 从空数据目录启动指定构建，通过原生窗口创建 Bot、提交主会话请求、点选合成题的明确答案、改派和撤销。关闭并再次打开应用后核对持久化结果。测时从提交到桌面确认行出现，daemon 耗时从原始事件和决策日志读取。

先 `pnpm build`，将 `AUT_PACKAGE_OUT` 指向本次打包目录，执行 `pnpm --filter @aut/desktop package:mac`，再执行 `node spikes/desktop/finder-live.mjs`。脚本读取现有 Codex 认证和环境中的 `TYPESAFE_API_KEY`，按需以临时私密配置提供给隔离 daemon，并在退出时移除该密钥文件。`AUT_E2E_RESULT` 可指定新的结果路径。
