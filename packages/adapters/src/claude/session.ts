// Claude stream-json session lifecycle adapted from OpenMausBot (Apache-2.0),
// server/drivers/claude.ts and server/permission-proxy.ts, commit
// 738ec88472a3b888ff7b7793755d89da613ed301. The runtime contract is aut's HarnessAdapter.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  Layer,
  PubSub,
  Queue,
  Runtime,
  Schema,
  Scope,
  Stream,
} from "effect";
import { HarnessAdapter } from "../interface.js";
import { type ClaudeTransportFactory, NodeClaudeTransport } from "./transport.js";
import {
  asRecord,
  type ClaudeFrame,
  decodeLine,
  eventDelta,
  textFromContent,
  toolResults,
  toolUses,
} from "./wire.js";

export interface ClaudeOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly startupTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly interruptGraceMs?: number;
  readonly questionProxyPath?: string;
}

export const claudeCapabilities: AdapterShape["capabilities"] = {
  sessionContext: false,
  resume: true,
  fork: true,
  steer: true,
  nativeFullAccess: true,
  questions: { native: true, multiQuestion: true, multiSelect: true, freeText: true },
  transcript: true,
  sessionHistory: false,
};

type BrokerAsk = {
  readonly id: string;
  readonly kind: "question" | "permission";
  readonly tool: string;
  readonly input: JsonValue;
};
type BrokerAnswer = {
  readonly behavior: "allow" | "deny" | "answer";
  readonly message?: string;
};
type BrokerEntry = { readonly connection: Socket };
type Broker = {
  readonly socketPath: string;
  readonly answer: (id: string, answer: BrokerAnswer) => Effect.Effect<void, AdapterError>;
  readonly closeAsk: (id: string, answer: BrokerAnswer) => Effect.Effect<void, AdapterError>;
  readonly close: Effect.Effect<void, AdapterError>;
};

type Pending = {
  readonly request: SessionRequest;
  readonly brokerId: string;
  readonly turnId: string;
};
type Active = {
  readonly id: string;
  readonly ended: Deferred.Deferred<void>;
  stopping: boolean;
  report: string;
  sawStreamText: boolean;
  /** Steers that have been written but have not yet been replayed by Claude. */
  readonly pendingSteers: Set<string>;
  /** A result can arrive before Claude starts the queued continuation. Keep it held. */
  deferred: NativeTurnResult | null;
  deferredReport: string | undefined;
  continuationGrace: ReturnType<typeof setTimeout> | undefined;
  continuationSilence: ReturnType<typeof setTimeout> | undefined;
};

// These values and the result-folding rule are copied from OpenMausBot's Claude driver.
// Claude Code can emit one result for the original prompt and another for a steer while
// retaining a single stdin process. aut exposes that sequence as one logical turn.
export interface NativeTurnResult {
  readonly ok: boolean;
  readonly stopReason: string | null;
  readonly cost: number | null;
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly cachedInput?: number;
  };
}

export const STEERED_CONTINUATION_GRACE_MS = 2_000;
export const STEERED_CONTINUATION_SILENCE_MS = 30_000;

export const sumNativeTurnResults = (
  earlier: NativeTurnResult | null,
  latest: NativeTurnResult,
): NativeTurnResult => {
  if (!earlier) return latest;
  const usage =
    earlier.usage && latest.usage
      ? {
          input: earlier.usage.input + latest.usage.input,
          output: earlier.usage.output + latest.usage.output,
          ...(earlier.usage.cachedInput !== undefined || latest.usage.cachedInput !== undefined
            ? { cachedInput: (earlier.usage.cachedInput ?? 0) + (latest.usage.cachedInput ?? 0) }
            : {}),
        }
      : (latest.usage ?? earlier.usage);
  return {
    ok: earlier.ok && latest.ok,
    stopReason: latest.stopReason ?? earlier.stopReason,
    cost: latest.cost ?? earlier.cost,
    ...(usage ? { usage } : {}),
  };
};

