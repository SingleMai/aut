# Classifier / Jev 实现

`packages/classifier` 提供 `/interface` 的 `Classifier` Service，以及具体实现
`makeJevLayer`、`makeMockClassifierLayer`。`core` 仅依赖 `/interface`；daemon 负责选择 Layer。
本模块只返回类型化判断或错误，备用后端和 clarify 仍由声明式决策树处理。

## 使用

```ts
import { makeJevLayer } from "@aut/classifier";
import { Redacted } from "effect";

// The configuration service resolves apiKeyRef before building this layer.
const classifierLayer = makeJevLayer({
  apiKey: Redacted.make(resolvedKey),
  config: { model: "jev-1.14.0" },
});
```

密钥在运行时注入，不由 classifier 读取环境、写配置或输出日志。`JevConfig` 用 Schema 验证：
默认 endpoint `https://api.typesafe.ai/v1/systemone`、固定模型 `jev-1.14.0`、总预算 1500ms、
最多重试 1 次、基础退避 100ms。总预算可配置为正安全整数毫秒；配置最多允许重试 2 次。
允许 HTTPS，以及本机 loopback HTTP；不接受 URL 凭据、query/hash 或重定向。

## 协议与失败处理

- 每次 decide 把全部 choice/noul/score 问题合为一个请求。重试重发同一批，不拆分问题。
- 按当前 API 验证 choice 1–255 个候选、score 1–10 个等级；单候选 choice 已真实录制。
  单级 score 遵循官方 OpenAPI 下限，通常应提供至少两个有意义的等级。
- 返回模型、问题集合、题型、choice 候选、完整分布、score 等级与 legend 均逐项校验。
  概率求和容差 0.1 沿用 OMB 对舍入的处理，不修改返回概率。score 分布进入协议日志；
  legend 必须等于请求 criteria，可从日志中的请求还原。
- choice.confidence 使用所选概率，不使用厂商集中度，见 ADR-0019。
- `Effect.timeoutFail` 限制整个请求，包括 fetch、响应体读取、退避和重试；Scope finalizer
  使用 AbortController 终止底层请求。429/5xx 使用 `Schedule` 指数退避并尊重 Retry-After。
- 其他 4xx、网络错误、格式错误不重试。HTTP 错误体不放入错误消息，异常文本也不包含请求或密钥。
  最终返回 `ClassifierError`，没有吞错或自动回答。

## 测试与录制

`fixtures/batch-zh.json` 和 `single-option.json` 是 2026-11-16 使用固定模型真实调用的响应，
输入为仓库中的合成测试语句；不包含用户消息、Authorization 或任何其他请求头。
`jev.test.ts` 回放这些响应；错误分布/HTTP 状态/超时等测试明确为合成用例。

```sh
pnpm exec vitest run packages/classifier/src
AUT_RUN_JEV_SMOKE=1 pnpm exec vitest run packages/classifier/src/jev.test.ts -t 'opt-in real Jev Layer smoke'
node packages/classifier/scripts/record-fixtures.mjs
```

后两条需要现有 `TYPESAFE_API_KEY`；普通测试默认跳过在线 smoke。
录制时返回：中文批量 661ms，单候选 296ms；真实 Layer smoke 481ms。
这是少量协议/接入检查，不能作为延迟 SLA 或中文路由准确率评测。

Mock 逐条消费给定的 request/response/error fixture，输入不匹配或耗尽就返回错误。
它不猜答案、不走网络，供后续决策树分支与阈值 fixture 使用。

## 官方资料核对（2026-11-16）

- [API / OpenAPI](https://docs.typesafe.ai/api/system-one.md)：混合批量问题、结果格式和候选上限。
- [模型](https://docs.typesafe.ai/models.md)：固定 `jev-1.14.0`；默认每请求 64k、每问题 32k token，
  没有独立的问题条数上限；本实现不打开长上下文模式。
- [错误与限制](https://docs.typesafe.ai/api/errors.md)：body 上限 32MiB，state/instructions/criteria
  各最多 64 层，429/529 要退避。模型 token 限制由服务执行，不用字符数冒充 token 估算。
- [changelog](https://docs.typesafe.ai/changelog.md) 说明 1.14 改善多语言支持，但未给中文准确率。
  中文业务质量仍需自有标注集验证；instructions/criteria 保持英文，用户 state 保留原语。
- [隐私政策](https://typesafe.ai/legal/privacy-policy) 承诺不使用 Input 训练或微调；
  [DPA](https://typesafe.ai/legal/data-processing) 按处理目的必要时长保留，没有固定天数保证。
  [Legal](https://docs.typesafe.ai/legal.md) 说明企业客户可申请 ZDR，不能宣称普通账户默认零保留。

参考实现为 OpenMausBot `738ec88472a3b888ff7b7793755d89da613ed301` 的
`server/decider/{jev,types,room-routing}.ts`；归属见根 NOTICE。没有使用 enterprise 代码。
