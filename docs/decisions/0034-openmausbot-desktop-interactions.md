# ADR-0034：以 OpenMausBot Simple / Daylight 为桌面对话基线

- 状态：已接受（用户明确要求先与 OpenMausBot 对齐，再做必要调优）
- 日期：2026-11-17
- 当前视觉规范见 [ADR-0050](0050-unified-desktop-styles.md)。

## 背景

早期桌面实现仅参考 OpenMausBot 的后台调度与原生问答机制，布局、消息和输入交互另行设计。
用户希望继承成熟客户端的交互细节，减少重复设计。按 ADR-0004 继续选择性借用，不 fork 整个项目。

## 决策

- 采用固定版本 `738ec88472a3b888ff7b7793755d89da613ed301` 的 Apache-2.0 UI 部分，排除 `enterprise/`。
- 视觉基线为 Simple 模式、Daylight 主题：浅灰侧栏与白色会话画布，紧凑标题条，消息/输入框同一居中列；
  用户消息右侧深色气泡、助手左侧浅灰气泡，15px/22px 文本，18px 气泡圆角，默认最大宽度 35rem/80%。
  保留 aut 品牌，不复制 OpenMausBot 的品牌标识或吉祥物。
- 沿用收敛的侧栏列表、搜索、状态与活动提示，引用和消息操作在悬停/键盘聚焦时出现。
  aut 主会话仍是唯一发送入口；任务项打开详情，不变成直接绕过 chief 的 bot 私聊。
- 输入框从单行高度随内容增长；Enter 发送、Shift+Enter 换行、Ctrl/⌘+Enter 亦可发送；
  中文输入法组合期间不发送。Esc 清除引用，网络接收期间新输入的草稿不能被旧发送结果清除。
- 复用原生提问卡的单题直选、多题分步与进度、最终整组提交交互。
  单题单选点击是用户明确提交动作；禁止默认勾选、自动回答或空题组提交。
  保留 aut 的 registered 显式重提、submitting/indeterminate 禁重、过期补答与草稿保留语义。
- 根据首轮使用反馈，补充一处明确的 aut 适配：多题尚未答完时底部按钮为「继续回答」，
  当前题完整后跳到下一道未答题；全部完成后同一位置变为「提交整组答案」。
  上游固定版本多选后仅靠顶部标签切题，未提供此继续入口。多题文字 Enter 也只完成当前题，
  不自动发送整组；保留本 ADR 已规定的最终明确提交。
- 跟随最新消息只作用于已在底部的读者；向上阅读时出现回到最新入口，加载历史保持阅读锚点。
- 保留不可变完整报告、来源任务、任务控制、Bot/分类器设置和密钥写入功能。
  现有原生 DOM/Effect 客户端通过既有 API 适配；不引入上游 cloud/team/计费或 LLM Chief。

## 来源与后果

主题与气泡：`src/styles.css`、`src/components/chat-bubble.ts`、`src/lib/chat-width.ts`。
会话与导航：`src/components/ChatView.tsx`、`Sidebar.tsx`、`SidebarSimpleTop.tsx`。
输入与引用：`src/components/Composer.tsx`、`ReplyQuote.tsx`、`src/lib/send-key.ts`。
提问卡：`src/components/QuestionCard.tsx`、`src/lib/question-card.ts`。

移植的文件注明来源、版本与适配说明，并更新 `NOTICE`。这是有对应源码的视觉与交互移植，
不是完整 React 前端的直接复用；测试覆盖输入法、草稿、历史滚动、问题投递与原报告读取。