const problem = (code: AdapterError["code"], message: string) =>
  new AdapterError({ code, message });

const nativeUser = (text: string, uuid?: string): JsonValue => ({
  type: "user",
  ...(uuid === undefined ? {} : { uuid }),
  message: { role: "user", content: text },
});

const questionProxyPath = (options: ClaudeOptions): string =>
  options.questionProxyPath ?? fileURLToPath(new URL("./question-proxy.js", import.meta.url));

const writeMcpConfig = (
  input: StartSessionInput,
  socketPath: string,
  proxyPath: string,
): string => {
  const directory = mkdtempSync(join(tmpdir(), "aut-claude-config-"));
  const path = join(directory, "mcp.json");
  const mcpServers: Record<string, JsonValue> = {};
  for (const server of input.mcpServers) {
    mcpServers[server.name] =
      server.transport === "stdio"
        ? {
            command: server.command,
            args: server.args,
            ...(server.env === undefined ? {} : { env: server.env }),
          }
        : {
            type: "http",
            url: server.url,
            ...(server.headers === undefined ? {} : { headers: server.headers }),
          };
  }
  mcpServers["aut-questions"] = {
    command: process.execPath,
    args: [proxyPath, socketPath],
    ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
  };
  writeFileSync(path, JSON.stringify({ mcpServers }), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return path;
};

const removeFileTree = (path: string): void => {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // The adapter finalizer must remain best effort after the child has exited.
  }
};

const openBroker = (
  onAsk: (ask: BrokerAsk) => Effect.Effect<void, AdapterError>,
  onDrop: (id: string) => Effect.Effect<void, AdapterError>,
): Effect.Effect<Broker, AdapterError> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    const run = Runtime.runFork(runtime);
    const socketPath = join(tmpdir(), `aut-claude-${randomUUID().slice(0, 12)}.sock`);
    const pending = new Map<string, BrokerEntry>();
    let closed = false;
    let server: ReturnType<typeof createServer> | undefined;

    const send = (id: string, answer: BrokerAnswer) =>
      Effect.async<void, AdapterError>((resume) => {
        const entry = pending.get(id);
        if (!entry) {
          resume(Effect.fail(problem("RequestExpired", "The Claude request is no longer open")));
          return;
        }
        pending.delete(id);
        entry.connection.write(`${JSON.stringify({ t: "answer", id, ...answer })}\n`, (error) =>
          resume(
            error ? Effect.fail(problem("DeliveryIndeterminate", error.message)) : Effect.void,
          ),
        );
      });

    const connectionHandler = (connection: Socket) => {
      connection.setEncoding("utf8");
      connection.on("error", () => undefined);
      let buffer = "";
      connection.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.trim()) continue;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
          const message = value as {
            readonly t?: unknown;
            readonly id?: unknown;
            readonly kind?: unknown;
            readonly tool?: unknown;
            readonly input?: unknown;
          };
          if (message.t !== "ask" || typeof message.id !== "string") continue;
          const id = message.id;
          if (closed || pending.has(id)) {
            run(
              send(id, { behavior: "deny", message: "aut question service is closed" }).pipe(
                Effect.catchAll(() => Effect.void),
              ),
            );
            continue;
          }
          const ask: BrokerAsk = {
            id,
            kind: message.kind === "question" ? "question" : "permission",
            tool: typeof message.tool === "string" ? message.tool : "tool",
            input: (message.input ?? {}) as JsonValue,
          };
          pending.set(id, { connection });
          run(
            onAsk(ask).pipe(
              Effect.catchAll((error) =>
                send(id, { behavior: "deny", message: error.message }).pipe(
                  Effect.catchAll(() => Effect.void),
                ),
              ),
            ),
          );
        }
      });
      connection.once("close", () => {
        for (const [id, entry] of pending) {
          if (entry.connection !== connection) continue;
          pending.delete(id);
          run(onDrop(id).pipe(Effect.catchAll(() => Effect.void)));
        }
      });
    };

    yield* Effect.async<void, AdapterError>((resume) => {
      server = createServer(connectionHandler);
      server.once("error", (error) =>
        resume(Effect.fail(problem("TransportError", error.message))),
      );
      server.listen(socketPath, () => {
        try {
          chmodSync(socketPath, 0o600);
          resume(Effect.void);
        } catch (error) {
          resume(Effect.fail(problem("TransportError", String(error))));
        }
      });
      return Effect.sync(() => server?.close());
    });

    const close = Effect.sync(() => {
      closed = true;
      for (const [id, entry] of pending) {
        pending.delete(id);
        try {
          entry.connection.write(
            `${JSON.stringify({ t: "answer", id, behavior: "deny", message: "The turn ended" })}\n`,
          );
        } catch {
          // The process is already closing.
        }
      }
      try {
        server?.close();
      } catch {
        // The server may have closed with the child process.
      }
      try {
        unlinkSync(socketPath);
      } catch {
        // Unix socket cleanup is best effort.
      }
    });

    return { socketPath, answer: send, closeAsk: send, close };
  });

