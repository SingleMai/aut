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
    "primary.source": "custom",
    "primary.endpoint": "ftp://fixture",
    "primary.model": "latest",
    "primary.key": "invalid raw input",
  });
  const errors = Effect.runSync(Effect.flip(readClassifierForm(data))).fields;
  expect(Object.keys(errors).sort()).toEqual(["primary.endpoint", "primary.key", "primary.model"]);
  expect(JSON.stringify(errors)).not.toContain("invalid raw input");
});
it("requires a primary source even with a saved key or configured backup", () => {
  const data = form({ "primary.key": "secret:primary" });
  expect(Object.keys(Effect.runSync(Effect.flip(readClassifierForm(data))).fields)).toEqual([
    "primary.source",
  ]);
  data.set("primary.source", "off");
  data.set("fallback.source", "custom");
  data.set("fallback.model", "fixture-v1");
  const errors = Effect.runSync(Effect.flip(readClassifierForm(data))).fields;
  expect(Object.keys(errors).sort()).toEqual([
    "fallback.endpoint",
    "fallback.model",
    "primary.source",
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
