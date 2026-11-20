import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BridgeSocket, makeBridgeSocket } from "@aut/mcp-bridge";
import { Context, Effect, Layer } from "effect";
import { io } from "./errors.js";
import { Ownership } from "./ownership.js";
import { SessionBridge } from "./session-setup.js";

export class BridgeRuntime extends Context.Tag("aut/BridgeRuntime")<
  BridgeRuntime,
  {
    readonly socket: BridgeSocket;
  }
>() {}

/** Listener readiness precedes HTTP admission; private paths avoid stale-socket takeover. */
export const BridgeRuntimeLive = Layer.scoped(
  BridgeRuntime,
  Effect.gen(function* () {
    yield* Ownership;
    const sessions = yield* SessionBridge;
    const directory = yield* Effect.acquireRelease(
      io("Failed to create a private MCP socket directory", () =>
        mkdtempSync(join(tmpdir(), "aut-mcp-")),
      ),
      (path) =>
        io("Failed to remove the private MCP directory", () =>
          rmSync(path, { recursive: true, force: true }),
        ).pipe(Effect.orDie),
    );
    const socket = yield* makeBridgeSocket({ socketPath: join(directory, "bridge.sock") });
    yield* sessions.bind(socket);
    return { socket };
  }),
);
