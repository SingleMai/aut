# 工作会话 UI 验收记录

- 日期：2026-11-17
- 环境：本机 ego-browser；真实桌面 bundle 与本地 API，合成只读 session adapter
- 场景：`spikes/desktop/task-session-qa.ts`
- 范围：浏览器预览交互与 API / WebSocket 联通；不代替真实 Codex 协议探针或 Electron 原生打包验收

## 结果

| 检查 | 结果 |
| --- | --- |
| 首次读取 | 12 轮中加载最新 10 轮，最新轮直接显示，历史组及工具默认折叠 |
| 早期分页 | 加载后恰好 12 个唯一 turn，最早 `qa-turn-01`，最新 `qa-turn-12`；历史组展开，分页按钮隐藏 |
| 长交接输入 | 120 字符摘要与“本轮输入”标记；完整 1169 字符可展开，末尾标记保留，内容滚动高度 653 / 360 px |
| 工具内容 | command、fileChange、MCP 的原始输入输出可展开；失败与未知状态分别显示，未知状态没有推断为成功 |
| 实时稳定性 | 同一工具重复失效通知后仍只有 1 个卡片；工具节点、输出节点、展开状态和键盘焦点均保留 |
| 阅读位置 | 更新前后工具输出滚动 318.5 px、外层滚动 449 px、工具卡 top 608.8 px 均一致；刷新中无插入加载行 |
| 故障与恢复 | unavailable 显示可重读提示，已加载 12 轮与展开工具保留；恢复后提示收起 |
| 最终结果 | 进行中工具更新为完成，最终结果恰好 1 条，运行提示收起；待答问题仍独立保留 |
| 问题跳转 | 点击“回主会话回答”定位原生题卡并聚焦首个 radio；查看会话时没有独立 composer |
| HTML 安全 | 历史助手文本中的 script 仅作为原文显示，测试标记未执行 |
| 读取降级 | pending / unsupported / unavailable / 空历史有不同明确提示；只有 unavailable 提供重读按钮 |
| 窄窗口 | 1040 × 760 下内容宽 800 px，scrollWidth 同为 800 px，无横向溢出；工具摘要未越界 |
| 顶部空间 | 1492 × 853 首次读取时最新轮 top 从 576.3 px 收紧到 414.3 px |

验收过程没有发送主会话消息或问题答案，审计 `userActions` 为空；适配器
`startAttempts` 始终为 0。所有工具输出都是合成记录，没有执行其展示的命令。

## 校验

```sh
pnpm typecheck
pnpm --filter @aut/desktop bundle
pnpm exec tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --module NodeNext --target ES2023 --skipLibCheck --types node spikes/desktop/task-session-qa.ts
```

上述检查通过。UI 模块通过 Biome；共享样式的其他区段由主开发者统一收尾。

本次截图位于工作区 `.artifacts/task-session-compact.png`、`task-session-tools.png`、
`task-session-final.png`、`task-session-narrow.png`，供主开发者选择发布。

## 独立审查后的追加回归

- 仅更新任务活动时间并发布工具失效通知：任务信息、最近报告保持同一 DOM 节点，两层展开和 summary 焦点保留。
- 最近报告原文变化：标题区按需重建，两层展开状态和最近报告 summary 焦点正确恢复。
- 将题卡置于 60 条后续 notice 之前：首次渲染为 50 条消息、0 张题卡；从任务点击回答后自动补读，得到 62 个唯一消息、1 张题卡，radio 获焦，题卡 top 为 217.5 px。
- 旧只读快照受 Deferred 明确挂起（标准输出 cursor 为 `full`）后切换 cursor：旧快照尚未返回时界面已清空为 0 轮；释放旧响应后仅展示 `qa-replacement-turn`。MutationObserver 未发现旧回合重新插入。
- 追加回归仍无用户动作和 Harness 启动；fixture / preview 进程与 ego 测试空间已全部关闭。

最后两项在独立新一轮浏览器验收中通过：

- 顶部手动刷新：记录 `window.aut.request` 的真实完成结果后再断言，观察到一次成功的
  `GET /v1/tasks/qa-session-full/session?limit=10`，回合数量保持 10。该计数只观察请求，未替换返回值。
- 最新工具名称宽度：1040 × 760 窗口下内容 clientWidth / scrollWidth 都为 800 px，
  5 个工具 pill 均无横向越界。commandExecution、fileChange、两类 MCP 名称的
  clientWidth 与 scrollWidth 相等，均完整可见，computed max-width 为 360 px。
- 截图 `.artifacts/task-session-tool-width-final.png` 已检查。最终审计 `startAttempts: 0`、
  `userActions: []`；浏览器测试空间和本轮 fixture / preview 均关闭。
