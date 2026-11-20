import type { MainThreadMessage, MessageId } from "@aut/protocol";
import { Context, Effect, Layer, type Option } from "effect";
import { withDispatch } from "./dispatch-correction.js";
import type { CoreError } from "./errors.js";
import { type PageOptions, Store, type StoreTransaction } from "./store.js";

/** Bulk reads use thread order in SQLite. Deliveries and explicit lookups follow the caller's IDs. */
export const messagesInOrder = (tx: StoreTransaction, ids: readonly MessageId[]) =>
  tx.messagesByIds(ids).pipe(
    Effect.map((rows) => {
      const byId = new Map(rows.map((message) => [message.id, message]));
      return ids.map((id) => byId.get(id)).filter((message) => message !== undefined);
    }),
  );

export class MainThread extends Context.Tag("aut/MainThread")<
  MainThread,
  {
    readonly append: (message: MainThreadMessage) => Effect.Effect<MainThreadMessage, CoreError>;
    readonly page: (
      options?: PageOptions,
    ) => Effect.Effect<readonly MainThreadMessage[], CoreError>;
    readonly get: (id: MessageId) => Effect.Effect<Option.Option<MainThreadMessage>, CoreError>;
    readonly getByIds: (
      ids: readonly MessageId[],
    ) => Effect.Effect<readonly MainThreadMessage[], CoreError>;
  }
>() {}

export const MainThreadLive = Layer.effect(
  MainThread,
  Effect.gen(function* () {
    const store = yield* Store;
    return {
      append: (message) =>
        store.transaction((tx) =>
          tx.insert("main_thread_messages", message).pipe(Effect.as(message)),
        ),
      page: (options = {}) =>
        store.transaction((tx) =>
          tx
            .list("main_thread_messages", options)
            .pipe(
              Effect.flatMap((rows) =>
                Effect.forEach(rows, (message) => withDispatch(tx, message)),
              ),
            ),
        ),
      get: (id) => store.transaction((tx) => tx.get("main_thread_messages", id)),
      getByIds: (ids) => store.transaction((tx) => messagesInOrder(tx, ids)),
    };
  }),
);
