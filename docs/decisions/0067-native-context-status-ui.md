# ADR-0067：原生上下文状态的只读展示

- 状态：已接受（用户要求接入原生状态，不提供手动压缩按钮）
- 日期：2026-11-24

## 背景

ADR-0066 将工作会话上下文交给 Harness。本次只把原生用量和压缩过程接入现有工作会话视图。
Codex 0.171.0 的独立临时会话探针，通过进程级低阈值触发自动压缩，录到
`thread/tokenUsage/updated` 及 `contextCompaction` 的开始、完成和历史记录；未请求手动压缩。

## 决策

1. 在只读 `SessionHistory` 增加可选 `context`（原生用量和最近压缩节点），由
   `AdapterCapabilities.sessionContext` 声明支持。当前仅 Codex 经过探针并声明支持，其他 adapter 不伪造数据。
2. 用量取最近一次原生 `last.inputTokens` 与有效的 `modelContextWindow`，不使用累计计费 token、
   本地字节估算或臆测窗口。压缩中不采纳读数；压缩后等待新的有效读数，旧百分比不继续展示。
3. 压缩节点是带 `noteKind: context-compaction` 的只读记录，保留原生 ID、时间和状态；
   开始/完成通过既有 `session.changed` 使 UI 回读，不改变 Task 状态、待答问题或回包逻辑。
4. 历史分页保留完整会话的当前 context，较早页面不能覆盖客户端已持有的新状态。冷读只展示
   原生历史中能确认的压缩记录；`thread/read` 不返回用量，不把历史或缓存值当作新读数。
5. UI 适配 OpenMausBot `ComposerContextMenu` 的用量环和详情仪表、`contextReading` / `formatTokens`
   及压缩后撤下旧读数的规则。入口放在工作会话的显示控件旁，原生压缩在过程记录及运行提示反馈。
   只读详情通过 Radix Popover 展开，不提供压缩、清空上下文或重新开始按钮，不新增写 API。

## 理由与后果

沿用原有只读快照与刷新链路，避免为了显示状态额外发起模型调用。未知、读取失败与中断均不能
显示为 0% 或整理成功。原生用量在冷读后需要等待新的运行通知；此限制由真实协议决定。
源码来源与改动记入 NOTICE；协议回放、分页竞争、界面状态与真实浏览器检查覆盖本次接入。
