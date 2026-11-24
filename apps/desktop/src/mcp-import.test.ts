import { Effect, Either } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { desktopApi } from "./api.js";
import {
  parseMcpPaste,
  prepareMcpImport,
  saveMcpImportSecrets,
  saveMcpServerSecrets,
} from "./mcp-import.js";

afterEach(() => vi.restoreAllMocks());

it("imports URLs, JSON and quoted commands without evaluating placeholders or overwriting names", async () => {
  const servers = await Effect.runPromise(
    parseMcpPaste(
      `claude mcp add --transport http notes https://notes.example/mcp --header 'Authorization: Bearer $TOKEN'\nclaude mcp add local -- npx -y @example/server '/path with spaces'`,
      ["notes"],
    ),
  );
  expect(servers[0]).toMatchObject({
    name: "notes-2",
    headers: [{ name: "Authorization", value: "", gap: { names: ["TOKEN"], before: "Bearer " } }],
  });
  expect(servers[1]).toMatchObject({
    transport: "stdio",
    command: "npx",
    args: ["-y", "@example/server", "/path with spaces"],
  });
  expect(await Effect.runPromise(parseMcpPaste("https://search.example/mcp", []))).toMatchObject([
    { type: "http", url: "https://search.example/mcp" },
  ]);
  expect(
    await Effect.runPromise(
      parseMcpPaste(
        '{"mcpServers":{"aut":{"command":"node","args":["server.js"],"cwd":"/tmp/work"}}}',
        [],
      ),
    ),
  ).toMatchObject([{ name: "mcp-aut", cwd: "/tmp/work" }]);
  expect(
    Either.isLeft(
      await Effect.runPromise(Effect.either(parseMcpPaste("npx tool && curl private.example", []))),
    ),
  ).toBe(true);
});

it("requires placeholder values and persists credentials separately from the server definition", async () => {
  const [draft] = await Effect.runPromise(
    parseMcpPaste(
      `claude mcp add notes https://notes.example/mcp -H 'Authorization: Bearer \${TOKEN}'`,
      [],
    ),
  );
  if (!draft) throw new Error("Missing draft");
  const form = new FormData();
  form.set("name", "notes");
  form.set("url", "https://notes.example/mcp");
  form.set("secret-0", "YOUR_API_KEY");
  expect(Either.isLeft(await Effect.runPromise(Effect.either(prepareMcpImport(draft, form))))).toBe(
    true,
  );
  form.set("secret-0", "fixture-private-value");
  const save = vi
    .spyOn(desktopApi, "saveSecret")
    .mockReturnValue(Effect.succeed({ apiKeyRef: "secret:fixture", configured: true }));
  const prepared = await Effect.runPromise(prepareMcpImport(draft, form));
  const input = await Effect.runPromise(saveMcpImportSecrets(prepared, "stable-id"));
  expect(save).toHaveBeenCalledExactlyOnceWith({
    name: "mcp-stable-id-0",
    key: "Bearer fixture-private-value",
  });
  expect(input).toMatchObject({ headers: { Authorization: "secret:fixture" } });
  expect(JSON.stringify(input)).not.toContain("fixture-private-value");
});

it.each([
  "-e API_KEY=private-fixture",
  "--env=API_KEY=private-fixture",
  "-eAPI_KEY=private-fixture",
])("moves docker environment values out of visible process arguments: %s", async (flag) => {
  const [draft] = await Effect.runPromise(
    parseMcpPaste(`docker run --rm -i ${flag} example/mcp`, []),
  );
  expect(draft).toMatchObject({
    command: "docker",
    args: ["run", "--rm", "-i", "-e", "API_KEY", "example/mcp"],
    env: [{ name: "API_KEY", value: "private-fixture" }],
  });
});

it("protects credentials from manual editing while preserving existing references", async () => {
  const save = vi
    .spyOn(desktopApi, "saveSecret")
    .mockReturnValue(Effect.succeed({ apiKeyRef: "secret:manual", configured: true }));
  const input = await Effect.runPromise(
    saveMcpServerSecrets(
      {
        name: "manual",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer fixture-private", Existing: "secret:existing" },
      },
      "manual",
    ),
  );
  expect(input).toMatchObject({
    headers: { Authorization: "secret:manual", Existing: "secret:existing" },
  });
  expect(save).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(input)).not.toContain("fixture-private");
});
