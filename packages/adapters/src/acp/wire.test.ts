import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { decodeLine } from "./wire.js";

const fixtures = fileURLToPath(new URL("../../../../spikes/acp/fixtures", import.meta.url));

const rows = (name: string): readonly Record<string, unknown>[] =>
  readFileSync(`${fixtures}/${name}`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("ACP JSON-RPC wire fixtures", () => {
  it.scopedLive("decodes every recorded provider frame", () =>
    Effect.gen(function* () {
      for (const name of [
        "normal-opencode-1.19.5.jsonl",
        "permission-opencode-1.19.5.jsonl",
        "interrupt-opencode-1.19.5.jsonl",
        "resume-opencode-1.19.5.jsonl",
        "fork-opencode-1.19.5.jsonl",
        "auth-required-grok-1.0.89.jsonl",
      ]) {
        for (const row of rows(name)) {
          if (row.direction !== "send" && row.direction !== "receive") continue;
          const payload = row.payload;
          const decoded = yield* decodeLine(JSON.stringify(payload));
          expect(decoded.method ?? decoded.result ?? decoded.error).toBeDefined();
        }
      }
    }),
  );

  it("keeps the recorded provider capabilities and lifecycle methods visible", () => {
    const normal = rows("normal-opencode-1.19.5.jsonl");
    const initialize = normal.find(
      (row) =>
        row.direction === "receive" &&
        (row.payload as { method?: unknown } | undefined)?.method === undefined &&
        typeof (row.payload as { result?: unknown } | undefined)?.result === "object",
    );
    expect(JSON.stringify(initialize?.payload)).toContain('"sessionCapabilities"');
    expect(
      normal
        .filter((row) => row.direction === "send")
        .map((row) => (row.payload as { method?: unknown }).method)
        .filter((method): method is string => typeof method === "string"),
    ).toEqual(expect.arrayContaining(["initialize", "session/new", "session/prompt"]));
  });

  it("records Grok authentication as a provider boundary requirement", () => {
    const grok = rows("auth-required-grok-1.0.89.jsonl");
    const initialize = grok.find(
      (row) =>
        row.direction === "receive" && (row.payload as { id?: unknown } | undefined)?.id === 1,
    );
    const sessionError = grok.find(
      (row) =>
        row.direction === "receive" && (row.payload as { id?: unknown } | undefined)?.id === 2,
    );
    expect(JSON.stringify(initialize?.payload)).toContain('"grok.com"');
    expect(JSON.stringify(sessionError?.payload)).toContain("Authentication required");
  });
});
