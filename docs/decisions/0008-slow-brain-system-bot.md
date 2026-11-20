# ADR-0008：慢脑是系统 bot，经 propose_route 动手

关于两个内置角色的决定已由 [ADR-0047](0047-single-primary-assistant.md) 更新。

- 状态：已接受
- 日期：2026-11-16

## 背景
快脑（决策树 + Jev）会遇到处理不了的情况：意图不明、复合指令、跨多任务的元请求。

## 决策
- 内置系统 bot `slow-brain`。决策树的 `slow` 节点：chief 模板回复"我想想"，在 slow-brain 上创建 task，后台运行，回来后在 main thread 与用户讨论。
- 慢脑工具：`read_main_thread`、`list_tasks`、`get_task`、`propose_route`。
- 慢脑不直接改变任务结构；需要派活/操作任务时提交结构化 Op，由 chief 校验、执行、记录决策日志。
- 另设系统 bot `general` 作为 new 路由兜底的通用 worker（与慢脑职责分离）。

## 理由
保持"快"的即时反馈；下沉是树的一环；"动手"的权力仍在确定性执行器里，避免慢脑演变为 LLM 协调者。

## 后果
慢脑 task 在任务面板可见，用户的后续回复按普通 send 路由到它。
