import {
  AdapterError,
  type BotModelsResponse,
  type JsonValue,
  NonEmptyString,
} from "@aut/protocol";
import { Effect, Queue, Schema } from "effect";
import { type AcpTransportFactory, NodeAcpTransport } from "./transport.js";

export interface ReadAcpModelsOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly authMethodIds?: readonly string[];
  readonly timeoutMs?: number;
}
const ModelValue = Schema.Struct({ value: NonEmptyString, name: Schema.optional(NonEmptyString) });
const ModelGroup = Schema.Struct({ options: Schema.Array(ModelValue) });
const Opened = Schema.Struct({
  sessionId: NonEmptyString,
  configOptions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: NonEmptyString,
        category: Schema.optional(Schema.String),
        type: Schema.String,
        currentValue: Schema.optional(Schema.String),
        options: Schema.optional(Schema.Array(Schema.Union(ModelValue, ModelGroup))),
      }),
    ),
  ),
});
const Initialized = Schema.Struct({
  authMethods: Schema.optional(Schema.Array(Schema.Struct({ id: NonEmptyString }))),
  agentCapabilities: Schema.optional(
    Schema.Struct({
      sessionCapabilities: Schema.optional(
        Schema.Struct({ close: Schema.optional(Schema.Unknown) }),
      ),
    }),
  ),
});
const failure = () =>
  new AdapterError({ code: "InvalidResponse", message: "ACP model discovery failed." });
const decode = <A>(schema: Schema.Schema<A>, value: JsonValue) =>
  Schema.decodeUnknown(schema)(value).pipe(Effect.mapError(failure));

/** ACP exposes model choices on an empty native session; no prompt or config mutation is sent. */
export const readAcpModels = (
  options: ReadAcpModelsOptions,
  factory: AcpTransportFactory = NodeAcpTransport,
): Effect.Effect<BotModelsResponse, AdapterError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* factory.open({
        ...options,
        rpcTimeoutMs: options.timeoutMs ?? 15_000,
      });
      yield* Effect.forever(
        Effect.gen(function* () {
          const notice = yield* Queue.take(transport.notices);
          if (notice.kind === "message" && notice.message.method && notice.message.id !== undefined)
            yield* transport.send({
              id: notice.message.id,
              error: { code: -32601, message: "Model discovery does not provide client tools." },
            });
        }),
      ).pipe(Effect.forkScoped);
      const initialized = yield* transport
        .request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "aut-model-discovery", version: "0.0.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        })
        .pipe(Effect.flatMap((value) => decode(Initialized, value)));
      if (options.authMethodIds?.length) {
        const methodId = options.authMethodIds.find((id) =>
          initialized.authMethods?.some((method) => method.id === id),
        );
        if (!methodId) return yield* Effect.fail(failure());
        yield* transport.request("authenticate", { methodId });
      }
      const opened = yield* transport
        .request("session/new", { cwd: options.cwd, mcpServers: [] })
        .pipe(Effect.flatMap((value) => decode(Opened, value)));
      if (initialized.agentCapabilities?.sessionCapabilities?.close !== undefined)
        yield* Effect.addFinalizer(() =>
          transport
            .request("session/close", {
              sessionId: opened.sessionId,
            })
            .pipe(Effect.timeout("2 seconds"), Effect.ignore),
        );
      const option = opened.configOptions?.find(
        (entry) => entry.type === "select" && (entry.category === "model" || entry.id === "model"),
      );
      const models = new Map<string, BotModelsResponse["models"][number]>();
      for (const value of option?.options ?? []) {
        for (const model of "options" in value ? value.options : [value])
          models.set(model.value, {
            model: model.value,
            ...(model.name ? { label: model.name } : {}),
          });
      }
      if (option?.currentValue && !models.has(option.currentValue))
        models.set(option.currentValue, { model: option.currentValue });
      return {
        models: [...models.values()],
        ...(option?.currentValue ? { defaultModel: option.currentValue } : {}),
        source: "catalog" as const,
      };
    }).pipe(
      Effect.interruptible,
      Effect.timeoutFail({ duration: options.timeoutMs ?? 15_000, onTimeout: failure }),
    ),
  ).pipe(Effect.mapError(failure));
