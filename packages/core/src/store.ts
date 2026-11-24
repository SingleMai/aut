import type { BotId, MessageId, RequestId, TaskId } from "@aut/protocol";
import { Context, type Effect, type Option } from "effect";
import type { CoreError } from "./errors.js";
import type { StoreRecords, StoreTable } from "./storage-model.js";

export interface PageOptions {
  readonly before?: string;
  readonly limit?: number;
}

type Rows<K extends StoreTable> = Effect.Effect<readonly StoreRecords[K][], CoreError>;
export interface StoreTransaction {
  readonly get: <K extends StoreTable>(
    table: K,
    id: string,
  ) => Effect.Effect<Option.Option<StoreRecords[K]>, CoreError>;
  readonly insert: <K extends StoreTable>(
    table: K,
    value: StoreRecords[K],
  ) => Effect.Effect<void, CoreError>;
  readonly set: <K extends StoreTable>(
    table: K,
    value: StoreRecords[K],
  ) => Effect.Effect<void, CoreError>;
  readonly list: <K extends StoreTable>(
    table: K,
    options?: PageOptions,
  ) => Effect.Effect<readonly StoreRecords[K][], CoreError>;
  readonly messagesByIds: (ids: readonly MessageId[]) => Rows<"main_thread_messages">;
  readonly referencedFileIds: (
    ids: readonly string[],
  ) => Effect.Effect<readonly string[], CoreError>;
  readonly messagesByCardId: (cardId: string) => Rows<"main_thread_messages">;
  readonly cardsForRequest: (id: RequestId) => Rows<"main_thread_messages">;
  readonly openTaskCards: (id: TaskId) => Rows<"main_thread_messages">;
  readonly openRequests: (id?: TaskId) => Rows<"session_requests">;
  readonly botHasTasks: (id: BotId) => Effect.Effect<boolean, CoreError>;
  readonly forgetBotCreation: (id: BotId) => Effect.Effect<void, CoreError>;
  readonly userEvents: Rows<"events">;
  readonly latestDecisionForEvent: (
    eventRef: string,
  ) => Effect.Effect<Option.Option<StoreRecords["decision_logs"]>, CoreError>;
}

export class Store extends Context.Tag("aut/Store")<
  Store,
  {
    readonly transaction: <A, E, R>(
      body: (tx: StoreTransaction) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | CoreError, R>;
  }
>() {}
