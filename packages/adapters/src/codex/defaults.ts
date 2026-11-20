import { AdapterError, type JsonValue, NonEmptyString } from "@aut/protocol";
import { Effect, Schema } from "effect";
import { NodeTransport, type TransportFactory } from "./transport.js";

const optionalText = Schema.optionalWith(Schema.NullOr(NonEmptyString), { exact: true });
const ConfigProjection = Schema.Struct({
  config: Schema.Struct({
    model: optionalText,
    model_provider: optionalText,
    model_reasoning_effort: optionalText,
  }),
});
const ModelProjection = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      model: NonEmptyString,
      isDefault: Schema.Boolean,
      defaultReasoningEffort: optionalText,
    }),
  ),
  nextCursor: optionalText,
});
export const CodexDefaults = Schema.Struct({
  model: NonEmptyString,
  effort: Schema.optionalWith(NonEmptyString, { exact: true }),
  provider: Schema.NullOr(NonEmptyString),
  source: Schema.Literal("configured", "reported-default"),
});
export type CodexDefaults = typeof CodexDefaults.Type;
export interface ReadCodexDefaultsOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs?: number;
}
const invalid = () =>
  new AdapterError({
    code: "InvalidResponse",
    message: "Codex did not report an unambiguous model configuration.",
  });
const project = <A>(schema: Schema.Schema<A>, input: JsonValue) =>
  Schema.decodeUnknown(schema)(input).pipe(
    // The unprojected configuration may contain credentials; never include it in an error.
    Effect.mapError(invalid),
  );

/** Only reads native settings. No thread, model turn, config write, or provider override is issued. */
export const readCodexDefaults = (
  options: ReadCodexDefaultsOptions,
  factory: TransportFactory = NodeTransport,
): Effect.Effect<CodexDefaults, AdapterError> => {
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    return Effect.fail(
      new AdapterError({
        code: "InvalidResponse",
        message: "The defaults probe timeout must be a positive safe integer.",
      }),
    );
  return Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* factory.open({
        command: options.command ?? "codex",
        args: ["app-server", "--stdio", ...(options.args ?? [])],
        cwd: options.cwd,
        rpcTimeoutMs: timeout,
        ...(options.env ? { env: options.env } : {}),
      });
      yield* transport.request("initialize", {
        clientInfo: { name: "aut-config-discovery", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      });
      yield* transport.send({ method: "initialized", params: {} });
      const snapshot = yield* transport
        .request("config/read", { cwd: options.cwd, includeLayers: false })
        .pipe(Effect.flatMap((value) => project(ConfigProjection, value)));
      const config = snapshot.config;
      if (config.model)
        return {
          model: config.model,
          provider: config.model_provider ?? null,
          source: "configured" as const,
          ...(config.model_reasoning_effort ? { effort: config.model_reasoning_effort } : {}),
        };
      const defaults: {
        readonly model: string;
        readonly defaultReasoningEffort?: string | null;
      }[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 32; page++) {
        const models = yield* transport
          .request("model/list", cursor ? { cursor } : {})
          .pipe(Effect.flatMap((value) => project(ModelProjection, value)));
        defaults.push(...models.data.filter((model) => model.isDefault));
        if (!models.nextCursor) {
          const selected = defaults[0];
          if (defaults.length !== 1 || !selected) return yield* Effect.fail(invalid());
          const effort = config.model_reasoning_effort ?? selected.defaultReasoningEffort;
          return {
            model: selected.model,
            provider: config.model_provider ?? null,
            source: "reported-default" as const,
            ...(effort ? { effort } : {}),
          };
        }
        if (cursors.has(models.nextCursor)) return yield* Effect.fail(invalid());
        cursors.add(models.nextCursor);
        cursor = models.nextCursor;
      }
      return yield* Effect.fail(invalid());
    }).pipe(
      Effect.interruptible,
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () =>
          new AdapterError({
            code: "TransportError",
            message: "The read-only Codex configuration probe timed out.",
          }),
      }),
    ),
  ).pipe(
    Effect.mapError(
      (error) =>
        new AdapterError({
          code: error.code,
          message: "Read-only Codex model discovery failed; native settings were not changed.",
        }),
    ),
  );
};
