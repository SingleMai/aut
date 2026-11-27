import { Chief, Store, type StoredEvent, type StoreTransaction } from "@aut/core";
import { type ClassifierErrorCode, MessageId } from "@aut/protocol";
import { Cause, Clock, Context, Effect, Layer, Option, Queue } from "effect";
import { Recovery } from "./recovery.js";

export class AdmissionInbox extends Context.Tag("aut/AdmissionInbox")<
  AdmissionInbox,
  {
    readonly offer: (event: StoredEvent) => Effect.Effect<void>;
    readonly take: Effect.Effect<StoredEvent>;
  }
>() {}

export const AdmissionInboxLive = Layer.scoped(
  AdmissionInbox,
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(Queue.unbounded<StoredEvent>(), Queue.shutdown);
    return {
      offer: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
      take: Queue.take(queue),
    };
  }),
);

export class ChiefIngress extends Context.Tag("aut/ChiefIngress")<
  ChiefIngress,
  { readonly recovered: number }
>() {}

const failureNotice = (
  tx: StoreTransaction,
  eventId: string,
  decisionLogId?: string,
  classifierFailure?: ClassifierErrorCode,
) =>
  Effect.gen(function* () {
    const id = MessageId.make(`inbound-failure:${eventId}`);
    if (Option.isSome(yield* tx.get("main_thread_messages", id))) return;
    yield* tx.insert("main_thread_messages", {
      id,
      at: yield* Clock.currentTimeMillis,
      author: "chief",
      kind: "notice",
      text:
        classifierFailure === "NotConfigured"
          ? "消息分配失败。请在「设置 → 快脑模型」检查服务和密钥，然后重新发送。"
          : classifierFailure
            ? "消息分配失败。快脑服务暂时不可用，请稍后重新发送。"
            : "这条消息暂时未能处理。请检查任务或设置后重试；详情见决策日志。",
      ...(decisionLogId ? { decisionLogId } : {}),
    });
  });

export const ChiefIngressLive = Layer.scoped(
  ChiefIngress,
  Effect.gen(function* () {
    yield* Recovery;
    const inbox = yield* AdmissionInbox;
    const chief = yield* Chief;
    const store = yield* Store;
    const scope = yield* Effect.scope;
    const pending = yield* store.transaction((tx) =>
      Effect.gen(function* () {
        const events = yield* tx.userEvents;
        const now = yield* Clock.currentTimeMillis;
        const unprocessed: StoredEvent[] = [];
        for (const event of events) {
          const decision = yield* tx.latestDecisionForEvent(event.id);
          if (Option.isNone(decision)) {
            unprocessed.push(event);
            continue;
          }
          const log = decision.value;
          if (log.execution.classifierFailure) {
            yield* failureNotice(tx, event.id, log.id, log.execution.classifierFailure);
            continue;
          }
          const acknowledgement = yield* tx.get("main_thread_messages", `chief:${log.id}`);
          const failed = yield* tx.get("main_thread_messages", `inbound-failure:${event.id}`);
          const progressMissing =
            log.output !== undefined &&
            "op" in log.output &&
            log.output.op === "ask" &&
            Option.isNone(yield* tx.get("main_thread_messages", `progress:${log.id}`));
          if (
            log.execution.error === "Execution pending" ||
            (Option.isNone(acknowledgement) && Option.isNone(failed)) ||
            progressMissing
          ) {
            const id = MessageId.make(`inbound-recovery:${event.id}`);
            if (Option.isNone(yield* tx.get("main_thread_messages", id)))
              yield* tx.insert("main_thread_messages", {
                id,
                at: now,
                author: "chief",
                kind: "notice",
                text: "该条消息的上次处理因服务重启未确认完成。请查看任务状态，或在主会话重新发送。",
                decisionLogId: log.id,
              });
            if (log.execution.error === "Execution pending")
              yield* tx.set("decision_logs", {
                ...log,
                execution: {
                  ok: false,
                  error: "Interrupted: Operation registration was not confirmed before restart.",
                },
              });
          }
        }
        return unprocessed;
      }),
    );
    for (const event of pending) yield* inbox.offer(event);
    // Retain only work awaiting a receipt. Completed IDs are deduplicated by their durable log.
    const seen = new Set<string>();
    yield* Effect.forever(
      inbox.take.pipe(
        Effect.flatMap((record) =>
          Effect.gen(function* () {
            if (seen.has(record.id)) return;
            const logged = yield* store.transaction((tx) => tx.latestDecisionForEvent(record.id));
            if (Option.isSome(logged)) return;
            seen.add(record.id);
            const receipt = yield* chief.submit(record.event, record.id);
            yield* receipt.awaitResult.pipe(
              Effect.flatMap((result) =>
                result.execution.ok
                  ? Effect.void
                  : store.transaction((tx) =>
                      failureNotice(
                        tx,
                        record.id,
                        result.decisionLogId,
                        result.execution.classifierFailure,
                      ),
                    ),
              ),
              Effect.catchAllCause((cause) =>
                Cause.isInterruptedOnly(cause)
                  ? Effect.void
                  : Effect.logError("Failed to persist inbound outcome"),
              ),
              Effect.ensuring(Effect.sync(() => seen.delete(record.id))),
              Effect.forkIn(scope),
            );
          }).pipe(
            Effect.catchAllCause((cause) => {
              seen.delete(record.id);
              return Cause.isInterruptedOnly(cause)
                ? Effect.failCause(cause)
                : store
                    .transaction((tx) => failureNotice(tx, record.id))
                    .pipe(
                      Effect.catchAll(() =>
                        Effect.logError("Failed to persist inbound admission failure"),
                      ),
                    );
            }),
          ),
        ),
      ),
    ).pipe(Effect.forkScoped);
    return { recovered: pending.length };
  }),
);
