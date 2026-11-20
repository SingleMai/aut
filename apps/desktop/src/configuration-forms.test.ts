import { Effect } from "effect";
import { expect, it } from "vitest";
import { readBotForm, readSettingsForm } from "./configuration-forms.js";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}
const row = (key: string, id: string) => ({
  [`${key}.id`]: id,
  [`${key}.name`]: "Local",
  [`${key}.kind`]: "codex",
  [`${key}.command`]: "codex",
  [`${key}.args`]: "[]",
  [`${key}.env`]: "{}",
});
it("locates simultaneous syntax, schema, and uniqueness errors by stable row key", () => {
  const data = form({
    ...row("last", "shared"),
    ...row("first", "shared"),
    "first.args": "[",
    "last.env": '{"SECRET":42}',
    "primary.backend": "service",
    "primary.endpoint": "ftp://fixture",
    "primary.model": "latest",
    "primary.key": "invalid raw input",
  });
  const errors = Effect.runSync(
    Effect.flip(readSettingsForm(data, [{ key: "last" }, { key: "first" }])),
  ).fields;
  expect(Object.keys(errors).sort()).toEqual([
    "first.args",
    "first.id",
    "last.env",
    "primary.endpoint",
    "primary.key",
    "primary.model",
  ]);
  expect(JSON.stringify(errors)).not.toMatch(/SECRET|invalid raw input/);
  expect(
    Effect.runSync(Effect.flip(readSettingsForm(data, [{ key: "last" }]))).fields,
  ).not.toHaveProperty("first.id");
});
it("keeps independent credentials and an empty optional backend separate from a partial backend", () => {
  const data = form({ "primary.key": "secret:primary" });
  expect(Effect.runSync(readSettingsForm(data, []))).toEqual({ harnessInstances: [] });
  data.set("fallback.model", "fixture-v1");
  const errors = Effect.runSync(Effect.flip(readSettingsForm(data, []))).fields;
  expect(Object.keys(errors).sort()).toEqual([
    "fallback.backend",
    "fallback.endpoint",
    "primary.backend",
  ]);
});
it("reports the offending MCP entry without including configuration values", () => {
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
  const { fields } = Effect.runSync(Effect.flip(readBotForm(data)));
  expect(Object.keys(fields)).toEqual(["mcp"]);
  expect(fields.mcp).toContain("第 2 项");
  expect(fields.mcp).not.toContain("secret-value");
});
