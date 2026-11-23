import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { afterEach, expect, it } from "vitest";
import { HttpServer } from "./http.js";
import { DaemonApiLive } from "./index.js";

const directories: string[] = [];
const scopes: Array<Scope.CloseableScope> = [];
afterEach(async () => {
  for (const scope of scopes.splice(0))
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("manages MCP servers and rejects the removed inline Bot configuration", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-mcp-api-"));
  directories.push(dataDirectory);
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  const context = await Effect.runPromise(
    Layer.buildWithScope(DaemonApiLive({ dataDirectory, port: 0 }), scope),
  );
  const server = Context.get(context, HttpServer);
  const token = readFileSync(join(dataDirectory, "daemon-token"), "utf8");
  const request = (path: string, method = "GET", value?: unknown) =>
    fetch(`http://${server.host}:${server.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  const listed = await request("/v1/mcp/servers");
  expect(await listed.json()).toEqual({ servers: [] });
  const created = await request("/v1/mcp/servers", "POST", {
    name: "Calendar",
    transport: "http",
    url: "https://example.com/mcp",
  });
  expect(created.status).toBe(201);
  const value = (await created.json()) as { server: { id: string; enabled: boolean } };
  expect(value.server.enabled).toBe(false);
  const id = value.server.id;
  expect((await request(`/v1/mcp/servers/${id}/enable`, "POST")).status).toBe(200);
  expect(
    (
      await request(`/v1/bots/bot-1/mcp-grants/${id}`, "PUT", {
        enabled: true,
        allowedTools: ["calendar_list"],
      })
    ).status,
  ).toBe(200);
  const oldBot = await request("/v1/bots", "POST", {
    id: "bot-1",
    name: "Worker",
    description: "Work",
    soul: "",
    cwd: "/tmp",
    modelSelection: { instanceId: "local", model: "fixture" },
    mcpServers: [],
  });
  expect(oldBot.status).toBe(400);
  expect((await request(`/v1/mcp/servers/${id}`, "DELETE")).status).toBe(200);
  expect((await (await request("/v1/mcp/servers")).json()) as unknown).toEqual({ servers: [] });
});
