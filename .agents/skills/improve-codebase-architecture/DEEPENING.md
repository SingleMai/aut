<!-- Adapted from mattpocock/skills (MIT) at abeeaf95660ba9e8b7c753eb38f441ca707a8823:
     skills/engineering/codebase-design/DEEPENING.md. -->

# Deepening

在依赖约束下安全地加深一组 shallow module。术语见 [SKILL.md](SKILL.md)「词汇」。

## 依赖类别

给候选的每个依赖归类。类别决定 deepened module 怎样跨 seam 测试。

1. **in-process**：纯计算、内存状态，没有 I/O，例如决策树执行器、任务状态机。总能加深：合并 module，直接通过新 interface 测试，不需要 adapter。
2. **local-substitutable**：有本地替身的依赖，例如 SQLite 内存库、临时数据目录。有替身就能加深，测试时运行替身。seam 留在内部，module 的外部 interface 上没有 port。
3. **ports & adapters**：跨进程但归 aut 所有的依赖，例如 desktop renderer 与 daemon 本地 API（HTTP + WS，见 `docs/local-api.md`）。在 seam 处定义 port，deep module 持有逻辑，传输作为 adapter 注入：测试用内存 adapter，生产用 HTTP/WS adapter。
4. **mock**：aut 控制不了的外部依赖，例如 harness CLI、分类器后端。deepened module 通过注入的 port 接收外部依赖。harness 测试用 adapter 回放 `spikes/` 录制的真实协议样本；Classifier 测试用确定性 mock。

## seam 纪律

- **一个 adapter 是假想的 seam，两个才是真的。** 至少有两个正当 adapter 时才引入 port，通常是生产加测试，在 Effect 里就是 Live `Layer` 加 Test `Layer`。
- **内部 seam 与外部 seam。** deep module 可以有只供自身测试用的内部 seam。内部 seam 留在 implementation 里，interface 只暴露外部 seam。

## 测试策略：替换，不叠加

- deepened module 的 interface 上有了测试，就删掉旧 shallow module 上已被覆盖的单元测试。`AGENTS.md` §5 要求的测试（决策树分支 fixture、状态机转移、adapter 样本回放）一律保留，必要时迁到新 interface 上。
- 新测试写在 deepened module 的 interface 上：interface 即测试面。
- 断言只看通过 interface 能观察到的结果。
- 测试描述行为，内部重构后依然成立。实现一变测试就得改，说明它越过了 interface。
