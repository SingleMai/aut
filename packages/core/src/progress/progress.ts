import { isDeepStrictEqual } from "node:util";
import {
  type AdapterError,
  type HarnessAdapter,
  type MainThreadMessage,
  MessageId,
  Op,
  type SessionHandle,
  type StartSessionInput,
} from "@aut/protocol";
import { Cause, Clock, Context, Effect, Layer, Option } from "effect";
import type { RegisteredExecution } from "../chief/ports.js";
import { ConfigStore } from "../config-store.js";
import { CoreError, validate } from "../errors.js";
import { runIsolatedTurn, temporarySessionInput } from "../isolated-turn.js";
import { reportSources } from "../report-sources.js";
import { SessionManager } from "../session-manager/manager.js";
import {
  HarnessResolver,
  SessionReplyGate,
  SessionSetup,
  type SessionSnapshot,
} from "../session-manager/ports.js";
import { Store } from "../store.js";
import { fastProgressText } from "./template.js";

export type AskOp = Extract<Op, { readonly op: "ask" }>;
export interface ProgressOptions {
  readonly queryTimeoutMs?: number;
}
export class ProgressQuery extends Context.Tag("aut/ProgressQuery")<
  ProgressQuery,
  {
    readonly register: (
      op: AskOp,
      decisionLogId: string,
    ) => Effect.Effect<RegisteredExecution, CoreError>;
  }
>() {}
const fault = (message: string) => new CoreError({ code: "InvalidRequest", message });
const adapterError = (error: AdapterError) =>
  fault(`The isolated progress query failed (${error.code}).`);
const queryInstructions =
  "Answer the user's progress question using only evidence already present in the task session or supplied transcript. Do not continue the original task, change files or settings, or create tasks. Do not ask follow-up questions. Clearly state what is known and what is still unknown. Reply briefly in the user's language.";
interface Source {
  readonly session: Pick<SessionHandle, "cursor" | "fork" | "transcript">;
  readonly adapter: HarnessAdapter;
  readonly input: StartSessionInput;
}

