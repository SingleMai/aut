import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BridgeBackend, makeSocketBridgeClient } from "@aut/mcp-bridge";
import { BotId, TaskId } from "@aut/protocol";
import { Effect, Either, Exit, Layer, Scope } from "effect";
import { expect, it } from "vitest";
import { BridgeRuntime, BridgeRuntimeLive } from "./bridge-runtime.js";
import { OwnershipLive } from "./ownership.js";
import { SessionBridge, SessionBridgeLive } from "./session-setup.js";

it("binds a private ready listener and revokes session credentials before cleaning its own directory", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-bridge-runtime-"));
  const backend = Layer.succeed(BridgeBackend, {
    authorize: () => Effect.void,
    readMainThread: () => Effect.succeed([]),
    listTasks: () => Effect.succeed([]),
    getTask: () => Effect.dieMessage("Unused task lookup"),
    createBot: (_identity, { id, name }) => Effect.succeed({ id, name }),
    proposeRoute: () => Effect.succeed({ accepted: true }),
  });
  const layer = BridgeRuntimeLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(OwnershipLive({ dataDirectory }), SessionBridgeLive, backend),
    ),
  );
  try {
    const path = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* BridgeRuntime;
          const scope = yield* Scope.make();
          const identity = {
            botId: BotId.make("bot"),
            taskId: TaskId.make("task"),
            role: "worker" as const,
          };
          const credentials = yield* Scope.extend((yield* SessionBridge).register(identity), scope);
          const client = yield* makeSocketBridgeClient(credentials);
          expect(yield* client.identity).toEqual(identity);
          expect(statSync(runtime.socket.socketPath).mode & 0o777).toBe(0o600);
          expect(statSync(dirname(runtime.socket.socketPath)).mode & 0o777).toBe(0o700);
          yield* Scope.close(scope, Exit.succeed(undefined));
          const revoked = yield* Effect.either(client.identity);
          expect(Either.isLeft(revoked) && revoked.left.code).toBe("Unauthorized");
          return runtime.socket.socketPath;
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
    expect(existsSync(dataDirectory)).toBe(true);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
