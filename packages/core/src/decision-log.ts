import { DecisionCorrection, DecisionLog as DecisionLogRecord } from "@aut/protocol";
import { Context, Effect, Layer, Option } from "effect";
import { CoreError, validate } from "./errors.js";
import { Store } from "./store.js";

export class DecisionLog extends Context.Tag("aut/DecisionLog")<
  DecisionLog,
  {
    readonly write: (log: DecisionLogRecord) => Effect.Effect<DecisionLogRecord, CoreError>;
    readonly get: (id: string) => Effect.Effect<Option.Option<DecisionLogRecord>, CoreError>;
    readonly correct: (
      id: string,
      correction: DecisionCorrection,
    ) => Effect.Effect<DecisionLogRecord, CoreError>;
    readonly complete: (
      id: string,
      execution: DecisionLogRecord["execution"],
    ) => Effect.Effect<DecisionLogRecord, CoreError>;
  }
>() {}

export const DecisionLogLive = Layer.effect(
  DecisionLog,
  Effect.gen(function* () {
    const store = yield* Store;
    return {
      write: (log) =>
        store.transaction((tx) => tx.insert("decision_logs", log).pipe(Effect.as(log))),
      get: (id) => store.transaction((tx) => tx.get("decision_logs", id)),
      correct: (id, correction) =>
        store.transaction((tx) =>
          Effect.gen(function* () {
            const checked = yield* validate(DecisionCorrection, correction);
            const previous = yield* tx.get("decision_logs", id);
            if (Option.isNone(previous))
              return yield* Effect.fail(
                new CoreError({ code: "NotFound", message: `Unknown decision log: ${id}` }),
              );
            const next = { ...previous.value, correction: checked };
            yield* tx.set("decision_logs", next);
            return next;
          }),
        ),
      complete: (id, execution) =>
        store.transaction((tx) =>
          Effect.gen(function* () {
            const previous = yield* tx.get("decision_logs", id);
            if (Option.isNone(previous))
              return yield* Effect.fail(
                new CoreError({ code: "NotFound", message: `Unknown decision log: ${id}` }),
              );
            const next = yield* validate(DecisionLogRecord, { ...previous.value, execution });
            yield* tx.set("decision_logs", next);
            return next;
          }),
        ),
    };
  }),
);
