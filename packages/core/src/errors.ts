import { Data, Effect, Schema } from "effect";

export class CoreError extends Data.TaggedError("CoreError")<{
  readonly code:
    | "Storage"
    | "Validation"
    | "NotFound"
    | "Conflict"
    | "InvalidTransition"
    | "InvalidRequest"
    | "ImmutableField"
    | "Configuration";
  readonly message: string;
  readonly detail?: string;
}> {}

export const boundary = <A>(message: string, operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) => new CoreError({ code: "Storage", message, detail: String(cause) }),
  });

export const validate = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new CoreError({
          code: "Validation",
          message: "Invalid domain value",
          detail: String(cause),
        }),
    ),
  );
