// Isolated MCP desktop QA: real daemon/IPC and stdio discovery; synthetic remote statuses.
// No model is started and no user configuration is read or modified.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ConfigStore } from "../../packages/core/dist/index.js";
import { DaemonApiLive, HttpServer } from "../../packages/daemon/dist/index.js";
import { BotId, McpServerId, type McpServer, type McpTool } from "../../packages/protocol/dist/index.js";
import { Data, Effect, Queue, Schema } from "effect";

class FixtureError extends Data.TaggedError("FixtureError")<{ readonly message: string }> {}
const directory = mkdtempSync(join(tmpdir(), "aut-mcp-ui-qa-"));
const serverPath = join(directory, "notes.mjs");
const tools: readonly McpTool[] = [
  { name: "search_notes", description: "按关键词搜索笔记，返回标题、摘要和来源。", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "read_note", description: "读取指定笔记的完整内容及最近更新时间。", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  { name: "create_note", description: "创建一条新笔记，可指定标题、正文和标签。", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
];
writeFileSync(serverPath, [
  "import readline from 'node:readline';",
  `const tools = ${JSON.stringify(tools)};`,
  "readline.createInterface({input:process.stdin}).on('line', line => {",
  "const message = JSON.parse(line); if (message.id === undefined) return; let result = {};",
  "if (message.method === 'initialize') result = {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'notes-qa',version:'1'}};",
  "if (message.method === 'tools/list') result = {tools};",
  "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n'); });",
].join("\n"), { mode: 0o600 });
const input = { name: "我的笔记", transport: "stdio", command: process.execPath, args: [serverPath], env: {} };
const Command = Schema.Struct({ command: Schema.Literal("seed", "empty", "audit") });
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
  yield* config.writeConfig({ harnessInstances: [{ id: "qa-local", name: "本地测试实例", kind: "codex", command: "codex", args: [] }] });
  yield* config.writeBots([
    { id: BotId.make("qa-research"), name: "研究助手", description: "整理资料与检索笔记", soul: "Use synthetic QA fixtures only.", cwd: directory, modelSelection: { instanceId: "qa-local", model: "fixture-only" } },
    { id: BotId.make("qa-writer"), name: "写作助手", description: "撰写内容与编辑笔记", soul: "Use synthetic QA fixtures only.", cwd: directory, modelSelection: { instanceId: "qa-local", model: "fixture-only" } },
  ]);
  const synthetic: McpServer[] = [
    { id: McpServerId.make("qa-reference"), name: "资料搜索", transport: "http", url: "https://search.example.com/mcp", enabled: false, auth: { status: "none" }, health: { status: "ready" }, tools: [{ name: "search", description: "搜索公开网页并返回可引用的来源。", inputSchema: { type: "object" } }] },
    { id: McpServerId.make("qa-calendar"), name: "个人日历", transport: "http", url: "https://calendar.example.com/mcp", enabled: false, auth: { status: "required" }, health: { status: "error" }, tools: [], oauth: { clientId: "qa-client" } },
    { id: McpServerId.make("qa-offline"), name: "本地资料库", transport: "http", url: "http://127.0.0.1:1/mcp", enabled: false, auth: { status: "none" }, health: { status: "error", message: "无法连接到本地服务，请确认服务已启动后重试。" }, tools: [] },
  ];
  const commands = yield* Effect.acquireRelease(Queue.unbounded<string>(), Queue.shutdown);
  const reader = yield* Effect.acquireRelease(Effect.sync(() => createInterface({ input: process.stdin })), (reader) => Effect.sync(() => reader.close()));
  reader.on("line", (line) => Effect.runFork(Queue.offer(commands, line)));
  yield* Effect.forever(Queue.take(commands).pipe(Effect.flatMap((line) => Effect.gen(function* () {
    const command = yield* Schema.decodeUnknown(Schema.parseJson(Command))(line, { onExcessProperty: "error" });
    if (command.command === "empty") yield* config.writeMcp({ schemaVersion: 1, servers: [], grants: [] });
    if (command.command === "seed") yield* config.updateMcp((current) => ({ ...current, servers: [...current.servers.filter((server) => !server.id.startsWith("qa-")), ...synthetic] }));
    const state = yield* config.readMcp;
    yield* Effect.sync(() => { writeFileSync(join(directory, "audit.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); console.log(JSON.stringify({ command: command.command, state })); });
  }).pipe(Effect.catchAll(() => Effect.sync(() => console.log(JSON.stringify({ error: "Fixture command failed" })))))))).pipe(Effect.forkScoped);
  const api = yield* HttpServer;
  const previewPort = yield* freePort;
  const preview = yield* Effect.acquireRelease(Effect.sync(() => {
    const child = spawn(process.execPath, [resolve("apps/desktop/scripts/preview.mjs")], { env: { ...process.env, AUT_DATA_DIR: directory, AUT_PORT: String(api.port), AUT_PREVIEW_PORT: String(previewPort) }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    return child;
  }), (child) => Effect.sync(() => { if (child.exitCode === null) child.kill("SIGTERM"); }));
  const receipt = { directory, apiPort: api.port, previewPort, url: `http://127.0.0.1:${previewPort}`, fixturePid: process.pid, previewPid: preview.pid, paste: JSON.stringify({ mcpServers: { [input.name]: input } }) };
  yield* Effect.sync(() => { writeFileSync(join(directory, "runtime.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); console.log(JSON.stringify(receipt)); });
  yield* Effect.async<void>((resume) => {
    const stop = () => resume(Effect.void);
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    return Effect.sync(() => { process.off("SIGTERM", stop); process.off("SIGINT", stop); });
  });
}).pipe(Effect.provide(DaemonApiLive({ dataDirectory: directory, port: 0 }))));
await Effect.runPromise(program);