const questionItems = (input: JsonValue, brokerId: string): readonly Question[] => {
  const record = asRecord(input);
  const values = Array.isArray(record?.questions)
    ? record.questions
    : record?.question === undefined
      ? []
      : [input];
  const questions: Question[] = [];
  values.forEach((value, index) => {
    const item = asRecord(value);
    if (!item || typeof item.question !== "string" || item.question.trim().length === 0) return;
    const rawOptions = Array.isArray(item.options)
      ? item.options
      : Array.isArray(item.choices)
        ? item.choices
        : [];
    const options = rawOptions.flatMap((option, optionIndex) => {
      if (typeof option === "string" && option.trim())
        return [{ id: `${brokerId}-${index}-${optionIndex}`, label: option }];
      const row = asRecord(option);
      return row && typeof row.label === "string" && row.label.trim()
        ? [
            {
              id: `${brokerId}-${index}-${optionIndex}`,
              label: row.label,
              ...(typeof row.description === "string" ? { description: row.description } : {}),
            },
          ]
        : [];
    });
    questions.push({
      id: `${brokerId}-${index}`,
      text: item.question,
      ...(options.length === 0 ? {} : { options }),
      multiSelect: item.multiSelect === true,
      allowFreeText: item.isOther !== false,
    });
  });
  return questions;
};

const answerText = (request: SessionRequest, answer: QuestionAnswer): string =>
  request.questions
    .map((question) => {
      const selected = answer.perQuestion.find((value) => value.questionId === question.id);
      if (!selected) return `${question.text}:`;
      const labels = (selected.optionIds ?? []).flatMap((id) => {
        const option = question.options?.find((value) => value.id === id);
        return option ? [option.label] : [];
      });
      if (selected.text) labels.push(selected.text);
      return `${question.text}: ${labels.join(", ")}`;
    })
    .join("\n");

