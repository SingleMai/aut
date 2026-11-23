import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotId } from "@aut/protocol";
import { Effect, Either } from "effect";
import { afterEach, expect, it } from "vitest";
import { ConfigStore } from "./config-store.js";
import { CoreLive } from "./index.js";
import { McpRegistry } from "./mcp-registry.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("stores global MCP servers and prunes grants when the tool catalog changes", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-mcp-registry-"));
  directories.push(dataDirectory);
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* McpRegistry;
        const server = yield* registry.create({
          name: "Calendar",
          transport: "http",
          url: "https://example.com/mcp",
        });
        expect(server.enabled).toBe(false);
        expect(
          (yield* registry.setGrant(BotId.make("bot-1"), server.id, true, ["list"])).allowedTools,
        ).toEqual([]);
        yield* registry.updateTools(server.id, [
          { name: "list", description: "List events" },
          { name: "delete", description: "Delete events" },
        ]);
        const grant = yield* registry.setGrant(BotId.make("bot-1"), server.id, true, [
          "list",
          "missing",
        ]);
        expect(grant.allowedTools).toEqual(["list"]);
        yield* registry.updateTools(server.id, [{ name: "delete" }]);
        expect((yield* registry.listGrants(BotId.make("bot-1")))[0]?.allowedTools).toEqual([]);
        const updated = yield* registry.update(server.id, {
          name: "Calendar",
          transport: "http",
          url: "https://example.com/other",
        });
        expect(updated.enabled).toBe(false);
        expect(updated.auth.status).toBe("none");
        expect(updated.tools).toEqual([]);
        yield* registry.setGrant(BotId.make("bot-1"), server.id, true, []);
        yield* registry.remove(server.id);
        return {
          servers: yield* registry.list,
          grants: yield* registry.listGrants(),
          file: readFileSync(join(dataDirectory, "mcp.json"), "utf8"),
          missing: yield* Effect.either(registry.get(server.id)),
        };
      }).pipe(Effect.provide(CoreLive({ dataDirectory }))),
    ),
  );
  expect(result.servers).toEqual([]);
  expect(result.grants).toEqual([]);
  expect(JSON.parse(result.file)).toEqual({ schemaVersion: 1, servers: [], grants: [] });
  expect(Either.isRight(result.missing) && result.missing.right._tag).toBe("None");
});

it("round-trips MCP configuration separately from Bot configuration", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-mcp-config-"));
  directories.push(dataDirectory);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* ConfigStore;
        yield* store.writeMcp({ schemaVersion: 1, servers: [], grants: [] });
        expect(yield* store.readMcp).toEqual({ schemaVersion: 1, servers: [], grants: [] });
        expect(yield* store.readBots).toEqual([]);
      }).pipe(Effect.provide(CoreLive({ dataDirectory }))),
    ),
  );
});
