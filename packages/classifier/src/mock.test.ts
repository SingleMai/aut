import { readFileSync } from "node:fs";
import { ClassifierError, DecisionRequest } from "@aut/protocol";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { JEV_MODEL, parseJevResponse } from "./jev.js";
import { makeMockClassifier } from "./mock.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/batch-zh.json", import.meta.url), "utf8"),
) as { request: unknown; response: unknown };
const request = Schema.decodeUnknownSync(DecisionRequest)(fixture.request);

it("consumes deterministic fixtures in order and fails instead of guessing", async () => {
  const response = await Effect.runPromise(
    parseJevResponse(fixture.response, request, JEV_MODEL, 0),
  );
  const error = new ClassifierError({ code: "RateLimited", message: "Synthetic rate limit." });
  const classifier = await Effect.runPromise(
    makeMockClassifier([
      { request, response },
      { request, error },
    ]),
  );
  expect(await Effect.runPromise(classifier.decide(request))).toEqual(response);
  const failed = await Effect.runPromise(Effect.either(classifier.decide(request)));
  expect(failed._tag === "Left" && failed.left.code).toBe("RateLimited");
  const exhausted = await Effect.runPromise(Effect.either(classifier.decide(request)));
  expect(exhausted._tag === "Left" && exhausted.left.code).toBe("InvalidResponse");
});

it("rejects unmatched requests without providing fallback answers", async () => {
  const response = await Effect.runPromise(
    parseJevResponse(fixture.response, request, JEV_MODEL, 0),
  );
  const classifier = await Effect.runPromise(makeMockClassifier([{ request, response }]));
  const failed = await Effect.runPromise(
    Effect.either(classifier.decide({ ...request, state: "Different state" })),
  );
  expect(failed._tag === "Left" && failed.left.code).toBe("InvalidResponse");
});
