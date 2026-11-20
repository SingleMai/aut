import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, configureToolOutputReader, ToolOutputError } from "./api.js";

afterEach(() => {
  configureToolOutputReader(() =>
    Effect.fail(new ToolOutputError({ message: "Full tool output is not available." })),
  );
});

describe("upstream tool output adapter", () => {
  it("passes decoded source identities to the daemon reader", async () => {
    const reader = vi.fn(() => Effect.succeed({ output: "complete tool result" }));
    configureToolOutputReader(reader);

    await expect(api("/api/threads/task%2F1/messages/event%20two/tool")).resolves.toEqual({
      output: "complete tool result",
    });
    expect(reader).toHaveBeenCalledWith({ threadId: "task/1", messageId: "event two" });
  });

  it("rejects an unknown or malformed source before calling the reader", async () => {
    const reader = vi.fn(() => Effect.succeed({ output: "unused" }));
    configureToolOutputReader(reader);

    await expect(api("https://example.com/tool")).rejects.toThrow("Unknown tool output source.");
    await expect(api("/api/threads/%E0%A4%A/messages/m1/tool")).rejects.toThrow(
      "Invalid tool output source.",
    );
    expect(reader).not.toHaveBeenCalled();
  });

  it("interrupts an outstanding Effect when the upstream disclosure aborts", async () => {
    let interrupted = false;
    configureToolOutputReader(() =>
      Effect.async<{ readonly output: string }>(() =>
        Effect.sync(() => {
          interrupted = true;
        }),
      ),
    );
    const abort = new AbortController();
    const pending = api("/api/threads/t1/messages/m1/tool", { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow();
    abort.abort();

    await rejected;
    expect(interrupted).toBe(true);
  });
});
