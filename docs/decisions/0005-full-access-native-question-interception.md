# ADR-0005：默认最高权限 + 问答原生拦截

- 状态：已接受
- 日期：2026-11-16

> 问题阻塞性与多请求状态语义由 ADR-0015 补充：原生非阻塞提问允许继续工作，`waiting_user` 表示存在未答问题。

## 背景
底层 session 不开放给用户，harness 的审批弹窗与提问必须由 chief 这一层处理。
曾考虑 MVP 用"回合结尾写 NEEDS INPUT"的文本约定替代原生拦截，被否决：回合中断、体验差。

## 决策
- 所有 harness 用原生最高权限模式启动；仍到达的 permission 请求自动放行（并审计）。
- question 必须原生拦截：harness 原生提问协议/工具 → `SessionRequest` → main thread 问题卡片 → 原通道回填；回合保持挂起，question 不设超时。
- 自动放行永不作用于 question。
- Codex 的处理方式以 OpenMausBot 为准（`item/tool/requestUserInput` + async 变体经 `turn/steer` 回填）。

## 理由
原生拦截让问答发生在回合中途，不中断工作；"最高权限"符合个人本机使用场景，避免无人点击的审批卡死。

## 后果
- daemon 必须常驻并保持 harness 进程存活。
- 每个 harness 的提问协议不同，需逐个探针与适配；能力不足时 UI 降级。
- 本机最高权限有风险；未来可在 permission 节点加入危险命令保底拦截（参考 OMB `drivers/permission-command.ts`）。
