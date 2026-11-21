// Claude stream-json frame definitions adapted from OpenMausBot (Apache-2.0),
// server/drivers/claude.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
import { AdapterError, JsonValue, optional } from "@aut/protocol";
import { Effect, Schema } from "effect";

export const ClaudeFrame = Schema.Struct({
  type: Schema.String,
  subtype: optional(Schema.String),
  session_id: optional(Schema.String),
  model: optional(Schema.String),
  permissionMode: optional(Schema.String),
  event: optional(JsonValue),
  message: optional(JsonValue),
  result: optional(Schema.String),
  is_error: optional(Schema.Boolean),
  errors: optional(JsonValue),
  api_error: optional(Schema.String),
  total_cost_usd: optional(Schema.Number),
  usage: optional(JsonValue),
  modelUsage: optional(JsonValue),
  stop_reason: optional(Schema.NullOr(Schema.String)),
  terminal_reason: optional(Schema.NullOr(Schema.String)),
  queued_turn_count: optional(Schema.Int),
  isReplay: optional(Schema.Boolean),
  origin: optional(JsonValue),
  request_id: optional(Schema.String),
  request: optional(JsonValue),
  uuid: optional(Schema.String),
});
export type ClaudeFrame = typeof ClaudeFrame.Type;

export const decodeLine = (line: string) =>
  Schema.decodeUnknown(Schema.parseJson(ClaudeFrame))(line).pipe(
    Effect.mapError((error) => new AdapterError({ code: "ProtocolError", message: String(error) })),
  );

export const asRecord = (
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : null;

export const textFromContent = (content: JsonValue | undefined): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      const block = asRecord(entry);
      return block && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("");
};

export type ClaudeToolUse = {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
};

export const toolUses = (message: JsonValue | undefined): readonly ClaudeToolUse[] => {
  const record = asRecord(message);
  const content = record?.content;
  if (!Array.isArray(content)) return [];
  const result: ClaudeToolUse[] = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (
      block &&
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string" &&
      block.input !== undefined
    ) {
      result.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  return result;
};

export const toolResults = (
  message: JsonValue | undefined,
): readonly {
  readonly id: string;
  readonly output: string;
  readonly ok: boolean;
}[] => {
  const record = asRecord(message);
  const content = record?.content;
  if (!Array.isArray(content)) return [];
  const result: { id: string; output: string; ok: boolean }[] = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (block && block.type === "tool_result" && typeof block.tool_use_id === "string") {
      result.push({
        id: block.tool_use_id,
        output: textFromContent(block.content),
        ok: block.is_error !== true,
      });
    }
  }
  return result;
};

export const eventDelta = (event: JsonValue | undefined): string | undefined => {
  const record = asRecord(event);
  const delta = asRecord(record?.delta);
  return delta?.type === "text_delta" && typeof delta.text === "string" ? delta.text : undefined;
};
