# ADR-0004：不 fork OpenMausBot，选择性借用

- 状态：已接受
- 日期：2026-11-16

## 背景
曾考虑直接 fork OpenMausBot 魔改以减少工作量。

## 决策
新建仓库。借用：Jev 客户端（`server/decider/jev.ts`）、Adapter 契约设计（`server/contracts.ts`）、投递语义（steer/queue/restart）、各驱动作为协议参考、bot 配置字段子集。

## 理由
- 体量与耦合：`server/` 约 29 万行源码 + 40 万行测试，UI 约 29 万行，`server/index.ts` 单文件 1.5 万行；cloud/team/boat/phone/计费贯穿核心类型，需剥离超过一半且难在解开交叉引用。
- 核心理念相反：其协调者是 LLM bot。
- 许可允许借用（Apache-2.0，`enterprise/` 除外）。

## 后果
驱动需按 aut 接口重写精简版；借用代码需维护 NOTICE 与文件头署名。
