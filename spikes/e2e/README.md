# MVP 主会话端到端探针

这些脚本在隔离的系统临时目录中运行正式 `DaemonLive`，通过与桌面相同的本地 HTTP API
创建配置、发送主会话消息、回答精确匹配的合成问题及执行任务动作。使用真实 Jev 和已登录的
Codex；生产 SessionManager、MCP bridge、交接剪枝、问题路由和回包门槛均参与执行。
Store 或原生 transcript 读取仅用于验收审计，不替代用户操作或修改结果。

## 运行环境与复验

- macOS、Node 24.18.0 LTS、pnpm 10.33.0，先完成 `pnpm check`；脚本加载各包的 `dist/`，
  修改源码后至少重新 `pnpm build`，不能用旧构建验收新代码。
- PATH 中已有可运行、已登录的 `codex`。模型与 Provider 从现有 CLI 只读发现；脚本不会改写
  全局配置、登录信息或用户项目。测试 bot 在自己的临时配置中使用 `effort:low`。
- 环境中已有 `TYPESAFE_API_KEY`。请通过现有凭据管理方式提供，不把密钥写到探针、命令记录或结果文件。
  真实调用消耗当前 Codex/Jev 额度。
- 为减少开发机资源竞争，建议逐个运行验收脚本；产品本身不设置并发 session 上限。
- 首次模型发现预算为30秒，普通探针HTTP请求预算为60秒。该探针预算不改变生产分类器1.5秒节点预算，
  也不改变桌面普通API的10秒请求预算。

从仓库根目录运行。以下输出路径是示例；每次选择尚不存在的新路径，已有文件不会被覆盖。

```sh
rtk proxy pnpm check
rtk proxy codex --version
rtk proxy env AUT_E2E_RESULT=/tmp/aut-main-thread-recheck.json node --experimental-strip-types spikes/e2e/main-thread-live.ts
rtk proxy env AUT_E2E_QUESTIONS_RESULT=/tmp/aut-questions-recheck.json node --experimental-strip-types spikes/e2e/questions-main-thread-live.ts
rtk proxy env AUT_E2E_RESULT=/tmp/aut-progress-recheck.json node --experimental-strip-types spikes/e2e/progress-live.ts
rtk proxy env AUT_E2E_RESULT=/tmp/aut-slow-brain-recheck.json node --experimental-strip-types spikes/e2e/slow-brain-live.ts
rtk proxy env AUT_E2E_CONTROL_RESULT=/tmp/aut-control-recheck.json node --experimental-strip-types spikes/e2e/control-live.ts
rtk proxy env AUT_E2E_DELIVERY_RESULT=/tmp/aut-delivery-recheck.json node --experimental-strip-types spikes/e2e/delivery-live.ts
rtk proxy env AUT_E2E_RESULT=/tmp/aut-trigger-recheck.json node --experimental-strip-types spikes/e2e/trigger-live.ts
rtk proxy env AUT_E2E_RESULT=/tmp/aut-mcp-recheck.json node --experimental-strip-types spikes/e2e/mcp-management-live.ts
```

各脚本的进度输出包含临时目录和阶段。脚本退出失败不代表用户动作未送达；先只读核对该目录的
事件、任务、答案claim和决策日志。尤其是 `answerState=delivered` 的答案不得因客户端超时重复提交。
结束时关闭当前daemon Scope；不要以全局进程名清理其他Codex或用户应用。

## 覆盖范围

| 脚本 | 场景与关键断言 |
|---|---|
| `main-thread-live.ts` | 建bot、路由试验、new、同任务引用续聊、fast状态查询；保留HTTP接收和chief确认耗时 |
| `questions-main-thread-live.ts` | 原生同步两题、异步一题；整组卡片、明确合成答案、delivered/answered/idle；未答异步题仍继续工作；受控子进程退出 |
| `progress-live.ts` | 超长原报告与历史引用、fork改写、deep查询；原任务字段和父transcript隔离、临时进程清理 |
| `slow-brain-live.ts` | 空目录只创建 aut 并完成计算。手动添加专长助手后，同一主助手在协调任务中读取主会话、提议派发，两个任务均通过回包流程 |
| `control-live.ts` | 取消、失败后重试、停止daemon后显式恢复；原任务游标、决策日志和Scope清理 |
| `delivery-live.ts` | 原生问题待答时追加queue，明确回答后顺序排出；运行中steer进入当前回合，检查真实Jev选择、无降级、父turn数和同一会话游标 |
| `trigger-live.ts` | 一次性计划触发真实 Codex 任务，核对触发器运行台账、任务回包、决策日志与 fired 事件，并验证暂停、恢复和更新 |
| `mcp-management-live.ts` | 主助手通过原生 MCP 管理工具接入 You.com 公开服务，测试/启用并精确授权 `you-search`；再从主会话创建一次性计划，核对原生 transcript 的实际搜索调用、返回结果、台账、回包和触发决策日志 |

