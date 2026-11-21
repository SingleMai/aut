// ACP JSON-RPC wire definitions adapted from OpenMausBot (Apache-2.0),
// server/drivers/acp/host.ts and server/drivers/acp/core.ts, commit
// 738ec88472a3b888ff7b7793755d89da613ed301.
import { AdapterError, JsonValue, optional } from "@aut/protocol";
import { Effect, Schema } from "effect";

export const RpcId = Schema.Union(Schema.String, Schema.Int);
export const RpcMessage = Schema.Struct({
  id: optional(RpcId),
  method: optional(Schema.String),
  params: optional(JsonValue),
  result: optional(JsonValue),
  error: optional(
    Schema.Struct({ code: Schema.Int, message: Schema.String, data: optional(JsonValue) }),
  ),
}).pipe(
  Schema.filter((message) =>
    message.method !== undefined
      ? message.method.length > 0 && message.result === undefined && message.error === undefined
      : message.id !== undefined &&
        (message.result !== undefined) !== (message.error !== undefined),
  ),
);
export type RpcMessage = typeof RpcMessage.Type;

export const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError((error) => new AdapterError({ code: "ProtocolError", message: String(error) })),
  );

export const decodeLine = (line: string) => decode(Schema.parseJson(RpcMessage), line);

export const asRecord = (
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : null;

export const textValue = (value: JsonValue | undefined): string =>
  typeof value === "string" ? value : "";

export const permissionOptions = (
  value: JsonValue | undefined,
): readonly {
  readonly optionId: string;
  readonly kind: string;
  readonly name: string;
}[] => {
  const params = asRecord(value);
  const options = params?.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((entry) => {
    const option = asRecord(entry);
    if (
      !option ||
      typeof option.optionId !== "string" ||
      typeof option.kind !== "string" ||
      typeof option.name !== "string"
    )
      return [];
    return [{ optionId: option.optionId, kind: option.kind, name: option.name }];
  });
};

export const toolCall = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> => {
  const params = asRecord(value);
  return asRecord(params?.toolCall) ?? {};
};

export const update = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> => {
  const params = asRecord(value);
  return asRecord(params?.update) ?? {};
};
