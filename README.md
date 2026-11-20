# aut

一个开源的 personal agent 客户端实验：**协调者（chief）不是 LLM，而是由分类器（Jev）驱动的工程决策树。**

- 你只在一个主会话里说话；
- chief 将消息用于派发任务、查询进度、继续工作、回答提问或澄清意图；
- 内置主助手 aut 可以自己完成任务、和你讨论，也可以把工作交给按需创建的专长助手。助手在 harness CLI 的原生会话中工作，结果经可读性检查后回到主会话。

设计思路来自《快与慢》：决策树 + 分类器是快脑，harness session 是慢脑。

> 状态：MVP 组件已实现并接通，真实 Codex + Jev 合成场景验收已完成，等待人工验收。尚未正式发布；结果和边界见 [验收记录](docs/acceptance.md)。

## 文档

- [AGENTS.md](AGENTS.md) — 实现总纲与硬性规则（实现者必读）
- [docs/architecture.md](docs/architecture.md) — 架构
- 桌面启动、Bot 配置与交互预览见[桌面客户端](docs/desktop.md)。
- 标志与主题见[品牌规范](docs/brand.md)。接入形象、扩展动作见[角色模块](packages/characters/README.md)。
- [docs/decision-tree.md](docs/decision-tree.md) — chief 决策树
- [docs/protocol.md](docs/protocol.md) — 协议与接口
- [docs/harness-adapters.md](docs/harness-adapters.md) — harness 适配
- [docs/roadmap.md](docs/roadmap.md) — 实现路线
- [docs/decisions/](docs/decisions/) — 架构决策记录（ADR）
- [docs/references.md](docs/references.md) — 外部参考
- [spikes/codex/README.md](spikes/codex/README.md) — Codex 0.167.0 实测结论、原始样本与回放验证

## 本地开发

运行时固定为 Node 24.18.0 LTS、pnpm 10.33.0。先通过现有 Node 版本管理工具切换到 `.nvmrc` 指定版本，再执行：

```sh
pnpm install --frozen-lockfile
pnpm check
```

- `pnpm build`：检查依赖方向，然后按 TypeScript project references 编译所有包；产物位于各包的 `dist/`。
- `pnpm typecheck`：检查生产源码、测试和工具配置。
- `pnpm test`：运行 Vitest，覆盖依赖边界、协议、状态机、决策树、会话投递、原生问答、回包门槛、MCP 和本地 API。
- `pnpm lint` / `pnpm format:check` / `pnpm format`：Biome 检查与格式化；现有设计文档及 `spikes/` 原始协议样本不参与格式化。
- `pnpm check:boundaries`：校验包依赖、静态/动态 import、re-export、require 与跨包相对路径。`core` 访问 adapter/classifier 只允许 `/interface` 入口。桌面 renderer 使用 `@aut/protocol` 校验数据，通过 `@aut/characters` 呈现 Bot 形象，业务数据经本地 API 读写。

`packages/protocol` 提供共享 Schema、数据树格式和接口类型；业务服务通过 Effect Layer 组装。`spikes/` 不参与生产构建。Effect 固定为 3.22.4，原因见 `AGENTS.md` §3；依赖升级需同步 catalog 与锁文件，并重新执行全部检查。

## 启动本地 daemon

```sh
pnpm build
pnpm --filter @aut/daemon start
```

默认监听 `127.0.0.1:4317`，数据目录为 `~/.aut`。可用 `AUT_PORT` 和 `AUT_DATA_DIR` 指定端口与隔离目录。使用早期开发版的本机可指定新的空目录启动，数据格式见[存储文档](docs/storage.md)。
首次启动在数据目录生成权限为 0600 的 `daemon-token`；HTTP 使用 Bearer token，WebSocket 也支持子协议鉴权，详见 [本地 API](docs/local-api.md)。请勿将 token 放进 URL 或日志。

消息和动作持久化后进入 chief 的串行队列，worker 会话并发执行。首次启动只读发现现有 Codex 模型，初始化一个可直接工作和协调的主助手 aut；不改写 CLI 的 Provider 配置。发现失败时仍可通过设置配置实例与 bot，再次保存会重试初始化。

启动时独占数据目录，并将上次异常退出的活跃任务恢复为 interrupted，保留会话游标、关闭旧问题卡片；用户显式恢复后才继续工作。已记录但未确认完成的入站动作会显示恢复提示，不自动重复执行。SIGINT / SIGTERM 释放服务资源。

## 桌面端与分类器配置

运行 `pnpm build` 后，可用 `pnpm --filter @aut/desktop start` 启动 Electron。主会话、问题卡片和 Bot 配置都连接本地 daemon。查看角色动作、问答状态和表单校验时，也可以直接打开离线组件预览。[桌面开发与打包](docs/desktop.md#开发和打包) · [组件预览](docs/desktop.md#组件预览)

在设置中配置 Jev（当前固定 `jev-1.14.0`，接口 `https://api.typesafe.ai/v1/systemone`）。密钥可使用已有 `env:TYPESAFE_API_KEY` 引用，或通过设置保存到独立的 `~/.aut/secrets.json`（0600）；普通配置只保存 `secret:<name>` 引用。未配置或分类失败时显示澄清选项，不跳过决策日志。

macOS 开发包的签名与公证进度见[验收记录](docs/acceptance.md)。

## 许可

Apache License 2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
