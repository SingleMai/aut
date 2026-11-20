import { readFileSync } from "node:fs";
import { JsonValue } from "@aut/protocol";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { decode, finalReport, ItemNotification, NativeRequest } from "./wire.js";

const Fixture = Schema.Struct({
  cli: Schema.Literal("codex-cli"),
  version: Schema.Literal("0.169.0"),
  requests: Schema.Array(
    Schema.Struct({
      kind: Schema.Literal("question"),
      raw: Schema.Struct({
        method: Schema.String,
        id: Schema.NullOr(Schema.Int),
        params: JsonValue,
      }),
    }),
  ),
});
const fixture = Schema.decodeUnknownSync(Schema.parseJson(Fixture))(
  readFileSync(
    new URL("../../../../spikes/codex/fixtures/questions-0.169.0.json", import.meta.url),
    "utf8",
  ),
);

it.effect("accepts the CLI 0.169.0 recorded native request and preserves both question IDs", () =>
  Effect.gen(function* () {
    const raw = fixture.requests.find(
      (entry) => entry.raw.method === "item/tool/requestUserInput",
    )?.raw;
    expect(raw?.id).toBe(0);
    const request = yield* decode(NativeRequest, raw?.params);
    expect(request.questions.map((question) => question.id)).toEqual([
      "probe_color",
      "probe_shape",
    ]);
    expect(
      request.questions.map((question) => question.options?.map((option) => option.label)),
    ).toEqual([
      ["Blue", "Red"],
      ["Circle", "Square"],
    ]);
  }),
);

it.effect("accepts the CLI 0.169.0 recorded async item without treating it as a final report", () =>
  Effect.gen(function* () {
    const raw = fixture.requests.find((entry) => entry.raw.method === "item/completed")?.raw;
    expect(raw?.id).toBeNull();
    const notification = yield* decode(ItemNotification, raw?.params);
    expect(notification.item.delivery).toBe("async");
    expect(notification.item.phase).toBe("final_answer");
    expect(notification.item.questions).toEqual([
      { title: "Which fixture color?", options: ["Blue", "Red"] },
    ]);
    expect(finalReport([notification.item])).toBeUndefined();
  }),
);
