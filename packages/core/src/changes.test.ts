import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageId, TaskId } from "@aut/protocol";
import {
  Context,
  Deferred,
  Effect,
  Either,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Scope,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Changes, ChangesLive } from "./changes.js";
import { ConfigStore } from "./config-store.js";
import { CoreError } from "./errors.js";
import { CoreLive } from "./index.js";
import { emptyExecution } from "./session-manager/model.js";
import { StoreLive } from "./sqlite-store.js";
import { Store } from "./store.js";

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "aut-changes-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const message = (id: string) => ({
  id: MessageId.make(id),
  at: 1,
  author: "chief" as const,
  kind: "ack" as const,
  text: "Acknowledged",
});

describe("committed resource changes", () => {
  it("publishes one unique resource set after commit, and none for reads, no-op writes or rollback", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* Store;
          const queue = yield* (yield* Changes).subscribe;
          yield* store.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert("main_thread_messages", message("m1"));
              yield* tx.insert("main_thread_messages", message("m2"));
              yield* tx.insert("sessions", {
                id: TaskId.make("t1"),
                instanceId: "local",
                execution: emptyExecution(),
              });
              expect(yield* Queue.size(queue)).toBe(0);
            }),
          );
          expect(yield* Queue.take(queue)).toEqual({
            type: "changed",
            resources: ["messages", "tasks"],
          });
          const persisted = yield* store.transaction((tx) => tx.get("main_thread_messages", "m1"));
          expect(Option.isSome(persisted)).toBe(true);
          yield* store.transaction((tx) => tx.set("main_thread_messages", message("m1")));
          yield* store.transaction((tx) =>
            tx.insert("events", {
              id: "e1",
              at: 1,
              event: { source: "user", kind: "message", messageId: MessageId.make("m1") },
            }),
          );
          const failed = yield* Effect.either(
            store.transaction((tx) =>
              tx
                .insert("main_thread_messages", message("rolled-back"))
                .pipe(
                  Effect.zipRight(
                    Effect.fail(new CoreError({ code: "Conflict", message: "Rollback" })),
                  ),
                ),
            ),
          );
          expect(Either.isLeft(failed)).toBe(true);
          expect(
            Option.isNone(
              yield* store.transaction((tx) => tx.get("main_thread_messages", "rolled-back")),
            ),
          ).toBe(true);
          expect(yield* Queue.size(queue)).toBe(0);
        }).pipe(Effect.provide(CoreLive({ dataDirectory: directory() }))),
      ),
    );
  });

  it("cannot be cancelled between durable commit and the change notification", async () => {
    const path = directory();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const changes = yield* Changes;
          const queue = yield* changes.subscribe;
          const delayed = Layer.succeed(Changes, {
            subscribe: changes.subscribe,
            publish: (resources) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.zipRight(Deferred.await(release)),
                Effect.zipRight(changes.publish(resources)),
              ),
          });
          const context = yield* Layer.buildWithScope(
            StoreLive({ dataDirectory: path }).pipe(Layer.provide(delayed)),
            yield* Scope.Scope,
          );
          const store = Context.get(context, Store);
          const worker = yield* store
            .transaction((tx) => tx.insert("main_thread_messages", message("committed")))
            .pipe(Effect.fork);
          yield* Deferred.await(entered);
          yield* Fiber.interruptFork(worker);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.await(worker);
          expect(yield* Queue.take(queue)).toEqual({ type: "changed", resources: ["messages"] });
        }).pipe(Effect.provide(ChangesLive)),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          expect(
            Option.isSome(
              yield* (yield* Store).transaction((tx) =>
                tx.get("main_thread_messages", "committed"),
              ),
            ),
          ).toBe(true);
        }).pipe(Effect.provide(CoreLive({ dataDirectory: path }))),
      ),
    );
  });

  it("notifies successful JSON saves and closes subscriptions with their scopes", async () => {
    const path = directory();
    const queue = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ConfigStore;
          const changes = yield* Changes;
          const queue = yield* changes.subscribe;
          yield* store.readConfig;
          expect(yield* Queue.size(queue)).toBe(0);
          yield* store.writeConfig({ harnessInstances: [] });
          expect(yield* Queue.take(queue)).toEqual({ type: "changed", resources: ["config"] });
          expect(JSON.parse(readFileSync(join(path, "config.json"), "utf8"))).toEqual({
            harnessInstances: [],
          });
          yield* store.writeBots([]);
          expect(yield* Queue.take(queue)).toEqual({ type: "changed", resources: ["bots"] });
          const failed = yield* Effect.either(
            store.writeConfig({ harnessInstances: [], unknown: true } as never),
          );
          expect(Either.isLeft(failed)).toBe(true);
          expect(yield* Queue.size(queue)).toBe(0);
          const childScope = yield* Scope.make();
          const child = yield* Scope.extend(changes.subscribe, childScope);
          yield* Scope.close(childScope, Exit.succeed(undefined));
          expect(yield* Queue.isShutdown(child)).toBe(true);
          return queue;
        }).pipe(Effect.provide(CoreLive({ dataDirectory: path }))),
      ),
    );
    expect(await Effect.runPromise(Queue.isShutdown(queue))).toBe(true);
  });
});
