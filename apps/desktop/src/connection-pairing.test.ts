import { Deferred, Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import {
  ConnectionPairing,
  ConnectionPairingLive,
  decodeConnectionCode,
  encodeConnectionCode,
} from "./connection-pairing.js";

const info = {
  version: 1 as const,
  hostId: "host",
  nodeId: "node",
  name: "办公室 Pro",
  token: "a".repeat(64),
};
it("accepts copied codes and old JSON without requiring manual network fields", async () => {
  for (const text of [encodeConnectionCode(info), JSON.stringify(info)])
    expect(await Effect.runPromise(decodeConnectionCode(`  ${text}\n`))).toEqual(info);
  for (const text of [
    "100.68.106.67",
    "aut-connect:invalid!",
    JSON.stringify({ ...info, version: 2 }),
    JSON.stringify({ ...info, extra: true }),
    "a".repeat(4097),
  ]) {
    const result = await Effect.runPromise(Effect.either(decodeConnectionCode(text)));
    expect(result._tag).toBe("Left");
    expect(JSON.stringify(result)).not.toContain(info.token);
  }
});
it("previews only identity, isolates windows, and invalidates overwritten or cancelled drafts", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* ConnectionPairing;
      const first = yield* service.inspect(1, Effect.succeed(encodeConnectionCode(info)));
      expect(Object.keys(first).sort()).toEqual(["hostId", "id", "name"]);
      expect(yield* service.read(1, first.id)).toEqual(info);
      expect((yield* Effect.either(service.read(2, first.id)))._tag).toBe("Left");
      const second = yield* service.inspect(
        1,
        Effect.succeed(JSON.stringify({ ...info, hostId: "other" })),
      );
      expect((yield* Effect.either(service.read(1, first.id)))._tag).toBe("Left");
      yield* service.clear(1);
      expect((yield* Effect.either(service.read(1, second.id)))._tag).toBe("Left");
      const third = yield* service.inspect(1, Effect.succeed(JSON.stringify(info)));
      yield* Effect.either(service.inspect(1, Effect.succeed("bad input")));
      expect((yield* Effect.either(service.read(1, third.id)))._tag).toBe("Left");
    }).pipe(Effect.provide(ConnectionPairingLive)),
  );
});
it("does not restore a cancelled draft when clipboard access finishes late", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* ConnectionPairing;
      const started = yield* Deferred.make<void>();
      const clipboard = yield* Deferred.make<string>();
      const task = yield* Effect.fork(
        service
          .inspect(
            1,
            Deferred.succeed(started, undefined).pipe(Effect.zipRight(Deferred.await(clipboard))),
          )
          .pipe(Effect.either),
      );
      yield* Deferred.await(started);
      yield* service.clear(1);
      yield* Deferred.succeed(clipboard, JSON.stringify(info));
      expect((yield* Fiber.join(task))._tag).toBe("Left");
    }).pipe(Effect.provide(ConnectionPairingLive)),
  );
});
