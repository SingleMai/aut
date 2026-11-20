# ADR-0019：Jev 固定版本与路由概率归一化

- 状态：已接受（按既定概率阈值语义细化）
- 日期：2026-11-16

## 背景

TypeSafe 当前 API 的 choice.confidence 是分布集中度，受候选数量影响，
并不等于所选项概率。OpenMausBot `738ec88` 的 `server/decider/jev.ts` 与
`types.ts` 明确提取 pTop，并用它做路由门槛。aut 决策树的阈值采用概率语义。

## 决策

- 固定默认模型 `jev-1.14.0`，拒绝 latest/preview 等漂移别名；响应 model 必须匹配请求。
- aut `DecisionResponse` 的 choice.confidence 定义为 `probabilities[choice]`。
  不将厂商集中度写入这个字段；完整概率分布保留，用于决策日志和校准。
  score 分支增加可选 probabilities；Jev 后端必须填入。legend 与请求 criteria 的下标逐项一致，因此可从已记录的请求还原，无需重复字段。
- 请求类型、候选与返回分布逐一验证；choice 必须是概率最高项之一。
  score 验证该请求的层级范围，noul 验证 [0,1]。不在 classifier 内路由或生成 clarify。
- 整个调用（含响应体读取、退避与重试）有默认 1500ms 总预算；429/5xx 使用 Effect Schedule
  退避，超过预算或最终失败返回类型化错误。重试不产生额外的独立分类问题请求。
- 密钥以运行时 Redacted 值注入，不写配置/日志/fixture。HTTP 错误体不读入错误消息，
  禁止携带密钥跟随重定向。

## 理由

沿用已经验证的 OMB 概率门槛模式，同时遵守 aut 的 Effect、Schema 与固定模型约定。
原始响应集中度仍可在无密钥的测试录制中观察；稳定的路由语义不随候选数量改写。

## 后果

同步 `protocol.md` 与分类器使用说明；真实中文 smoke 只证明该样本可用，不是中文准确率评测。
不得把合成异常测试样本宣称为服务录制。后端故障的 fallback/clarify 仍由决策树负责。

## 依据

- [TypeSafe Confidence](https://docs.typesafe.ai/confidence.md)
- [TypeSafe Models](https://docs.typesafe.ai/models.md)
- [TypeSafe API](https://docs.typesafe.ai/api/system-one.md)
- [OpenMausBot Jev adapter](https://github.com/milind-soni/OpenMausBot/blob/738ec88/server/decider/jev.ts)
