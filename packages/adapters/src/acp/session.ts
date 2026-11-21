// Generic ACP session lifecycle adapted from OpenMausBot (Apache-2.0),
// server/drivers/acp/core.ts, host.ts, question-requests.ts and steer.ts,
// commit 738ec88472a3b888ff7b7793755d89da613ed301. ACP remains a direct
// harness connection owned by aut and is mapped to the aut SessionHandle.
import { randomUUID } from "node:crypto";
import {
  AdapterError,
  type HarnessAdapter as AdapterShape,
  type JsonValue,
  type Question,
  QuestionAnswer,
  RequestId,
  ResumeCursor,
  SessionEvent,
  type SessionHandle,
  SessionRequest,
  StartSessionInput,
  type TranscriptEntry,
  TurnInput,
} from "@aut/protocol";
import {
  Deferred,
  Effect,
  ExecutionStrategy,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Queue,
  Runtime,
  Schema,
  Scope,
  Stream,
} from "effect";
import { HarnessAdapter } from "../interface.js";
import { type AcpTransportFactory, NodeAcpTransport } from "./transport.js";
import {
  asRecord,
  permissionOptions,
  type RpcMessage,
  textValue,
  toolCall,
  update,
} from "./wire.js";

export interface AcpOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** ACP auth method ids copied from the provider's initialize response, in preference order. */
  readonly authMethodIds?: readonly string[];
  /** ACP config option used for model selection when the provider advertises it. */
  readonly modelConfigId?: string;
  readonly resumeMethod?: "load" | "resume";
  readonly rpcTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly interruptGraceMs?: number;
  /** Optional provider-published slash command. ACP has no standard steer method. */
  readonly steerCommand?: string;
}

export const acpCapabilities: AdapterShape["capabilities"] = {
  resume: true,
  fork: false,
  steer: false,
  nativeFullAccess: false,
  questions: { native: true, multiQuestion: false, multiSelect: false, freeText: false },
  transcript: true,
  sessionHistory: false,
};

type PendingQuestion = {
  readonly request: SessionRequest;
  readonly message: RpcMessage;
  readonly mode: "permission" | "grok";
  readonly options: readonly {
    readonly optionId: string;
    readonly kind: string;
    readonly name: string;
  }[];
  readonly turnId: string;
  readonly grokQuestions?: readonly GrokQuestion[];
};

type GrokQuestion = {
  readonly text: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly multiSelect: boolean;
};

type Active = {
  readonly id: string;
  readonly ended: Deferred.Deferred<void>;
  stopping: boolean;
  report: string;
};

const problem = (code: AdapterError["code"], message: string) =>
  new AdapterError({ code, message });

const requestId = (value: string | number | undefined): string =>
  typeof value === "number" || typeof value === "string" ? String(value) : randomUUID();

const responseId = (message: RpcMessage): string | number =>
  message.id === undefined ? randomUUID() : message.id;

const mcpServers = (input: StartSessionInput): JsonValue[] =>
  input.mcpServers.map((server) =>
    server.transport === "stdio"
      ? {
          name: server.name,
          command: server.command,
          args: server.args,
          ...(server.env === undefined ? {} : { env: server.env }),
        }
      : {
          name: server.name,
          url: server.url,
          ...(server.headers === undefined ? {} : { headers: server.headers }),
        },
  );

const configOption = (
  value: JsonValue,
  ids: readonly string[],
  category?: string,
): Readonly<Record<string, JsonValue>> | undefined => {
  const options = asRecord(value)?.configOptions;
  if (!Array.isArray(options)) return undefined;
  return (
    options
      .map((entry) => asRecord(entry))
      .find(
        (entry) =>
          entry !== null &&
          typeof entry.id === "string" &&
          (ids.includes(entry.id) || (category !== undefined && entry.category === category)),
      ) ?? undefined
  );
};

