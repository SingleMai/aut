import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreLive, McpRegistry } from "@aut/core";
import { BotId } from "@aut/protocol";
import { Effect, Layer } from "effect";
import { afterEach, expect, it } from "vitest";
import { McpOAuthLive } from "./mcp-oauth.js";
import { McpSupervisor, McpSupervisorLive } from "./mcp-supervisor.js";
import { SecretReaderLive } from "./secret-reader.js";
import { SecretStoreLive } from "./secret-store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("discovers stdio tools once and exposes only the granted tools through the proxy", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-mcp-supervisor-"));
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "aut-mcp-fixture-"));
  directories.push(dataDirectory, fixtureDirectory);
  const command = join(fixtureDirectory, "server.mjs");
  writeFileSync(
    command,
    [
      "import readline from 'node:readline';",
      "const input = readline.createInterface({ input: process.stdin });",
      "input.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.id === undefined) return;",
      "  let result = {};",
      "  if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };",
      "  if (message.method === 'tools/list') result = { tools: [{ name: 'list_events', description: 'List events', inputSchema: { type: 'object' } }, { name: 'delete_event', description: 'Delete event', inputSchema: { type: 'object' } }] };",
      "  if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'fixture' }] };",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');",
      "});",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(command, 0o700);
  const base = Layer.merge(
    CoreLive({ dataDirectory }),
    SecretReaderLive.pipe(Layer.provideMerge(SecretStoreLive({ dataDirectory }))),
  );
  const services = McpSupervisorLive.pipe(Layer.provide(McpOAuthLive), Layer.provideMerge(base));
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* McpRegistry;
        const supervisor = yield* McpSupervisor;
        const server = yield* registry.create({
          name: "stdio fixture",
          transport: "stdio",
          command: process.execPath,
          args: [command],
        });
        const tested = yield* supervisor.test(server.id);
        expect(tested.tools.map((tool) => tool.name)).toEqual(["list_events", "delete_event"]);
        yield* supervisor.setGrant(BotId.make("bot-1"), server.id, true, [
          "list_events",
          "delete_event",
        ]);
        yield* supervisor.setEnabled(server.id, true);
        const configs = yield* supervisor.configsForBot("task-1", BotId.make("bot-1"));
        if (configs.length !== 1 || configs[0]?.transport !== "stdio")
          return yield* Effect.dieMessage("Missing MCP proxy configuration");
        return { server: tested, config: configs[0] };
      }).pipe(Effect.provide(services)),
    ),
  );
  expect(result.server.health.status).toBe("ready");
  expect(result.config.name).toBe("stdio fixture");
  expect(result.config.env?.AUT_MCP_MODE).toBe("proxy");
  expect(result.config.env?.AUT_MCP_PROXY_TOOLS).toContain("list_events");
  expect(result.config.env?.AUT_MCP_PROXY_TOOLS).toContain("delete_event");
});
