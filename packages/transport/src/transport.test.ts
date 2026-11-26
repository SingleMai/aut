import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { afterEach, expect, it } from "vitest";
import { RemoteTransport, RemoteTransportLive, transportEnvironment } from "./index.js";

const paths: string[] = [];
it("forwards network environment without provider credentials or inherited Tailscale identity", () => {
  const env = transportEnvironment({
    HOME: "/fixture",
    HTTPS_PROXY: "http://127.0.0.1:7890",
    OPENAI_API_KEY: "fixture-only",
    TYPESAFE_API_KEY: "fixture-only",
    AUT_DAEMON_TOKEN: "fixture-only",
    TS_AUTHKEY: "fixture-only",
    TS_CONTROL_URL: "https://invalid.test",
  });
  expect(env).toEqual({
    HOME: "/fixture",
    HTTPS_PROXY: "http://127.0.0.1:7890",
    TS_BIND_TO_INTERFACE_BY_ROUTE: "1",
    TS_NO_LOGS_NO_SUPPORT: "true",
  });
});
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
const fixture = (source: string) => {
  const directory = mkdtempSync(join(tmpdir(), "aut-companion-"));
  paths.push(directory);
  const binary = join(directory, "helper");
  writeFileSync(binary, `#!/bin/sh\n${source}`, { mode: 0o700 });
  return { directory, layer: RemoteTransportLive(binary) };
};
it.each([
  `printf '%s\\n' '{"type":"login","url":"https://attacker.invalid/login"}'`,
  `printf '%s\\n' '{"type":"ready","nodeId":"one","port":70000}'`,
  `printf '%70000s\\n' ''`,
  "exit 0",
])(
  "rejects invalid events or unexpected helper exit without leaking output",
  async (source) => {
    const test = fixture(source);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* RemoteTransport;
        return yield* Effect.either(
          transport
            .run({ version: 1, mode: "host", directory: test.directory, localPort: 4317 }, () =>
              Effect.die("Invalid event was forwarded"),
            )
            .pipe(Effect.timeout("8 seconds")),
        );
      }).pipe(Effect.provide(test.layer)),
    );
    expect(result._tag === "Left" && result.left._tag).toBe("TransportError");
    expect(JSON.stringify(result)).not.toContain("attacker");
  },
  10_000,
);
const readyLine = `printf '%s\\n' '{"type":"ready","nodeId":"test-node","port":4318}'`;
it("delivers the last stdout event before reporting a helper exit", async () => {
  const test = fixture(`read -r config\n${readyLine}\nexit 0`);
  const received: string[] = [];
  const result = await Effect.runPromise(
    Effect.flatMap(RemoteTransport, (transport) =>
      transport.run(
        { version: 1, mode: "host", directory: test.directory, localPort: 4317 },
        (event) =>
          Effect.sync(() => {
            received.push(event.type);
          }),
      ),
    ).pipe(Effect.provide(test.layer), Effect.timeout("8 seconds"), Effect.flip),
  );
  expect(received).toEqual(["ready"]);
  expect(result._tag).toBe("TransportError");
}, 10_000);
it.each(["accepts", "ignores"] as const)(
  "retains stdin and reaps the helper on interruption when it %s SIGTERM",
  async (behavior) => {
    const test = fixture(
      [
        behavior === "ignores" ? "trap '' TERM" : "",
        "read -r config",
        `printf '%s' "$$" > "$(dirname "$0")/pid"`,
        readyLine,
        "while IFS= read -r line; do :; done",
      ].join("\n"),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* RemoteTransport;
          const ready = yield* Deferred.make<void>();
          const child = yield* transport
            .run({ version: 1, mode: "host", directory: test.directory, localPort: 4317 }, () =>
              Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(ready).pipe(Effect.timeout("8 seconds"));
          yield* Effect.sleep("100 millis");
          expect((yield* Fiber.poll(child))._tag).toBe("None");
        }).pipe(Effect.provide(test.layer)),
      ),
    );
    const pid = Number(readFileSync(join(test.directory, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  },
  12_000,
);
