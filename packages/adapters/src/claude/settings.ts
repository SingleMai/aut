import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AdapterError, JsonValue } from "@aut/protocol";
import { Effect, Schema } from "effect";

const problem = (code: AdapterError["code"], message: string) =>
  new AdapterError({ code, message });

export const claudeMemorySettings = (args: readonly string[], cwd: string) =>
  Effect.gen(function* () {
    const remaining: string[] = [];
    let source: string | undefined;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--settings") {
        source = args[++index];
        if (source === undefined || source.startsWith("--"))
          return yield* Effect.fail(problem("InvalidResponse", "Claude settings require a value"));
      } else if (arg?.startsWith("--settings=")) source = arg.slice("--settings=".length);
      else if (arg !== undefined) remaining.push(arg);
    }
    let settings: Readonly<Record<string, JsonValue>> = {};
    if (source !== undefined) {
      const text = source.trimStart().startsWith("{")
        ? source
        : yield* Effect.try({
            try: () => readFileSync(resolve(cwd, source), "utf8"),
            catch: () => problem("InvalidResponse", "Unable to read Claude settings"),
          });
      settings = yield* Schema.decodeUnknown(
        Schema.parseJson(Schema.Record({ key: Schema.String, value: JsonValue })),
      )(text).pipe(
        Effect.mapError(() => problem("InvalidResponse", "Invalid Claude settings JSON object")),
      );
    }
    const env = yield* Schema.decodeUnknown(
      Schema.Record({ key: Schema.String, value: Schema.String }),
    )(settings.env ?? {}).pipe(
      Effect.mapError(() => problem("InvalidResponse", "Invalid Claude settings environment")),
    );
    return {
      args: remaining,
      settings: {
        ...settings,
        autoMemoryEnabled: false,
        env: { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      },
    };
  });
