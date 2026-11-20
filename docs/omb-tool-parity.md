# 工具展示对照

工具名称、详情、分组、折叠、可见性与定位沿用 OpenMausBot `738ec88472a3b888ff7b7793755d89da613ed301` 的 Apache-2.0 源码（ADR-0036）。范围限 UI 与所需纯函数，不含 `enterprise/`、账户、云端或调度器。

## 行为要求

| ID | 验收要求 |
|---|---|
| P01 | Simple 显示可读动作摘要，命令原文放入详情 |
| P02 | Advanced 使用原始工具名/原生 label，按上游条件显示命令摘要 |
| P03 | MCP 前缀、未知名称分词与显式 label 优先级沿用上游规则 |
| P04 | 连续成功工具形成 run；单条独立显示，正文分隔 run |
| P05 | 分组显示总步数、重复次数及最多三个名称，保留首次出现顺序并显示其余种类数 |
| P06 | 不跨角色、Bot 或本地日聚合 |
| P07 | 运行、失败、未确认步骤不并入成功 run |
| P08 | recovery、notice、stopped、failed-turn 记录及正文中的相同前缀不误作成功工具 |
| P09 | 终结回答后仅折叠该回合成功工具；用户输入、进度、结果与非成功步骤保留在外 |
| P10 | 未结束回合只使用连续工具分组 |
| P11 | 组与详情默认折叠，键盘可切换，aria-expanded 与实际一致 |
| P12 | focusItem 展开所属组并定位；查看不恢复任务，当前无全局工具搜索入口 |
| P13 | 隐藏工具仍保留正文、结果与非工具状态记录 |
| P14 | 失败摘要显示明确原因全文；成功工具忽略 problem |
| P15 | 详情完整展示输入输出，按文本处理，不执行 HTML |
| P16 | 空输出区分运行中、未确认与已完成/失败 |
| P17 | clipped 组件首次展开读取完整输出，成功后缓存 |
| P18 | clipped 读取失败保留预览，关闭中止，再次展开可重试 |
| P19 | 实时刷新按稳定 ID 更新，保留展开、焦点和阅读位置 |
| P20 | 1040px 窗口与长文本不横向溢出，输入输出仍可完整读取 |

P17–P18 已由迁入组件测试覆盖；生产 API 返回完整输出，不设置 clipped，未启用该懒读路径。

## 来源与适配

所有迁入文件保留来源头、固定版本和修改说明；逐文件归属以 [NOTICE](../NOTICE) 与文件头为准。本地根目录为 `apps/desktop/src/openmausbot/`。

| 上游来源 | 本地位置与采用方式 |
|---|---|
| ToolActivity、ActivityRun、TurnNarrationRun、PlaceIcon | `components/`：沿用组件行为，适配导入、类型、语言、宿主端口及 aut 样式 |
| WorkingIndicator、AttachmentPreview、state/store | 分别摘取 WorkingDots、附件上下文类型和最小 Message/Tool 类型 |
| activity-runs、tool-step-label、activity-text、working-time | `lib/`：整文件迁入纯规则与对应测试 |
| server-text、tool-name、client-cancel、tool-surface | `shared/`：server-text 取协议实际定义，client-cancel 只使用已停止活动的标记判断 |
| place、approval-summary、verify-steps、transcript-derivations、failed-turn | 摘取所需位置、命令、时间和失败标记函数；其余后台逻辑不迁入 |
| i18n 与四语言词条 | `lib/`、`locales.ts`：保留插值和回退规则，产品名与默认语言适配 aut |
| ToolActivity 与纯规则原测试 | 对应测试文件：保留 UI/规则断言，外部后台生成器换为固定 fixture |

### 会话数据

`apps/desktop/src/session-presentation.ts` 将只读 SessionHistory 投影给组件：

- ID 使用 `turnId:itemId`；正文、输入输出与顺序保留原始记录，原生 item ID 用于定位。
- 只有明确 completed/failed 映射为成功/失败；仅运行回合中的运行项显示 live。已完成助手消息的原生 final phase 才触发终结折叠。
- 时间取原生 item，缺失时回退原生 turn 时间，再缺失使用稳定零值。失败原因只取明确结构化错误，不从任意输出猜测。
- 生产记录完整提供输入输出。提示统一为「工具输入与输出记录，分享前请先检查」，不声明自动脱敏或裁剪。

### 样式

工具组件共用桌面主题与本地字体。展开详情在空间充足时宽 608 px，窄窗口内随可用宽度缩小。输入输出可滚动，失败原因可换行。当前样式约定见[品牌规范](brand.md)与 [ADR-0050](decisions/0050-unified-desktop-styles.md)。

## 验收结果

桌面主题迁移后的对照使用同一组工具数据，核对八种状态的可见内容、可访问名称与键盘展开。aut 单独检查 608 px 展开宽度、窄窗口换行和焦点。复验入口见下节。

以下记录来自 2026-11-17 的迁移前基线。

| 范围 | 结果与证据 |
|---|---|
| 源码与组件 | 八份纯规则文件及八个组件/辅助函数的运行时 AST 对照一致；迁入用例覆盖分组、标签、完整输出及失败重试 |
| 同输入上游对照 | 八种状态的 DOM、文本、可访问属性与几何一致：[报告](../.artifacts/omb-tool-parity/oracle-report.json) |
| 原生数据投影 | 运行中与完成态的分组、DOM 对照一致：[报告](../.artifacts/omb-tool-parity/native-oracle-report.json) |
| 实时、分页与定位 | 状态与阅读位置保留，未触发执行或用户动作：[桌面](../.artifacts/omb-tool-parity/desktop-report.json)、[定位](../.artifacts/omb-tool-parity/production-focus-report.json)、[审计](../.artifacts/omb-tool-parity/final-fixture-audit.json) |
| 本机 Electron | 工具展开宽 608px、字号 13px、Geist 加载正常；模式切换与隐藏工具保留结果，任务和配置未变化：[记录](../spikes/e2e/results/tool-parity-native.json) |
| 构建与开发包 | 自动检查、样式回归、ZIP/许可与实际验收构建匹配：[包记录](../spikes/e2e/results/tool-parity-release.json) |

## 复验

组件与投影测试位于 `apps/desktop/src/`，浏览器场景与控制方式见 [桌面验收说明](../spikes/desktop/README.md)。上游对照入口：

```sh
rtk proxy node spikes/desktop/tool-parity-oracle.mjs
rtk proxy ego-browser nodejs < spikes/desktop/tool-parity-browser.ego.mjs
```