const configOptionValues = (option: Readonly<Record<string, JsonValue>>): readonly string[] => {
  if (!Array.isArray(option.options)) return [];
  return option.options.flatMap((entry) => {
    const value = asRecord(entry)?.value;
    return typeof value === "string" ? [value] : [];
  });
};

const questionFromPermission = (
  input: StartSessionInput,
  message: RpcMessage,
  options: readonly {
    readonly optionId: string;
    readonly kind: string;
    readonly name: string;
  }[],
): Effect.Effect<SessionRequest, AdapterError> => {
  const call = toolCall(message.params);
  const text =
    textValue(call.title) || textValue(call.name) || "The agent is asking you to choose an option.";
  return Schema.decodeUnknown(SessionRequest)({
    id: RequestId.make(`acp-question-${requestId(message.id)}`),
    taskId: input.taskId,
    kind: "question",
    questions: [
      {
        id: `question-${requestId(message.id)}`,
        text,
        options: options.map((option) => ({
          id: option.optionId,
          label: option.name,
        })),
        multiSelect: false,
        allowFreeText: false,
      },
    ],
    openedAt: Date.now(),
    raw: message.params ?? {},
  }).pipe(Effect.mapError((error) => problem("ProtocolError", String(error))));
};

const permissionRequest = (
  input: StartSessionInput,
  message: RpcMessage,
): Effect.Effect<SessionRequest, AdapterError> => {
  const call = toolCall(message.params);
  const tool = textValue(call.kind) || "tool";
  const summary = textValue(call.title) || textValue(call.rawInput) || "ACP requested permission";
  return Schema.decodeUnknown(SessionRequest)({
    id: RequestId.make(`acp-permission-${requestId(message.id)}`),
    taskId: input.taskId,
    kind: "permission",
    questions: [],
    permission: { tool, summary },
    openedAt: Date.now(),
    raw: message.params ?? {},
  }).pipe(Effect.mapError((error) => problem("ProtocolError", String(error))));
};

const selectedOption = (
  answer: QuestionAnswer,
  request: SessionRequest,
  options: readonly { readonly optionId: string; readonly name: string }[],
): string | undefined => {
  const first = request.questions[0];
  const value = answer.perQuestion.find((entry) => entry.questionId === first?.id);
  const optionId = value?.optionIds?.[0];
  if (optionId && options.some((option) => option.optionId === optionId)) return optionId;
  const label = value?.text?.trim();
  return label ? options.find((option) => option.name === label)?.optionId : undefined;
};

const grokQuestion = (value: JsonValue, index: number): GrokQuestion | undefined => {
  const item = asRecord(value);
  const text = textValue(item?.question) || textValue(item?.title);
  if (!text.trim()) return undefined;
  const rawOptions = item?.options;
  const options = Array.isArray(rawOptions)
    ? rawOptions.flatMap((option, optionIndex) => {
        if (typeof option === "string" && option.trim())
          return [{ id: `option-${index}-${optionIndex}`, label: option }];
        const record = asRecord(option);
        const label = textValue(record?.label) || textValue(record?.name);
        return label.trim() ? [{ id: `option-${index}-${optionIndex}`, label }] : [];
      })
    : [];
  return {
    text,
    options,
    multiSelect: item?.multi_select === true || item?.multiSelect === true,
  };
};

const grokRequest = (
  input: StartSessionInput,
  message: RpcMessage,
): Effect.Effect<
  { readonly request: SessionRequest; readonly questions: readonly GrokQuestion[] },
  AdapterError
