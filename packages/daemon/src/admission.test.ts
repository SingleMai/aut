import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chief, CoreLive, Store, type StoredEvent } from "@aut/core";
import { type DecisionLog, MessageId } from "@aut/protocol";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import { AdmissionInbox, AdmissionInboxLive, ChiefIngress, ChiefIngressLive } from "./admission.js";
import { InboundGateway, InboundGatewayLive } from "./inbound.js";
import { Recovery } from "./recovery.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const core = () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-admission-"));
  directories.push(dataDirectory);
  return CoreLive({ dataDirectory });
};

it("admits persisted messages in order and deduplicates a retried HTTP message ID", async () => {
  const services = InboundGatewayLive.pipe(
    Layer.provideMerge(Layer.merge(core(), AdmissionInboxLive)),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* InboundGateway;
        const inbox = yield* AdmissionInbox;
        const store = yield* Store;
        const first = { id: MessageId.make("first"), text: "One" };
        expect((yield* gateway.message(first)).created).toBe(true);
        expect((yield* gateway.message(first)).created).toBe(false);
        yield* gateway.message({ id: MessageId.make("second"), text: "Two" });
        const received = [yield* inbox.take, yield* inbox.take];
        const records = yield* store.transaction((tx) => tx.list("events"));
        expect(received).toEqual(records);
        expect(received.map((event) => event.id)).toEqual(["message:first", "message:second"]);
      }).pipe(Effect.provide(services)),
    ),
  );
});

it("finishes the durable admission handoff even if the HTTP request is cancelled after commit", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const offered: StoredEvent[] = [];
        const layer = InboundGatewayLive.pipe(
          Layer.provideMerge(
            Layer.merge(
              core(),
              Layer.succeed(AdmissionInbox, {
                offer: (event) =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.zipRight(Deferred.await(release)),
                    Effect.zipRight(
                      Effect.sync(() => {
                        offered.push(event);
                      }),
                    ),
                  ),
                take: Effect.never,
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const gateway = yield* InboundGateway;
          const fiber = yield* Effect.fork(
            gateway.message({ id: MessageId.make("cancelled-http"), text: "Persist me" }),
          );
          yield* Deferred.await(entered);
          const interruption = yield* Effect.fork(Fiber.interrupt(fiber));
          yield* Effect.yieldNow();
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(interruption);
          expect(offered.map((record) => record.id)).toEqual(["message:cancelled-http"]);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
});

it("replays only unclassified events and gives an idempotent notice for uncertain registration", async () => {
  const services = Layer.mergeAll(
    core(),
    AdmissionInboxLive,
    Layer.succeed(Recovery, { recovered: 0 }),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store;
        const submitted: string[] = [];
        const received = yield* Deferred.make<void>();
        const pending: DecisionLog = {
          id: "old-decision",
          at: 1,
          tree: "inbound",
          treeVersion: "v1",
          input: { eventRef: "classified", state: {}, dynamicOptions: {} },
          classifierCalls: [],
          path: [],
          execution: { ok: false, error: "Execution pending" },
        };
        yield* store.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert("events", {
              id: "unclassified",
              at: 20,
              event: { source: "user", kind: "message", messageId: MessageId.make("a") },
            });
            yield* tx.insert("events", {
              id: "classified",
              at: 10,
              event: { source: "user", kind: "message", messageId: MessageId.make("b") },
            });
            yield* tx.insert("decision_logs", pending);
          }),
        );
        const chief = Layer.succeed(Chief, {
          submit: (_, eventRef = "missing") =>
            Effect.gen(function* () {
              submitted.push(eventRef);
              const id = `handled:${eventRef}`;
              yield* store.transaction((tx) =>
                Effect.gen(function* () {
                  yield* tx.insert("decision_logs", {
                    ...pending,
                    id,
                    input: { ...pending.input, eventRef },
                    execution: { ok: false, error: "Synthetic test fixture" },
                  });
                  yield* tx.insert("main_thread_messages", {
                    id: MessageId.make(`chief:${id}`),
                    at: 30,
                    author: "chief",
                    kind: "ack",
                    text: "已接收",
                    decisionLogId: id,
                  });
                }),
              );
              yield* Deferred.succeed(received, undefined);
              return {
                decisionLogId: id,
                awaitResult: Effect.succeed({ decisionLogId: id, execution: { ok: true } }),
              };
            }),
          propose: () => Effect.dieMessage("No proposal is expected during recovery"),
          results: Stream.empty,
        });
        const ingress = ChiefIngressLive.pipe(Layer.provide(chief));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const ready = yield* ChiefIngress;
            expect(ready.recovered).toBe(1);
            yield* Deferred.await(received);
          }).pipe(Effect.provide(ingress)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            expect((yield* ChiefIngress).recovered).toBe(0);
          }).pipe(Effect.provide(ingress)),
        );
        const messages = yield* store.transaction((tx) => tx.list("main_thread_messages"));
        expect(submitted).toEqual(["unclassified"]);
        expect(
          messages.filter((message) => message.kind === "notice").map((message) => message.id),
        ).toEqual(["inbound-recovery:classified"]);
        const log = yield* store.transaction((tx) => tx.get("decision_logs", "old-decision"));
        expect(log._tag === "Some" && log.value.execution.error).toContain("Interrupted");
      }).pipe(Effect.provide(services)),
    ),
  );
});
