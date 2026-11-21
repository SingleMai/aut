<!-- Adapted from mattpocock/skills (MIT) at abeeaf95660ba9e8b7c753eb38f441ca707a8823:
     skills/engineering/codebase-design/DESIGN-IT-TWICE.md. -->

# Design It Twice

用户想为选定候选比较多种 interface 时使用。依据 Ousterhout 的 "Design It Twice"：第一个想法很少是最好的。术语见 [SKILL.md](SKILL.md)「词汇」。

## 1. 描述问题空间

派子 agent 之前，先给用户写一段问题空间说明：

- 新 interface 必须满足的约束，包括 `AGENTS.md` §2 铁律和 §4 依赖方向中相关的条目。
- 它依赖什么，各属于哪个依赖类别（见 [DEEPENING.md](DEEPENING.md)）。
- 一段示意代码，用来把约束说具体，不作为方案。

给用户看完后立即进入第 2 步。用户阅读时，子 agent 并行工作。

## 2. 并行设计

并行派 3 个以上上下文全新的子 agent，每个产出一种**截然不同**的 interface。

每个子 agent 拿到一份独立的技术 brief：文件路径、耦合细节、依赖类别、seam 后面藏什么，以及 [SKILL.md](SKILL.md)「词汇」和「约束」两节全文。这份 brief 和第 1 步给用户的说明分开写。每个子 agent 各有一条设计约束：

- 子 agent 1："最小化 interface：最多 1 到 3 个入口，让每个入口的 leverage 最大。"
- 子 agent 2："最大化灵活性：支持多种用例和扩展。"
- 子 agent 3："为最常见的调用方优化：让默认用法最简单。"
- 子 agent 4（适用时）："跨 seam 依赖按 ports & adapters 设计。"

每个子 agent 返回：

1. interface：类型、方法、参数，以及不变式、调用顺序、错误类型（`Data.TaggedError`）。
2. 调用方的用法示例。
3. implementation 在 seam 后面藏了什么。
4. 依赖策略和 adapter（Live / Test `Layer`）。
5. 取舍：哪里 leverage 高，哪里薄。

## 3. 对比与推荐

逐个展示设计，让用户逐一消化，再用文字对比：depth（interface 处的 leverage）、locality（改动集中在哪）、seam 位置。

对比之后给出你自己的推荐：哪个设计最强、为什么。不同设计的要素能组合时，提出混合方案。用户要的是明确判断。