> => {
  const params = asRecord(message.params);
  const rawQuestions = params?.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0)
    return Effect.fail(problem("ProtocolError", "ACP question request has no questions"));
  const questions = rawQuestions.flatMap((value, index) => {
    const question = grokQuestion(value, index);
    return question ? [question] : [];
  });
  if (questions.length !== rawQuestions.length)
    return Effect.fail(problem("ProtocolError", "ACP question request has invalid questions"));
  const requestQuestions: Question[] = questions.map((question, index) => ({
    id: `question-${index}`,
    text: question.text,
    ...(question.options.length > 0 ? { options: question.options } : {}),
    multiSelect: question.multiSelect,
    allowFreeText: true,
  }));
  return Schema.decodeUnknown(SessionRequest)({
    id: RequestId.make(`acp-question-${requestId(message.id)}`),
    taskId: input.taskId,
    kind: "question",
    questions: requestQuestions,
    openedAt: Date.now(),
    raw: message.params ?? {},
  }).pipe(
    Effect.map((request) => ({ request, questions })),
    Effect.mapError((error) => problem("ProtocolError", String(error))),
  );
};

const grokAnswer = (
  answer: QuestionAnswer,
  request: SessionRequest,
  questions: readonly GrokQuestion[],
): JsonValue | undefined => {
  const answers: Record<string, string[]> = {};
  const annotations: Record<string, { readonly notes: string }> = {};
  for (const [index, question] of questions.entries()) {
    const expected = request.questions[index];
    const value = answer.perQuestion.find((entry) => entry.questionId === expected?.id);
    if (!value) return undefined;
    const labels = (value.optionIds ?? []).flatMap((optionId) => {
      const option = question.options.find((candidate) => candidate.id === optionId);
      return option ? [option.label] : [];
    });
    if (labels.length !== (value.optionIds?.length ?? 0)) return undefined;
    if (!question.multiSelect && labels.length > 1) return undefined;
    if (value.text && !question.options.length && !question.multiSelect) {
      answers[question.text] = ["Other"];
      annotations[question.text] = { notes: value.text };
      continue;
    }
    if (value.text) {
      labels.push("Other");
      annotations[question.text] = { notes: value.text };
    }
    if (labels.length === 0) return undefined;
    answers[question.text] = labels;
  }
  return {
    outcome: "accepted",
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
};

export const makeAcpAdapter = (
  options: AcpOptions = {},
  factory: AcpTransportFactory = NodeAcpTransport,
): AdapterShape => {
  const openScoped = (
    input: StartSessionInput,
    mode: "start" | "resume",
    nativeId?: string,
  ): Effect.Effect<SessionHandle, AdapterError, Scope.Scope> =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknown(StartSessionInput)(input).pipe(
        Effect.mapError((error) => problem("InvalidResponse", String(error))),
      );
      const bus = yield* PubSub.unbounded<SessionEvent>();
      const mutex = yield* Effect.makeSemaphore(1);
      const runtime = yield* Effect.runtime<never>();
      const run = Runtime.runFork(runtime);
      const transport = yield* factory.open({
        command: options.command ?? "opencode",
        args: options.args ?? ["acp"],
        cwd: input.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.rpcTimeoutMs === undefined ? {} : { rpcTimeoutMs: options.rpcTimeoutMs }),
        ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
      });
      const pending = new Map<RequestId, PendingQuestion>();
      const transcript: TranscriptEntry[] = [];
      let active: Active | undefined;
      let sessionId = nativeId;
      let exited = false;
      let commands = new Set<string>();

      const publish = (event: SessionEvent) =>
        Schema.decodeUnknown(SessionEvent)(event).pipe(
          Effect.mapError((error) => problem("ProtocolError", String(error))),
          Effect.flatMap((value) => PubSub.publish(bus, value)),
          Effect.asVoid,
        );

      const closePending = (reason: "turn-ended" | "cancelled") =>
        Effect.gen(function* () {
          for (const [id, entry] of pending) {
            pending.delete(id);
            yield* transport
              .send({
                id: responseId(entry.message),
                result:
                  entry.mode === "grok"
                    ? { outcome: "cancelled" }
                    : { outcome: { outcome: "cancelled" } },
              })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* publish({ kind: "request.closed", requestId: id, reason });
          }
        });

      const finish = (event: SessionEvent) =>
        Effect.gen(function* () {
          const current = active;
          if (!current) return;
          active = undefined;
          yield* closePending(current.stopping ? "cancelled" : "turn-ended");
          yield* publish(event);
          yield* Deferred.succeed(current.ended, undefined);
        });

      const fail = (error: AdapterError) =>
        active
          ? finish({ kind: "turn.failed", turnId: active.id, error: error.message })
          : Effect.void;

      const sendCancelled = (message: RpcMessage) =>
        transport.send({ id: responseId(message), result: { outcome: { outcome: "cancelled" } } });

      const sendGrokCancelled = (message: RpcMessage) =>
        transport.send({ id: responseId(message), result: { outcome: "cancelled" } });

      const handleGrokQuestion = (message: RpcMessage) =>
        Effect.gen(function* () {
          const current = active;
          if (!current || current.stopping) {
            yield* sendGrokCancelled(message).pipe(Effect.catchAll(() => Effect.void));
            return;
          }
          const parsed = yield* grokRequest(input, message);
          const request = parsed.request;
          pending.set(request.id, {
            request,
            message,
            mode: "grok",
            options: [],
            turnId: current.id,
            grokQuestions: parsed.questions,
          });
          yield* publish({ kind: "request.opened", request });
        });

      const handlePermission = (message: RpcMessage) =>
        Effect.gen(function* () {
          const current = active;
          if (!current || current.stopping) {
            yield* sendCancelled(message).pipe(Effect.catchAll(() => Effect.void));
            return;
          }
          const optionsForRequest = permissionOptions(message.params);
          const call = toolCall(message.params);
          const isQuestion = textValue(call.toolCallId).startsWith("interaction_");
          if (isQuestion) {
            if (optionsForRequest.length === 0) {
              yield* sendCancelled(message).pipe(Effect.catchAll(() => Effect.void));
              return;
            }
            const request = yield* questionFromPermission(input, message, optionsForRequest);
            pending.set(request.id, {
              request,
              message,
              mode: "permission",
              options: optionsForRequest,
              turnId: current.id,
            });
            yield* publish({ kind: "request.opened", request });
            return;
          }
          const request = yield* permissionRequest(input, message);
          yield* publish({ kind: "request.opened", request });
          const allow = optionsForRequest.find(
            (option) => option.kind === "allow_once" || option.kind.startsWith("allow"),
          );
          if (allow) {
            yield* transport.send({
              id: responseId(message),
              result: { outcome: { outcome: "selected", optionId: allow.optionId } },
            });
            yield* publish({ kind: "request.closed", requestId: request.id, reason: "answered" });
          } else {
            yield* sendCancelled(message).pipe(Effect.catchAll(() => Effect.void));
            yield* publish({ kind: "request.closed", requestId: request.id, reason: "cancelled" });
          }
        });

      const receiveUpdate = (message: RpcMessage) =>
        Effect.gen(function* () {
          const params = asRecord(message.params);
          const messageSessionId = textValue(params?.sessionId);
          if (sessionId && messageSessionId && messageSessionId !== sessionId) return;
          if (params?._meta && asRecord(params._meta)?.isReplay === true) return;
          const nextCommands = update(message.params).availableCommands;
          if (Array.isArray(nextCommands)) {
            commands = new Set(
              nextCommands.flatMap((value) => {
                const command = asRecord(value);
                return typeof command?.name === "string" ? [command.name] : [];
              }),
            );
          }
          const current = active;
          if (!current) return;
          const next = update(message.params);
          const kind = textValue(next.sessionUpdate);
          if (kind === "agent_message_chunk") {
            const content = asRecord(next.content);
            const text = textValue(content?.text);
            if (text) {
              current.report += text;
              yield* publish({ kind: "message.delta", turnId: current.id, text });
            }
          } else if (kind === "tool_call" || kind === "tool_call_update") {
            const itemId = textValue(next.toolCallId) || undefined;
            yield* publish({
              kind: "session.changed",
              turnId: current.id,
              ...(itemId ? { itemId } : {}),
            });
          }
        });

      const receive = (message: RpcMessage) =>
        Effect.gen(function* () {
          if (message.method === "_x.ai/ask_user_question") {
            yield* handleGrokQuestion(message);
            return;
          }
          if (message.method === "session/request_permission") {
            yield* handlePermission(message);
            return;
          }
          if (message.method === "session/update") {
            yield* receiveUpdate(message);
            return;
          }
          if (message.method !== undefined && message.id !== undefined) {
            yield* transport
              .send({
                id: responseId(message),
                error: { code: -32601, message: "ACP request is not supported by aut" },
              })
              .pipe(Effect.catchAll(() => Effect.void));
          }
        });

      const reader = yield* Effect.forever(
        Effect.gen(function* () {
          const notice = yield* Queue.take(transport.notices);
          if (notice.kind === "message") {
            yield* receive(notice.message).pipe(
              Effect.catchAll((error) =>
                transport.stop.pipe(
                  Effect.catchAll(() => Effect.void),
                  Effect.zipRight(fail(error)),
                ),
              ),
            );
          } else if (notice.kind === "error") {
            yield* transport.stop.pipe(
              Effect.catchAll(() => Effect.void),
              Effect.zipRight(fail(notice.error)),
            );
          } else {
            exited = true;
            if (active)
              yield* active.stopping
                ? finish({
                    kind: "turn.completed",
                    turnId: active.id,
                    ok: false,
                    stopReason: "interrupted",
                  })
                : finish({
                    kind: "turn.failed",
                    turnId: active.id,
                    error: "ACP agent exited during the turn",
                  });
            yield* publish({ kind: "process.exited", code: notice.code });
          }
        }),
      ).pipe(Effect.forkScoped);

      const rpc = (method: string, params: JsonValue) => transport.request(method, params);
      const applyConfigOption = (
        opened: JsonValue,
        ids: readonly string[],
        value: string | undefined,
        sessionIdForConfig: string,
        category?: string,
      ) =>
        Effect.gen(function* () {
          if (value === undefined) return;
          const option = configOption(opened, ids, category);
          if (!option || typeof option.id !== "string") return;
          if (textValue(option.currentValue) === value) return;
          const offered = configOptionValues(option);
          if (offered.length > 0 && !offered.includes(value))
            return yield* Effect.fail(
              problem(
                "InvalidResponse",
                `ACP does not advertise the configured value for ${option.id}`,
              ),
            );
          const result = yield* rpc("session/set_config_option", {
            sessionId: sessionIdForConfig,
            configId: option.id,
            value,
          });
          const selected = configOption(result, [option.id]);
          const current = selected ? textValue(selected.currentValue) : "";
          if (current && current !== value)
            return yield* Effect.fail(
              problem("InvalidResponse", `ACP did not apply the configured value for ${option.id}`),
            );
        });
      const initialized = yield* rpc("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "aut", version: "0.0.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const authMethodIds = options.authMethodIds ?? [];
      if (authMethodIds.length > 0) {
        const advertised = asRecord(initialized)?.authMethods;
        const available = Array.isArray(advertised)
          ? advertised.flatMap((method) => {
              const id = textValue(asRecord(method)?.id);
              return id ? [id] : [];
            })
          : [];
        const methodId = authMethodIds.find((id) => available.includes(id));
        if (!methodId)
          return yield* Effect.fail(
            problem(
              "InvalidResponse",
              `ACP did not advertise any configured auth method: ${authMethodIds.join(", ")}`,
            ),
          );
        yield* rpc("authenticate", { methodId });
      }
      const openParams = {
        cwd: input.cwd,
        mcpServers: mcpServers(input),
      } satisfies JsonValue;
      let opened: JsonValue;
      if (mode === "resume" && nativeId) {
        const method = options.resumeMethod === "resume" ? "session/resume" : "session/load";
        opened = yield* rpc(method, { ...openParams, sessionId: nativeId });
        sessionId = nativeId;
      } else {
        opened = yield* rpc("session/new", openParams);
        const value = asRecord(opened);
        if (typeof value?.sessionId !== "string" || value.sessionId.length === 0)
          return yield* Effect.fail(
            problem("ProtocolError", "ACP session/new returned no sessionId"),
          );
        sessionId = value.sessionId;
      }
      if (!sessionId) return yield* Effect.fail(problem("ProtocolError", "ACP session has no id"));
      const currentSessionId = sessionId;
      yield* applyConfigOption(
        opened,
        [options.modelConfigId ?? "model"],
        input.model,
        currentSessionId,
        "model",
      );
      yield* applyConfigOption(
        opened,
        ["effort", "reasoning_effort", "thought_level", "thinking"],
        input.effort,
        currentSessionId,
      );
      yield* publish({ kind: "cursor.updated", cursor: { kind: "acp", data: { sessionId } } });

      yield* Effect.addFinalizer(() =>
        transport.stop.pipe(
          Effect.catchAll(() => Effect.void),
          Effect.ensuring(Fiber.interrupt(reader)),
          Effect.ensuring(PubSub.shutdown(bus)),
        ),
      );

      const ensureAlive = () =>
        exited ? Effect.fail(problem("ProcessExited", "ACP agent process exited")) : Effect.void;
      const handle: SessionHandle = {
        cursor: { kind: "acp", data: { sessionId } },
        events: Stream.fromPubSub(bus),
        startTurn: (turn) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              yield* ensureAlive();
              yield* Schema.decodeUnknown(TurnInput)(turn).pipe(
                Effect.mapError((error) => problem("InvalidAnswer", String(error))),
              );
              if (active)
                return yield* Effect.fail(
                  problem("ProtocolError", "An ACP turn is already active"),
                );
              const current: Active = {
                id: randomUUID(),
                ended: yield* Deferred.make<void>(),
                stopping: false,
                report: "",
              };
              active = current;
              transcript.push({
                role: "user",
                text: turn.text,
                turnId: current.id,
                at: Date.now(),
              });
              yield* Effect.yieldNow();
              yield* publish({ kind: "turn.started", turnId: current.id });
              const prompt = input.instructions
                ? `${input.instructions}\n\n${turn.text}`
                : turn.text;
              run(
                rpc("session/prompt", {
                  sessionId,
                  prompt: [{ type: "text", text: prompt }],
                }).pipe(
                  Effect.flatMap((result) => {
                    const stopReason = textValue(asRecord(result)?.stopReason);
                    if (current.stopping || stopReason === "cancelled")
                      return finish({
                        kind: "turn.completed",
                        turnId: current.id,
                        ok: false,
                        stopReason: "interrupted",
                      });
                    if (stopReason === "end_turn") {
                      transcript.push({
                        role: "assistant",
                        text: current.report,
                        turnId: current.id,
                        at: Date.now(),
                      });
                      return finish({
                        kind: "turn.completed",
                        turnId: current.id,
                        ok: true,
                        finalReport: current.report,
                      });
                    }
                    return finish({
                      kind: "turn.failed",
                      turnId: current.id,
                      error: `ACP turn ended with ${stopReason || "an unknown stop reason"}`,
                    });
                  }),
                  Effect.catchAll((error) => fail(error)),
                ),
              );
            }),
          ),
        steer: (turn) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              yield* Schema.decodeUnknown(TurnInput)(turn).pipe(
                Effect.mapError((error) => problem("InvalidAnswer", String(error))),
              );
              if (
                !options.steerCommand ||
                !active ||
                active.stopping ||
                !commands.has(options.steerCommand)
              )
                return "refused" as const;
              yield* transport.send({
                id: randomUUID(),
                method: "session/prompt",
                params: {
                  sessionId,
                  prompt: [{ type: "text", text: `/${options.steerCommand} ${turn.text}` }],
                },
              });
              transcript.push({ role: "user", text: turn.text, turnId: active.id, at: Date.now() });
              return "steered" as const;
            }),
          ),
        interrupt: () =>
          Effect.gen(function* () {
            const ended = yield* mutex.withPermits(1)(
              Effect.sync(() => {
                if (!active) return undefined;
                active.stopping = true;
                return active.ended;
              }),
            );
            if (!ended || !sessionId) return;
            yield* transport
              .send({ method: "session/cancel", params: { sessionId } })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* Deferred.await(ended).pipe(
              Effect.timeoutFail({
                duration: options.interruptGraceMs ?? 8_000,
                onTimeout: () =>
                  problem("TransportError", "ACP agent did not acknowledge interruption"),
              }),
            );
          }),
        respond: (id, response) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              const entry = pending.get(id);
              if (!entry || !active || active.id !== entry.turnId)
                return yield* Effect.fail(
                  problem("RequestExpired", "The ACP question is no longer open"),
                );
              if ("allow" in response)
                return yield* Effect.fail(
                  problem("InvalidAnswer", "A permission approval cannot answer a question"),
                );
              const answer = yield* Schema.decodeUnknown(QuestionAnswer)(response).pipe(
                Effect.mapError((error) => problem("InvalidAnswer", String(error))),
              );
              if (answer.perQuestion.length !== entry.request.questions.length)
                return yield* Effect.fail(
                  problem("InvalidAnswer", "Every ACP question must be answered together"),
                );
              const result =
                entry.mode === "grok"
                  ? grokAnswer(answer, entry.request, entry.grokQuestions ?? [])
                  : (() => {
                      const selected = selectedOption(answer, entry.request, entry.options);
                      return selected
                        ? { outcome: { outcome: "selected", optionId: selected } }
                        : undefined;
                    })();
              if (!result)
                return yield* Effect.fail(problem("InvalidAnswer", "Choose a valid ACP answer"));
              pending.delete(id);
              yield* transport.send({
                id: responseId(entry.message),
                result,
              });
              yield* publish({ kind: "request.closed", requestId: id, reason: "answered" });
            }),
          ),
        fork: () =>
          Effect.fail(problem("NotSupported", "ACP does not expose a portable fork method")),
        transcript: () => Effect.succeed([...transcript]),
      };
      return handle;
    });

  const open = (
    input: StartSessionInput,
    mode: "start" | "resume",
    nativeId?: string,
  ): Effect.Effect<SessionHandle, AdapterError, Scope.Scope> =>
    Effect.scopeWith((parent) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(parent, ExecutionStrategy.sequential);
        return yield* openScoped(input, mode, nativeId).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        );
      }),
    );

  return {
    kind: "acp",
    capabilities: acpCapabilities,
    startSession: (input) => open(input, "start"),
    resumeSession: (cursor, input) =>
      Effect.gen(function* () {
        yield* Schema.decodeUnknown(ResumeCursor)(cursor).pipe(
          Effect.mapError((error) => problem("InvalidResponse", String(error))),
        );
        if (cursor.kind !== "acp")
          return yield* Effect.fail(
            problem("InvalidResponse", "Cursor belongs to another adapter"),
          );
        const data = asRecord(cursor.data);
        if (typeof data?.sessionId !== "string" || !data.sessionId)
          return yield* Effect.fail(problem("InvalidResponse", "ACP cursor has no sessionId"));
        return yield* open(input, "resume", data.sessionId);
      }),
  };
};

export const AcpAdapterLive = (options: AcpOptions = {}) =>
  Layer.succeed(HarnessAdapter, makeAcpAdapter(options));
