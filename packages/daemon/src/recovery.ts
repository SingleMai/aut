import { expireTaskRequests, Store, saveTask, transitionTask } from "@aut/core";
import { type MainThreadMessage, MessageId } from "@aut/protocol";
import { Clock, Context, Effect, Layer } from "effect";
import { Ownership } from "./ownership.js";

export class Recovery extends Context.Tag("aut/DaemonRecovery")<
  Recovery,
  { readonly recovered: number }
>() {}

export const RecoveryLive = Layer.effect(
  Recovery,
  Effect.gen(function* () {
    yield* Ownership;
    const store = yield* Store;
    const recovered = yield* store.transaction((tx) =>
      Effect.gen(function* () {
        const tasks = yield* tx.list("tasks", { limit: Number.MAX_SAFE_INTEGER });
        const active = tasks.filter((task) =>
          ["created", "running", "waiting_user", "reporting"].includes(task.status),
        );
        if (active.length === 0) return 0;
        const now = yield* Clock.currentTimeMillis;
        for (const task of active) {
          yield* saveTask(tx, yield* transitionTask(task, { type: "daemon.restart" }, now));
          yield* expireTaskRequests(tx, task.id, now, "daemon.restart");
          const notice: MainThreadMessage = {
            id: MessageId.make(`recovery:${task.id}:${task.updatedAt}`),
            at: now,
            author: "chief",
            kind: "notice",
            taskId: task.id,
            text: `任务『${task.title}』因服务重启而中断，可继续。`,
          };
          yield* tx.insert("main_thread_messages", notice);
        }
        return active.length;
      }),
    );
    return { recovered };
  }),
);
