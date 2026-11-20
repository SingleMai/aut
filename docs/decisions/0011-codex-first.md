# ADR-0011：Codex 优先

- 状态：已接受
- 日期：2026-11-16

## 决策
MVP 只实现 Codex adapter（`codex app-server` JSON-RPC），走通全流程后再做 Claude Code 与通用 ACP。

## 理由
先用一个 harness 走通端到端链路；OpenMausBot 的驱动无法直接复制，多 harness 并行只会放大不确定性。

## 后果
P0 必须先探明 Codex 何时发出提问请求（OMB 未发现开启配置）、是否有原生 fork、transcript 来源；结论可能触发补充 ADR。
