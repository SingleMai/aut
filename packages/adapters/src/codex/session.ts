// Lifecycle and question-delivery design adapted from OpenMausBot (Apache-2.0),
// server/drivers/codex.ts and codex-questions.ts, commit
// 738ec88472a3b888ff7b7793755d89da613ed301. Reimplemented using Effect and persistent sessions.
import { randomUUID } from "node:crypto";
import {
  AdapterError,
  type HarnessAdapter as AdapterShape,
  type JsonValue,
  QuestionAnswer,
  RequestId,
  ResumeCursor,
  SessionEvent,
  type SessionHandle,
  SessionHistory,
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
  Layer,
  PubSub,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import { HarnessAdapter } from "../interface.js";
import { SessionHistoryCache } from "./history.js";
import { NodeTransport, type TransportFactory } from "./transport.js";
import {
  DeltaNotification,
  decode,
  finalReport,
  ItemNotification,
  McpConfig,
  NativeIdentity,
  NativeRequest,
  PermissionRequest,
  ResolvedRequest,
  type RpcMessage,
  ThreadResult,
  ThreadTranscript,
  TurnNotification,
  TurnResult,
} from "./wire.js";

export interface CodexOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly rpcTimeoutMs?: number;
  readonly interruptGraceMs?: number;
}
export const codexCapabilities: AdapterShape["capabilities"] = {
  resume: true,
  fork: true,
  steer: true,
  nativeFullAccess: true,
  questions: { native: true, multiQuestion: true, multiSelect: false, freeText: true },
  transcript: true,
  sessionHistory: true,
};
const threadAccess = {
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: "danger-full-access",
} as const;
const turnAccess = {
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "dangerFullAccess" },
} as const;
const problem = (code: AdapterError["code"], message: string) =>
  new AdapterError({ code, message });
const nativeInput = (text: string) => [{ type: "text", text, text_elements: [] }];
// config/read serializes absent optional fields as null. TOML overrides have no null value.
const omitConfigNulls = (value: JsonValue): JsonValue =>
  Array.isArray(value)
    ? value.filter((entry) => entry !== null).map(omitConfigNulls)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, entry]) => entry !== null)
            .map(([key, entry]) => [key, omitConfigNulls(entry)]),
        )
      : value;
type Pending = {
  readonly request: SessionRequest;
  readonly turnId: string;
  readonly rpcId?: string | number;
};
type Active = {
  readonly id: string;
  readonly ended: Deferred.Deferred<void>;
  report: string;
  stopping: boolean;
};

