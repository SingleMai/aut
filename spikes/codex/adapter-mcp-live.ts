// Local synthetic MCP server: verifies per-thread configuration without a model turn.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCodexAdapter } from "../../packages/adapters/dist/index.js";
import { NodeTransport, type Transport } from "../../packages/adapters/dist/codex/transport.js";
import { BotId, TaskId, type StartSessionInput } from "../../packages/protocol/dist/index.js";
import { Effect, Schema } from "effect";

const cwd = mkdtempSync(join(tmpdir(), "aut-adapter-mcp-"));
const serverPath = join(cwd, "fixture.cjs");
writeFileSync(serverPath, `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'aut-fixture',version:'1'}};if(m.method==='tools/list')result={tools:[{name:process.env.AUT_MCP_FIXTURE_TOOL??'fixture_echo',description:'Synthetic fixture',inputSchema:{type:'object',properties:{}}}]};if(m.method==='resources/list')result={resources:[]};if(m.method==='resources/templates/list')result={resourceTemplates:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`, { flag: "wx" });
const model = process.env.AUT_CODEX_MODEL ?? "gpt-6.1-sol";
const server = { name: process.env.AUT_MCP_FIXTURE_NAME ?? "aut.fixture", transport: "stdio" as const, command: process.execPath, args: [serverPath] };
const overridden = { ...server, name: "aut_override_fixture", env: { AUT_MCP_FIXTURE_TOOL: "override_fixture" } };
const input: StartSessionInput = { taskId: TaskId.make("mcp-fixture"), bot: { id: BotId.make("mcp-probe"), name: "Probe", description: "Fixture", soul: "", modelSelection: { instanceId: "codex", model }, cwd, mcpServers: [server, overridden] }, cwd, model, instructions: "Synthetic configuration test", mcpServers: [server, overridden] };
let native: Transport | undefined;
const baseline = (tool: string) => `{command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(serverPath)}],env={AUT_MCP_FIXTURE_TOOL=${JSON.stringify(tool)}}}`;
const adapter = makeCodexAdapter({ args: ["-c", `mcp_servers.aut_inherited_fixture=${baseline("inherited_fixture")}`, "-c", `mcp_servers.aut_override_fixture=${baseline("old_fixture")}`] }, { open: (options) => NodeTransport.open(options).pipe(Effect.tap((value) => Effect.sync(() => { native = value; }))) });
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const session = yield* adapter.startSession(input);
  const cursor = yield* Schema.decodeUnknown(Schema.Struct({ threadId: Schema.String }))(session.cursor.data);
  if (!native) return yield* Effect.fail(new Error("Missing transport"));
  const checks: { name: string; toolNames: string[] }[] = [];
  for (const [name, expected] of [[server.name, "fixture_echo"], ["aut_inherited_fixture", "inherited_fixture"], ["aut_override_fixture", "override_fixture"]]) {
    const raw = yield* native.request("mcpServerStatus/list", { threadId: cursor.threadId, serverName: name ?? "" });
    const status = yield* Schema.decodeUnknown(Schema.Struct({ data: Schema.Array(Schema.Struct({ name: Schema.String, tools: Schema.Record({ key: Schema.String, value: Schema.Struct({ name: Schema.String }) }) })) }))(raw);
    const found = status.data.find((value) => value.name === name);
    const toolNames = Object.values(found?.tools ?? {}).map((tool) => tool.name);
    if (!found || !toolNames.includes(expected ?? "")) return yield* Effect.fail(new Error(`Synthetic MCP assertion failed for ${name}`));
    checks.push({ name: found.name, toolNames });
  }
  // Only synthetic tool names are recorded; config/read responses never leave memory.
  return { at: new Date().toISOString(), cliVersion: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(), checks };
})).pipe(Effect.timeout("1 minute")));
const output = join(cwd, "adapter-mcp-result.json");
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ output }));
