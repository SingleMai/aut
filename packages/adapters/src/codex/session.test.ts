import { readFileSync } from "node:fs";
import {
  AdapterError,
  BotId,
  type JsonValue,
  type SessionEvent,
  type StartSessionInput,
  TaskId,
} from "@aut/protocol";
import { it } from "@effect/vitest";
import { Effect, Fiber, Queue, Schema, Stream, Take } from "effect";
import { describe, expect } from "vitest";
import { makeCodexAdapter } from "./session.js";
import type { TransportFactory, TransportNotice } from "./transport.js";
import { decode, decodeLine, type RpcMessage, ThreadResult, TurnResult } from "./wire.js";

const Frame = Schema.Struct({ direction: Schema.String, payload: Schema.Unknown });
const expectedReports: Record<string, string> = {
  normal: "TEST_NORMAL_OK",
  default: "TOOL_UNAVAILABLE",
  "default-enabled": "TEST_ANSWER:Blue:Circle",
  "default-delayed": "TEST_ANSWER:Blue:Circle",
  plan: "TEST_ANSWER:Blue:Circle",
  "plan-free": "TEST_ANSWER:Teal fixture text:Circle",
  async: "TEST_ASYNC:Blue",
  "async-enabled": "TEST_ASYNC:Blue",
  "async-delayed": "TEST_ASYNC:Blue",
  "resume-persisted": "TEST_PERSISTED_RESUME_OK",
};
const fixtures = [
  "normal",
  "default",
  "default-enabled",
  "default-delayed",
  "plan",
  "plan-free",
  "async",
  "async-enabled",
  "async-delayed",
  "resume-persisted",
];
const rawFrames = (name: string) =>
  readFileSync(new URL(`../../../../spikes/codex/fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(Schema.parseJson(Frame))(line));
const input: StartSessionInput = {
  taskId: TaskId.make("adapter-test"),
  bot: {
    id: BotId.make("test-bot"),
    name: "Test",
    description: "Test worker",
    soul: "",
    modelSelection: { instanceId: "codex-test", model: "gpt-6.1-sol" },
    cwd: "/tmp",
  },
  model: "gpt-6.1-sol",
  cwd: "/tmp",
  instructions: "Synthetic fixture",
  mcpServers: [],
};

const setup = (
  name = "plan",
  steerOutcome: "steered" | "refused" | "indeterminate" = "steered",
  failures: {
    readonly start?: boolean;
    readonly answer?: boolean;
    readonly startPending?: boolean;
    readonly config?: boolean;
  } = {},
  sessionInput: StartSessionInput = input,
) =>
  Effect.gen(function* () {
    const frames = rawFrames(name);
    const wire = yield* Effect.forEach(
      frames.filter((frame) => ["send", "receive"].includes(frame.direction)),
      (frame) =>
        decodeLine(JSON.stringify(frame.payload)).pipe(
          Effect.map((message) => ({ direction: frame.direction, message })),
        ),
    );
    const exchange = (method: string) => {
      const call = wire.find(
        (frame) => frame.direction === "send" && frame.message.method === method,
      )?.message;
      return (
        wire.find(
          (frame) =>
            frame.direction === "receive" && frame.message.id === call?.id && !frame.message.method,
        )?.message.result ?? null
      );
    };
    const thread = yield* decode(
      ThreadResult,
      exchange(name === "resume-persisted" ? "thread/resume" : "thread/start"),
    );
    const turn = yield* decode(TurnResult, exchange("turn/start"));
    const notices = yield* Queue.unbounded<TransportNotice>();
    const sent: RpcMessage[] = [];
    let stopped = false;
    const requests: { method: string; params: JsonValue }[] = [];
    const factory: TransportFactory = {
      open: () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              stopped = true;
            }),
          );
          return {
            notices,
            send: (message) =>
              Effect.gen(function* () {
                sent.push(message);
                if (failures.answer && message.id !== undefined && message.result)
                  return yield* Effect.fail(
                    new AdapterError({ code: "TransportError", message: "Ambiguous answer write" }),
                  );
              }),
            stop: Effect.sync(() => {
              stopped = true;
            }),
            request: (method, params) =>
              Effect.suspend(() => {
                requests.push({ method, params });
                if (method === "turn/steer" && steerOutcome !== "steered")
                  return Effect.fail(
                    new AdapterError({
                      code: steerOutcome === "refused" ? "ProtocolError" : "TransportError",
                      message: steerOutcome,
                      ...(steerOutcome === "refused" ? { detail: { rpcCode: -32600 } } : {}),
                    }),
                  );
                if (["thread/start", "thread/resume", "thread/fork"].includes(method))
                  return Effect.succeed({ thread: { id: thread.thread.id } });
                if (method === "config/read" && failures.config)
                  return Effect.succeed({
                    config: { mcp_servers: "SYNTHETIC_CREDENTIAL_DO_NOT_LOG" },
                  });
                if (method === "config/read")
                  return Effect.succeed({
                    config: {
                      mcp_servers: {
                        "inherited.fixture": {
                          command: "inherited",
                          args: [],
                          env: { TEST_KEEP: "synthetic" },
                          tool_timeout_sec: null,
                          enabled_tools: null,
                        },
                        "fixture.with.dot": { command: "old-command", args: [] },
                      },
                    },
                  });
                if (method === "turn/steer") return Effect.succeed({ turnId: turn.turn.id });
                if (method === "turn/start" && failures.startPending) return Effect.never;
                if (method === "turn/start")
                  return failures.start
                    ? Effect.fail(
                        new AdapterError({ code: "TransportError", message: "Timed out" }),
                      )
                    : Effect.succeed(exchange("turn/start"));
                if (method === "thread/read") return Effect.succeed(exchange("thread/read"));
                if (method === "turn/interrupt")
                  return Queue.offer(notices, {
                    kind: "message",
                    message: {
                      method: "turn/completed",
                      params: {
                        threadId: thread.thread.id,
                        turn: { id: turn.turn.id, status: "interrupted", items: [] },
                      },
                    },
                  }).pipe(Effect.as({}));
                return Effect.succeed({});
              }),
          };
        }),
    };
    const adapter = makeCodexAdapter({}, factory);
    const session = yield* adapter.startSession(sessionInput);
    const events = yield* Stream.toQueue(session.events);
    yield* Effect.yieldNow();
    const next = Effect.gen(function* () {
      const take = yield* Queue.take(events);
      const chunk = yield* Take.done(take);
      return [...chunk];
    });
    const until = (kind: SessionEvent["kind"]) =>
      Effect.gen(function* () {
        const all: SessionEvent[] = [];
        while (!all.some((event) => event.kind === kind)) all.push(...(yield* next));
        return all;
      });
    const push = (message: RpcMessage) =>
      Queue.offer(notices, { kind: "message", message }).pipe(Effect.asVoid);
    const question = wire.find(
      (frame) =>
        frame.direction === "receive" &&
        (frame.message.method === "item/tool/requestUserInput" ||
          (frame.message.method === "item/completed" &&
            JSON.stringify(frame.message.params).includes('"delivery":"async"'))),
    )?.message;
    const completion = wire.find(
      (frame) => frame.direction === "receive" && frame.message.method === "turn/completed",
    )?.message;
    return {
      session,
      adapter,
      events,
      next,
      until,
      push,
      question,
      completion,
      wire,
      sent,
      requests,
      notices,
      threadId: thread.thread.id,
      turnId: turn.turn.id,
      isStopped: () => stopped,
    };
  });

describe("Codex P0 fixture replay", () => {
  for (const name of fixtures)
    it.scoped(`parses raw ${name} and normalizes its first complete turn`, () =>
      Effect.gen(function* () {
        const test = yield* setup(name);
        yield* test.session.startTurn({ text: "Replay", messageIds: [] });
        for (const frame of test.wire) {
          if (frame.direction !== "receive" || !frame.message.method) continue;
          const params = frame.message.params;
          if (params === null || typeof params !== "object" || Array.isArray(params)) continue;
          if (!JSON.stringify(params).includes(test.turnId)) continue;
          yield* test.push(frame.message);
          if (frame.message.method === "turn/completed") break;
        }
        const events = yield* test.until("turn.completed");
        const complete = events.find((event) => event.kind === "turn.completed");
        expect(complete).toMatchObject({
          ok: true,
          turnId: test.turnId,
          finalReport: expectedReports[name],
        });
        expect(events.some((event) => event.kind === "turn.failed")).toBe(false);
        expect(test.isStopped()).toBe(false);
        expect(
          test.sent.filter((message) => message.result && "answers" in Object(message.result)),
        ).toHaveLength(0);
      }),
    );
});

const openQuestion = (
  name = "plan",
  outcome: "steered" | "refused" | "indeterminate" = "steered",
  failures: {
    readonly start?: boolean;
    readonly answer?: boolean;
    readonly startPending?: boolean;
    readonly config?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const test = yield* setup(name, outcome, failures);
    yield* test.session.startTurn({ text: "Question", messageIds: [] });
    expect(test.question).toBeDefined();
    yield* test.push(test.question as RpcMessage);
    const events = yield* test.until("request.opened");
    const opened = events.find((event) => event.kind === "request.opened");
    if (opened?.kind !== "request.opened") return yield* Effect.die("Missing question fixture");
    const answer = {
      perQuestion: opened.request.questions.map((question) => ({
        questionId: question.id,
        optionIds: [question.options?.[0]?.id ?? "0"],
      })),
    };
    return { ...test, request: opened.request, answer };
  });

it.scoped("never accepts permission approval or incomplete/invalid question answers", () =>
  Effect.gen(function* () {
    const test = yield* openQuestion();
    for (const answer of [
      { allow: true as const },
      { perQuestion: [] },
      { perQuestion: test.answer.perQuestion.slice(0, 1) },
      {
        perQuestion: test.answer.perQuestion.map((entry) => ({ ...entry, optionIds: ["absent"] })),
      },
    ]) {
      const error = yield* test.session.respond(test.request.id, answer).pipe(Effect.flip);
      expect(error.code).toBe("InvalidAnswer");
    }
    expect(test.sent.filter((message) => message.id !== undefined)).toHaveLength(0);
    yield* test.session.respond(test.request.id, test.answer);
    expect(test.sent.at(-1)?.result).toEqual({
      answers: { probe_color: { answers: ["Blue"] }, probe_shape: { answers: ["Circle"] } },
    });
    const duplicate = yield* test.session.respond(test.request.id, test.answer).pipe(Effect.flip);
    expect(duplicate.code).toBe("InvalidAnswer");
  }),
);

it.scoped("expires unanswered requests when their native turn ends", () =>
  Effect.gen(function* () {
    const test = yield* openQuestion();
    yield* test.push(test.completion as RpcMessage);
    const events = yield* test.until("turn.completed");
    expect(events[0]).toMatchObject({ kind: "request.closed", reason: "turn-ended" });
    expect((yield* test.session.respond(test.request.id, test.answer).pipe(Effect.flip)).code).toBe(
      "RequestExpired",
    );
  }),
);

for (const outcome of ["steered", "refused", "indeterminate"] as const)
  it.scoped(`async answer ${outcome} preserves delivery certainty`, () =>
    Effect.gen(function* () {
      const test = yield* openQuestion("async", outcome);
      const result = yield* test.session.respond(test.request.id, test.answer).pipe(Effect.either);
      if (outcome === "steered") expect(result._tag).toBe("Right");
      else {
        expect(result._tag).toBe("Left");
        if (result._tag === "Left")
          expect(result.left.code).toBe(
            outcome === "refused" ? "RequestExpired" : "DeliveryIndeterminate",
          );
      }
      expect(test.requests.filter((call) => call.method === "turn/steer")).toHaveLength(1);
      if (outcome === "indeterminate") {
        expect(
          (yield* test.session.respond(test.request.id, test.answer).pipe(Effect.flip)).code,
        ).toBe("DeliveryIndeterminate");
        expect(test.requests.filter((call) => call.method === "turn/steer")).toHaveLength(1);
      }
    }),
  );

it.scoped("interrupt waits for a terminal result and leaves a healthy process alive", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    yield* test.session.startTurn({ text: "Run", messageIds: [] });
    yield* test.session.interrupt();
    const events = yield* test.until("turn.completed");
    expect(events.at(-1)).toEqual({
      kind: "turn.completed",
      turnId: test.turnId,
      ok: false,
      stopReason: "interrupted",
    });
    expect(test.isStopped()).toBe(false);
    yield* test.session.startTurn({ text: "Next", messageIds: [] });
  }),
);

it.scoped("rejects overlapping turns, unknown requests and stale request identities", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    yield* test.session.startTurn({ text: "Run", messageIds: [] });
    expect(
      (yield* test.session.startTurn({ text: "Again", messageIds: [] }).pipe(Effect.flip)).code,
    ).toBe("ProtocolError");
    yield* test.push({ id: "unknown", method: "future/tool", params: {} });
    yield* test.push({
      ...test.question,
      id: "stale",
      params: { threadId: "other-thread", turnId: test.turnId, questions: [] },
    });
    yield* test.push(test.completion as RpcMessage);
    yield* test.until("turn.completed");
    expect(
      test.sent.filter((message) => message.error).map((message) => message.error?.code),
    ).toEqual([-32601, -32000]);
  }),
);

it.scoped("audits automatic permission approval without treating it as a question", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    yield* test.session.startTurn({ text: "Run", messageIds: [] });
    yield* test.push({
      id: 77,
      method: "item/commandExecution/requestApproval",
      params: { threadId: test.threadId, turnId: test.turnId, command: "echo fixture" },
    });
    const events = yield* test.until("request.closed");
    expect(events[0]).toMatchObject({ kind: "request.opened", request: { kind: "permission" } });
    expect(test.sent.at(-1)).toEqual({ id: 77, result: { decision: "accept" } });
  }),
);

it.scoped("reports native failed turns without producing a successful report", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    yield* test.session.startTurn({ text: "Run", messageIds: [] });
    yield* test.push({
      method: "turn/completed",
      params: {
        threadId: test.threadId,
        turn: { id: test.turnId, status: "failed", error: { message: "fixture failure" } },
      },
    });
    expect((yield* test.until("turn.failed")).at(-1)).toEqual({
      kind: "turn.failed",
      turnId: test.turnId,
      error: "fixture failure",
    });
  }),
);

it.scoped("quarantines an ambiguously accepted start and never starts twice", () =>
  Effect.gen(function* () {
    const test = yield* setup("plan", "steered", { start: true });
    expect(
      (yield* test.session.startTurn({ text: "Start", messageIds: [] }).pipe(Effect.flip)).code,
    ).toBe("DeliveryIndeterminate");
    expect(test.isStopped()).toBe(true);
    expect(
      (yield* test.session.startTurn({ text: "Retry", messageIds: [] }).pipe(Effect.flip)).code,
    ).toBe("ProcessExited");
    expect(test.requests.filter((call) => call.method === "turn/start")).toHaveLength(1);
  }),
);

it.scoped("process exit closes native questions and prevents subsequent starts", () =>
  Effect.gen(function* () {
    const test = yield* openQuestion();
    yield* Queue.offer(test.notices, { kind: "exit", code: 9 });
    const events = yield* test.until("process.exited");
    expect(events.map((event) => event.kind)).toEqual([
      "request.closed",
      "turn.failed",
      "process.exited",
    ]);
    expect((yield* test.session.respond(test.request.id, test.answer).pipe(Effect.flip)).code).toBe(
      "RequestExpired",
    );
    expect(
      (yield* test.session.startTurn({ text: "Retry", messageIds: [] }).pipe(Effect.flip)).code,
    ).toBe("ProcessExited");
  }),
);

it.scoped("maps a free-text answer through the original native request id", () =>
  Effect.gen(function* () {
    const test = yield* openQuestion("plan-free");
    const question = test.request.questions[0];
    expect(question).toBeDefined();
    yield* test.session.respond(test.request.id, {
      perQuestion: test.request.questions.map((value) => ({
        questionId: value.id,
        text: "Teal fixture text",
      })),
    });
    expect(test.sent.at(-1)?.id).toBe(test.question?.id);
    expect(JSON.stringify(test.sent.at(-1)?.result)).toContain("Teal fixture text");
  }),
);

it.scoped("uses full native access and the configured model without switching to Plan", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    yield* test.session.startTurn({ text: "Run", messageIds: [] });
    expect(test.requests.find((call) => call.method === "thread/start")?.params).toMatchObject({
      model: input.model,
      cwd: input.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const params = test.requests.find((call) => call.method === "turn/start")?.params;
    expect(params).toMatchObject({
      model: input.model,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    expect(params).not.toHaveProperty("collaborationMode");
  }),
);

it.scoped("does not resend a synchronous answer after an ambiguous write", () =>
  Effect.gen(function* () {
    const test = yield* openQuestion("plan", "steered", { answer: true });
    expect((yield* test.session.respond(test.request.id, test.answer).pipe(Effect.flip)).code).toBe(
      "DeliveryIndeterminate",
    );
    expect((yield* test.session.respond(test.request.id, test.answer).pipe(Effect.flip)).code).toBe(
      "DeliveryIndeterminate",
    );
    expect(test.sent.filter((message) => message.result !== undefined)).toHaveLength(1);
    yield* test.push(test.completion as RpcMessage);
    expect((yield* test.until("turn.completed"))[0]).toMatchObject({ kind: "request.closed" });
  }),
);

it.scoped("native serverRequest/resolved prevents a late answer before the turn ends", () =>
  Effect.gen(function* () {
    const test = yield* openQuestion();
    yield* test.push({
      method: "serverRequest/resolved",
      params: { threadId: test.threadId, requestId: test.question?.id ?? 0 },
    });
    expect((yield* test.until("request.closed")).at(-1)).toMatchObject({
      kind: "request.closed",
      reason: "cancelled",
    });
    expect((yield* test.session.respond(test.request.id, test.answer).pipe(Effect.flip)).code).toBe(
      "RequestExpired",
    );
    expect(test.sent.filter((message) => message.result !== undefined)).toHaveLength(0);
  }),
);

it.scoped("deduplicates repeated native question notifications", () =>
  Effect.gen(function* () {
    const test = yield* openQuestion();
    yield* test.push(test.question as RpcMessage);
    yield* test.push(test.completion as RpcMessage);
    const events = yield* test.until("turn.completed");
    expect(events.filter((event) => event.kind === "request.opened")).toHaveLength(0);
    expect(events.filter((event) => event.kind === "request.closed")).toHaveLength(1);
  }),
);

it.scoped("grants only the declared native permission profile and omits null grants", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    yield* test.session.startTurn({ text: "Run", messageIds: [] });
    yield* test.push({
      id: 78,
      method: "item/permissions/requestApproval",
      params: {
        threadId: test.threadId,
        turnId: test.turnId,
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    });
    yield* test.until("request.closed");
    expect(test.sent.at(-1)?.result).toEqual({
      permissions: { network: { enabled: true } },
      scope: "turn",
    });
  }),
);

it.scoped("rejects malformed permission requests instead of granting them", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    yield* test.session.startTurn({ text: "Run", messageIds: [] });
    yield* test.push({
      id: 79,
      method: "item/permissions/requestApproval",
      params: { threadId: test.threadId, turnId: test.turnId, permissions: "full" },
    });
    yield* test.push(test.completion as RpcMessage);
    const events = yield* test.until("turn.completed");
    expect(events.filter((event) => event.kind === "request.opened")).toHaveLength(0);
    expect(test.sent.at(-1)?.error?.code).toBe(-32602);
  }),
);

it.scoped("failed session acquisition releases its child Scope immediately", () =>
  Effect.gen(function* () {
    let released = false;
    const factory: TransportFactory = {
      open: () =>
        Effect.gen(function* () {
          const notices = yield* Queue.unbounded<TransportNotice>();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              released = true;
            }),
          );
          return {
            notices,
            request: () =>
              Effect.fail(
                new AdapterError({ code: "TransportError", message: "initialize failed" }),
              ),
            send: () => Effect.void,
            stop: Effect.void,
          };
        }),
    };
    const adapter = makeCodexAdapter({}, factory);
    expect((yield* adapter.startSession(input).pipe(Effect.flip)).message).toBe(
      "initialize failed",
    );
    expect(released).toBe(true);
  }),
);

it.scoped("cancelling an in-flight start closes the session to avoid orphaned work", () =>
  Effect.gen(function* () {
    const test = yield* setup("plan", "steered", { startPending: true });
    const fiber = yield* test.session.startTurn({ text: "Run", messageIds: [] }).pipe(Effect.fork);
    yield* Effect.yieldNow();
    yield* Fiber.interrupt(fiber);
    expect(test.isStopped()).toBe(true);
    expect(
      (yield* test.session.startTurn({ text: "Again", messageIds: [] }).pipe(Effect.flip)).code,
    ).toBe("ProcessExited");
  }),
);

it.scoped("encodes per-thread MCP tables without splitting names or changing Provider", () =>
  Effect.gen(function* () {
    const test = yield* setup(
      "normal",
      "steered",
      {},
      {
        ...input,
        mcpServers: [
          {
            name: "fixture.with.dot",
            transport: "stdio",
            command: "node",
            args: ["fixture.js"],
            env: { FIXTURE: "1" },
          },
          {
            name: "http-fixture",
            transport: "http",
            url: "http://127.0.0.1:1234/mcp",
            headers: { "X-Fixture": "1" },
          },
        ],
      },
    );
    expect(test.requests.find((call) => call.method === "thread/start")?.params).toMatchObject({
      config: {
        mcp_servers: {
          "fixture.with.dot": { command: "node", args: ["fixture.js"], env: { FIXTURE: "1" } },
          "http-fixture": { url: "http://127.0.0.1:1234/mcp", http_headers: { "X-Fixture": "1" } },
        },
      },
    });
    expect(test.requests.find((call) => call.method === "thread/start")?.params).toHaveProperty(
      ["config", "mcp_servers", "inherited.fixture"],
      { command: "inherited", args: [], env: { TEST_KEEP: "synthetic" } },
    );
    expect(
      test.requests.some(
        (call) => call.method.startsWith("config/") && call.method !== "config/read",
      ),
    ).toBe(false);
    expect(test.requests.find((call) => call.method === "thread/start")?.params).not.toHaveProperty(
      "modelProvider",
    );
  }),
);

it.scoped("does not include configuration values in parsing errors", () =>
  Effect.gen(function* () {
    const error = yield* setup(
      "normal",
      "steered",
      { config: true },
      {
        ...input,
        mcpServers: [{ name: "fixture", transport: "stdio", command: "node", args: [] }],
      },
    ).pipe(Effect.flip);
    expect(error.code).toBe("InvalidResponse");
    expect(error.message).not.toContain("SYNTHETIC_CREDENTIAL_DO_NOT_LOG");
  }),
);
