import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { expect, it } from "vitest";
import { DesktopConnection } from "./connection.js";
import { DesktopShellConnectionLive } from "./shell-connection.js";

it("opens the shell during pending local initialization and surfaces authentication failure without replacing credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aut-shell-startup-"));
  const token = "b".repeat(64);
  writeFileSync(join(directory, "daemon-token"), token);
  let reject: (() => void) | undefined;
  const server = createServer((_, response) => {
    reject = () => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end("{}");
    };
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const scope = await Effect.runPromise(Scope.make());
  try {
    const context = await Effect.runPromise(
      Layer.buildWithScope(
        DesktopShellConnectionLive({
          dataDirectory: directory,
          port: address.port,
          daemonEntry: "/must-not-spawn",
          executable: process.execPath,
        }),
        scope,
      ),
    );
    const connection = Context.get(context, DesktopConnection);
    expect((await Effect.runPromise(connection.status)).phase).toBe("connecting");
    expect(
      (
        await Effect.runPromise(
          Effect.either(connection.request({ method: "GET", path: "/v1/config" })),
        )
      )._tag,
    ).toBe("Left");
    await expect.poll(() => !!reject).toBe(true);
    reject?.();
    await expect.poll(async () => (await Effect.runPromise(connection.status)).phase).toBe("error");
    expect(readFileSync(join(directory, "daemon-token"), "utf8")).toBe(token);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