export const makeClaudeAdapter = (
  options: ClaudeOptions = {},
  factory: ClaudeTransportFactory = NodeClaudeTransport,
): AdapterShape => {
  const openScoped = (
    input: StartSessionInput,
    mode: "start" | "resume" | "fork",
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
      const initialized = yield* Deferred.make<string, AdapterError>();
      const pending = new Map<RequestId, Pending>();
      const attempted = new Map<RequestId, "delivered" | "indeterminate">();
      const transcript: TranscriptEntry[] = [];
      let active: Active | undefined;
      let sessionId = nativeId ?? randomUUID();
      let exited = false;
      let brokerHandler: (ask: BrokerAsk) => Effect.Effect<void, AdapterError> = () => Effect.void;
      let brokerDropHandler: (id: string) => Effect.Effect<void, AdapterError> = () => Effect.void;
      const broker = yield* openBroker(
        (ask) => brokerHandler(ask),
        (id) => brokerDropHandler(id),
      );
      const configPath = writeMcpConfig(input, broker.socketPath, questionProxyPath(options));
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--replay-user-messages",
        "--allow-dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions",
        "--strict-mcp-config",
        "--mcp-config",
        configPath,
        "--system-prompt",
        input.instructions,
        "--model",
        input.model,
        ...(input.effort === undefined ? [] : ["--effort", input.effort]),
        ...(mode === "start" ? ["--session-id", sessionId] : []),
        ...(mode === "resume" ? ["--resume", sessionId] : []),
        ...(mode === "fork"
          ? ["--resume", sessionId, "--fork-session", "--no-session-persistence"]
          : []),
        ...(options.args ?? []),
      ];
      const transport = yield* factory.open({
        command: options.command ?? "claude",
        args,
        cwd: input.cwd,
        env: {
          // OpenMausBot disables these process-global features because the daemon owns
          // session lifetime and scheduling. Keep the same boundary for aut workers.
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
          CLAUDE_CODE_DISABLE_CRON: "1",
          ...(options.env ?? {}),
        },
        ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
      });

      const publish = (event: SessionEvent) =>
        Schema.decodeUnknown(SessionEvent)(event).pipe(
          Effect.mapError((error) => problem("ProtocolError", String(error))),
          Effect.flatMap((value) => PubSub.publish(bus, value)),
          Effect.asVoid,
        );
      const closeRequests = (reason: "turn-ended" | "cancelled") =>
        Effect.gen(function* () {
          for (const [requestId, entry] of pending) {
            pending.delete(requestId);
            yield* broker
              .closeAsk(entry.brokerId, { behavior: "deny", message: "The turn ended" })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* publish({ kind: "request.closed", requestId, reason });
          }
        });
      const finish = (event: SessionEvent) =>
        Effect.gen(function* () {
          const current = active;
          if (!current) return;
          active = undefined;
          if (current.continuationGrace) clearTimeout(current.continuationGrace);
          if (current.continuationSilence) clearTimeout(current.continuationSilence);
          yield* closeRequests(current.stopping ? "cancelled" : "turn-ended");
          yield* publish(event);
          yield* Deferred.succeed(current.ended, undefined);
        });
      const fail = (error: AdapterError) =>
        active
          ? finish({ kind: "turn.failed", turnId: active.id, error: error.message })
          : Effect.void;

      const onBrokerAsk = (ask: BrokerAsk) =>
        Effect.gen(function* () {
          const current = active;
          if (!current || current.stopping) {
            yield* broker.answer(ask.id, {
              behavior: "deny",
              message: "The turn is no longer active",
            });
            return;
          }
          if (ask.kind === "permission") {
            const request = yield* Schema.decodeUnknown(SessionRequest)({
              id: RequestId.make(randomUUID()),
              taskId: input.taskId,
              kind: "permission",
              questions: [],
              permission: { tool: ask.tool, summary: "Claude requested permission" },
              openedAt: Date.now(),
              raw: ask.input,
            }).pipe(Effect.mapError((error) => problem("ProtocolError", String(error))));
            yield* publish({ kind: "request.opened", request });
            yield* broker.answer(ask.id, { behavior: "allow" });
            yield* publish({ kind: "request.closed", requestId: request.id, reason: "answered" });
            return;
          }
          const questions = questionItems(ask.input, ask.id);
          if (questions.length === 0) {
            yield* broker.answer(ask.id, {
              behavior: "deny",
              message: "The question had no answerable text",
            });
            return;
          }
          const request = yield* Schema.decodeUnknown(SessionRequest)({
            id: RequestId.make(randomUUID()),
            taskId: input.taskId,
            kind: "question",
            questions,
            openedAt: Date.now(),
            raw: ask.input,
          }).pipe(Effect.mapError((error) => problem("ProtocolError", String(error))));
          pending.set(request.id, { request, brokerId: ask.id, turnId: current.id });
          yield* publish({ kind: "request.opened", request });
        });
      brokerHandler = onBrokerAsk;
      brokerDropHandler = (brokerId) =>
        Effect.gen(function* () {
          for (const [requestId, entry] of pending) {
            if (entry.brokerId !== brokerId) continue;
            pending.delete(requestId);
            yield* publish({ kind: "request.closed", requestId, reason: "cancelled" });
          }
        });

      const settleHeld = (current: Active) =>
        Effect.gen(function* () {
          if (active !== current || current.stopping || current.deferredReport === undefined)
            return;
          const report = current.deferredReport;
          current.deferredReport = undefined;
          current.deferred = null;
          yield* finish({
            kind: "turn.completed",
            turnId: current.id,
            ok: true,
            finalReport: report,
          });
        });
      const receive = (frame: ClaudeFrame) =>
        Effect.gen(function* () {
          if (frame.type === "system" && frame.subtype === "init") {
            if (frame.session_id) sessionId = frame.session_id;
            const cursor: ResumeCursor = { kind: "claude", data: { sessionId } };
            yield* publish({ kind: "cursor.updated", cursor });
            yield* Deferred.succeed(initialized, sessionId);
            if (active?.continuationGrace) {
              clearTimeout(active.continuationGrace);
              active.continuationGrace = undefined;
              if (active.continuationSilence) clearTimeout(active.continuationSilence);
              active.continuationSilence = setTimeout(() => {
                if (
                  active === undefined ||
                  active.stopping ||
                  active.deferred === null ||
                  active.deferredReport === undefined
                )
                  return;
                active.continuationSilence = undefined;
                run(settleHeld(active).pipe(Effect.catchAll(() => Effect.void)));
              }, STEERED_CONTINUATION_SILENCE_MS);
              active.continuationSilence.unref?.();
            }
            return;
          }
          const current = active;
          if (!current) return;
          if (current.continuationSilence) {
            clearTimeout(current.continuationSilence);
            current.continuationSilence = undefined;
          }
          if (frame.type === "stream_event") {
            const delta = eventDelta(frame.event);
            if (delta) {
              current.sawStreamText = true;
              current.report += delta;
              yield* publish({ kind: "message.delta", turnId: current.id, text: delta });
            }
            return;
          }
          if (frame.type === "assistant") {
            const message = asRecord(frame.message);
            const text = textFromContent(message?.content);
            if (text && !current.sawStreamText) {
              current.report += text;
              yield* publish({ kind: "message.delta", turnId: current.id, text });
            }
            for (const tool of toolUses(frame.message))
              yield* publish({ kind: "session.changed", turnId: current.id, itemId: tool.id });
            if (text)
              transcript.push({ role: "assistant", text, turnId: current.id, at: Date.now() });
            return;
          }
          if (frame.type === "user") {
            if (frame.isReplay === true) {
              if (typeof frame.uuid === "string") current.pendingSteers.delete(frame.uuid);
              return;
            }
            for (const result of toolResults(frame.message))
              yield* publish({ kind: "session.changed", turnId: current.id, itemId: result.id });
            return;
          }
          if (frame.type !== "result") return;
          if (frame.origin && asRecord(frame.origin)?.kind === "task-notification") return;
          const report = frame.result ?? current.report;
          if (current.stopping) {
            yield* finish({
              kind: "turn.completed",
              turnId: current.id,
              ok: false,
              stopReason: "interrupted",
            });
          } else if (frame.is_error === true) {
            yield* finish({
              kind: "turn.failed",
              turnId: current.id,
              error: report || "Claude turn failed",
            });
          } else if (current.pendingSteers.size > 0 || (frame.queued_turn_count ?? 0) > 0) {
            const usage = asRecord(frame.usage);
            const native: NativeTurnResult = {
              ok: true,
              stopReason: frame.stop_reason ?? frame.terminal_reason ?? null,
              cost: typeof frame.total_cost_usd === "number" ? frame.total_cost_usd : null,
              ...(usage
                ? {
                    usage: {
                      input:
                        (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) +
                        (typeof usage.cache_read_input_tokens === "number"
                          ? usage.cache_read_input_tokens
                          : 0) +
                        (typeof usage.cache_creation_input_tokens === "number"
                          ? usage.cache_creation_input_tokens
                          : 0),
                      output: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
                      ...(typeof usage.cache_read_input_tokens === "number"
                        ? { cachedInput: usage.cache_read_input_tokens }
                        : {}),
                    },
                  }
                : {}),
            };
            current.deferredReport = report;
            current.deferred = sumNativeTurnResults(current.deferred, native);
            if (current.continuationGrace) clearTimeout(current.continuationGrace);
            current.continuationGrace = setTimeout(() => {
              if (active !== current || current.stopping || current.deferred === null) return;
              current.continuationGrace = undefined;
              run(settleHeld(current).pipe(Effect.catchAll(() => Effect.void)));
            }, 2_000);
            current.continuationGrace.unref?.();
          } else {
            yield* finish({
              kind: "turn.completed",
              turnId: current.id,
              ok: true,
              finalReport: report,
            });
          }
        });

      yield* Effect.forever(
        Effect.gen(function* () {
          const notice = yield* Queue.take(transport.notices);
          if (notice.kind === "line")
            yield* decodeLine(notice.line).pipe(
              Effect.flatMap(receive),
              Effect.catchAll((error) =>
                Effect.logError(`Claude frame handling failed: ${error.message}`).pipe(
                  Effect.zipRight(
                    transport.stop.pipe(
                      Effect.catchAll(() => Effect.void),
                      Effect.zipRight(fail(error)),
                    ),
                  ),
                ),
              ),
            );
          else if (notice.kind === "error")
            yield* transport.stop.pipe(
              Effect.catchAll(() => Effect.void),
              Effect.zipRight(fail(notice.error)),
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
                    error: "Claude process exited during the turn",
                  });
            yield* publish({ kind: "process.exited", code: notice.code });
            yield* Deferred.fail(
              initialized,
              problem("ProcessExited", "Claude exited before initialization"),
            );
          }
        }),
      ).pipe(Effect.forkScoped);

      yield* Effect.addFinalizer(() =>
        broker.close.pipe(
          Effect.catchAll(() => Effect.void),
          Effect.zipRight(transport.stop.pipe(Effect.catchAll(() => Effect.void))),
          Effect.ensuring(PubSub.shutdown(bus)),
          Effect.ensuring(Effect.sync(() => removeFileTree(configPath))),
        ),
      );

      const ensureAlive = () =>
        exited ? Effect.fail(problem("ProcessExited", "Claude process exited")) : Effect.void;
      const awaitInitialized = () =>
        Deferred.await(initialized).pipe(
          Effect.timeoutFail({
            duration: options.startupTimeoutMs ?? 15_000,
            onTimeout: () => problem("TransportError", "Claude did not initialize"),
          }),
        );
      const handle: SessionHandle = {
        cursor: { kind: "claude", data: { sessionId } },
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
                  problem("ProtocolError", "A Claude turn is already active"),
                );
              const current: Active = {
                id: randomUUID(),
                ended: yield* Deferred.make<void>(),
                stopping: false,
                report: "",
                sawStreamText: false,
                pendingSteers: new Set(),
                deferred: null,
                deferredReport: undefined,
                continuationGrace: undefined,
                continuationSilence: undefined,
              };
              active = current;
              transcript.push({
                role: "user",
                text: turn.text,
                turnId: current.id,
                at: Date.now(),
              });
              // Stream.fromPubSub subscribes in a scoped fiber. Yield once before the first
              // publication so a caller that subscribed immediately after startSession cannot
              // miss the synchronous turn-start event.
              yield* Effect.yieldNow();
              yield* publish({ kind: "turn.started", turnId: current.id });
              yield* transport.send(nativeUser(turn.text)).pipe(
                Effect.catchAll((error) =>
                  transport.stop.pipe(
                    Effect.catchAll(() => Effect.void),
                    Effect.zipRight(Effect.fail(error)),
                  ),
                ),
              );
              // Claude emits `system/init` in response to the first stream-json user frame,
              // so readiness is awaited after the prompt is written rather than at session open.
              yield* awaitInitialized();
            }),
          ),
        steer: (turn) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              yield* Schema.decodeUnknown(TurnInput)(turn).pipe(
                Effect.mapError((error) => problem("InvalidAnswer", String(error))),
              );
              if (!active || active.stopping || exited) return "refused" as const;
              const steerId = randomUUID();
              active.pendingSteers.add(steerId);
              yield* transport.send(nativeUser(turn.text, steerId)).pipe(
                Effect.catchAll((error) => {
                  active?.pendingSteers.delete(steerId);
                  return Effect.fail(error);
                }),
              );
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
            if (!ended) return;
            yield* transport.stop.pipe(Effect.catchAll(() => Effect.void));
            yield* Deferred.await(ended).pipe(
              Effect.timeoutFail({
                duration: options.interruptGraceMs ?? 8_000,
                onTimeout: () =>
                  problem("TransportError", "Claude did not acknowledge interruption"),
              }),
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
                    "This answer has already been submitted",
                  ),
                );
              const entry = pending.get(requestId);
              if (!entry || !active || active.id !== entry.turnId)
                return yield* Effect.fail(
                  problem("RequestExpired", "The original Claude question is no longer open"),
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
                  problem("InvalidAnswer", "Every question must be answered together"),
                );
              for (const question of entry.request.questions) {
                const perQuestion = answer.perQuestion.find(
                  (value) => value.questionId === question.id,
                );
                if (!perQuestion)
                  return yield* Effect.fail(
                    problem("InvalidAnswer", "Every question must be answered together"),
                  );
                if (!question.allowFreeText && perQuestion.text)
                  return yield* Effect.fail(
                    problem("InvalidAnswer", "Free text is not allowed for this question"),
                  );
                if (!question.multiSelect && (perQuestion.optionIds?.length ?? 0) > 1)
                  return yield* Effect.fail(
                    problem("InvalidAnswer", "Multiple options are not allowed for this question"),
                  );
                for (const optionId of perQuestion.optionIds ?? [])
                  if (!question.options?.some((option) => option.id === optionId))
                    return yield* Effect.fail(problem("InvalidAnswer", "Unknown question option"));
              }
              attempted.set(requestId, "indeterminate");
              yield* broker
                .answer(entry.brokerId, {
                  behavior: "answer",
                  message: answerText(entry.request, answer),
                })
                .pipe(Effect.mapError((error) => problem("DeliveryIndeterminate", error.message)));
              attempted.set(requestId, "delivered");
              pending.delete(requestId);
              yield* publish({ kind: "request.closed", requestId, reason: "answered" });
            }),
          ),
        fork: () => open(input, "fork", sessionId),
        transcript: () => Effect.succeed([...transcript]),
      };
      return handle;
    });

  const open = (
    input: StartSessionInput,
    mode: "start" | "resume" | "fork",
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
    kind: "claude",
    capabilities: claudeCapabilities,
    startSession: (input) => open(input, "start"),
    resumeSession: (cursor, input) =>
      Effect.gen(function* () {
        yield* Schema.decodeUnknown(ResumeCursor)(cursor).pipe(
          Effect.mapError((error) => problem("InvalidResponse", String(error))),
        );
        if (cursor.kind !== "claude")
          return yield* Effect.fail(
            problem("InvalidResponse", "Cursor belongs to another adapter"),
          );
        const value = yield* Schema.decodeUnknown(
          Schema.Struct({ sessionId: Schema.String.pipe(Schema.minLength(1)) }),
        )(cursor.data).pipe(Effect.mapError((error) => problem("InvalidResponse", String(error))));
        return yield* open(input, "resume", value.sessionId);
      }),
  };
};

export const ClaudeAdapterLive = (options: ClaudeOptions = {}) =>
  Layer.succeed(HarnessAdapter, makeClaudeAdapter(options));
