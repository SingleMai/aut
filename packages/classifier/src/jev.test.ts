import { readFileSync } from "node:fs";
import { DecisionRequest } from "@aut/protocol";
import { it as effectIt } from "@effect/vitest";
import { Effect, Fiber, Redacted, Schema, TestClock } from "effect";
import { describe, expect, it, vi } from "vitest";
import { Classifier } from "./interface.js";
import {
  JEV_MODEL,
  JevConfig,
  makeJev,
  makeJevLayer,
  parseJevResponse,
  validateJevRequest,
} from "./jev.js";

const recorded = JSON.parse(
  readFileSync(new URL("../fixtures/batch-zh.json", import.meta.url), "utf8"),
) as {
  source: string;
  model: string;
  request: unknown;
  response: unknown;
};
const single = JSON.parse(
  readFileSync(new URL("../fixtures/single-option.json", import.meta.url), "utf8"),
) as typeof recorded;
const request = Schema.decodeUnknownSync(DecisionRequest)(recorded.request);
const apiKey = Redacted.make("unit-test-secret");
const jsonResponse = (body: unknown = recorded.response) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const cloneBody = (): {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  usage: { input_tokens: number; output_tokens: number };
} => JSON.parse(JSON.stringify(recorded.response));
const errorCode = (result: { readonly _tag: string; readonly left?: { readonly code: string } }) =>
  result.left?.code;

describe("recorded Jev protocol", () => {
  it.each([recorded, single])("normalizes a real $model response", async (fixture) => {
    expect(fixture.source).toBe("live-typesafe-api");
    const result = await Effect.runPromise(
      parseJevResponse(
        fixture.response,
        Schema.decodeUnknownSync(DecisionRequest)(fixture.request),
        JEV_MODEL,
        42,
      ),
    );
    expect(result.latencyMs).toBe(42);
    expect(result.answers.route).toMatchObject({
      type: "choice",
      choice: "research",
      confidence: 1,
    });
  });

  it("preserves score probabilities and input-token usage", async () => {
    const result = await Effect.runPromise(
      parseJevResponse(recorded.response, request, JEV_MODEL, 42),
    );
    expect(result.answers.detail).toEqual({
      type: "score",
      score: 0,
      probabilities: { "0": 1, "1": 0, "2": 0 },
    });
    expect(result.usage?.inputTokens).toBe(424);
  });

  it("uses selected probability instead of synthetic vendor concentration", async () => {
    const body = cloneBody();
    body.answers.route = {
      type: "choice",
      choice: "research",
      confidence: 0.4,
      probabilities: { research: 0.6, coding: 0.3, general: 0.1 },
    };
    const result = await Effect.runPromise(parseJevResponse(body, request, JEV_MODEL, 0));
    expect(result.answers.route).toMatchObject({ confidence: 0.6 });
  });

  it.each([
    [
      "wrong model",
      (body: ReturnType<typeof cloneBody>) => {
        body.model = "jev-latest";
      },
    ],
    [
      "missing answer",
      (body: ReturnType<typeof cloneBody>) => {
        delete body.answers.urgent;
      },
    ],
    [
      "extra answer",
      (body: ReturnType<typeof cloneBody>) => {
        body.answers.extra = { type: "noul", noul: 0.5 };
      },
    ],
    [
      "wrong type",
      (body: ReturnType<typeof cloneBody>) => {
        body.answers.urgent = { type: "score", score: 1 };
      },
    ],
    [
      "unknown choice",
      (body: ReturnType<typeof cloneBody>) => {
        body.answers.route = {
          type: "choice",
          choice: "unknown",
          confidence: 1,
          probabilities: { unknown: 1 },
        };
      },
    ],
    [
      "non-top choice",
      (body: ReturnType<typeof cloneBody>) => {
        body.answers.route = {
          type: "choice",
          choice: "coding",
          confidence: 0.4,
          probabilities: { research: 0.6, coding: 0.3, general: 0.1 },
        };
      },
    ],
    [
      "incomplete distribution",
      (body: ReturnType<typeof cloneBody>) => {
        body.answers.route = {
          type: "choice",
          choice: "research",
          confidence: 1,
          probabilities: { research: 1 },
        };
      },
    ],
    [
      "invalid sum",
      (body: ReturnType<typeof cloneBody>) => {
        body.answers.route = {
          type: "choice",
          choice: "research",
          confidence: 1,
          probabilities: { research: 1, coding: 1, general: 1 },
        };
      },
    ],
    [
      "invalid noul",
      (body: ReturnType<typeof cloneBody>) => {
        body.answers.urgent = { type: "noul", noul: 1.1 };
      },
    ],
    [
      "score outside rubric",
      (body: ReturnType<typeof cloneBody>) => {
        const answer = body.answers.detail;
        if (answer) answer.score = 3;
      },
    ],
    [
      "wrong legend",
      (body: ReturnType<typeof cloneBody>) => {
        const answer = body.answers.detail;
        if (answer) answer.legend = { "0": "Wrong" };
      },
    ],
    [
      "invalid token count",
      (body: ReturnType<typeof cloneBody>) => {
        body.usage.input_tokens = -1;
      },
    ],
  ])("rejects synthetic %s corruption of a recorded response", async (_name, mutate) => {
    const body = cloneBody();
    mutate(body);
    const result = await Effect.runPromise(
      Effect.either(parseJevResponse(body, request, JEV_MODEL, 0)),
    );
    expect(errorCode(result)).toBe("InvalidResponse");
  });

  it("accepts rounded distributions without rewriting their probabilities", async () => {
    const body = cloneBody();
    body.answers.route = {
      type: "choice",
      choice: "research",
      confidence: 0,
      probabilities: { research: 0.33, coding: 0.33, general: 0.33 },
    };
    const result = await Effect.runPromise(parseJevResponse(body, request, JEV_MODEL, 0));
    expect(result.answers.route).toMatchObject({
      confidence: 0.33,
      probabilities: { research: 0.33, coding: 0.33, general: 0.33 },
    });
  });
});

