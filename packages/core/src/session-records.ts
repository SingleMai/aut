import type { ReportResponse, RequestId, RequestResponse } from "@aut/protocol";
import { Context, Effect, Layer, Option } from "effect";
import { CoreError } from "./errors.js";
import { Store } from "./store.js";

export class SessionRecords extends Context.Tag("aut/SessionRecords")<
  SessionRecords,
  {
    readonly readRequest: (id: RequestId) => Effect.Effect<typeof RequestResponse.Type, CoreError>;
    readonly readReport: (ref: string) => Effect.Effect<typeof ReportResponse.Type, CoreError>;
  }
>() {}

export const SessionRecordsLive = Layer.effect(
  SessionRecords,
  Effect.gen(function* () {
    const store = yield* Store;
    return {
      readRequest: (id) =>
        Effect.gen(function* () {
          const record = yield* store.transaction((tx) => tx.get("session_requests", id));
          if (Option.isNone(record))
            return yield* Effect.fail(
              new CoreError({ code: "NotFound", message: "Unknown request" }),
            );
          const { request, answerClaim } = record.value;
          return {
            request,
            ...(answerClaim ? { answerState: answerClaim.phase } : {}),
            ...(request.kind === "question" && answerClaim?.phase === "delivered"
              ? { deliveredAnswer: answerClaim.answer }
              : {}),
          };
        }),
      readReport: (ref) =>
        Effect.gen(function* () {
          const record = ref.startsWith("event:")
            ? yield* store.transaction((tx) => tx.get("events", ref.slice("event:".length)))
            : Option.none();
          if (
            Option.isNone(record) ||
            record.value.event.source !== "session" ||
            record.value.event.event.kind !== "turn.completed" ||
            !record.value.event.event.ok
          )
            return yield* Effect.fail(
              new CoreError({ code: "NotFound", message: "Unknown completed report" }),
            );
          return { ref, text: record.value.event.event.finalReport };
        }),
    };
  }),
);