慢脑探针只在临时系统bot与回声bot配置中添加明确的合成指令，要求慢脑通过 `propose_route`
派活，并要求普通worker仅执行回声验证；不会通过shell直接调用后台API来伪造MCP路径。
问题探针只回答预先声明且逐字段匹配的合成题，遇到其他问题失败退出；产品question策略仍由用户作答。

## 已保存证据与限制

| 结果 | 证据含义 |
|---|---|
| `results/main-thread-0.169.0.json` | 路由试验、新任务、同任务引用续聊、fast模板查询通过；分类器不可用时连续两条生成澄清卡、不派发未确认任务。HTTP接收78ms，真实路由确认352ms |
| `results/questions-main-thread-0.169.0.json` | 完整同步与异步问答通过。CLI版本来自实际二进制，包含决策日志和子进程退出证据 |
| `results/progress-0.169.0.json` | 432字原文保留，一次fork改写为35字；deep查询保持原Task、原报告及父transcript不变，Scope关闭后无子进程残留 |
| `results/pre-release-baseline-0.169.0.json` | 当前单主助手协议、SQLite 第 4 版重开、两种角色创建专长助手、路由纠正及打包应用的复验。含完整决策样例。 |
| `results/slow-brain-0.169.0.json` | 真实Jev直接进入slow，856ms显示“我想想”；原生MCP提议一次，两个Task最终idle，无问题自动回答。两个回包均在两次改写后按预算截断，不能表述为可读性直接放行 |
| `results/control-0.169.0.json` | 取消、受控CLI退出后的失败重试、daemon重启后的显式恢复通过；启动时转interrupted、自动重放数为0，Scope关闭后已记录子进程均退出 |
| `results/delivery-0.169.0.json` | Jev实际输出queue与steer且执行无降级；原生题等待期间排队、答题后依次完成，steer在一个父turn内生效，始终同Task同会话游标，最终idle空队列且已记录子进程退出 |
| `results/mcp-management-live.json` | Codex 0.171.0 的真实管理操作和一次性搜索调用通过；保存完整工具输入/结果，主会话摘要经过回包门槛后截断，来源全文保留在原报告。公开端点未使用 OAuth，不代表第三方账户登录验收 |
| `results/main-thread-partial-0.167.0.json` | 早期新任务与同任务续聊完成，但最后fast查询未完成；15秒HTTP客户端超时后探针关闭。只证明已记录的部分场景 |
| `results/questions-main-thread-partial-0.167.0.json` | 同步答案已原生送达，但未观察最终报告，异步场景未执行完；没有重发该答案 |
| `results/progress-startup-0.167.0.json` | 首次发现未创建系统bot，API仍可用，模型回合尚未开始；不构成progress/gate验收结果 |

最新整体结论以 `docs/acceptance.md` 为准；目录中新增加的结果须按其自身断言与版本评估。
0.167.0样本与0.169.0复验分别保留，不因CLI更新重写旧证据。失败记录不会被后续成功覆盖。

已有成功样本证明具体合成场景，不证明所有提示都稳定选中同一分支。Jev概率、网络与CLI冷启动
会影响路由及延迟；300ms是目标，856ms的实测不能称为已达到该目标。普通worker没有提议权限的
拒绝路径另有bridge/Chief单元测试，不是慢脑成功样本的隐含结论。


## 建 Bot、并发与派发纠正复验

继续使用本页的隔离目录和现有认证。三个探针均支持 `AUT_E2E_RESULT` 指向新的结果文件。

- `bot-dispatch-live.ts` 从主会话委托普通 Agent 和慢脑各建一个 Bot，核对原生工具结果、未使用 Bot 的回执撤销、首次派活后的回执状态，以及中文专长、引用降级和派发纠正。
- `concurrent-delivery-live.ts` 在两个 worker 同时待答时发出模糊请求，然后用自然语言取消较新的任务，验证另一个任务在排出时把两条追加消息合并到一轮。
- `restart-live.ts` 在运行中的原生回合替换指令。若用户入口返回重做澄清卡，探针只点击该任务绑定的 restart 选项，检查原会话两轮的实际终态。

运行方式为 `node --experimental-strip-types spikes/e2e/<脚本名>`。最新结果与耗时见 [验收结果](../../docs/acceptance.md)。