describe("request and configuration validation", () => {
  it("validates the current choice and score limits before transport", async () => {
    for (const count of [1, 255]) {
      const candidate = Schema.decodeUnknownSync(DecisionRequest)({
        state: "x",
        questions: {
          choice: {
            type: "choice",
            instructions: "Choose.",
            criteria: Object.fromEntries(
              Array.from({ length: count }, (_, index) => [`o${index}`, "Option"]),
            ),
          },
        },
      });
      expect((await Effect.runPromise(Effect.either(validateJevRequest(candidate))))._tag).toBe(
        "Right",
      );
    }
    for (const question of [
      {
        type: "choice",
        instructions: "Choose.",
        criteria: Object.fromEntries(
          Array.from({ length: 256 }, (_, index) => [`o${index}`, "Option"]),
        ),
      },
      { type: "score", instructions: "Rate.", criteria: Array.from({ length: 11 }, () => "Level") },
    ]) {
      const candidate = Schema.decodeUnknownSync(DecisionRequest)({
        state: "x",
        questions: { q: question },
      });
      expect(errorCode(await Effect.runPromise(Effect.either(validateJevRequest(candidate))))).toBe(
        "InvalidResponse",
      );
    }
  });

  it.each(["jev-latest", "jev-preview", "jev-1.14"])(
    "rejects drifting or incomplete model %s",
    async (model) => {
      expect(
        errorCode(await Effect.runPromise(Effect.either(makeJev({ apiKey, config: { model } })))),
      ).toBe("NotConfigured");
    },
  );

  it.each([
    "http://example.com/v1/systemone",
    "https://user:password@example.com",
    "https://example.com?key=secret",
  ])("rejects unsafe key destinations %s", async (endpoint) => {
    expect(
      errorCode(await Effect.runPromise(Effect.either(makeJev({ apiKey, config: { endpoint } })))),
    ).toBe("NotConfigured");
  });

  it("allows configured local HTTP and requires a nonempty key", async () => {
    const classifier = await Effect.runPromise(
      makeJev({ apiKey, config: { endpoint: "http://127.0.0.1:9000/v1/systemone" } }),
    );
    expect(classifier.model).toBe(JEV_MODEL);
    expect(
      errorCode(await Effect.runPromise(Effect.either(makeJev({ apiKey: Redacted.make("") })))),
    ).toBe("NotConfigured");
    expect(
      Schema.decodeUnknownEither(JevConfig)({
        endpoint: "https://api.typesafe.ai/v1/systemone",
        model: JEV_MODEL,
        timeoutMs: 0,
        maxRetries: 1,
        retryDelayMs: 100,
      })._tag,
    ).toBe("Left");
  });
});

