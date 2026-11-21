---
name: improve-codebase-architecture
description: 找出可 deepen 的 shallow module，生成可视化 HTML 报告，再就选中的一项逐轮追问到结论。
disable-model-invocation: true
---

<!-- Adapted from mattpocock/skills (MIT) at abeeaf95660ba9e8b7c753eb38f441ca707a8823:
     skills/engineering/{improve-codebase-architecture,codebase-design}/SKILL.md and
     skills/productivity/grilling/SKILL.md. See LICENSE in this directory and NOTICE. -->

# 改进代码库架构

找出架构摩擦，提出 **deepening** 候选：把 shallow module 重构成 deep module，目标是可测试性和 agent 可导航性。本技能的产出是报告、追问结论和 ADR 草稿；代码实现另起任务。

## 词汇

架构名词一律用下列英文原词，报告、卡片和追问都用同一组词：

- **module**：任何有 interface 和 implementation 的东西，不分尺度：函数、Effect Service、包、跨进程链路。
- **interface**：调用方正确使用 module 必须知道的一切：类型签名，加上不变式、调用顺序、错误类型、所需配置与 `Layer`、性能特征。
- **implementation**：module 内部的代码。
- **depth**：调用方或测试每学一单位 interface，能用到多少行为。interface 小而背后行为多是 **deep**；interface 几乎和 implementation 一样复杂是 **shallow**。
- **seam**：不改此处代码就能替换行为的位置，即 interface 所在之处。
- **adapter**：在 seam 处满足 interface 的具体实现。`HarnessAdapter` 的各 harness 实现、`Classifier` 的 Jev 后端、测试 mock 都是 adapter。
- **leverage**：调用方从 depth 得到的收益：一份 implementation 服务 N 个调用点和 M 个测试。
- **locality**：维护者从 depth 得到的收益：改动、bug 和验证集中在一处。

引用代码时，`Context.Tag`、`Service`、`Layer`、`Schema` 保留 Effect API 原名，再映射到上面的词：一个 `Context.Tag` Service 是 module 的 interface，它的每个 `Layer` 是一个 adapter。

领域名词以 `AGENTS.md` §0 和对应 `docs/*.md` 为准（chief、main thread、bot、session、Jev、决策树、交接包、回包等）。用领域名词给 module 命名，例如"回包门槛 module""chief 路由 module"。

### 原则

- **deletion test**：设想删掉这个 module。复杂度随之消失，说明它只是转发；复杂度在 N 个调用方重新出现，说明它值得存在。
- **interface 即测试面**：调用方和测试穿过同一个 seam。要越过 interface 才能测，说明 module 形状不对。
- **一个 adapter 是假想的 seam，两个才是真的**：只有一个 `Layer` 的 `Context.Tag` 只是间接层。
- **depth 是 interface 的属性**：deep module 内部可以由小部件组成，只要它们留在 implementation 里。

## 约束

- `AGENTS.md` §2 铁律和 §4 依赖方向是硬约束：每个候选都在铁律和依赖方向之内成立。
- `docs/decisions/` 的 ADR 记录已定决策。候选与某条 ADR 冲突时，只在摩擦真实到值得重议时列出，并在卡片上标明"与 ADR-NNNN 冲突，值得重议，因为……"。
- `AGENTS.md` §5 要求的测试（决策树分支 fixture、状态机转移、adapter 样本回放）在每个候选里都保留。

## 流程

### 1. 探查

先定范围。deepening 的回报是让将来的改动更容易，所以优先看最近频繁改动的区域：

- 用户指定了方向（module、子系统、痛点）就照做，跳过下面的推断。
- 否则读 `git log --oneline --name-only` 的较长一段历史，把反复出现的文件和目录当作热点。改动分散、没有明显热点时，扩大范围。
- 历史太短看不出热点时（例如不到 20 个提交），改看 `git status` 的未提交改动、`docs/progress.md` 和 `docs/roadmap.md` 当前阶段涉及的包；仍无头绪就请用户给范围。

读范围内的相关 `docs/*.md`（入口见 `AGENTS.md` §1）及其引用的 ADR。

然后派一个上下文全新的子 agent 探查代码。brief 包含范围内的路径、本文件「词汇」和「约束」两节全文、下面的问题清单和返回格式。让它记录阅读时实际感受到的摩擦：

- 理解一个概念，要在很多小 module 之间来回跳？
- 哪些 module 是 shallow 的？
- 哪些纯函数只为可测试而抽出，真正的 bug 却藏在调用方式里（缺 locality）？
- 哪些紧耦合的 module 跨 seam 泄漏？
- 哪些部分没有测试，或通过现有 interface 很难测？

子 agent 对每个疑似 shallow 的 module 做 deletion test，返回：涉及文件、deletion test 结论（复杂度集中还是只是挪动，点名受影响的调用方）、依赖类别（见 [DEEPENING.md](DEEPENING.md)）。

完成标准：范围内每个热点目录都有结论（候选或"无摩擦"），每个候选都有点名调用方的 deletion test 结论。

### 2. 报告

按 [HTML-REPORT.md](HTML-REPORT.md) 写一个自包含 HTML 文件到 `${TMPDIR:-/tmp}/architecture-review-<时间戳>.html`，用 `open` 打开，并告诉用户绝对路径。报告留在仓库之外。

每个候选一张卡片：涉及文件、问题、方案、收益（用 locality 和 leverage 表述，并说明测试如何改善）、前后对比图、依赖类别、推荐强度（`Strong` / `Worth exploring` / `Speculative`）。报告末尾给出首选推荐及理由。

卡片只描述要合并什么、藏起什么，interface 设计留到第 3 步。报告写完后问用户："想深入哪一个？"

### 3. 追问

用户选定候选后，把它当作一棵**设计树**逐轮追问：约束、依赖、deepened module 的形状、seam 后面藏什么、哪些测试保留。

- 每轮把**前沿**一次问完。前沿指前置决策已定、现在就能问的问题。每题编号并给出你的推荐答案，措辞让"是"即接受推荐，然后等用户回答。
- 一题的答案依赖本轮另一道未决的题，就放到下一轮。
- 事实由你查，决策归用户。需要代码或环境里的事实时，派上下文全新的子 agent 去查；只有依赖该事实的问题等结果，其余照常问。
- 依赖类别和测试策略见 [DEEPENING.md](DEEPENING.md)。用户想比较多种 interface 时，按 [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md) 做。

每轮格式：

```
❓ **Q1** - **<问题标题>**：<问题正文，可含多个选项>

➡ <推荐答案>
```

完成标准：设计树每个分支都已访问、前沿为空，且用户确认已达成共识。

### 4. 落地

按 `AGENTS.md` §6 处理追问结论：

- 结论会改变架构、协议或规则：按 `docs/decisions/0000-template.md` 起草 ADR，编号取现有最大编号加一，状态写"提议"。写入前先征得用户同意。
- 用户以长期有效的理由否掉候选：问"要把这条记成 ADR，免得以后的架构评审再提吗？"。只在将来的评审确实需要这条理由时才问；"现在不值得"这类临时理由和不言自明的理由跳过。
- 讨论中出现文档未定义、又会长期使用的领域名词：建议补进对应的 `docs/*.md`，由用户决定。