export const makeCodexAdapter = (
  options: CodexOptions = {},
  factory: TransportFactory = NodeTransport,
): AdapterShape => {
  const openScoped = (
    input: StartSessionInput,
    method: "thread/start" | "thread/resume" | "thread/fork",
    nativeId?: string,
  ): Effect.Effect<SessionHandle, AdapterError, import("effect").Scope.Scope> =>
    Effect.gen(function* () {
      yield* decode(StartSessionInput, input);
      const transport = yield* factory.open({
        command: options.command ?? "codex",
        args: [
          "app-server",
          "--stdio",
          "--enable",
          "default_mode_request_user_input",
          ...(options.args ?? []),
        ],
        cwd: input.cwd,
        ...(options.env ? { env: options.env } : {}),
        rpcTimeoutMs: options.rpcTimeoutMs ?? 15_000,
      });
      const bus = yield* PubSub.unbounded<SessionEvent>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(bus));
      const mutex = yield* Effect.makeSemaphore(1);
      const pending = new Map<RequestId, Pending>();
      const attempted = new Map<RequestId, "delivered" | "indeterminate">();
      const seenRequests = new Set<string>();
      const history = new SessionHistoryCache();
      let threadId = "";
      let active: Active | undefined;
      let exited = false;
      const publish = (event: SessionEvent) =>
        decode(SessionEvent, event).pipe(
          Effect.flatMap((value) => PubSub.publish(bus, value)),
          Effect.asVoid,
        );
      const closeRequests = (reason: "turn-ended" | "cancelled") =>
        Effect.gen(function* () {
          for (const [id] of pending) {
            pending.delete(id);
            yield* publish({ kind: "request.closed", requestId: id, reason });
          }
        });
      const finish = (event: SessionEvent) =>
        Effect.gen(function* () {
          const previous = active;
          if (!previous) return;
          active = undefined;
          seenRequests.clear();
          yield* closeRequests(previous.stopping ? "cancelled" : "turn-ended");
          yield* publish(event);
          yield* Deferred.succeed(previous.ended, undefined);
        });
      const failTurn = (error: AdapterError) =>
        active
          ? finish({ kind: "turn.failed", turnId: active.id, error: error.message })
          : Effect.void;
      const reject = (message: RpcMessage, reason: string, code = -32601) =>
        message.id === undefined
          ? Effect.void
          : transport.send({ id: message.id, error: { code, message: reason } });
      const createRequest = (
        message: RpcMessage,
        value: Omit<SessionRequest, "id" | "taskId" | "openedAt" | "raw">,
      ) =>
        decode(SessionRequest, {
          ...value,
          id: RequestId.make(randomUUID()),
          taskId: input.taskId,
          openedAt: Date.now(),
          raw: {
            method: message.method ?? "",
            id: message.id ?? null,
            params: message.params ?? null,
          },
        });
      const receiveRequest = (message: RpcMessage) =>
        Effect.gen(function* () {
          const method = message.method;
          if (
            ![
              "item/tool/requestUserInput",
              "item/commandExecution/requestApproval",
              "item/fileChange/requestApproval",
              "item/permissions/requestApproval",
            ].includes(method ?? "")
          ) {
            yield* reject(message, "Unsupported server request");
            return;
          }
          const identity = yield* decode(NativeIdentity, message.params);
          if (!active || identity.threadId !== threadId || identity.turnId !== active.id) {
            yield* reject(message, "Request does not belong to the active turn", -32000);
            return;
          }
          if (method === "item/tool/requestUserInput") {
            const native = yield* decode(NativeRequest, message.params);
            const key = `rpc:${typeof message.id}:${String(message.id)}`;
            if (seenRequests.has(key)) return;
            const request = yield* createRequest(message, {
              kind: "question",
              questions: native.questions.map((question) => ({
                id: question.id,
                text: question.question,
                multiSelect: false,
                allowFreeText: question.isOther !== false,
                ...(question.options
                  ? {
                      options: question.options.map((option, index) => ({
                        id: String(index),
                        label: option.label,
                        ...(option.description === undefined
                          ? {}
                          : { description: option.description }),
                      })),
                    }
                  : {}),
              })),
            });
            pending.set(request.id, {
              request,
              turnId: active.id,
              ...(message.id === undefined ? {} : { rpcId: message.id }),
            });
            seenRequests.add(key);
            yield* publish({ kind: "request.opened", request });
            return;
          }
          const grant =
            method === "item/permissions/requestApproval"
              ? (yield* decode(PermissionRequest, message.params)).permissions
              : undefined;
          const request = yield* createRequest(message, {
            kind: "permission",
            questions: [],
            permission: { tool: method ?? "permission", summary: "Native permission request" },
          });
          yield* publish({ kind: "request.opened", request });
          // Preserve the requested native permissions; never fabricate additional grants.
          if (message.id !== undefined)
            yield* transport.send({
              id: message.id,
              result:
                method === "item/permissions/requestApproval"
                  ? {
                      permissions: {
                        ...(grant?.network ? { network: grant.network } : {}),
                        ...(grant?.fileSystem ? { fileSystem: grant.fileSystem } : {}),
                      },
                      scope: "turn",
                    }
                  : { decision: "accept" },
            });
          yield* publish({ kind: "request.closed", requestId: request.id, reason: "answered" });
        });
      const receive = (message: RpcMessage) =>
        Effect.gen(function* () {
          if (message.id !== undefined && message.method) {
            yield* receiveRequest(message);
            return;
          }
          switch (message.method) {
            case "serverRequest/resolved": {
              const resolved = yield* decode(ResolvedRequest, message.params);
              if (resolved.threadId !== threadId) break;
              for (const [id, entry] of pending) {
                if (entry.rpcId !== resolved.requestId) continue;
                pending.delete(id);
                yield* publish({ kind: "request.closed", requestId: id, reason: "cancelled" });
              }
              break;
            }
            case "turn/started": {
              const event = yield* decode(TurnNotification, message.params);
              if (event.threadId === threadId && active?.id === event.turn.id) {
                history.turn(event.turn);
                yield* publish({ kind: "turn.started", turnId: active.id });
              }
              break;
            }
            case "item/agentMessage/delta": {
              const event = yield* decode(DeltaNotification, message.params);
              if (event.threadId === threadId && active?.id === event.turnId) {
                if (event.itemId) history.delta(event.turnId, event.itemId, event.delta, false);
                yield* publish({ kind: "message.delta", turnId: active.id, text: event.delta });
              }
              break;
            }
            case "item/commandExecution/outputDelta": {
              const event = yield* decode(DeltaNotification, message.params);
              if (event.threadId === threadId && active?.id === event.turnId && event.itemId) {
                history.delta(event.turnId, event.itemId, event.delta, true);
                yield* publish({
                  kind: "session.changed",
                  turnId: event.turnId,
                  itemId: event.itemId,
                });
              }
              break;
            }
            case "item/started": {
              const event = yield* decode(ItemNotification, message.params);
              if (event.threadId !== threadId || active?.id !== event.turnId) break;
              history.item(event.turnId, event.item, false);
              yield* publish({
                kind: "session.changed",
                turnId: event.turnId,
                itemId: event.item.id,
              });
              break;
            }
            case "item/completed": {
              const event = yield* decode(ItemNotification, message.params);
              if (event.threadId !== threadId || active?.id !== event.turnId) break;
              const item = event.item;
              history.item(event.turnId, item, true);
              yield* publish({ kind: "session.changed", turnId: event.turnId, itemId: item.id });
              if (
                item.type === "agentMessage" &&
                item.delivery === "async" &&
                item.questions?.length
              ) {
                const key = `async:${item.id}`;
                if (seenRequests.has(key)) break;
                const request = yield* createRequest(message, {
                  kind: "question",
                  questions: item.questions.map((question, index) => ({
                    id: `${item.id}:${index}`,
                    text: question.title,
                    multiSelect: false,
                    allowFreeText: true,
                    ...(question.options
                      ? {
                          options: question.options.map((label, optionIndex) => ({
                            id: String(optionIndex),
                            label,
                          })),
                        }
                      : {}),
                  })),
                });
                pending.set(request.id, { request, turnId: active.id });
                seenRequests.add(key);
                yield* publish({ kind: "request.opened", request });
              } else {
                const report = finalReport([item]);
                if (report !== undefined) active.report = report;
              }
              break;
            }
            case "turn/completed": {
              const event = yield* decode(TurnNotification, message.params);
              if (event.threadId !== threadId || active?.id !== event.turn.id) break;
              history.turn(event.turn);
              if (event.turn.status === "completed")
                yield* finish({
                  kind: "turn.completed",
                  turnId: active.id,
                  ok: true,
                  finalReport: finalReport(event.turn.items ?? []) ?? active.report,
                });
              else if (event.turn.status === "interrupted")
                yield* finish({
                  kind: "turn.completed",
                  turnId: active.id,
                  ok: false,
                  stopReason: "interrupted",
                });
              else
                yield* finish({
                  kind: "turn.failed",
                  turnId: active.id,
                  error: event.turn.error?.message ?? "Codex turn failed",
                });
              break;
            }
          }
        });
      yield* Effect.forever(
        Effect.gen(function* () {
          const notice = yield* Queue.take(transport.notices);
          yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              if (notice.kind === "message")
                yield* receive(notice.message).pipe(
                  Effect.catchAll((error) =>
                    notice.message.id !== undefined && error.code === "ProtocolError"
                      ? reject(notice.message, error.message, -32602).pipe(
                          Effect.catchAll(() => Effect.void),
                        )
                      : transport.stop.pipe(
                          Effect.catchAll(() => Effect.void),
                          Effect.zipRight(failTurn(error)),
                        ),
                  ),
                );
              else if (notice.kind === "error")
                yield* transport.stop.pipe(
                  Effect.catchAll(() => Effect.void),
                  Effect.zipRight(failTurn(notice.error)),
                );
              else {
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
                        error: "Codex process exited during the turn",
                      });
                yield* publish({ kind: "process.exited", code: notice.code });
              }
            }),
          );
        }),
      ).pipe(Effect.forkScoped);
      yield* transport.request("initialize", {
        clientInfo: { name: "aut", title: "aut", version: "0.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      yield* transport.send({ method: "initialized", params: {} });
      const config: Record<string, JsonValue> = {};
      const mcpServers = new Map<string, JsonValue>();
      if (input.mcpServers.length > 0) {
        const inherited = yield* transport
          .request("config/read", { cwd: input.cwd, includeLayers: false })
          .pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknown(McpConfig)(value).pipe(
                // Config may contain credentials. Never render its values in a decoding error.
                Effect.mapError(() =>
                  problem("InvalidResponse", "Codex returned an invalid MCP configuration"),
                ),
              ),
            ),
          );
        for (const [name, value] of Object.entries(inherited.config.mcp_servers ?? {}))
          if (value !== null) mcpServers.set(name, omitConfigNulls(value));
      }
      for (const server of input.mcpServers) {
        mcpServers.set(
          server.name,
          server.transport === "stdio"
            ? {
                command: server.command,
                args: server.args,
                ...(server.env ? { env: server.env } : {}),
              }
            : { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}) },
        );
      }
      if (input.mcpServers.length > 0) config.mcp_servers = Object.fromEntries(mcpServers);
      const result = yield* transport.request(method, {
        cwd: input.cwd,
        model: input.model,
        developerInstructions: input.instructions,
        ...threadAccess,
        config,
        ...(nativeId ? { threadId: nativeId } : {}),
      });
      threadId = (yield* decode(ThreadResult, result)).thread.id;
      const cursor: ResumeCursor = { kind: "codex", data: { threadId } };
      const ensureAlive = () =>
        exited ? Effect.fail(problem("ProcessExited", "Codex process exited")) : Effect.void;
      const steer = (turn: TurnInput) =>
        Effect.gen(function* () {
          yield* decode(TurnInput, turn);
          if (!active || exited || active.stopping) return "refused" as const;
          const expectedTurnId = active.id;
          return yield* transport
            .request("turn/steer", {
              threadId,
              expectedTurnId,
              input: nativeInput(turn.text),
            })
            .pipe(
              Effect.flatMap((value) => decode(Schema.Struct({ turnId: Schema.String }), value)),
              Effect.map((value) =>
                value.turnId === expectedTurnId ? ("steered" as const) : ("indeterminate" as const),
              ),
              Effect.catchAll((error) =>
                Effect.succeed(
                  error.code === "ProtocolError" && error.detail !== undefined
                    ? ("refused" as const)
                    : ("indeterminate" as const),
                ),
              ),
            );
        });
      const handle: SessionHandle = {
        cursor,
        events: Stream.fromPubSub(bus),
        startTurn: (turn) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              yield* ensureAlive();
              yield* decode(TurnInput, turn);
              if (active)
                return yield* Effect.fail(problem("ProtocolError", "A turn is already active"));
              const response = yield* transport
                .request("turn/start", {
                  threadId,
                  ...turnAccess,
                  model: input.model,
                  ...(input.effort ? { effort: input.effort } : {}),
                  input: nativeInput(turn.text),
                })
                .pipe(
                  Effect.catchAll((error) => {
                    if (error.code === "ProtocolError" && error.detail !== undefined)
                      return Effect.fail(error);
                    exited = true;
                    return transport.stop.pipe(
                      Effect.catchAll(() => Effect.void),
                      Effect.zipRight(
                        Effect.fail(
                          problem(
                            "DeliveryIndeterminate",
                            "Turn start could not be confirmed; this session is closed to prevent duplicate work",
                          ),
                        ),
                      ),
                    );
                  }),
                );
              const result = yield* decode(TurnResult, response).pipe(
                Effect.catchAll((error) => {
                  exited = true;
                  return transport.stop.pipe(
                    Effect.catchAll(() => Effect.void),
                    Effect.zipRight(Effect.fail(problem("DeliveryIndeterminate", error.message))),
                  );
                }),
              );
              const id = result.turn.id;
              active = { id, ended: yield* Deferred.make<void>(), stopping: false, report: "" };
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  exited = true;
                }).pipe(Effect.zipRight(transport.stop.pipe(Effect.catchAll(() => Effect.void)))),
              ),
            ),
          ),
        steer: (turn) => mutex.withPermits(1)(steer(turn)),
        interrupt: () =>
          Effect.gen(function* () {
            const ended = yield* mutex.withPermits(1)(
              Effect.gen(function* () {
                if (!active) return undefined;
                const current = active;
                current.stopping = true;
                yield* transport
                  .request("turn/interrupt", { threadId, turnId: current.id })
                  .pipe(Effect.catchAll(() => Effect.void));
                return current.ended;
              }),
            );
            if (!ended) return;
            yield* Deferred.await(ended).pipe(
              Effect.timeoutFail({
                duration: options.interruptGraceMs ?? 1_500,
                onTimeout: () =>
                  problem("TransportError", "Codex did not acknowledge interruption"),
              }),
              Effect.catchAll(() =>
                transport.stop.pipe(
                  Effect.zipRight(Deferred.await(ended)),
                  Effect.timeoutFail({
                    duration: 8_000,
                    onTimeout: () => problem("TransportError", "Codex stop remains unconfirmed"),
                  }),
                ),
              ),
            );
          }),
        respond: (requestId, response) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              const previous = attempted.get(requestId);
              if (previous)
                return yield* Effect.fail(
                  problem(
                    previous === "indeterminate" ? "DeliveryIndeterminate" : "InvalidAnswer",
                    "This answer has already been submitted; do not resend",
                  ),
                );
              const entry = pending.get(requestId);
              if (!entry || !active || active.id !== entry.turnId)
                return yield* Effect.fail(
                  problem("RequestExpired", "The original question is no longer open"),
                );
              if ("allow" in response)
                return yield* Effect.fail(
                  problem("InvalidAnswer", "A permission approval cannot answer a question"),
                );
              const answer = yield* decode(QuestionAnswer, response).pipe(
                Effect.mapError((error) => problem("InvalidAnswer", error.message)),
              );
              const texts = new Map<string, string[]>();
              if (answer.perQuestion.length !== entry.request.questions.length)
                return yield* Effect.fail(
                  problem("InvalidAnswer", "Every question must be answered together"),
                );
              for (const question of entry.request.questions) {
                const perQuestion = answer.perQuestion.find(
                  (value) => value.questionId === question.id,
                );
                if (
                  !perQuestion ||
                  (!question.allowFreeText && perQuestion.text) ||
                  (!question.multiSelect && (perQuestion.optionIds?.length ?? 0) > 1)
                )
                  return yield* Effect.fail(
                    problem("InvalidAnswer", "Answer does not match the question capabilities"),
                  );
                const selected: string[] = [];
                for (const id of perQuestion.optionIds ?? []) {
                  const option = question.options?.find((value) => value.id === id);
                  if (!option)
                    return yield* Effect.fail(problem("InvalidAnswer", "Unknown question option"));
                  selected.push(option.label);
                }
                if (perQuestion.text) selected.push(perQuestion.text);
                texts.set(question.id, selected);
              }
              // Reserve before delivery: an ambiguous write must never be retried automatically.
              attempted.set(requestId, "indeterminate");
              if (entry.rpcId !== undefined) {
                yield* transport
                  .send({
                    id: entry.rpcId,
                    result: {
                      answers: Object.fromEntries(
                        [...texts].map(([id, answers]) => [id, { answers }]),
                      ),
                    },
                  })
                  .pipe(
                    Effect.mapError((error) => problem("DeliveryIndeterminate", error.message)),
                  );
              } else {
                const text = entry.request.questions
                  .map(
                    (question) =>
                      `Q: ${question.text}\nA: ${texts.get(question.id)?.join("\n") ?? ""}`,
                  )
                  .join("\n\n");
                const outcome = yield* steer({ text, messageIds: [] });
                if (outcome === "refused") {
                  attempted.delete(requestId);
                  pending.delete(requestId);
                  yield* publish({ kind: "request.closed", requestId, reason: "turn-ended" });
                  return yield* Effect.fail(
                    problem("RequestExpired", "The question answer was not delivered"),
                  );
                }
                if (outcome === "indeterminate")
                  return yield* Effect.fail(
                    problem(
                      "DeliveryIndeterminate",
                      "Question delivery cannot be confirmed; do not resend",
                    ),
                  );
              }
              attempted.set(requestId, "delivered");
              pending.delete(requestId);
              yield* publish({ kind: "request.closed", requestId, reason: "answered" });
            }),
          ),
        fork: () => open(input, "thread/fork", threadId),
        readSession: () =>
          transport.request("thread/read", { threadId, includeTurns: true }).pipe(
            Effect.flatMap((value) => decode(ThreadTranscript, value)),
            Effect.flatMap(({ thread }) =>
              mutex.withPermits(1)(
                Effect.gen(function* () {
                  if (thread.id !== threadId)
                    return yield* Effect.fail(
                      problem("InvalidResponse", "Session history belongs to another thread"),
                    );
                  history.hydrate(thread.turns);
                  return yield* decode(SessionHistory, history.snapshot());
                }),
              ),
            ),
          ),
        transcript: () =>
          transport.request("thread/read", { threadId, includeTurns: true }).pipe(
            Effect.flatMap((value) => decode(ThreadTranscript, value)),
            Effect.map(({ thread }) =>
              thread.turns.flatMap((turn) =>
                (turn.items ?? []).flatMap((item): TranscriptEntry[] => {
                  const text =
                    item.type === "reasoning"
                      ? (item.summary?.join("\n") ?? "")
                      : (item.text ??
                        item.content
                          ?.map((content) =>
                            typeof content === "string" ? content : (content.text ?? ""),
                          )
                          .join("\n") ??
                        item.aggregatedOutput ??
                        "");
                  const role =
                    item.type === "userMessage"
                      ? "user"
                      : item.type === "agentMessage"
                        ? "assistant"
                        : "tool";
                  return text
                    ? [
                        {
                          role,
                          text,
                          turnId: turn.id,
                          ...(item.startedAtMs == null ? {} : { at: item.startedAtMs }),
                        },
                      ]
                    : [];
                }),
              ),
            ),
          ),
      };
      return handle;
    });
  // A failed acquisition must release its process immediately, even when the daemon's
  // parent Scope remains open. Successful sessions inherit that parent's lifetime.
  const open = (
    input: StartSessionInput,
    method: "thread/start" | "thread/resume" | "thread/fork",
    nativeId?: string,
  ): Effect.Effect<SessionHandle, AdapterError, Scope.Scope> =>
    Effect.scopeWith((parent) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(parent, ExecutionStrategy.sequential);
        return yield* openScoped(input, method, nativeId).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        );
      }),
    );
  return {
    kind: "codex",
    capabilities: codexCapabilities,
    readSession: (cursor) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* decode(ResumeCursor, cursor);
          if (cursor.kind !== "codex")
            return yield* Effect.fail(
              problem("InvalidResponse", "Cursor belongs to another adapter"),
            );
          const identity = yield* decode(
            Schema.Struct({ threadId: Schema.String.pipe(Schema.minLength(1)) }),
            cursor.data,
          );
          const transport = yield* factory.open({
            command: options.command ?? "codex",
            args: ["app-server", "--stdio", ...(options.args ?? [])],
            cwd: process.cwd(),
            rpcTimeoutMs: options.rpcTimeoutMs ?? 15_000,
            ...(options.env ? { env: options.env } : {}),
          });
          yield* transport.request("initialize", {
            clientInfo: { name: "aut-session-reader", version: "0.0.0" },
            capabilities: { experimentalApi: true },
          });
          yield* transport.send({ method: "initialized", params: {} });
          const { thread } = yield* transport
            .request("thread/read", { threadId: identity.threadId, includeTurns: true })
            .pipe(Effect.flatMap((value) => decode(ThreadTranscript, value)));
          if (thread.id !== identity.threadId)
            return yield* Effect.fail(
              problem("InvalidResponse", "Session history belongs to another thread"),
            );
          const history = new SessionHistoryCache();
          history.hydrate(thread.turns);
          return yield* decode(SessionHistory, history.snapshot());
        }),
      ),
    startSession: (input) => open(input, "thread/start"),
    resumeSession: (cursor, input) =>
      Effect.gen(function* () {
        yield* decode(ResumeCursor, cursor);
        if (cursor.kind !== "codex")
          return yield* Effect.fail(
            problem("InvalidResponse", "Cursor belongs to another adapter"),
          );
        const value = yield* decode(
          Schema.Struct({ threadId: Schema.String.pipe(Schema.minLength(1)) }),
          cursor.data,
        );
        return yield* open(input, "thread/resume", value.threadId);
      }),
  };
};

export const CodexAdapterLive = (options: CodexOptions = {}) =>
  Layer.succeed(HarnessAdapter, makeCodexAdapter(options));
