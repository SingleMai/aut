# 外部参考

> 参考代码只是线索，不是事实（AGENTS.md 铁律 13）。借用任何代码须在文件头注明来源并更新 `NOTICE`。

## OpenMausBot
- 仓库：https://github.com/milind-soni/OpenMausBot （阅读时 commit `738ec88`，2026-11-16）
- 许可：Apache-2.0，**`enterprise/` 目录除外**（源码可见许可，禁止借用）。
- 定位差异：它的协调者 Chief of Staff 是 LLM bot（`server/chief-of-staff.ts`，用 `coordinate_bots` 工具委派），与 aut 的非 LLM chief 相反；仅房间路由用了 Jev。
- 实现时优先参考其已经处理的基础工程问题与回归测试，包括回合结束、取消、重启、队列排出和投递幂等；不另造一套同类机制。将设计映射到 aut 的 Effect、串行 chief 与常驻 session 约束，Codex wire 字段仍以本地探针为准。此次具体映射见 ADR-0017。
- 值得参考的位置：

| 主题 | 路径 | 用法 |
|---|---|---|
| Jev 客户端 | `server/decider/jev.ts`、`server/decider/types.ts` | 可近乎直接借用（改用固定模型版本） |
| Jev 用于路由的降级策略 | `server/decider/room-routing.ts` | 1.5s 超时、0.6 最低概率、失败回落到规则 |
| Adapter 契约 | `server/contracts.ts`（`ProviderAdapter` / `ProviderInstance` / `ProviderDriver`） | 设计参考 |
| 投递语义 | `server/admission.ts`、`server/steer-queue.ts`、`server/routes/bot-messages.ts`（`followUp: steer/queue/restart`） | 排队、steer、排出合并（120s / 30 条） |
| 回合结束与取消 | `server/runtime/runtime.ts`、`server/person-stops.ts`、`server/host/person-stop.ts` | 先持久化取消，再中断；turn/执行代次所有权；restart 先入队再 Stop，清理后排出 |
| 迟到回答与投递幂等 | `server/person-replies.ts`、`server/send-idempotency.ts`、`server/drivers/codex-questions.ts` | 稳定投递标识；明确拒绝才重排；indeterminate 不重投 |
| Codex 驱动 | `server/drivers/codex.ts`、`codex-questions.ts`、`codex-approval-config.ts` | 协议参考 |
| Claude 驱动 | `server/drivers/claude.ts`、`claude-keepwarm.ts`（原生 fork）、`claude-unusable-tools.ts` | 协议参考 |
| ACP 驱动 | `server/drivers/acp/core.ts`、`acp/grok.ts`、`acp/steer.ts` | 协议参考 |
| 提问代理 | `server/permission-proxy.ts` | Claude 的 `ask_user` MCP 注入与 AskUserQuestion 回填 |
| 权限模式 | `packages/phone-protocol/src/approval-mode.ts`、`server/auto-approve.ts`、`docs/approval-levels.md` | 默认 full、question 永不自动回答 |
| Bot 配置 | `packages/phone-protocol/src/wire.ts`（`WireBot`） | aut bot schema 的来源 |
| 桌面对话 UI | `src/styles.css`、`src/components/{ChatView,Composer,QuestionCard,ReplyQuote,Sidebar}.tsx`、`chat-bubble.ts`、`src/lib/{send-key,chat-width,question-card}.ts` | 沿用 ADR-0034 的布局、气泡、输入与问答交互，视觉实现见 [ADR-0050](decisions/0050-unified-desktop-styles.md) |

## DeepSeek Super-agent
- 设计文章英译：https://offloop.org/learn/exploring-deepseek-super-agent-design
- 解读：https://agentspulse.github.io/tutorials/deepseek-super-agent-architecture/
- 原型：https://github.com/deepseek-ai/dsh-superagent-prototype
- 借鉴点：
  - Router/Worker 分离，worker 不直接面向用户；router 是全局排序点。
  - **回包门槛是代码强制的**：`src/infra/text.ts` 的 `checkedImText` 超过 100 词即报错
    "Rewrite as a short high-level update. Do not split it into multiple messages."，模型据此重写。aut 改为 fork 改写（ADR-0007）。
  - Inline & Spill 与 Chain of Recall：交接时内联少量上下文、其余给 ID 按需读取（aut 交接包的依据）。

## Jev（TypeSafe AI）

2026-11-16 已核对官方实时文档，并用固定模型完成合成输入的真实调用。

- 实现入口：`packages/classifier`；细节与复现见 [classifier.md](classifier.md)。
- 直连 `https://api.typesafe.ai/v1/systemone`，默认固定 `jev-1.14.0`；版本必须显式固定，不使用 latest/preview。[模型资料](https://docs.typesafe.ai/models.md)
- 支持同请求混合 choice/noul/score。当前 OpenAPI：choice 1–255 个候选、score 1–10 个等级；建议 score 至少两个有意义的等级。单候选 choice 已实测通过，故不照搬 OMB 的旧 min=2 限制。[API](https://docs.typesafe.ai/api/system-one.md)、[Score](https://docs.typesafe.ai/primitives/score.md)
- 厂商 choice.confidence 是分布集中度；aut 沿用 OMB pTop，令 confidence=probabilities[choice]，保留全部概率。详见 ADR-0019。[Confidence](https://docs.typesafe.ai/confidence.md)
- 默认每请求 64k、每问题 32k token；没有额外的问题条数上限。body 上限 32MiB；数据嵌套最多64层。[模型资料](https://docs.typesafe.ai/models.md)、[请求规则](https://docs.typesafe.ai/api/errors.md)
- 中文效果：1.14 官方只说明多语言能力改善，没有中文准确率数据；本仓库中文 smoke 通过不代表业务准确率。instructions/criteria 保持英文，中文 state 原样发送，后续依赖自有标注集评测。[Changelog](https://docs.typesafe.ai/changelog.md)
- 已知弱点包括日期、计数、算术、间接指代、无关上下文与候选顺序；这些处理优先放代码。[Model jaggedness](https://docs.typesafe.ai/model-jaggedness.md)
- 数据政策：官方承诺不用 Input 训练/微调；DPA 按处理目的必要时长保留，未给固定天数；企业可申请 ZDR，不能推断普通账户默认零保留。[隐私政策](https://typesafe.ai/legal/privacy-policy)、[DPA](https://typesafe.ai/legal/data-processing)、[Legal](https://docs.typesafe.ai/legal.md)
- 参考 OMB `738ec88` 的 `server/decider/{jev,types,room-routing}.ts`：概率验证、1.5s总预算、错误体不回显、禁止重定向。实现改用 Effect/Schema；署名见 NOTICE。
