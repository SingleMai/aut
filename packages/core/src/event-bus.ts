import { AutEvent } from "@aut/protocol";
import { Context, Effect, Layer, PubSub, type Queue, type Scope } from "effect";
import { type CoreError, validate } from "./errors.js";

export class EventBus extends Context.Tag("aut/EventBus")<
  EventBus,
  {
    readonly publish: (event: AutEvent) => Effect.Effect<void, CoreError>;
    readonly subscribe: Effect.Effect<Queue.Dequeue<AutEvent>, never, Scope.Scope>;
  }
>() {}

export const EventBusLive = Layer.scoped(
  EventBus,
  Effect.gen(function* () {
    const bus = yield* Effect.acquireRelease(PubSub.unbounded<AutEvent>(), PubSub.shutdown);
    return {
      publish: (event) =>
        validate(AutEvent, event).pipe(
          Effect.flatMap((checked) => PubSub.publish(bus, checked)),
          Effect.asVoid,
        ),
      subscribe: PubSub.subscribe(bus),
    };
  }),
);
