import { AdapterError, JsonValue, NonEmptyString, optional } from "@aut/protocol";
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

export const ThreadResult = Schema.Struct({ thread: Schema.Struct({ id: NonEmptyString }) });
export const TurnResult = Schema.Struct({ turn: Schema.Struct({ id: NonEmptyString }) });
export const NativeOption = Schema.Struct({
  label: NonEmptyString,
  description: optional(Schema.String),
});
export const NativeQuestion = Schema.Struct({
  id: NonEmptyString,
  question: NonEmptyString,
  isOther: optional(Schema.Boolean),
  options: optional(Schema.NullOr(Schema.Array(NativeOption))),
});
export const NativeRequest = Schema.Struct({
  threadId: NonEmptyString,
  turnId: NonEmptyString,
  questions: Schema.Array(NativeQuestion).pipe(Schema.minItems(1)),
});
export const AsyncQuestion = Schema.Struct({
  title: NonEmptyString,
  options: Schema.NullOr(Schema.Array(NonEmptyString)),
});
export const Item = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  text: optional(Schema.String),
  phase: optional(Schema.NullOr(Schema.String)),
  delivery: optional(Schema.NullOr(Schema.String)),
  questions: optional(Schema.NullOr(Schema.Array(AsyncQuestion))),
  content: optional(
    Schema.Array(
      Schema.Union(
        Schema.String,
        Schema.Struct({ type: Schema.String, text: optional(Schema.String) }),
      ),
    ),
  ),
  aggregatedOutput: optional(Schema.NullOr(Schema.String)),
  startedAtMs: optional(Schema.NullOr(Schema.Number)),
  completedAtMs: optional(Schema.NullOr(Schema.Number)),
  status: optional(Schema.String),
  command: optional(Schema.String),
  cwd: optional(Schema.String),
  exitCode: optional(Schema.NullOr(Schema.Int)),
  server: optional(Schema.String),
  tool: optional(Schema.String),
  query: optional(Schema.String),
  action: optional(JsonValue),
  results: optional(Schema.NullOr(Schema.Array(JsonValue))),
  namespace: optional(Schema.NullOr(Schema.String)),
  contentItems: optional(Schema.NullOr(Schema.Array(JsonValue))),
  success: optional(Schema.NullOr(Schema.Boolean)),
  prompt: optional(Schema.NullOr(Schema.String)),
  receiverThreadIds: optional(Schema.Array(Schema.String)),
  agentsStates: optional(JsonValue),
  path: optional(Schema.String),
  revisedPrompt: optional(Schema.NullOr(Schema.String)),
  savedPath: optional(Schema.NullOr(Schema.String)),
  fileId: optional(Schema.String),
  failure: optional(JsonValue),
  arguments: optional(JsonValue),
  result: optional(JsonValue),
  error: optional(JsonValue),
  summary: optional(Schema.Array(Schema.String)),
  changes: optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        kind: Schema.Struct({ type: Schema.String }),
        diff: Schema.String,
      }),
    ),
  ),
});
export const NativeTurn = Schema.Struct({
  id: NonEmptyString,
  status: optional(Schema.String),
  items: optional(Schema.Array(Item)),
  error: optional(Schema.NullOr(Schema.Struct({ message: Schema.String }))),
  startedAt: optional(Schema.NullOr(Schema.Number)),
  completedAt: optional(Schema.NullOr(Schema.Number)),
});
export const TurnNotification = Schema.Struct({ threadId: NonEmptyString, turn: NativeTurn });
export const ItemNotification = Schema.Struct({
  threadId: NonEmptyString,
  turnId: NonEmptyString,
  item: Item,
});
export const DeltaNotification = Schema.Struct({
  threadId: NonEmptyString,
  turnId: NonEmptyString,
  delta: Schema.String,
  itemId: optional(Schema.String),
});
export const ThreadTranscript = Schema.Struct({
  thread: Schema.Struct({ id: NonEmptyString, turns: Schema.Array(NativeTurn) }),
});
export const NativeIdentity = Schema.Struct({ threadId: NonEmptyString, turnId: NonEmptyString });
export const ResolvedRequest = Schema.Struct({ threadId: NonEmptyString, requestId: RpcId });
export const McpConfig = Schema.Struct({
  config: Schema.Struct({
    mcp_servers: optional(Schema.NullOr(Schema.Record({ key: Schema.String, value: JsonValue }))),
  }),
});
export const PermissionRequest = Schema.Struct({
  permissions: Schema.Struct({
    network: Schema.NullOr(Schema.Struct({ enabled: Schema.NullOr(Schema.Boolean) })),
    fileSystem: Schema.NullOr(
      Schema.Struct({
        read: Schema.NullOr(Schema.Array(Schema.String)),
        write: Schema.NullOr(Schema.Array(Schema.String)),
        globScanMaxDepth: optional(Schema.Number),
        entries: optional(Schema.Array(JsonValue)),
      }),
    ),
  }),
});

export const finalReport = (items: readonly (typeof Item.Type)[]): string | undefined =>
  items
    .filter(
      (item) =>
        item.type === "agentMessage" && item.phase === "final_answer" && item.delivery !== "async",
    )
    .at(-1)?.text;