export const ProgressQueryLive = (options: ProgressOptions = {}) =>
  Layer.scoped(
    ProgressQuery,
    Effect.gen(function* () {
      const store = yield* Store;
      const config = yield* ConfigStore;
      const manager = yield* SessionManager;
      const resolver = yield* HarnessResolver;
      const setup = yield* SessionSetup;
      const gate = yield* SessionReplyGate;
      const scope = yield* Effect.scope;
      const semaphore = yield* Effect.makeSemaphore(1);
      const registrations = new Map<string, RegisteredExecution>();
      yield* Effect.addFinalizer(() => Effect.sync(() => registrations.clear()));
      const timeoutMs = options.queryTimeoutMs ?? 120_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
        return yield* Effect.fail(
          new CoreError({
            code: "Configuration",
            message: "Progress query timeout must be a positive safe integer",
          }),
        );

      const persistResult = (
        id: string,
        message: MainThreadMessage,
        execution: {
          readonly ok: boolean;
          readonly error?: string;
          readonly degraded?: readonly string[];
        },
      ) =>
        store.transaction((tx) =>
          Effect.gen(function* () {
            if (Option.isSome(yield* tx.get("main_thread_messages", message.id))) return;
            const log = yield* tx.get("decision_logs", id);
            if (Option.isNone(log))
              return yield* Effect.fail(fault("The progress decision log is missing."));
            yield* tx.insert("main_thread_messages", message);
            yield* tx.set("decision_logs", { ...log.value, execution });
          }),
        );
      const resumeSource = (snapshot: SessionSnapshot) =>
        Effect.gen(function* () {
          const task = snapshot.task;
          const adapter = yield* resolver.resolve(task.session.instanceId);
          if (!task.session.cursor || !adapter.capabilities.resume)
            return yield* Effect.fail(
              fault("No resumable session context is available for this progress query."),
            );
          const bot = (yield* config.readBots).find((value) => value.id === task.botId);
          if (!bot) return yield* Effect.fail(fault("The task bot configuration is unavailable."));
          const input = yield* setup.prepare(task, bot);
          const session = yield* adapter
            .resumeSession(task.session.cursor, input)
            .pipe(Effect.mapError(adapterError));
          return { session, adapter, input } satisfies Source;
        });
      const childFor = (source: Source) =>
        Effect.gen(function* () {
          if (source.adapter.capabilities.fork)
            return {
              child: yield* source.session.fork().pipe(Effect.mapError(adapterError)),
              source,
              transcript: undefined,
            };
          if (!source.adapter.capabilities.transcript)
            return yield* Effect.fail(
              fault("The harness supports neither a fork nor transcript access."),
            );
          const transcript = yield* source.session.transcript().pipe(Effect.mapError(adapterError));
          const input = temporarySessionInput(source.input, queryInstructions);
          return {
            child: yield* source.adapter.startSession(input).pipe(Effect.mapError(adapterError)),
            source: { ...source, input },
            transcript,
          };
        });
      const deep = (op: AskOp, id: string, question: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const snapshot = yield* manager.snapshot(op.taskId);
            const initial = snapshot.live ?? (yield* resumeSource(snapshot));
            const isolated = yield* childFor(initial).pipe(
              Effect.catchAll((error) => {
                if (!snapshot.live || !snapshot.task.session.cursor) return Effect.fail(error);
                return resumeSource(snapshot).pipe(Effect.flatMap(childFor));
              }),
            );
            const { child, source, transcript } = isolated;
            const prompt = `${queryInstructions}\n\n<question>\n${question}\n</question>${transcript === undefined ? "" : `\n\n<transcript>\n${JSON.stringify(transcript)}\n</transcript>`}`;
            const completedReport = yield* runIsolatedTurn(store, {
              session: child,
              taskId: op.taskId,
              eventPrefix: `progress:${id}`,
              input: { text: prompt, messageIds: [op.messageId] },
            });
            const result = yield* gate.check({
              task: snapshot.task,
              report: completedReport.report,
              reportEventId: completedReport.eventId,
              session: child,
              adapter: source.adapter,
              sessionInput: source.input,
            });
            const at = yield* Clock.currentTimeMillis;
            yield* persistResult(
              id,
              {
                id: MessageId.make(`progress:${id}`),
                at,
                author: { botId: snapshot.task.botId, taskId: op.taskId },
                kind: "reply",
                text: result.delivered,
                taskId: op.taskId,
                fullReportRef: `event:${completedReport.eventId}`,
                sources: reportSources(completedReport.report),
                decisionLogId: id,
              },
              {
                ok: true,
                ...(transcript === undefined
                  ? {}
                  : { degraded: ["ask.deep: temporary session with transcript"] }),
              },
            );
          }),
        ).pipe(
          Effect.timeoutFail({
            duration: timeoutMs,
            onTimeout: () => fault("The isolated progress query timed out."),
          }),
        );
      const fast = (op: AskOp, id: string) =>
        Effect.gen(function* () {
          const task = yield* store
            .transaction((tx) => tx.get("tasks", op.taskId))
            .pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(fault("The task is unavailable.")),
                  onSome: Effect.succeed,
                }),
              ),
            );
          const bot = (yield* config.readBots).find((value) => value.id === task.botId);
          const at = yield* Clock.currentTimeMillis;
          yield* persistResult(
            id,
            {
              id: MessageId.make(`progress:${id}`),
              at,
              author: "chief",
              kind: "reply",
              text: fastProgressText(task, bot?.name ?? task.botId),
              taskId: task.id,
              decisionLogId: id,
            },
            { ok: true },
          );
        });
      return {
        register: (input, decisionLogId) =>
          semaphore.withPermits(1)(
            Effect.gen(function* () {
              const checked = yield* validate(Op, input);
              if (checked.op !== "ask")
                return yield* Effect.fail(fault("ProgressQuery only accepts ask operations."));

              const registration = yield* store.transaction((tx) =>
                Effect.gen(function* () {
                  const log = yield* tx.get("decision_logs", decisionLogId);
                  if (Option.isNone(log) || !isDeepStrictEqual(log.value.output, checked))
                    return yield* Effect.fail(
                      fault("The ask operation does not match its persisted decision log."),
                    );
                  const task = yield* tx.get("tasks", checked.taskId);
                  const message = yield* tx.get("main_thread_messages", checked.messageId);
                  if (
                    Option.isNone(task) ||
                    Option.isNone(message) ||
                    message.value.author !== "user"
                  )
                    return yield* Effect.fail(
                      fault("The progress query requires an existing task and user message."),
                    );
                  return {
                    message: message.value,
                    previous: yield* tx.get("main_thread_messages", `progress:${decisionLogId}`),
                    execution: log.value.execution,
                  };
                }),
              );
              if (Option.isSome(registration.previous))
                return { execution: registration.execution };
              const current = registrations.get(decisionLogId);
              if (current) return current;
              let activated = false;
              const work = (
                checked.mode === "fast"
                  ? fast(checked, decisionLogId)
                  : deep(checked, decisionLogId, registration.message.text)
              ).pipe(
                Effect.catchAllCause((cause) =>
                  Effect.gen(function* () {
                    const at = yield* Clock.currentTimeMillis;
                    const error = Cause.isInterruptedOnly(cause)
                      ? "The progress query was interrupted."
                      : Cause.failureOption(cause).pipe(
                          Option.match({
                            onNone: () => "The progress query failed unexpectedly.",
                            onSome: (value) => value.message,
                          }),
                        );
                    yield* persistResult(
                      decisionLogId,
                      {
                        id: MessageId.make(`progress:${decisionLogId}`),
                        at,
                        author: "chief",
                        kind: "notice",
                        text: "这次进度查询未能完成。请在主会话补充问题或稍后重试；原任务不受影响。",
                        taskId: checked.taskId,
                        decisionLogId,
                      },
                      { ok: false, error },
                    );
                  }).pipe(Effect.uninterruptible),
                ),
                Effect.ensuring(Effect.sync(() => registrations.delete(decisionLogId))),
              );
              const activate = Effect.uninterruptible(
                Effect.gen(function* () {
                  if (activated) return;
                  activated = true;
                  yield* work.pipe(
                    Effect.interruptible,
                    Effect.catchAll(() =>
                      Effect.logError("Failed to persist progress query outcome"),
                    ),
                    Effect.forkIn(scope),
                  );
                }),
              );
              const registered: RegisteredExecution = { execution: { ok: true }, activate };
              registrations.set(decisionLogId, registered);
              return registered;
            }),
          ),
      };
    }),
  );
