import { Effect } from "effect";
import { expect, it } from "vitest";
import { readBotForm, readClassifierForm } from "./configuration-forms.js";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}
it("locates concurrent classifier field errors without echoing the entered credential", () => {
  const data = form({
    "primary.backend": "service",
    "primary.endpoint": "ftp://fixture",
    "primary.model": "latest",
    "primary.key": "invalid raw input",
  });
  const errors = Effect.runSync(Effect.flip(readClassifierForm(data))).fields;
  expect(Object.keys(errors).sort()).toEqual(["primary.endpoint", "primary.key", "primary.model"]);
  expect(JSON.stringify(errors)).not.toContain("invalid raw input");
});
it("keeps independent credentials and an empty optional backend separate from a partial backend", () => {
  const data = form({ "primary.key": "secret:primary" });
  expect(Effect.runSync(readClassifierForm(data))).toBeUndefined();
  data.set("fallback.model", "fixture-v1");
  const errors = Effect.runSync(Effect.flip(readClassifierForm(data))).fields;
  expect(Object.keys(errors).sort()).toEqual([
    "fallback.backend",
    "fallback.endpoint",
    "primary.backend",
  ]);
});
it("does not include the removed inline MCP configuration in a Bot", () => {
  const data = form({
    id: "bot",
    name: "Research",
    description: "Work",
    cwd: ".",
    instance: "local",
    model: "fixture",
    mcp: JSON.stringify([
      { name: "events", transport: "http", url: "https://example.test" },
      {
        name: "tools",
        transport: "stdio",
        command: "tool",
        args: [42],
        env: { KEY: "secret-value" },
      },
    ]),
  });
  expect(Effect.runSync(readBotForm(data))).toEqual({
    id: "bot",
    name: "Research",
    description: "Work",
    soul: "",
    cwd: ".",
    modelSelection: { instanceId: "local", model: "fixture" },
  });
});
