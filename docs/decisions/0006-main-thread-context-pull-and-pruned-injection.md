# ADR-0006：main thread 上下文——按需拉取 + Jev 剪枝的少量注入

- 状态：已接受
- 日期：2026-11-16

## 背景
交接时 worker 需要知道用户在做什么，用户原话往往不自包含（可能由多句组成、带指代）；但全量注入会污染上下文、浪费 token。

## 决策
- 不默认注入 main thread。agent 通过 McpBridge 工具 `read_main_thread` / `list_tasks` / `get_task` 按需拉取。
- 交接包 = 模板任务头 + 用户原话 + Jev 剪枝出的相关片段（token 预算约束）+ 引用 ID + 工具提示。
- v1 不由 LLM 撰写简报。

## 理由
借鉴 DeepSeek super-agent 的 Inline & Spill / Chain of Recall：少量内联、其余给 ID；worker 是强模型，给准确上下文比替它转述更好；chief 保持不生成。

## 后果
若实测交接质量不足，可在树中增加"简报"慢脑节点（需新 ADR）。
