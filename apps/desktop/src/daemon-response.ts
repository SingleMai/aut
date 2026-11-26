import { ApiErrorResponse, JsonValue } from "@aut/protocol";
import { Effect, Schema } from "effect";
import type { ApiRequest } from "./bridge.js";
import { desktopError } from "./desktop-error.js";

export const requestInit = ({ method, body }: ApiRequest): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** Both transports speak the same daemon protocol and report errors for the chosen host. */
export function daemonResponses(messages: { invalidJson: string; incompatible: string }) {
  const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
    Schema.decodeUnknown(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => desktopError("Protocol", messages.incompatible)),
    );
  const json = (response: Response, message = messages.invalidJson) =>
    Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: () => desktopError("Protocol", message),
    });
  const readResult = (response: Response) =>
    Effect.gen(function* () {
      const data = yield* json(response);
      if (response.ok) return { ok: true as const, data: yield* decode(JsonValue, data) };
      const { error } = yield* decode(ApiErrorResponse, data);
      return { ok: false as const, error };
    });
  return { decode, json, readResult };
}
