// Isolated desktop fixture using the real daemon, memory files, and IPC allowlist.
// Synthetic documents only; this fixture never starts a model or edits user configuration.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BotMemory, ConfigStore } from "../../packages/core/dist/index.js";
import { DaemonApiLive, HttpServer } from "../../packages/daemon/dist/index.js";
import { BotId } from "../../packages/protocol/dist/index.js";
import { Data, Effect } from "effect";

class FixtureError extends Data.TaggedError("FixtureError")<{ readonly message: string }> {}
const directory = mkdtempSync(join(tmpdir(), "aut-memory-graph-qa-"));
const botId = BotId.make("qa-memory");
const documents: ReadonlyArray<readonly [string, string]> = [
  ["MEMORY.md", "# 一起工作的默契\n\n## 沟通偏好\n\n- 用中文交流，先说结论，再补充必要依据。\n- 方案保持简单，优先通过真实使用发现问题。\n\n## 正在积累的知识\n\n- [记忆设计](knowledge/memory.md)：核心记忆、知识库和会话笔记各自的职责。\n- [发布流程](knowledge/release.md)：准备版本、完成验收，再交付。\n- [桌面交互](knowledge/desktop.md)：让用户先看到内容，再进入编辑。\n\n这些是隔离验收使用的示例内容。\n"],
  ["knowledge/memory.md", "# 记忆设计\n\n每个 Bot 拥有独立的记忆目录。核心记忆保留最重要的约定，知识库保存可以复用的内容，笔记记录工作中值得留下的发现。\n\n定时整理时维护文档关联，用户可以直接阅读和修改。\n\n## 相关知识\n\n- [知识链接](links.md)\n- [桌面交互](desktop.md)\n- [自动整理](dreams.md)\n\n[返回核心记忆](../MEMORY.md)\n"],
  ["knowledge/links.md", "# 知识链接\n\n一份 Markdown 文档对应一个知识节点，正文链接组成关系。使用与当前文件相对的路径，保持标题清楚。\n\n图谱可以从文件重新生成。没有关联的文件也可以独立保留。\n\n参见 [记忆设计](memory.md) 和 [自动整理](dreams.md)。\n"],
  ["knowledge/dreams.md", "# 自动整理\n\n每天空闲时阅读笔记，将有价值的发现整理进知识库。拆分、合并文档时同步修复链接。\n\n参见 [知识链接](links.md) 与 [记忆设计](memory.md)。\n\n[本次讨论笔记](../notes/design-session.md)\n"],
  ["knowledge/desktop.md", "# 桌面交互\n\n打开记忆先看到核心内容，需要修改时再进入编辑。\n\n知识库提供图谱和列表；点选节点后阅读原文。搜索帮助找到已经积累的主题。\n\n参见 [记忆设计](memory.md) 与 [验收方法](testing.md)。\n"],
  ["knowledge/release.md", "# 发布流程\n\n发布前核对版本、完成构建和真实环境验收，再准备交付。\n\n## 检查入口\n\n- [验收方法](testing.md)\n- [环境配置](environment.md)\n\n出现问题时记录复现过程，修复后重新检查受影响的步骤。\n"],
  ["knowledge/testing.md", "# 验收方法\n\n单元测试覆盖路径边界和错误处理，桌面验收检查实际交互。\n\n真实工作会话验证记忆是否能被读取、整理和再次使用。\n\n参见 [环境配置](environment.md) 与 [发布流程](release.md)。\n"],
  ["knowledge/environment.md", "# 环境配置\n\n开发和验收使用独立的数据目录，保留用户已有 Provider 配置。\n\n参见 [验收方法](testing.md)。\n"],
  ["knowledge/future.md", "# 待验证的想法\n\n观察真实工作中知识能否被再次找到，再决定是否需要更多整理机制。\n"],
  ["notes/design-session.md", "# 设计讨论\n\n已确认先接通核心记忆阅读、知识链接和做梦整理。暂不引入剪枝或热度评分。\n\n相关主题：[记忆设计](../knowledge/memory.md)。\n"],
];
const freePort = Effect.async<number, FixtureError>((resume) => {
  const server = createServer();
  server.once("error", () => resume(Effect.fail(new FixtureError({ message: "Cannot allocate preview port" }))));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    server.close(() => resume(port ? Effect.succeed(port) : Effect.fail(new FixtureError({ message: "Missing preview port" }))));
  });
  return Effect.sync(() => server.close());
});

const program = Effect.scoped(Effect.gen(function* () {
  const config = yield* ConfigStore;
  yield* config.writeConfig({ harnessInstances: [{ id: "qa-local", name: "隔离验收实例", kind: "codex", command: "codex", args: [] }] });
  yield* config.writeBots([{ id: botId, name: "记忆体验助手", description: "隔离示例：阅读核心记忆，浏览关联知识。", soul: "Synthetic UI fixture only.", cwd: directory, modelSelection: { instanceId: "qa-local", model: "fixture-only" } }]);
  const memory = yield* BotMemory;
  for (const [path, content] of documents) yield* memory.write(botId, path, content);
  const memoryDirectory = yield* memory.directory(botId);
  const api = yield* HttpServer;
  const previewPort = yield* freePort;
  const preview = yield* Effect.acquireRelease(Effect.sync(() => {
    const child = spawn(process.execPath, [resolve("apps/desktop/scripts/preview.mjs")], { env: { ...process.env, AUT_DATA_DIR: directory, AUT_PORT: String(api.port), AUT_PREVIEW_PORT: String(previewPort) }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    return child;
  }), (child) => Effect.sync(() => { if (child.exitCode === null) child.kill("SIGTERM"); }));
  const receipt = { directory, botId, memoryDirectory, apiPort: api.port, previewPort, url: `http://127.0.0.1:${previewPort}`, fixturePid: process.pid, previewPid: preview.pid };
  yield* Effect.sync(() => { writeFileSync(join(directory, "runtime.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); console.log(JSON.stringify(receipt)); });
  yield* Effect.async<void>((resume) => {
    const stop = () => resume(Effect.void);
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    return Effect.sync(() => { process.off("SIGTERM", stop); process.off("SIGINT", stop); });
  });
}).pipe(Effect.provide(DaemonApiLive({ dataDirectory: directory, port: 0 }))));
await Effect.runPromise(program);
