import { Data, Effect, Schema } from "effect";
import type { MessageAttachmentContext } from "./components/AttachmentPreview.js";

export class ToolOutputError extends Data.TaggedError("ToolOutputError")<{
  readonly message: string;
}> {}

const ToolOutput = Schema.Struct({ output: Schema.String });
export type ToolOutputReader = (
  source: MessageAttachmentContext,
) => Effect.Effect<{ readonly output: string }, { readonly message: string }>;

let reader: ToolOutputReader = () =>
  Effect.fail(new ToolOutputError({ message: "Full tool output is not available." }));

/** Supply the daemon reader without changing upstream's disclosure/cache/abort hook. */
export const configureToolOutputReader = (read: ToolOutputReader) => {
  reader = read;
};

/** Upstream paths are internal identities here; no request is sent to an OpenMausBot server. */
export const api = <T>(path: string, options: RequestInit = {}): Promise<T> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const match = /^\/api\/threads\/([^/]+)\/messages\/([^/]+)\/tool$/.exec(path);
      const rawThreadId = match?.[1];
      const rawMessageId = match?.[2];
      if (!rawThreadId || !rawMessageId)
        return yield* Effect.fail(new ToolOutputError({ message: "Unknown tool output source." }));
      const source = yield* Effect.try({
        try: () => ({
          threadId: decodeURIComponent(rawThreadId),
          messageId: decodeURIComponent(rawMessageId),
        }),
        catch: () => new ToolOutputError({ message: "Invalid tool output source." }),
      });
      const output = yield* reader(source).pipe(Effect.flatMap(Schema.decodeUnknown(ToolOutput)));
      return output as T;
    }),
    options.signal ? { signal: options.signal } : undefined,
  );
