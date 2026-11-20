import { CoreError } from "@aut/core";
import { Data, Effect, Schema } from "effect";

export class DaemonError extends Data.TaggedError("DaemonError")<{
  readonly code:
    | "Unauthorized"
    | "Validation"
    | "NotFound"
    | "Conflict"
    | "BodyTooLarge"
    | "Transport"
    | "Unavailable"
    | "Lock";
  readonly message: string;
}> {}

export const io = <A>(message: string, operation: () => A) =>
  Effect.try({
    try: operation,
    catch: () => new DaemonError({ code: "Transport", message }),
  });

export const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new DaemonError({ code: "Validation", message: "Invalid request data" })),
  );

export const publicError = (error: unknown) => {
  if (error instanceof DaemonError) {
    const statuses = {
      Unauthorized: 401,
      Validation: 400,
      NotFound: 404,
      Conflict: 409,
      BodyTooLarge: 413,
      Transport: 500,
      Unavailable: 503,
      Lock: 409,
    };
    return { status: statuses[error.code], error: { code: error.code, message: error.message } };
  }
  if (error instanceof CoreError) {
    const status =
      error.code === "NotFound"
        ? 404
        : error.code === "Validation"
          ? 400
          : ["Conflict", "ImmutableField", "InvalidTransition", "InvalidRequest"].includes(
                error.code,
              )
            ? 409
            : 500;
    return {
      status,
      error: {
        code: error.code,
        message: status === 500 ? "Local storage operation failed" : error.message,
      },
    };
  }
  return { status: 500, error: { code: "Internal", message: "Local service operation failed" } };
};
