import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Schema, TestClock, TestContext } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ApiRequest } from "./bridge.js";
import {
  DesktopConnection,
  DesktopConnectionLive,
  DesktopError,
  packagedDaemonPath,
  waitForDaemonStartup,
} from "./connection.js";

const paths: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("bounded cold startup", () => {
  it("makes CLI locations available to Finder launches after existing PATH entries", () => {
    expect(
      packagedDaemonPath("/custom/bin:/usr/bin:/opt/homebrew/bin", "/Users/sample").split(":"),
    ).toEqual([
      "/custom/bin",
      "/usr/bin",
      "/opt/homebrew/bin",
      "/Users/sample/.local/bin",
      "/usr/local/bin",
    ]);
    expect(packagedDaemonPath(undefined, "/Users/sample")).toContain(
      "/bin:/usr/sbin:/sbin:/Users/sample/.local/bin",
    );
  });
  it("keeps waiting beyond the former ten-second window and accepts readiness", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let ready = false;
        const waiter = yield* waitForDaemonStartup(
          Effect.suspend(() =>
            ready
              ? Effect.void
              : Effect.fail(new DesktopError({ code: "Unavailable", message: "Fixture refusal" })),
          ),
        ).pipe(Effect.fork);
        yield* TestClock.adjust("11 seconds");
        expect((yield* Fiber.poll(waiter))._tag).toBe("None");
        ready = true;
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(waiter);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });
  // Advancing 600 virtual retries needs wall-clock headroom during parallel native UI QA.
  it("stops after sixty seconds and never retries an authentication failure", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const unavailable = new DesktopError({ code: "Unavailable", message: "Fixture refusal" });
        const waiter = yield* Effect.either(waitForDaemonStartup(Effect.fail(unavailable))).pipe(
          Effect.fork,
        );
        yield* TestClock.adjust("60 seconds");
        const result = yield* Fiber.join(waiter);
        expect(result._tag === "Left" && result.left.code).toBe("Startup");
        let attempts = 0;
        const auth = yield* Effect.either(
          waitForDaemonStartup(
            Effect.suspend(() => {
              attempts++;
              return Effect.fail(
                new DesktopError({ code: "Authentication", message: "Fixture rejection" }),
              );
            }),
          ),
        );
        expect(auth._tag === "Left" && auth.left.code).toBe("Authentication");
        expect(attempts).toBe(1);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  }, 15_000);
});
const fixture = async (status = 200, health: unknown = { status: "ok" }) => {
  const directory = mkdtempSync(join(tmpdir(), "aut-desktop-test-"));
  paths.push(directory);
  const token = "a".repeat(64);
  writeFileSync(join(directory, "daemon-token"), token, { mode: 0o600 });
  const marker = join(directory, "spawned");
  const entry = join(directory, "should-not-start.cjs");
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`);
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization ?? "");
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/v1/health" ? health : { messages: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  shutdowns.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return {
    directory,
    token,
    seen,
    marker,
    layer: DesktopConnectionLive({
      dataDirectory: directory,
      port: address.port,
      executable: process.execPath,
      daemonEntry: entry,
    }),
  };
};

describe("desktop API isolation", () => {
  it.each(["/v1/tasks/task-1/session", "/v1/tasks/task-1/session?limit=10&before=turn-1"])(
    "allows the read-only session route %s",
    (path) => {
      expect(Schema.decodeUnknownEither(ApiRequest)({ method: "GET", path })._tag).toBe("Right");
      expect(Schema.decodeUnknownEither(ApiRequest)({ method: "POST", path })._tag).toBe("Left");
    },
  );
  it.each([
    { method: "GET", path: "https://example.com/v1/messages" },
    { method: "GET", path: "/v1/../config" },
    { method: "GET", path: "/v1/credentials/export" },
    { method: "POST", path: "/v1/tasks" },
    { method: "DELETE", path: "/v1/config" },
  ])("rejects out-of-contract IPC route $method $path", (input) => {
    expect(Schema.decodeUnknownEither(ApiRequest)(input)._tag).toBe("Left");
  });
  it("reuses the daemon and keeps its token inside the main process boundary", async () => {
    const test = await fixture();
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* (yield* DesktopConnection).request({ method: "GET", path: "/v1/messages" });
        }).pipe(Effect.provide(test.layer)),
      ),
    );
    expect(result).toEqual({ ok: true, data: { messages: [] } });
    expect(test.seen.every((header) => header === `Bearer ${test.token}`)).toBe(true);
    expect(existsSync(test.marker)).toBe(false);
  });
  it.each([
    {
      status: 401,
      body: { error: { code: "Unauthorized", message: "No" } },
      code: "Authentication",
    },
    { status: 200, body: { status: "different-service" }, code: "Protocol" },
    { status: 404, body: {}, code: "Protocol" },
  ])(
    "does not spawn or overwrite credentials when an existing service reports $code",
    async ({ status, body, code }) => {
      const test = await fixture(status, body);
      const result = await Effect.runPromise(
        Effect.scoped(Effect.either(DesktopConnection.pipe(Effect.provide(test.layer)))),
      );
      expect(result._tag === "Left" && result.left.code).toBe(code);
      expect(existsSync(test.marker)).toBe(false);
    },
  );
});
