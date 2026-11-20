# ADR-0015：待回答问题与回合执行状态

- 状态：已接受（用户确认保留异步继续工作）
- 日期：2026-11-16

## 背景

P0 对本机 Codex CLI 0.167.0 的真实探针观察到两种不同的问答行为：

- Plan 模式的 `item/tool/requestUserInput` 请求带 `isBlocking: true`。
- 默认模式开启 `default_mode_request_user_input` 后，同一请求可带 `isBlocking: false`；
  `request_user_input_async` 还可通过 `agentMessage.delivery: "async"` 发出问题，以 `turn/steer` 接收回答。

精确样本与复现方式见 `spikes/codex/`。这些事实与 `architecture.md` §7.6 中
“question 一律保持回合挂起”的描述不一致。`protocol.md` 的任务表还规定任一回答都会使
`waiting_user → running`，不能表达同一任务仍有其他未答问题的情况。

## 决策

1. 保留原生阻塞与非阻塞问答行为，不由 aut 强制中断非阻塞回合。
2. `waiting_user` 表示“该任务有尚未回答的问题”，不承诺 worker 已停止执行。
   同步阻塞请求的暂停由 harness 自身负责；异步请求允许 worker 继续工作。
3. 同一任务允许同时存在多个待答 request，以 `pendingRequestIds` 为依据：回答部分 request
   后仍为 `waiting_user`，最后一个待答 request 完成后才回到 `running`。
4. 单个 request 内多道 questions 使用现有 `QuestionAnswer.perQuestion` 一次整组回填，
   不通过自动批准或空答案补齐。
5. 回合结束后未答卡片按现有规则过期；用户之后回答走下一回合 `send`。
   回填与回合结束的竞争必须串行处理，不能将同一个回答同时投递两次。
6. 权限自动放行规则不变；任何类型的 question 都只能由用户回答。

## 理由

既保留已经验证的 Codex 原生能力，也沿用现有 `pendingRequestIds` 与任务状态模型。
将“用户尚未回答”和“worker 是否停住”区分，避免第一次回答就错误清除仍在等待的状态。

## 后果与验收

同步修改 `architecture.md` §6/§7.6、`protocol.md` §4/§5 及相关测试要求。
至少验证：阻塞提问、异步提问继续工作、同任务两个 request 逐个回答、单 request 多题整组回答、
回合结束后的迟到回答。TaskRegistry 仍按声明式表驱动，不把判断散落到 adapter 或 UI 中。

此提议不决定底层问答工具开关；adapter 的版本与开关选择仍以 P0 录制证据为准。
