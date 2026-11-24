import type {
  JsonValue,
  SessionContext,
  SessionHistory,
  SessionItem,
  SessionTurn,
} from "@aut/protocol";
import type { Item, NativeTurn } from "./wire.js";

type NativeItem = typeof Item.Type;
type NativeTurnValue = typeof NativeTurn.Type;
const status = (value: string | undefined): SessionItem["status"] => {
  switch (value) {
    case "inProgress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "declined":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "unknown";
  }
};
const json = (value: JsonValue | undefined): string =>
  value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);

export const normalizeItem = (
  item: NativeItem,
  fallback: SessionItem["status"] = "unknown",
): SessionItem => {
  const common = {
    id: item.id,
    status: item.status
      ? status(item.status)
      : item.completedAtMs != null
        ? ("completed" as const)
        : fallback,
    ...(item.startedAtMs == null ? {} : { startedAt: item.startedAtMs }),
    ...(item.completedAtMs == null ? {} : { completedAt: item.completedAtMs }),
  };
  if (item.type === "userMessage")
    return {
      ...common,
      kind: "user",
      text:
        item.content
          ?.map((part) => (typeof part === "string" ? part : (part.text ?? "")))
          .join("\n") ?? "",
    };
  if (item.type === "agentMessage")
    return {
      ...common,
      kind: "assistant",
      text: item.text ?? "",
      ...(item.phase === "commentary"
        ? { phase: "commentary" as const }
        : item.phase === "final_answer"
          ? { phase: "final" as const }
          : {}),
    };
  if (item.type === "contextCompaction")
    return { ...common, kind: "note", noteKind: "context-compaction", text: "" };
  if (item.type === "commandExecution")
    return {
      ...common,
      kind: "tool",
      text: item.command ?? "",
      tool: {
        name: "commandExecution",
        input: item.command ?? "",
        output: item.aggregatedOutput ?? "",
        ...(item.exitCode == null ? {} : { exitCode: item.exitCode }),
      },
    };
  if (item.type === "fileChange")
    return {
      ...common,
      kind: "tool",
      text: (item.changes ?? []).map((change) => `${change.kind.type}: ${change.path}`).join("\n"),
      tool: {
        name: "fileChange",
        input: (item.changes ?? [])
          .map((change) => `${change.kind.type}: ${change.path}`)
          .join("\n"),
        output: (item.changes ?? []).map((change) => `${change.path}\n${change.diff}`).join("\n\n"),
      },
    };
  if (item.type === "mcpToolCall")
    return {
      ...common,
      kind: "tool",
      text: [item.server, item.tool].filter(Boolean).join("."),
      tool: {
        name: [item.server, item.tool].filter(Boolean).join(".") || "mcpToolCall",
        input: json(item.arguments),
        output: json(item.result) || json(item.error),
      },
    };
  // Additional known tool shapes come from the CLI-generated 0.169.0 schema, not a model invocation.
  if (item.type === "webSearch")
    return {
      ...common,
      kind: "tool",
      text: item.query ?? "webSearch",
      tool: {
        name: "webSearch",
        input: json({ query: item.query ?? "", action: item.action ?? null }),
        output: json(item.results),
      },
    };
  if (item.type === "dynamicToolCall")
    return {
      ...common,
      ...(item.success === false ? { status: "failed" as const } : {}),
      kind: "tool",
      text: [item.namespace, item.tool].filter(Boolean).join("."),
      tool: {
        name: [item.namespace, item.tool].filter(Boolean).join(".") || "dynamicToolCall",
        input: json(item.arguments),
        output: json(item.contentItems),
      },
    };
  if (item.type === "collabAgentToolCall")
    return {
      ...common,
      kind: "tool",
      text: item.tool ?? "collabAgentToolCall",
      tool: {
        name: item.tool ?? "collabAgentToolCall",
        input: json({
          prompt: item.prompt ?? null,
          receiverThreadIds: item.receiverThreadIds ?? [],
        }),
        output: json(item.agentsStates),
      },
    };
  if (item.type === "imageView")
    return {
      ...common,
      kind: "tool",
      text: item.path ?? "imageView",
      tool: { name: "imageView", input: item.path ?? "", output: "" },
    };
  if (item.type === "imageGeneration")
    return {
      ...common,
      kind: "tool",
      text: item.revisedPrompt ?? "imageGeneration",
      tool: {
        name: "imageGeneration",
        input: item.revisedPrompt ?? "",
        output: item.savedPath ?? item.fileId ?? json(item.failure ?? item.result),
      },
    };
  // Native reasoning content is not a user-facing transcript. Only its explicit public summary is projected.
  return {
    ...common,
    kind: "note",
    text: item.type === "reasoning" ? (item.summary?.join("\n") ?? "") : (item.text ?? item.type),
  };
};

/** Stable IDs join native snapshots with stream items; an absent snapshot item never deletes a live item. */
export class SessionHistoryCache {
  private readonly turns = new Map<string, SessionTurn>();
  private usage: SessionContext["usage"];
  private usageCompaction: SessionContext["compaction"];

  private latestCompaction(): SessionContext["compaction"] {
    for (const turn of [...this.turns.values()].reverse()) {
      const item = turn.items.findLast((entry) => entry.noteKind === "context-compaction");
      if (item)
        return {
          turnId: turn.id,
          itemId: item.id,
          status: item.status,
          ...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
          ...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
        };
    }
    return undefined;
  }

