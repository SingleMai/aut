import { randomUUID } from "node:crypto";
import {
  SessionEvent,
  type SessionHandle,
  type StartSessionInput,
  type TaskId,
  type TurnInput,
} from "@aut/protocol";
import { Clock, Deferred, Effect, Stream } from "effect";
import { CoreError, validate } from "./errors.js";
import type { Store } from "./store.js";

export const temporarySessionInput = (
  input: StartSessionInput,
  instructions: string,
): StartSessionInput => ({
  ...input,
  instructions,
  bot: { ...input.bot, soul: "" },
  mcpServers: [],
});

/** The adapter owns permissions. Internal questions end this child without an answer. */
export const runIsolatedTurn = (
  store: typeof Store.Service,
  options: {
    readonly session: Pick<SessionHandle, "events" | "startTurn">;
    readonly taskId: TaskId;
    readonly eventPrefix: string;
    readonly input: TurnInput;
  },
) =>
  Effect.gen(function* () {
    const { session, taskId, eventPrefix, input } = options;
    const completed = yield* Deferred.make<
      { readonly report: string; readonly eventId: string },
      CoreError
    >();
    const failure = (message: string) => new CoreError({ code: "InvalidRequest", message });
    let turnId: string | undefined;
    const observe = Stream.runForEach(session.events, (raw) =>
      Effect.gen(function* () {
        const event = yield* validate(SessionEvent, raw);
        const eventId = `${eventPrefix}:${randomUUID()}`;
        const at = yield* Clock.currentTimeMillis;
        yield* store.transaction((tx) =>
          tx.insert("events", {
            id: eventId,
            at,
            event: { source: "session", taskId, kind: event.kind, event },
          }),
        );
        switch (event.kind) {
          case "turn.started":
            turnId ??= event.turnId;
            break;
          case "turn.completed":
            if (event.turnId !== turnId) break;
            if (!event.ok || !event.finalReport.trim())
              return yield* Effect.fail(
                failure("The isolated turn ended without a successful report."),
              );
            yield* Deferred.succeed(completed, { report: event.finalReport, eventId });
            break;
          case "turn.failed":
            if (event.turnId === turnId)
              return yield* Effect.fail(failure("The isolated turn failed."));
            break;
          case "process.exited":
            return yield* Effect.fail(failure("The isolated session exited."));
          case "request.opened":
            if (event.request.kind === "question")
              return yield* Effect.fail(
                failure("The isolated turn requested additional user input."),
              );
            break;
        }
      }),
    ).pipe(
      Effect.zipRight(Effect.fail(failure("The isolated event stream ended before a report."))),
      Effect.catchAllCause((cause) => Deferred.failCause(completed, cause)),
    );
    yield* Effect.forkScoped(observe);
    // Subscribe to the child before startTurn can publish its first event.
    yield* Effect.yieldNow();
    const [report] = yield* Effect.all(
      [
        Deferred.await(completed),
        session
          .startTurn(input)
          .pipe(
            Effect.mapError((error) =>
              failure(`The isolated turn could not start (${error.code}).`),
            ),
          ),
      ],
      { concurrency: "unbounded" },
    );
    return report;
  });
