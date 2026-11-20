import { Effect, Redacted } from "effect";
import { BridgeError } from "./interface.js";
import { serveMcpStdio } from "./server.js";
import { makeSocketBridgeClient } from "./socket.js";

const program = Effect.gen(function* () {
  const socketPath = process.env.AUT_MCP_SOCKET;
  const token = process.env.AUT_MCP_TOKEN;
  if (!socketPath || !token)
    return yield* Effect.fail(
      new BridgeError({
        code: "Unauthorized",
        message: "MCP session credentials are not configured.",
      }),
    );
  const client = yield* makeSocketBridgeClient({ socketPath, token: Redacted.make(token) });
  yield* serveMcpStdio(client);
}).pipe(
  Effect.scoped,
  Effect.catchAllCause(() =>
    Effect.sync(() => {
      process.stderr.write("The aut MCP bridge could not start or authenticate.\n");
      process.exitCode = 1;
    }),
  ),
);

Effect.runFork(program);
