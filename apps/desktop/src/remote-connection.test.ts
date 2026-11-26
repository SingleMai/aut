import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TransportEvent } from "@aut/protocol";
import { RemoteTransport } from "@aut/transport";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { DesktopConnection, DesktopConnectionLive } from "./connection.js";
import { remoteConnection } from "./remote-connection.js";

const profile = {
  version: 1 as const,
  hostId: "office-pro",
  name: "Office Pro",
  nodeId: "pro-node",
  token: "c".repeat(64),
};
const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
const build = async (event: TransportEvent) => {
  const scope = await Effect.runPromise(Scope.make());
  closes.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  return Effect.runPromise(
    remoteConnection(profile, "/unused-client-state").pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provide(
        Layer.succeed(RemoteTransport, {
          run: (_, receive) => receive(event).pipe(Effect.zipRight(Effect.never)),
        }),
      ),
    ),
  );
};
it("exposes pending login immediately with no local daemon or credential fallback", async () => {
  const service = await build({ type: "login", url: "https://login.tailscale.com/a/fixture" });
  await expect.poll(async () => (await Effect.runPromise(service.status)).phase).toBe("login");
  expect(await Effect.runPromise(service.loginUrl)).toBe("https://login.tailscale.com/a/fixture");
  const request = await Effect.runPromise(
    Effect.either(service.request({ method: "GET", path: "/v1/config" })),
  );
  expect(request._tag === "Left" && request.left.code).toBe("Disconnected");

  const directory = mkdtempSync(join(tmpdir(), "aut-remote-no-fallback-"));
  closes.push(async () => rmSync(directory, { recursive: true, force: true }));
  const entry = join(directory, "daemon.cjs"),
    marker = join(directory, "started");
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopConnection;
        expect((yield* service.status).mode).toBe("remote");
      }).pipe(
        Effect.provide(
          DesktopConnectionLive({
            remote: profile,
            daemonEntry: entry,
            executable: process.execPath,
            dataDirectory: directory,
            transportDirectory: directory,
          }),
        ),
      ),
    ),
  );
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(join(directory, "daemon-token"))).toBe(false);
});
it("checks host identity, reconnects event streams and never automatically replays an ambiguous write", async () => {
  let hostId = "wrong-host";
  let writes = 0;
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization ?? "");
    if (request.url === "/v1/messages" && request.method === "POST") {
      writes++;
      request.socket.destroy();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/v1/health"
          ? { status: "ok" }
          : request.url === "/v1/remote/identity"
            ? { hostId, name: "Office Pro" }
            : { messages: [] },
      ),
    );
  });
  const wss = new WebSocketServer({ server, path: "/v1/events" });
  wss.on("connection", (socket) =>
    socket.send(JSON.stringify({ type: "changed", resources: ["messages"] })),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closes.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const service = await build({ type: "ready", nodeId: "air", port: address.port });
  await expect
    .poll(async () => (await Effect.runPromise(service.status)).message)
    .toContain("身份");
  expect(wss.clients.size).toBe(0);
  expect(
    (
      await Effect.runPromise(
        Effect.either(service.request({ method: "GET", path: "/v1/messages" })),
      )
    )._tag,
  ).toBe("Left");
  hostId = profile.hostId;
  await expect
    .poll(async () => (await Effect.runPromise(service.status)).phase, { timeout: 6000 })
    .toBe("connected");
  expect(await Effect.runPromise(service.request({ method: "GET", path: "/v1/messages" }))).toEqual(
    { ok: true, data: { messages: [] } },
  );
  const pending = Effect.runPromise(
    service.notices.pipe(
      Stream.filter((notice) => notice.type === "connection" && notice.connected),
      Stream.take(1),
      Stream.runCollect,
      Effect.timeout("6 seconds"),
    ),
  );
  for (const socket of wss.clients) socket.terminate();
  await pending;
  expect(
    (
      await Effect.runPromise(
        Effect.either(
          service.request({
            method: "POST",
            path: "/v1/messages",
            body: { id: "stable-message", text: "fixture" },
          }),
        ),
      )
    )._tag,
  ).toBe("Left");
  await Effect.runPromise(Effect.sleep("2200 millis"));
  expect(writes).toBe(1);
  expect(seen.every((header) => header === `Bearer ${profile.token}`)).toBe(true);
}, 15_000);

it("reconnects a stalled WebSocket even while fresh HTTP requests remain healthy", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/v1/health"
          ? { status: "ok" }
          : { hostId: profile.hostId, name: profile.name },
      ),
    );
  });
  const wss = new WebSocketServer({ server, autoPong: false });
  let connections = 0;
  wss.on("connection", (socket) => {
    const index = ++connections;
    socket.on("ping", (data) => {
      if (index > 1) socket.pong(data);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closes.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const service = await build({ type: "ready", nodeId: "air", port: address.port });
  await expect.poll(async () => (await Effect.runPromise(service.status)).phase).toBe("connected");
  await expect
    .poll(() => connections, { timeout: 20_000, interval: 100 })
    .toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await Effect.runPromise(service.status)).phase).toBe("connected");
}, 25_000);
