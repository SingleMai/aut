import {
  AdapterError,
  BotId,
  type SessionEvent,
  type StartSessionInput,
  TaskId,
} from "@aut/protocol";
import { it } from "@effect/vitest";
import { Deferred, Effect, Queue, Stream, Take } from "effect";
import { describe, expect } from "vitest";
import { makeAcpAdapter } from "./session.js";
import type { AcpTransportFactory, AcpTransportNotice } from "./transport.js";
import type { RpcMessage } from "./wire.js";

const input: StartSessionInput = {
  taskId: TaskId.make("acp-test-task"),
  bot: {
    id: BotId.make("acp-test-bot"),
    name: "ACP test",
    description: "ACP fixture",
    soul: "",
    modelSelection: { instanceId: "acp-fixture", model: "fixture-model" },
    cwd: "/tmp",
    mcpServers: [],
  },
  model: "fixture-model",
  cwd: "/tmp",
  instructions: "You are a test worker.",
  mcpServers: [],
};

type Mode = "normal" | "question" | "grok" | "mismatch" | "model" | "auth" | "hang";

const makeFactory = (mode: Mode = "normal") => {
  const sent: RpcMessage[] = [];
  const methods: string[] = [];
  const requestParams: Array<{ readonly method: string; readonly params: unknown }> = [];
  const stopped: boolean[] = [];
  let notices: Queue.Queue<AcpTransportNotice> | undefined;
  let answer: Deferred.Deferred<void> | undefined;
  const factory: AcpTransportFactory = {
    open: () =>
      Effect.gen(function* () {
        notices = yield* Queue.unbounded<AcpTransportNotice>();
        answer = yield* Deferred.make<void>();
        const currentNotices = notices;
        const currentAnswer = answer;
        const sessionId = "acp-fixture-session";
        const send = (message: RpcMessage) =>
          Effect.gen(function* () {
            sent.push(message);
            if ((message.id === 42 || message.id === 43) && message.result !== undefined)
              yield* Deferred.succeed(currentAnswer, undefined);
            if (message.method === "session/cancel") {
              yield* Deferred.succeed(currentAnswer, undefined);
              yield* Queue.offer(currentNotices, { kind: "exit", code: null });
            }
          });
        const request = (method: string, _params: unknown) => {
          methods.push(method);
          requestParams.push({ method, params: _params });
          if (method === "initialize")
            return Effect.succeed({
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
              ...(mode === "auth" ? { authMethods: [{ id: "other" }, { id: "grok.com" }] } : {}),
            });
          if (method === "authenticate")
            return mode === "auth"
              ? Effect.succeed({ authenticated: true })
              : Effect.fail(
                  new AdapterError({ code: "ProtocolError", message: "Unexpected authenticate" }),
                );
          if (method === "session/new")
            return mode === "model"
              ? Effect.succeed({
                  sessionId,
                  configOptions: [
                    {
                      id: "model",
                      category: "model",
                      type: "select",
                      currentValue: "other-model",
                      options: [
                        { value: "fixture-model", name: "Fixture" },
                        { value: "other-model", name: "Other" },
                      ],
                    },
                  ],
                })
              : Effect.succeed({ sessionId });
          if (method === "session/load" || method === "session/resume")
            return Effect.succeed({ sessionId });
          if (method === "session/set_config_option")
            return Effect.succeed({
              configOptions: [
                {
                  id: "model",
                  category: "model",
                  type: "select",
                  currentValue: "fixture-model",
                  options: [{ value: "fixture-model", name: "Fixture" }],
                },
              ],
            });
          if (method === "session/prompt") {
            if (mode === "normal")
              return Queue.offer(currentNotices, {
                kind: "message",
                message: {
                  method: "session/update",
                  params: {
                    sessionId,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "fixture answer" },
                    },
                  },
                },
              }).pipe(Effect.zipRight(Effect.yieldNow()), Effect.as({ stopReason: "end_turn" }));
            if (mode === "mismatch")
              return Queue.offer(currentNotices, {
                kind: "message",
                message: {
                  method: "session/update",
                  params: {
                    sessionId: "another-acp-session",
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "wrong session" },
                    },
                  },
                },
              }).pipe(
                Effect.zipRight(
                  Queue.offer(currentNotices, {
                    kind: "message",
                    message: {
                      method: "session/update",
                      params: {
                        sessionId,
                        update: {
                          sessionUpdate: "agent_message_chunk",
                          content: { type: "text", text: "fixture answer" },
                        },
                      },
                    },
                  }),
                ),
                Effect.zipRight(Effect.yieldNow()),
                Effect.as({ stopReason: "end_turn" }),
              );
            if (mode === "question") {
              return Queue.offer(currentNotices, {
                kind: "message",
                message: {
                  id: 42,
                  method: "session/request_permission",
                  params: {
                    toolCall: {
                      toolCallId: "interaction_fixture",
                      title: "Choose a color",
                    },
                    options: [
                      { optionId: "blue", kind: "select", name: "Blue" },
                      { optionId: "red", kind: "select", name: "Red" },
                    ],
                  },
                },
              }).pipe(
                Effect.zipRight(Deferred.await(currentAnswer)),
                Effect.as({ stopReason: "end_turn" }),
              );
            }
            if (mode === "grok") {
              return Queue.offer(currentNotices, {
                kind: "message",
                message: {
                  id: 43,
                  method: "_x.ai/ask_user_question",
                  params: {
                    questions: [
                      {
                        question: "Which color?",
                        options: ["Blue", "Red"],
                        multi_select: false,
                      },
                      { question: "Anything else?", options: [] },
                    ],
                  },
                },
              }).pipe(
                Effect.zipRight(Deferred.await(currentAnswer)),
                Effect.as({ stopReason: "end_turn" }),
              );
            }
            return Deferred.await(currentAnswer).pipe(Effect.as({ stopReason: "cancelled" }));
          }
          return Effect.fail(
            new AdapterError({ code: "ProtocolError", message: `Unexpected ${method}` }),
          );
        };
        return {
          notices: currentNotices,
          request,
          send,
          stop: Effect.sync(() => {
            stopped.push(true);
          }),
        };
      }),
  };
  return {
    factory,
    sent,
    methods,
    requestParams,
    stopped,
    notices: () => {
      if (!notices) throw new Error("ACP test transport has not been opened");
      return notices;
    },
  };
};