describe("Effect HTTP lifecycle", () => {
  it("sends every question in one request through the Layer", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse());
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const classifier = yield* Classifier;
        return yield* classifier.decide(request);
      }).pipe(Effect.provide(makeJevLayer({ apiKey, fetch }))),
    );
    expect(result.answers.route).toMatchObject({ choice: "research" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ model: JEV_MODEL, ...request });
    expect(init?.signal?.aborted).toBe(true);
  });

  it.each([
    [400, "TransportError"],
    [401, "NotConfigured"],
    [403, "NotConfigured"],
    [413, "TransportError"],
    [422, "TransportError"],
  ] as const)(
    "reports HTTP %s as %s without retrying or retaining the sensitive body",
    async (status, code) => {
      const json = vi.fn();
      const response = new Response("unit-test-secret user message", { status });
      Object.defineProperty(response, "json", { value: json });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      const classifier = await Effect.runPromise(makeJev({ apiKey, fetch }));
      const result = await Effect.runPromise(Effect.either(classifier.decide(request)));
      expect(errorCode(result)).toBe(code);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(json).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("unit-test-secret");
    },
  );

  effectIt.effect("retries a 429 after Retry-After within the same total budget", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0.2" } }))
        .mockResolvedValueOnce(jsonResponse());
      const classifier = yield* makeJev({ apiKey, fetch });
      const fiber = yield* Effect.fork(classifier.decide(request));
      yield* TestClock.adjust("199 millis");
      expect(fetch).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust("1 millis");
      const result = yield* Fiber.join(fiber);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result.latencyMs).toBe(200);
    }),
  );

  effectIt.effect("honors a configured total budget longer than the default", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "2" } }))
        .mockResolvedValueOnce(jsonResponse());
      const classifier = yield* makeJev({ apiKey, fetch, config: { timeoutMs: 3_000 } });
      const fiber = yield* Effect.fork(classifier.decide(request));
      yield* TestClock.adjust("1500 millis");
      expect(fetch).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust("500 millis");
      const result = yield* Fiber.join(fiber);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result.latencyMs).toBe(2_000);
    }),
  );

  effectIt.effect("returns the final 5xx error after bounded retries", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() => Promise.resolve(new Response("", { status: 503 })));
      const classifier = yield* makeJev({ apiKey, fetch });
      const fiber = yield* Effect.fork(Effect.either(classifier.decide(request)));
      yield* TestClock.adjust("100 millis");
      const result = yield* Fiber.join(fiber);
      expect(errorCode(result)).toBe("TransportError");
      expect(fetch).toHaveBeenCalledTimes(2);
    }),
  );

  effectIt.effect("aborts stalled response-body reading at the total deadline", () =>
    Effect.gen(function* () {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
        const response = new Response("");
        Object.defineProperty(response, "json", { value: () => new Promise(() => {}) });
        return Promise.resolve(response);
      });
      const classifier = yield* makeJev({ apiKey, fetch });
      const fiber = yield* Effect.fork(Effect.either(classifier.decide(request)));
      yield* TestClock.adjust("1500 millis");
      const result = yield* Fiber.join(fiber);
      expect(errorCode(result)).toBe("Timeout");
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    }),
  );

  effectIt.effect("aborts transport when the caller interrupts the decision fiber", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() => new Promise(() => {}));
      const classifier = yield* makeJev({ apiKey, fetch });
      const fiber = yield* Effect.fork(classifier.decide(request));
      yield* TestClock.adjust("1 millis");
      yield* Fiber.interrupt(fiber);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    }),
  );

  effectIt.effect("preserves RateLimited after the final retry", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() => Promise.resolve(new Response("", { status: 429 })));
      const classifier = yield* makeJev({ apiKey, fetch });
      const fiber = yield* Effect.fork(Effect.either(classifier.decide(request)));
      yield* TestClock.adjust("100 millis");
      expect(errorCode(yield* Fiber.join(fiber))).toBe("RateLimited");
      expect(fetch).toHaveBeenCalledTimes(2);
    }),
  );

  effectIt.effect("does not let Retry-After exceed the total deadline", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "30" } }));
      const classifier = yield* makeJev({ apiKey, fetch });
      const fiber = yield* Effect.fork(Effect.either(classifier.decide(request)));
      yield* TestClock.adjust("1500 millis");
      expect(errorCode(yield* Fiber.join(fiber))).toBe("Timeout");
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );

  it("returns typed errors for transport failures and malformed JSON", async () => {
    for (const [fetch, code] of [
      [
        vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("unit-test-secret")),
        "TransportError",
      ],
      [
        vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(new Response("invalid JSON unit-test-secret")),
        "InvalidResponse",
      ],
    ] as const) {
      const classifier = await Effect.runPromise(makeJev({ apiKey, fetch }));
      const result = await Effect.runPromise(Effect.either(classifier.decide(request)));
      expect(errorCode(result)).toBe(code);
      expect(JSON.stringify(result)).not.toContain("unit-test-secret");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});

it.skipIf(process.env.AUT_RUN_JEV_SMOKE !== "1" || !process.env.TYPESAFE_API_KEY)(
  "runs the opt-in real Jev Layer smoke",
  async () => {
    const classifier = await Effect.runPromise(
      makeJev({ apiKey: Redacted.make(process.env.TYPESAFE_API_KEY ?? "") }),
    );
    const result = await Effect.runPromise(classifier.decide(request));
    expect(result.answers.route).toMatchObject({ choice: "research" });
  },
);
