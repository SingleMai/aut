# ADR-0013：MVP 范围约束

- 状态：已接受
- 日期：2026-11-16

## 决策
- bot 不做 memory（长期指令写入 workdir 文件由 harness 读取）。
- 不设并发 session 上限。
- 不做主动型 agent，但事件模型预留 `trigger` 来源，未来以"带触发器的 bot"实现。
- 一个 task = 一个 bot 的一个 session，创建后不可换 bot。
- request 树 v1：question 永远转给用户，不做自动默认回答。

## 理由
保持最简模型，先验证"决策树驱动的 session 管理"这一核心实验。
