import type { CoreOptions } from "@aut/core";
import { NonEmptyString, NonNegativeInteger } from "@aut/protocol";
import { Context, Effect, Layer, Schema } from "effect";
import { decode } from "./errors.js";
import { HttpServer } from "./http.js";

export interface DaemonOptions extends CoreOptions {
  readonly port?: number;
}
export const environmentOptions = Effect.gen(function* () {
  const dataDirectory = process.env.AUT_DATA_DIR;
  const port = yield* decode(
    NonNegativeInteger.pipe(Schema.lessThanOrEqualTo(65535)),
    Number(process.env.AUT_PORT ?? 4317),
  );
  if (dataDirectory !== undefined) yield* decode(NonEmptyString, dataDirectory);
  return { ...(dataDirectory === undefined ? {} : { dataDirectory }), port };
});

export class DaemonRuntime extends Context.Tag("aut/DaemonRuntime")<
  DaemonRuntime,
  { readonly waitForShutdown: Effect.Effect<void> }
>() {}
export const DaemonRuntimeLive = Layer.effect(
  DaemonRuntime,
  Effect.gen(function* () {
    const server = yield* HttpServer;
    yield* Effect.logInfo(`aut daemon listening on http://${server.host}:${server.port}`);
    return {
      waitForShutdown: Effect.async<void>((resume) => {
        const done = () => resume(Effect.void);
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
        return Effect.sync(() => {
          process.off("SIGINT", done);
          process.off("SIGTERM", done);
        });
      }),
    };
  }),
);

export const runDaemon = <E>(layer: Layer.Layer<DaemonRuntime, E>) => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* (yield* DaemonRuntime).waitForShutdown;
    }).pipe(Effect.provide(layer)),
  ).pipe(
    Effect.catchAll(() =>
      Effect.sync(() => {
        console.error("aut daemon failed to start or shut down");
        process.exitCode = 1;
      }),
    ),
  );
  Effect.runFork(program);
};
