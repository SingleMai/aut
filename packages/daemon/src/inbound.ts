import { randomUUID } from "node:crypto";
import { type CoreError, EventBus, Store } from "@aut/core";
import { type MainThreadMessage, MessageId, SendMessageInput, UiAction } from "@aut/protocol";
import { Clock, Context, Effect, Layer, Option } from "effect";
import { AdmissionInbox } from "./admission.js";
import { DaemonError, decode } from "./errors.js";

export class InboundGateway extends Context.Tag("aut/InboundGateway")<
  InboundGateway,
  {
    readonly message: (
      input: SendMessageInput,
    ) => Effect.Effect<
      { readonly message: MainThreadMessage; readonly created: boolean },
      CoreError | DaemonError
    >;
    readonly action: (action: UiAction) => Effect.Effect<void, CoreError | DaemonError>;
  }
>() {}

export const InboundGatewayLive = Layer.effect(
  InboundGateway,
  Effect.gen(function* () {
    const store = yield* Store;
    const bus = yield* EventBus;
    const inbox = yield* AdmissionInbox;
    const serial = yield* Effect.makeSemaphore(1);
    return {
      message: (input) =>
        serial.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const checked = yield* decode(SendMessageInput, input);
              const id = checked.id ?? MessageId.make(randomUUID());
              const at = yield* Clock.currentTimeMillis;
              const event = { source: "user", kind: "message", messageId: id } as const;
              const result = yield* store.transaction((tx) =>
                Effect.gen(function* () {
                  const existing = yield* tx.get("main_thread_messages", id);
                  if (Option.isSome(existing)) {
                    if (
                      existing.value.author !== "user" ||
                      existing.value.kind !== "text" ||
                      existing.value.text !== checked.text
                    )
                      return yield* Effect.fail(
                        new DaemonError({
                          code: "Conflict",
                          message: "Message ID already contains different content",
                        }),
                      );
                    return { message: existing.value, created: false };
                  }
                  const message: MainThreadMessage = {
                    id,
                    at,
                    author: "user",
                    kind: "text",
                    text: checked.text,
                  };
                  yield* tx.insert("main_thread_messages", message);
                  yield* tx.insert("events", { id: `message:${id}`, at, event });
                  return { message, created: true };
                }),
              );
              if (result.created) {
                yield* inbox.offer({ id: `message:${id}`, at, event });
                yield* bus.publish(event);
              }
              return result;
            }),
          ),
        ),
      action: (input) =>
        serial.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const action = yield* decode(UiAction, input);
              const event = { source: "user", kind: "ui-action", action } as const;
              const at = yield* Clock.currentTimeMillis;
              const id = randomUUID();
              yield* store.transaction((tx) =>
                Effect.gen(function* () {
                  if (action.type === "quote-reply") {
                    const quoted = yield* tx.get("main_thread_messages", action.quotedMessageId);
                    if (Option.isNone(quoted))
                      return yield* Effect.fail(
                        new DaemonError({ code: "NotFound", message: "Unknown quoted message" }),
                      );
                    yield* tx.insert("main_thread_messages", {
                      id: MessageId.make(`quote:${id}`),
                      at,
                      author: "user",
                      kind: "text",
                      text: action.text,
                      ...(quoted.value.taskId === undefined ? {} : { taskId: quoted.value.taskId }),
                    });
                  }
                  yield* tx.insert("events", { id, at, event });
                }),
              );
              yield* inbox.offer({ id, at, event });
              yield* bus.publish(event);
            }),
          ),
        ),
    };
  }),
);
