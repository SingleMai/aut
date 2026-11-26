import { AdapterError, type JsonValue, NonEmptyString } from "@aut/protocol";
import { Effect, Schema } from "effect";
import type { Transport, TransportFactory } from "./transport.js";

export interface CodexDiscoveryOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export const optionalText = Schema.optionalWith(Schema.NullOr(NonEmptyString), { exact: true });
export const ModelConfig = Schema.Struct({
  model: optionalText,
  model_provider: optionalText,
  model_reasoning_effort: optionalText,
});
export const ModelEntry = Schema.Struct({
  model: NonEmptyString,
  isDefault: Schema.Boolean,
  defaultReasoningEffort: optionalText,
});

const invalidResponse = () =>
  new AdapterError({ code: "InvalidResponse", message: "Invalid Codex model discovery response." });

// The unprojected native configuration may contain credentials.
const decode = <A>(schema: Schema.Schema<A>, value: JsonValue) =>
  Schema.decodeUnknown(schema)(value).pipe(Effect.mapError(invalidResponse));

export const openModelDiscovery = (
  factory: TransportFactory,
  options: CodexDiscoveryOptions,
  clientName: string,
  timeoutMs: number,
) =>
  Effect.gen(function* () {
    const transport = yield* factory.open({
      command: options.command ?? "codex",
      args: ["app-server", "--stdio", ...(options.args ?? [])],
      cwd: options.cwd,
      rpcTimeoutMs: timeoutMs,
      ...(options.env ? { env: options.env } : {}),
    });
    yield* transport.request("initialize", {
      clientInfo: { name: clientName, version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    yield* transport.send({ method: "initialized", params: {} });
    return transport;
  });

export const readModelConfig = <A>(
  transport: Transport,
  cwd: string,
  projection: Schema.Schema<A>,
) =>
  transport.request("config/read", { cwd, includeLayers: false }).pipe(
    Effect.flatMap((value) => decode(Schema.Struct({ config: projection }), value)),
    Effect.map(({ config }) => config),
  );

export const forEachListedModel = <A>(
  transport: Transport,
  entry: Schema.Schema<A>,
  visit: (model: A) => void,
) =>
  Effect.gen(function* () {
    const pageSchema = Schema.Struct({ data: Schema.Array(entry), nextCursor: optionalText });
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 32; page++) {
      const response = yield* transport
        .request("model/list", cursor ? { cursor } : {})
        .pipe(Effect.flatMap((value) => decode(pageSchema, value)));
      for (const model of response.data) visit(model);
      if (!response.nextCursor) return;
      if (seen.has(response.nextCursor)) break;
      cursor = response.nextCursor;
      seen.add(cursor);
    }
    return yield* Effect.fail(invalidResponse());
  });
