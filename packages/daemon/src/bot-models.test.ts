import { expect, it } from "vitest";
import { botModelOptions, programInstalled } from "./bot-models.js";

it("defers cwd-relative programs instead of incorrectly hiding their model discovery", () => {
  const relative = {
    id: "project-cli",
    name: "Project CLI",
    kind: "claude",
    command: "./bin/claude",
    args: [],
  };
  expect(programInstalled(relative)).toBeUndefined();
  expect(botModelOptions({ harnessInstances: [relative] }).options[0]).toMatchObject({
    availability: "unknown",
    discovery: true,
  });
  expect(programInstalled({ ...relative, command: process.execPath })).toBe(true);
});

it("lists every registered program even without stored connections and does not claim Grok is verified", () => {
  const result = botModelOptions(
    { harnessInstances: [] },
    (instance) => instance.command !== "grok",
  );
  expect(result.options.map((option) => option.instance.name)).toEqual([
    "Codex",
    "Claude Code",
    "OpenCode",
    "Grok",
  ]);
  expect(result.options.find((option) => option.instance.name === "Grok")).toMatchObject({
    availability: "missing",
    verification: "preview",
  });
  expect(result.options.every((option) => option.discovery && !option.configured)).toBe(true);
});

it("retains custom accounts, exact identities, env and ACP auth without replacing them with presets", () => {
  const custom = {
    id: "native-account",
    name: "Work account",
    kind: "claude",
    command: "/bin/claude",
    args: ["--settings", "work.json"],
    env: { EXAMPLE: "synthetic-secret" },
  };
  const acp = {
    id: "custom-acp",
    name: "My ACP",
    kind: "acp",
    command: "custom",
    args: [],
    authMethodIds: ["login"],
  };
  const config = { harnessInstances: [custom, acp] };
  const before = JSON.stringify(config);
  const result = botModelOptions(config, () => true);
  expect(result.options[0]?.instance).toBe(custom);
  expect(result.options[1]?.instance).toBe(acp);
  expect(result.options.some((option) => option.instance.id === "builtin:claude")).toBe(true);
  expect(JSON.stringify(config)).toBe(before);
});

it("reuses stored defaults, handles identifier collisions, and labels unknown adapters honestly", () => {
  const result = botModelOptions(
    {
      harnessInstances: [
        { id: "local", name: "Codex", kind: "codex", command: "/bin/codex", args: [] },
        {
          id: "builtin:claude",
          name: "Old provider",
          kind: "unknown",
          command: "custom",
          args: [],
        },
      ],
    },
    () => true,
  );
  expect(result.options.filter((option) => option.instance.kind === "codex")).toHaveLength(1);
  expect(result.options.find((option) => option.instance.kind === "unknown")).toMatchObject({
    availability: "unsupported",
    discovery: false,
  });
  expect(result.options.find((option) => option.instance.kind === "claude")?.instance.id).toBe(
    "builtin:claude:default",
  );
});