  /** Native last-input reading, never the accumulated billing total or a local estimate. */
  recordUsage(usage: NonNullable<SessionContext["usage"]>): void {
    const compaction = this.latestCompaction();
    if (compaction?.status === "running") return;
    this.usage = usage.tokens > 0 ? usage : undefined;
    this.usageCompaction = compaction;
  }

  turn(value: NativeTurnValue, nativeOrder = false): void {
    const previous = this.turns.get(value.id);
    const nextStatus = value.status ? status(value.status) : (previous?.status ?? "unknown");
    const effectiveStatus =
      previous &&
      (nextStatus === "unknown" ||
        (previous.status !== "running" &&
          previous.status !== "unknown" &&
          nextStatus === "running"))
        ? previous.status
        : nextStatus;
    const items = new Map(previous?.items.map((item) => [item.id, item]));
    for (const item of value.items ?? []) {
      const next = normalizeItem(item, nextStatus === "completed" ? "completed" : "unknown");
      const old = items.get(item.id);
      // A historical read may lag the stream. Preserve confirmed terminal or longer in-flight content.
      const stale =
        old &&
        ((next.status === "unknown" && old.status !== "unknown") ||
          (old.status !== "running" && old.status !== "unknown" && next.status === "running") ||
          (old.status === "running" &&
            next.status === "running" &&
            ((old.tool?.output.length ?? 0) > (next.tool?.output.length ?? 0) ||
              old.text.length > next.text.length)));
      if (!stale) items.set(item.id, next);
    }
    const ordered = nativeOrder
      ? [
          ...(value.items ?? []).flatMap((item) => {
            const found = items.get(item.id);
            return found ? [found] : [];
          }),
          ...[...items.values()].filter(
            (item) => !value.items?.some((native) => native.id === item.id),
          ),
        ]
      : [...items.values()];
    this.turns.set(value.id, {
      id: value.id,
      status: effectiveStatus,
      ...(previous?.startedAt === undefined ? {} : { startedAt: previous.startedAt }),
      ...(previous?.completedAt === undefined ? {} : { completedAt: previous.completedAt }),
      ...(value.startedAt == null ? {} : { startedAt: value.startedAt * 1000 }),
      ...(value.completedAt == null ? {} : { completedAt: value.completedAt * 1000 }),
      ...(value.error?.message ? { error: value.error.message } : {}),
      items: ordered.map((item) =>
        item.status === "running" && effectiveStatus !== "running" && effectiveStatus !== "unknown"
          ? {
              ...item,
              status: effectiveStatus === "completed" ? ("unknown" as const) : effectiveStatus,
            }
          : item,
      ),
    });
  }

  hydrate(values: readonly NativeTurnValue[]): void {
    for (const turn of values) this.turn(turn, true);
    const order = [
      ...values.flatMap((turn) => {
        const found = this.turns.get(turn.id);
        return found ? [found] : [];
      }),
      ...[...this.turns.values()].filter((turn) => !values.some((native) => native.id === turn.id)),
    ];
    this.turns.clear();
    for (const turn of order) this.turns.set(turn.id, turn);
  }

  item(turnId: string, value: NativeItem, completed: boolean): void {
    const previous = this.turns.get(turnId) ?? {
      id: turnId,
      status: "running" as const,
      items: [],
    };
    const items = new Map(previous.items.map((item) => [item.id, item]));
    const old = items.get(value.id);
    if (!completed && old && !["running", "unknown"].includes(old.status)) return;
    items.set(value.id, normalizeItem(value, completed ? "completed" : "running"));
    this.turns.set(turnId, { ...previous, items: [...items.values()] });
  }

  delta(turnId: string, itemId: string, text: string, tool: boolean): void {
    const previous = this.turns.get(turnId) ?? {
      id: turnId,
      status: "running" as const,
      items: [],
    };
    const items = new Map(previous.items.map((item) => [item.id, item]));
    if (!["running", "unknown"].includes(previous.status)) return;
    const old = items.get(itemId);
    if (old && !["running", "unknown"].includes(old.status)) return;
    items.set(
      itemId,
      tool
        ? {
            ...(old ?? { id: itemId, status: "running" as const, kind: "tool" as const, text: "" }),
            tool: {
              name: old?.tool?.name ?? "commandExecution",
              input: old?.tool?.input ?? "",
              output: (old?.tool?.output ?? "") + text,
            },
          }
        : {
            ...(old ?? { id: itemId, status: "running" as const, kind: "assistant" as const }),
            text: (old?.text ?? "") + text,
          },
    );
    this.turns.set(turnId, { ...previous, items: [...items.values()] });
  }

  snapshot(): SessionHistory {
    const compaction = this.latestCompaction();
    // A reading from before a newly observed compaction cannot describe the current context.
    const usage =
      compaction?.status !== "running" &&
      this.usageCompaction?.turnId === compaction?.turnId &&
      this.usageCompaction?.itemId === compaction?.itemId
        ? this.usage
        : undefined;
    return {
      context: { ...(usage ? { usage } : {}), ...(compaction ? { compaction } : {}) },
      turns: [...this.turns.values()].map((turn) => ({ ...turn, items: [...turn.items] })),
    };
  }
}
