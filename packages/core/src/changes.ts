import type { DaemonResource, ResourcesChanged } from "@aut/protocol";
import { Context, Effect, Layer, PubSub, type Queue, type Scope } from "effect";

export class Changes extends Context.Tag("aut/Changes")<
  Changes,
  {
    readonly publish: (resources: readonly DaemonResource[]) => Effect.Effect<void>;
    readonly subscribe: Effect.Effect<Queue.Dequeue<ResourcesChanged>, never, Scope.Scope>;
  }
>() {}

export const ChangesLive = Layer.scoped(
  Changes,
  Effect.gen(function* () {
    const bus = yield* Effect.acquireRelease(PubSub.unbounded<ResourcesChanged>(), PubSub.shutdown);
    return {
      publish: (resources) =>
        Effect.suspend(() => {
          const [first, ...rest] = new Set(resources);
          return first === undefined
            ? Effect.void
            : PubSub.publish(bus, {
                type: "changed",
                resources: [first, ...rest],
              }).pipe(Effect.asVoid);
        }),
      subscribe: PubSub.subscribe(bus),
    };
  }),
);
