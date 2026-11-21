import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@aut/protocol";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { decodeLine, eventDelta, textFromContent, toolResults, toolUses } from "./wire.js";

const fixtures = fileURLToPath(new URL("../../../../spikes/claude/fixtures", import.meta.url));

const receiveFrames = (name: string): readonly Record<string, unknown>[] =>
  readFileSync(`${fixtures}/${name}`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { direction?: unknown; payload?: unknown })
    .filter(
      (row) =>
        row.direction === "receive" && typeof row.payload === "object" && row.payload !== null,
    )
    .map((row) => row.payload as Record<string, unknown>);

describe("Claude stream-json wire fixtures", () => {
  it.scopedLive("decodes every recorded receive frame", () =>
    Effect.gen(function* () {
      for (const name of [
        "normal-2.1.325.jsonl",
        "question-2.1.325.jsonl",
        "steer-2.1.325.jsonl",
        "interrupt-2.1.325.jsonl",
        "resume-2.1.325.jsonl",
        "fork-2.1.325.jsonl",
      ]) {
        for (const frame of receiveFrames(name)) {
          const decoded = yield* decodeLine(JSON.stringify(frame));
          expect(decoded.type).toEqual(frame.type);
        }
      }
    }),
  );

  it("extracts text, tool use, tool result, and stream deltas from real shapes", () => {
    const question = receiveFrames("question-2.1.325.jsonl");
    const toolUse = question.find(
      (frame) => toolUses((frame as { message?: JsonValue }).message).length > 0,
    );
    expect(toolUse).toBeDefined();
    expect(toolUses((toolUse as { message?: JsonValue } | undefined)?.message)).toHaveLength(1);

    const toolResult = question.find((frame) =>
      toolResults((frame as { message?: JsonValue }).message).some((result) =>
        result.output.includes("AUT_CLAUDE_PROBE_ANSWER"),
      ),
    );
    expect(toolResult).toBeDefined();
    expect(
      toolResults((toolResult as { message?: JsonValue } | undefined)?.message)[0]?.output,
    ).toContain("AUT_CLAUDE_PROBE_ANSWER");

    const delta = question.find(
      (frame) => eventDelta((frame as { event?: JsonValue }).event) !== undefined,
    );
    expect(delta).toBeDefined();
    const blocks = (
      (toolResult as { message?: JsonValue } | undefined)?.message as
        | { content?: JsonValue }
        | undefined
    )?.content;
    const firstToolResult = Array.isArray(blocks)
      ? (blocks[0] as { content?: JsonValue } | undefined)
      : undefined;
    expect(textFromContent(firstToolResult?.content)).toContain("AUT_CLAUDE_PROBE_ANSWER");
  });
});
