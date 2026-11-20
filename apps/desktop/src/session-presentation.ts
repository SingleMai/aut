// Codex tool titles follow OpenMausBot server/drivers/codex.ts (Apache-2.0),
// commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. See NOTICE.
// aut adaptation: project the existing read-only SessionHistory into UI fields;
// retain native status and full recorded input/output without importing a driver or store.
import type { SessionItem, SessionTurn, TaskSessionResponse } from "@aut/protocol";
import { Schema } from "effect";
import type { Message, Tool } from "./openmausbot/types.js";

export interface SessionPresentation {
  messages: Message[];
  liveMessageIds: Set<string>;
  /** Projection message ID -> native item ID, for navigation into the original record. */
  itemIds: Map<string, string>;
}

const ExplicitToolError = Schema.Union(
  Schema.Struct({ error: Schema.String }),
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
  Schema.Struct({ code: Schema.Number, message: Schema.String }),
);
const decodeToolError = Schema.decodeUnknownEither(Schema.parseJson(ExplicitToolError));

const toolProblem = (item: SessionItem): string | undefined => {
  if (item.status !== "failed" || !item.tool) return undefined;
  const decoded = decodeToolError(item.tool.output);
  if (decoded._tag === "Left") return undefined;
  const value = decoded.right;
  const message =
    "error" in value
      ? typeof value.error === "string"
        ? value.error
        : value.error.message
      : value.message;
  return message.trim() ? message : undefined;
};

const toolName = (tool: NonNullable<SessionItem["tool"]>): string => {
  switch (tool.name) {
    case "commandExecution":
      return tool.input || "shell";
    case "fileChange":
      return "edit";
    case "webSearch":
      return "web_search";
    default: {
      // The normalized history stores MCP/dynamic tools as server.tool / namespace.tool.
      const separator = tool.name.indexOf(".");
      return separator >= 0 ? tool.name.slice(separator + 1) || tool.name : tool.name;
    }
  }
};

const projectTool = (item: SessionItem): Tool | undefined => {
  const native = item.tool;
  if (!native) return undefined;
  const problem = toolProblem(item);
  // OpenMausBot server/tool-summary.ts: commandSummary's newline folding and 200-char limit.
  // aut retains the recorded command; it does not claim upstream's separate secret-redaction pass.
  const summary =
    native.name === "commandExecution"
      ? native.input
          .replace(/\s*[\r\n]+\s*/g, " ")
          .trim()
          .slice(0, 200)
      : undefined;
  return {
    name: toolName(native),
    itemId: item.id,
    input: native.input,
    output: native.output,
    ...(item.status === "completed" ? { ok: true } : item.status === "failed" ? { ok: false } : {}),
    ...(summary ? { summary } : {}),
    ...(problem ? { problem } : {}),
  };
};

const timestamp = (item: SessionItem, turn: SessionTurn): number => {
  const native =
    item.phase === "final"
      ? (item.completedAt ?? item.startedAt)
      : (item.startedAt ?? item.completedAt);
  // Zero is a stable unknown-time sentinel, never a fabricated wall-clock event time.
  return (
    native ??
    (item.phase === "final"
      ? (turn.completedAt ?? turn.startedAt)
      : (turn.startedAt ?? turn.completedAt)) ??
    0
  );
};

export const projectSession = (response: TaskSessionResponse): SessionPresentation => {
  const messages: Message[] = [];
  const liveMessageIds = new Set<string>();
  const itemIds = new Map<string, string>();
  for (const turn of response.history.turns) {
    for (const item of turn.items) {
      // Codex's empty reasoning entries are not visible conversation messages.
      if (item.kind === "note" && !item.text.trim()) continue;
      const id = `${turn.id}:${item.id}`;
      const tool = item.kind === "tool" ? projectTool(item) : undefined;
      messages.push({
        id,
        at: timestamp(item, turn),
        role: item.kind === "user" ? "user" : item.kind === "note" ? "system" : "bot",
        kind: tool ? "activity" : "text",
        text: item.text,
        turnId: turn.id,
        ...(item.kind === "assistant" && item.phase === "final" && item.status === "completed"
          ? { turnTerminal: true }
          : {}),
        ...(item.kind === "user" ? {} : { from: { botId: response.task.botId } }),
        ...(tool ? { tool } : {}),
      });
      itemIds.set(id, item.id);
      if (turn.status === "running" && item.status === "running") liveMessageIds.add(id);
    }
  }
  return { messages, liveMessageIds, itemIds };
};
