import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteConnectionInfo, RemoteHostStatus } from "@aut/protocol";
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HttpServer } from "./http.js";
import { DaemonApiLive } from "./index.js";

const paths: string[] = [];
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
const start = async (directory?: string) => {
  const dataDirectory = directory ?? mkdtempSync(join(tmpdir(), "aut-remote-api-"));
  if (!directory) paths.push(dataDirectory);
  const binary = join(dataDirectory, "fixture-helper");
  writeFileSync(
    binary,
    `#!/bin/sh\nread -r config\nprintf '%s\\n' '{"type":"ready","nodeId":"fixture-host-node","port":4318}'\nwhile IFS= read -r line; do :; done`,
    { mode: 0o700 },
  );
  const scope = await Effect.runPromise(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  closes.push(close);
  const context = await Effect.runPromise(
    Layer.buildWithScope(DaemonApiLive({ dataDirectory, port: 0, transportBinary: binary }), scope),
  );
  const server = Context.get(context, HttpServer);
  const base = `http://127.0.0.1:${server.port}`;
  const token = readFileSync(join(dataDirectory, "daemon-token"), "utf8");
  const request = (path: string, method = "GET", body?: unknown, key = token) =>
    fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const connection = async () => {
    let info: RemoteConnectionInfo | undefined;
    await expect
      .poll(
        async () => {
          const response = await request("/v1/remote/connection", "POST");
          if (response.ok)
            info = Schema.decodeUnknownSync(RemoteConnectionInfo)(await response.json());
          return response.status;
        },
        { timeout: 5000 },
      )
      .toBe(200);
    if (!info) throw new Error("Missing fixture connection");
    return info;
  };
  return { request, dataDirectory, token, base, close, connection };
};
it("defaults off, keeps credentials local, revokes remote sockets and preserves local access across rotation and restart", async () => {
  const server = await start();
  const disabled = Schema.decodeUnknownSync(RemoteHostStatus)(
    await (await server.request("/v1/remote/host")).json(),
  );
  expect(disabled.enabled).toBe(false);
  expect(existsSync(join(server.dataDirectory, "remote-host.private.json"))).toBe(false);
  expect((await server.request("/v1/remote/connection", "POST")).status).toBe(409);
  expect((await server.request("/v1/remote/host?token=bad")).status).toBe(400);
  await server.request("/v1/remote/host", "PUT", { enabled: true, name: "Office Pro" });
  const first = await server.connection();
  expect(first.token).not.toBe(server.token);
  expect(statSync(join(server.dataDirectory, "remote-host.private.json")).mode & 0o777).toBe(0o600);
  expect((await server.request("/v1/health", "GET", undefined, first.token)).status).toBe(200);
  expect(
    await (await server.request("/v1/remote/identity", "GET", undefined, first.token)).json(),
  ).toEqual({ hostId: first.hostId, name: "Office Pro" });
  for (const [path, method] of [
    ["/v1/remote/connection", "POST"],
    ["/v1/remote/host", "GET"],
    ["/v1/remote/host", "PUT"],
  ])
    expect(
      (
        await server.request(
          path as string,
          method,
          method === "GET" ? undefined : { enabled: false, name: "Hijack" },
          first.token,
        )
      ).status,
    ).toBe(401);
  const status = await (await server.request("/v1/remote/host")).text();
  expect(status).not.toContain(first.token);
  const remote = new WebSocket(`${server.base.replace("http:", "ws:")}/v1/events`, [
    "aut",
    `aut-token.${first.token}`,
  ]);
  const local = new WebSocket(`${server.base.replace("http:", "ws:")}/v1/events`, [
    "aut",
    `aut-token.${server.token}`,
  ]);
  closes.push(async () => {
    remote.terminate();
    local.terminate();
  });
  await Promise.all([once(remote, "open"), once(local, "open")]);
  const revoked = once(remote, "close");
  await server.request("/v1/remote/host", "PUT", {
    enabled: true,
    name: "Office Pro",
    rotate: true,
  });
  await revoked;
  expect(local.readyState).toBe(WebSocket.OPEN);
  expect((await server.request("/v1/health", "GET", undefined, first.token)).status).toBe(401);
  const second = await server.connection();
  expect(second.token).not.toBe(first.token);
  local.terminate();
  await server.close();
  const restarted = await start(server.dataDirectory);
  expect(await restarted.connection()).toEqual(second);
  expect(restarted.token).toBe(server.token);
  await restarted.request("/v1/remote/host", "PUT", { enabled: false, name: "Office Pro" });
  expect((await restarted.request("/v1/health", "GET", undefined, second.token)).status).toBe(401);
  expect((await restarted.request("/v1/health")).status).toBe(200);
  expect(
    readFileSync(join(server.dataDirectory, "remote-host.private.json"), "utf8"),
  ).not.toContain(second.token);
}, 15_000);
