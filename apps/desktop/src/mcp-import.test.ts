import { McpServerId } from "@aut/protocol";
import { Effect, Either } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { desktopApi } from "./api.js";
import { parseMcpPaste, prepareMcpDraft, saveMcpImportSecrets } from "./mcp-import.js";
import {
  draftFor,
  draftFromPaste,
  emptyDraft,
  secretRow,
} from "./openmausbot/components/mcp-draft.js";

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
  const fields = draftFromPaste(draft);
  const credential = fields.headers[0];
  if (!credential) throw new Error("Missing credential");
  credential.value = "YOUR_API_KEY";
  expect(Either.isLeft(await Effect.runPromise(Effect.either(prepareMcpDraft(fields))))).toBe(true);
  credential.value = "fixture-private-value";
  const save = vi
    .spyOn(desktopApi, "saveSecret")
    .mockReturnValue(Effect.succeed({ apiKeyRef: "secret:fixture", configured: true }));
  const prepared = await Effect.runPromise(prepareMcpDraft(fields));
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
    prepareMcpDraft({
      ...emptyDraft(),
      name: "manual",
      url: "https://example.com/mcp",
      headers: [
        secretRow({ name: "Authorization", value: "Bearer fixture-private" }),
        secretRow({ name: "Existing", value: "", savedValue: "secret:existing" }),
      ],
    }).pipe(Effect.flatMap((prepared) => saveMcpImportSecrets(prepared, "manual"))),
  );
  expect(input).toMatchObject({
    headers: { Authorization: "secret:manual", Existing: "secret:existing" },
  });
  expect(save).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(input)).not.toContain("fixture-private");
});

it("preserves, replaces and explicitly removes the OAuth client secret", async () => {
  const draft = {
    ...emptyDraft(),
    name: "calendar",
    url: "https://calendar.example/mcp",
    oauthClientId: "client",
    oauthSecretRef: "secret:existing",
  };
  const save = vi
    .spyOn(desktopApi, "saveSecret")
    .mockReturnValue(Effect.succeed({ apiKeyRef: "secret:replacement", configured: true }));
  const persist = (value: typeof draft) =>
    Effect.runPromise(
      prepareMcpDraft(value).pipe(
        Effect.flatMap((prepared) => saveMcpImportSecrets(prepared, "oauth")),
      ),
    );
  expect(await persist(draft)).toMatchObject({
    oauth: { clientId: "client", clientSecretRef: "secret:existing" },
  });
  expect(save).not.toHaveBeenCalled();
  expect(await persist({ ...draft, oauthClientSecret: "replacement-value" })).toMatchObject({
    oauth: { clientSecretRef: "secret:replacement" },
  });
  expect(save).toHaveBeenCalledExactlyOnceWith({
    name: "mcp-oauth-oauth",
    key: "replacement-value",
  });
  const removed = await persist({ ...draft, oauthForgetSecret: true });
  expect(removed).toMatchObject({ oauth: { clientId: "client" } });
  expect(JSON.stringify(removed)).not.toContain("clientSecretRef");
});

it("keeps write-only saved credentials and parses one argument per line", async () => {
  const draft = draftFor({
    id: McpServerId.make("local"),
    name: "local",
    transport: "stdio",
    command: "node",
    args: ["/path with spaces/server.js"],
    env: { API_KEY: "secret:existing" },
    enabled: false,
    auth: { status: "none" },
    health: { status: "unknown" },
    tools: [],
  });
  expect(draft.env[0]?.value).toBe("");
  draft.args += "\n--verbose";
  const prepared = await Effect.runPromise(prepareMcpDraft(draft));
  expect(prepared.input).toMatchObject({
    args: ["/path with spaces/server.js", "--verbose"],
    env: { API_KEY: "secret:existing" },
  });
  const save = vi.spyOn(desktopApi, "saveSecret");
  expect((await Effect.runPromise(saveMcpImportSecrets(prepared, "edit"))).transport).toBe("stdio");
  expect(save).not.toHaveBeenCalled();
});

it("keeps the bearer prefix once and refuses duplicate headers before saving", async () => {
  const [pasted] = await Effect.runPromise(
    parseMcpPaste(
      `claude mcp add notes https://notes.example/mcp -H 'Authorization: Bearer $TOKEN'`,
      [],
    ),
  );
  if (!pasted) throw new Error("Missing draft");
  const draft = draftFromPaste(pasted);
  const first = draft.headers[0];
  if (!first) throw new Error("Missing header");
  first.value = "Bearer fixture-secret";
  expect((await Effect.runPromise(prepareMcpDraft(draft))).values[0]?.value).toBe(
    "Bearer fixture-secret",
  );
  draft.headers.push({ id: 999, name: "authorization", value: "second" });
  expect(Either.isLeft(await Effect.runPromise(Effect.either(prepareMcpDraft(draft))))).toBe(true);
});
