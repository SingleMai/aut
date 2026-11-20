# ADR-0016：协议 Schema 的基础类型与决策树数据格式

- 状态：已接受（既定架构的实现细化）
- 日期：2026-11-16

## 背景

`protocol.md` 已确定领域字段与接口，但尚未定义 ID、时间戳、恢复游标、回合输入、
配置文件、MCP 输出及树配置的具体序列化结构。直接编码会导致不同模块各自补字段，
也可能让持久化边界接受不能被 JSON 保存的值。

## 决策

1. ID 使用非空字符串品牌；时间为非负安全整数的 Unix 毫秒时间戳。所有不透明数据
   只允许有限 JSON 值，禁止函数、`undefined`、`BigInt`、非有限数字等。
2. 恢复游标包装 adapter 的不透明 JSON 数据；上层仅存取，禁止依据 harness 名称做业务分支。
   回合输入承载文本与消息引用，transcript 使用统一角色/文本条目。StartSessionInput 带 taskId，临时 fork 沿用源 taskId。
   AdapterError 区分确定过期与投递结果未知，避免不确定结果触发重复 send。
3. 配置与 MCP 输入输出按 `protocol.md` 补齐。密钥仅存引用，引用解析属于配置服务；
   classifier 未配置是合法状态。Bot 权限仍固定为最高权限。
4. UI 增加 `question-answer` 动作，承载一个 request 的整组 `QuestionAnswer`；保留
   `card-choice`，不以多个单选点击隐式代替多题提交。
5. 树使用固定的纯数据 Expr / Predicate AST；允许必要的集合变换和模板插值，禁止
   `eval`、脚本字符串、任意函数名注册表。六种节点不变，阈值保存在树配置中。
6. `classify.onError` 必填；`slow` 只允许出现在 inbound 树，`rewrite` 只允许出现在
   reply-gate 树。Schema 校验节点与阈值引用；执行器还必须限制总步骤预算与最多两次改写，
   循环不能绕过预算。输出在执行时再用对应结果 Schema 校验。
7. 不改变既有状态机或决策阈值。`waiting_user` 多请求语义遵循 ADR-0015。

## 理由

共享 Schema 既是编译期类型来源，也是 IPC、配置、持久化的边界校验。
AST 使分支与数据处理可审查、可记录，并避免在通用执行器中隐藏业务意图判断。

## 后果

新增或修改协议字段需同步文档与 Schema。递归 Card/Op 和 AST 使用延迟 Schema；
接口中的 Effect/Stream/Scope 不是可序列化数据，不伪装成 JSON Schema。
每个导出的数据 Schema 需提供往返与非法输入测试。classifier 的回答题型、choice 候选范围、
置信度与对应概率一致性等依赖请求的约束，由响应适配层额外校验。