const nextEvents = (queue: Queue.Dequeue<Take.Take<SessionEvent>>) =>
  Effect.gen(function* () {
    return yield* Take.done(yield* Queue.take(queue));
  });

const until = (queue: Queue.Dequeue<Take.Take<SessionEvent>>, kind: SessionEvent["kind"]) =>
  Effect.gen(function* () {
    const events: SessionEvent[] = [];
    while (!events.some((event) => event.kind === kind)) {
      const chunk = yield* nextEvents(queue);
      events.push(...chunk);
    }
    return events;
  });

describe("ACP adapter", () => {
  it.scoped("maps session updates to the common turn and transcript events", () =>
    Effect.gen(function* () {
      const test = makeFactory();
      const session = yield* makeAcpAdapter({}, test.factory).startSession(input);
      const events = yield* Stream.toQueue(session.events);
      yield* Effect.yieldNow();
      yield* session.startTurn({ text: "Say hello", messageIds: [] });
      const received = yield* until(events, "turn.completed");
      expect(received).toContainEqual(expect.objectContaining({ kind: "turn.started" }));
      expect(received).toContainEqual(
        expect.objectContaining({ kind: "message.delta", text: "fixture answer" }),
      );
      expect(received).toContainEqual(
        expect.objectContaining({
          kind: "turn.completed",
          ok: true,
          finalReport: "fixture answer",
        }),
      );
      expect((yield* session.transcript()).map((entry) => entry.role)).toEqual([
        "user",
        "assistant",
      ]);
    }),
  );

  it.scoped("ignores updates belonging to another ACP session", () =>
    Effect.gen(function* () {
      const test = makeFactory("mismatch");
      const session = yield* makeAcpAdapter({}, test.factory).startSession(input);
      const events = yield* Stream.toQueue(session.events);
      yield* Effect.yieldNow();
      yield* session.startTurn({ text: "Say hello", messageIds: [] });
      const received = yield* until(events, "turn.completed");
      expect(received.filter((event) => event.kind === "message.delta")).toEqual([
        expect.objectContaining({ text: "fixture answer" }),
      ]);
    }),
  );

  it.scoped("applies an advertised model config before the first turn", () =>
    Effect.gen(function* () {
      const test = makeFactory("model");
      yield* makeAcpAdapter({}, test.factory).startSession(input);
      expect(test.methods).toContain("session/set_config_option");
    }),
  );

  it.scoped("authenticates with the first configured method advertised by ACP", () =>
    Effect.gen(function* () {
      const test = makeFactory("auth");
      yield* makeAcpAdapter(
        { authMethodIds: ["cached_token", "grok.com"] },
        test.factory,
      ).startSession(input);
      expect(test.methods.slice(0, 3)).toEqual(["initialize", "authenticate", "session/new"]);
      expect(test.requestParams[1]).toEqual({
        method: "authenticate",
        params: { methodId: "grok.com" },
      });
    }),
  );

  it.scoped("auto-approves ACP permissions and exposes interaction questions", () =>
    Effect.gen(function* () {
      const test = makeFactory("question");
      const session = yield* makeAcpAdapter({}, test.factory).startSession(input);
      const events = yield* Stream.toQueue(session.events);
      yield* Effect.yieldNow();
      yield* session.startTurn({ text: "Ask", messageIds: [] });
      const opened = yield* until(events, "request.opened");
      const request = opened.find((event) => event.kind === "request.opened");
      if (request?.kind !== "request.opened") return yield* Effect.die("missing question");
      const question = request.request.questions[0];
      if (!question) return yield* Effect.die("missing question options");
      yield* session.respond(request.request.id, {
        perQuestion: [{ questionId: question.id, optionIds: ["blue"] }],
      });
      expect(test.sent).toContainEqual({
        id: 42,
        result: { outcome: { outcome: "selected", optionId: "blue" } },
      });
      expect(
        (yield* until(events, "turn.completed")).some((event) => event.kind === "turn.completed"),
      ).toBe(true);
    }),
  );

  it.scoped("maps Grok's ACP question extension without auto-answering it", () =>
    Effect.gen(function* () {
      const test = makeFactory("grok");
      const session = yield* makeAcpAdapter({}, test.factory).startSession(input);
      const events = yield* Stream.toQueue(session.events);
      yield* Effect.yieldNow();
      yield* session.startTurn({ text: "Ask two questions", messageIds: [] });
      const opened = yield* until(events, "request.opened");
      const request = opened.find((event) => event.kind === "request.opened");
      if (request?.kind !== "request.opened") return yield* Effect.die("missing Grok question");
      yield* session.respond(request.request.id, {
        perQuestion: [
          { questionId: "question-0", optionIds: ["option-0-0"] },
          { questionId: "question-1", text: "A fixture note" },
        ],
      });
      expect(test.sent).toContainEqual({
        id: 43,
        result: {
          outcome: "accepted",
          answers: { "Which color?": ["Blue"], "Anything else?": ["Other"] },
          annotations: { "Anything else?": { notes: "A fixture note" } },
        },
      });
    }),
  );

  it.scoped("resumes a saved cursor with the configured ACP method", () =>
    Effect.gen(function* () {
      const test = makeFactory();
      const adapter = makeAcpAdapter({ resumeMethod: "resume" }, test.factory);
      const session = yield* adapter.resumeSession(
        { kind: "acp", data: { sessionId: "saved-session" } },
        input,
      );
      expect(session.cursor).toEqual({ kind: "acp", data: { sessionId: "saved-session" } });
      expect(test.methods).toContain("session/resume");
    }),
  );
});
