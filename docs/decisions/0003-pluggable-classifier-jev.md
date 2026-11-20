# ADR-0003：Classifier 可插拔，默认 Jev，后端由用户配置

- 状态：已接受
- 日期：2026-11-16

## 背景
Jev（TypeSafe "System One"）提供类型化选择题（choice/noul/score），p50 约 200ms、成本极低、返回概率，适合作快脑。但它只有托管 API，且资料以英文为主。

## 决策
定义 `Classifier` 接口（形态对齐 Jev / OpenRouter Decisions API），Jev 为默认后端，必须固定模型版本。
后端由用户在设置中配置；未来扩展 LiteLLM 等结构化输出后端。不可用时决策树降级为 clarify，绝不阻塞。

## 理由
快、可校准概率、选项可动态生成，天然适合"选择题式"的协调；可插拔规避单一托管服务依赖。

## 后果
- 用户消息会发送到所选分类服务（隐私需在设置中明示）。
- criteria/instructions 统一英文；中文效果需用自有标注集验证。
- 改动选项措辞后需重新校准阈值。
