import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { decodeLine, finalReport } from "./wire.js";

for (const value of [
  "not-json",
  "{}",
  '{"id":1}',
  '{"id":1,"result":{},"error":{"code":-1,"message":"bad"}}',
]) {
  it.effect(`rejects malformed RPC ${value}`, () =>
    Effect.gen(function* () {
      expect((yield* decodeLine(value).pipe(Effect.flip)).code).toBe("ProtocolError");
    }),
  );
}

it.effect("an async question cannot become a final report even when phase is final_answer", () =>
  Effect.sync(() => {
    const question = {
      id: "async-item",
      type: "agentMessage",
      phase: "final_answer",
      delivery: "async",
      text: "Question text",
    };
    expect(finalReport([question])).toBeUndefined();
    expect(
      finalReport([
        { id: "comment", type: "agentMessage", phase: "commentary", text: "Unfinished" },
      ]),
    ).toBeUndefined();
    expect(
      finalReport([
        { id: "report", type: "agentMessage", phase: "final_answer", text: "Completed" },
        question,
      ]),
    ).toBe("Completed");
  }),
);
