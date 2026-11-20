# ADR-0009：技术栈

- 状态：已接受
- 日期：2026-11-16

## 决策
TypeScript（strict）+ Node LTS；pnpm monorepo；**Effect** 协调业务逻辑（Service/Layer、Schema、Queue/PubSub、Fiber、Scope、Schedule）；
SQLite + JSON 存储于 `~/.aut/`；Electron 客户端；daemon 常驻、UI 只是客户端；MVP 仅 macOS。

## 理由
- harness 生态（ACP SDK、MCP SDK、参考代码）在 TS；Electron 管理 Node 子进程最省事。
- 原生拦截要求进程长驻，daemon/UI 分离也为未来移动端/CLI 前端留口。
- Effect 适合大量并发长生命周期进程、队列、超时重试与类型化错误的协调。

## 后果
实现者需遵守 AGENTS.md §3 的 Effect 约定；Effect 版本在初始化代码时锁定。
